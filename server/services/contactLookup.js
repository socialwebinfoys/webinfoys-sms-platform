// Contact lookup: categories, filters, and "Lookup All".
//
// This is NOT a second lookup system. Every number is looked up through the
// existing lookupService (one Twilio client) and the result is stored in the
// existing Contact.lookup cache, in exactly the shape the single-contact lookup
// and the send policy write — so the mobile-only filter reads the same data.
// Freshness uses the send policy's own isLookupFresh + Settings.lookupMaxAgeDays.
//
// WHERE THE RESULT LIVES (Contact.lookup):
//   status  'unknown' (never classified) | 'valid' | 'invalid'
//   type    Twilio line type: mobile, landline, fixedVoip, nonFixedVoip,
//           tollFree … (the simulator writes plain 'voip')
//   lastError / lastAttemptAt — set ONLY when an attempt failed. A failure
//           never changes `status`, so it can never make a number "invalid".
//
// INVALID means one thing: lookup.status === 'invalid', which is written only
// when Twilio answered that the number is invalid (valid:false or a 404). A
// failed lookup, an unparseable number, unknown, landline or VoIP never match.
'use strict';

const Contact = require('../models/Contact');
const Settings = require('../models/Settings');
const WorkerLock = require('../models/WorkerLock');
const lookupService = require('./lookupService');
const { isLookupFresh } = require('./sendPolicy');

// The stored spellings of each line-type bucket. They are the inputs
// sendPolicy.canonicalLineType understands, so a filter bucket and the send
// policy always agree on what a stored value means (asserted in the tests).
const TYPE_SPELLINGS = {
  mobile: ['mobile'],
  landline: ['landline'],
  voip: ['voip', 'fixedVoip', 'nonFixedVoip', 'fixedvoip', 'nonfixedvoip'],
  tollFree: ['tollFree', 'tollfree', 'toll-free'],
};
const KNOWN_TYPES = Object.values(TYPE_SPELLINGS).flat();

const LOOKUP_FILTERS = ['mobile', 'landline', 'voip', 'tollFree', 'invalid', 'unknown', 'not_checked'];

const NEVER_CLASSIFIED = { $or: [{ 'lookup.status': 'unknown' }, { 'lookup.status': null }] };
const NO_FAILED_ATTEMPT = { $or: [{ 'lookup.lastError': '' }, { 'lookup.lastError': null }] };

// The Mongo condition for one lookup-status bucket.
function lookupCondition(key) {
  switch (key) {
    case 'mobile':
    case 'landline':
    case 'voip':
    case 'tollFree':
      return { 'lookup.status': 'valid', 'lookup.type': { $in: TYPE_SPELLINGS[key] } };
    case 'invalid':
      return { 'lookup.status': 'invalid' };
    case 'unknown':
      // Checked but unclassifiable, OR an attempt that failed (never invalid).
      return {
        $or: [
          { 'lookup.status': 'valid', 'lookup.type': { $nin: KNOWN_TYPES } },
          { $and: [NEVER_CLASSIFIED, { 'lookup.lastError': { $nin: ['', null] } }] },
        ],
      };
    case 'not_checked':
      return { $and: [NEVER_CLASSIFIED, NO_FAILED_ATTEMPT] };
    default:
      return null;
  }
}

// Add a lookup bucket to an existing contact filter without disturbing its
// shape: plain keys merge; anything with its own $or/$and, or a key the filter
// already constrains (the Remaining view sets lookup.status), is AND-ed so
// neither condition can overwrite the other.
function withLookup(filter, key) {
  const cond = lookupCondition(key);
  if (!cond) return filter;
  const overlaps = Object.keys(cond).some((k) => k in filter);
  if (overlaps || cond.$or || cond.$and || filter.$or || filter.$and) return { $and: [filter, cond] };
  return { ...filter, ...cond };
}

// Contacts that need a lookup: never classified (including failed attempts),
// or classified longer ago than the configured maximum age. A fresh cached
// classification is reused, never re-bought.
function needsLookupCondition(maxAgeDays, now = new Date()) {
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);
  return {
    phone: { $nin: ['', null] },
    $or: [
      { 'lookup.status': { $in: ['unknown', null] } },
      { 'lookup.lookedUpAt': null },
      { 'lookup.lookedUpAt': { $lt: cutoff } },
    ],
  };
}

// The cache of a number that has never been looked up — the schema defaults,
// with no lookedUpAt / lastAttemptAt.
function emptyLookup() {
  return { status: 'unknown', type: '', carrier: '', canonicalPhone: '', lastError: '' };
}

// A Lookup result describes ONE number. When a contact's phone changes, the
// cached status, line type and carrier belong to the old number and must not be
// applied to the new one — a corrected number would otherwise stay "invalid",
// and a bad number would inherit "valid / mobile". Only `lookup` is replaced;
// the contact then reads as "not checked", so Lookup All (needsLookupCondition)
// and the send-time line-type check look the new number up again.
function resetLookup(contact) {
  contact.lookup = emptyLookup();
  return contact;
}

// Twilio's rate-limit answer (HTTP 429 / error 20429).
function isRateLimited(err) {
  return !!err && (err.twilioCode === 20429 || /\b429\b|too many requests/i.test(err.message || ''));
}

// Look up one contact through the existing service and cache the result.
// Only `lookup.*` is written — never name, phone, email, tags or custom fields.
// Returns 'mobile' | 'landline' | … | 'invalid' | 'failed'. Rate limits throw.
async function lookupOne(contact, now = new Date()) {
  let result;
  try {
    result = await lookupService.lookupNumber(contact.phone);
  } catch (err) {
    if (isRateLimited(err)) throw err;
    // A failure is recorded, not classified: status is left exactly as it was,
    // so it can never turn into "invalid" and the send policy is unaffected.
    await Contact.updateOne(
      { _id: contact._id },
      {
        $set: {
          'lookup.lastError': String(err.message || 'Lookup failed').slice(0, 200),
          'lookup.lastAttemptAt': now,
        },
      }
    );
    return 'failed';
  }

  const status = result.valid ? 'valid' : 'invalid';
  await Contact.updateOne(
    { _id: contact._id },
    {
      $set: {
        'lookup.status': status,
        'lookup.type': result.type || '',
        'lookup.carrier': result.carrier || '',
        'lookup.canonicalPhone': result.phone || '',
        'lookup.lookedUpAt': result.lookedUpAt || now,
        'lookup.lastError': '',
        'lookup.lastAttemptAt': now,
      },
    }
  );
  if (status === 'invalid') return 'invalid';
  const bucket = Object.keys(TYPE_SPELLINGS).find((k) => TYPE_SPELLINGS[k].includes(result.type || ''));
  return bucket || 'unknown';
}

// ---------------------------------------------------------------------------
// Lookup All — one run at a time, across every server instance.
//
// The run is a background task: the request that starts it returns at once and
// the page polls the status. Exclusion is the existing WorkerLock lease, renewed
// as the run progresses, so a second click — or a second server — is refused
// rather than starting a duplicate (and billing every number twice).
const LOCK_KEY = 'lookup-all';
const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCK_OWNER = `${process.pid}@${require('os').hostname()}`;
const PAGE = 100;
const CONCURRENCY = 4;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 1000;
// After this many rate-limited contacts in a row, stop and say so.
const RATE_LIMIT_STOP_AFTER = 5;

let state = { status: 'idle' };
let running = null; // the current run's promise (tests await it)
let starting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot() {
  return { ...state };
}

async function runLookupAll({ scope, maxAgeDays, total, onFinished, backoffMs }) {
  const filter = { ...scope, ...needsLookupCondition(maxAgeDays, new Date(state.startedAt)) };
  let lastId = null;
  let rateLimitedInARow = 0;
  try {
    for (;;) {
      const page = await Contact.find(lastId ? { $and: [filter, { _id: { $gt: lastId } }] } : filter)
        .sort({ _id: 1 })
        .limit(PAGE)
        .select('_id phone lookup')
        .lean();
      if (!page.length) break;
      lastId = page[page.length - 1]._id;
      await WorkerLock.acquire(LOCK_KEY, LOCK_OWNER, LOCK_TTL_MS); // renew

      for (let i = 0; i < page.length; i += CONCURRENCY) {
        const chunk = page.slice(i, i + CONCURRENCY);
        const outcomes = await Promise.all(
          chunk.map(async (contact) => {
            for (let attempt = 0; ; attempt += 1) {
              try {
                return await lookupOne(contact);
              } catch (err) {
                if (!isRateLimited(err) || attempt >= RATE_LIMIT_RETRIES) {
                  await Contact.updateOne(
                    { _id: contact._id },
                    { $set: { 'lookup.lastError': 'Rate limited by Twilio Lookup', 'lookup.lastAttemptAt': new Date() } }
                  );
                  return 'rateLimited';
                }
                await sleep(backoffMs * 2 ** attempt);
              }
            }
          })
        );
        for (const o of outcomes) {
          state.processed += 1;
          if (o === 'failed' || o === 'rateLimited') state.failed += 1;
          else {
            state.lookedUp += 1;
            state.results[o] = (state.results[o] || 0) + 1;
          }
          rateLimitedInARow = o === 'rateLimited' ? rateLimitedInARow + 1 : 0;
        }
        if (rateLimitedInARow >= RATE_LIMIT_STOP_AFTER) {
          state.status = 'stopped';
          state.message = 'Twilio Lookup is rate-limiting requests. Stopped early — run Lookup All again later to continue.';
          return;
        }
      }
    }
    state.status = 'done';
    state.message = `Looked up ${state.lookedUp} of ${total} contact${total === 1 ? '' : 's'}.`;
  } catch (err) {
    state.status = 'failed';
    state.message = `Lookup All stopped: ${err.message || 'unexpected error'}`;
  } finally {
    state.finishedAt = new Date();
    try {
      await WorkerLock.release(LOCK_KEY, LOCK_OWNER);
    } catch (e) {
      console.error('Lookup All lock release failed:', e.message);
    }
    if (onFinished) {
      try {
        await onFinished(snapshot());
      } catch (e) {
        console.error('Lookup All follow-up failed:', e.message);
      }
    }
  }
}

class LookupJobError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Start a run over `scope` (a contact filter — one imported list, or {} for
// every contact). Returns the status snapshot immediately.
async function startLookupAll({ scope = {}, scopeLabel = 'all contacts', userId, onFinished, backoffMs = RATE_LIMIT_BACKOFF_MS }) {
  // Claimed synchronously, before any await: two clicks reaching THIS process
  // together would otherwise both pass — the lease below treats its own holder
  // as free, so it only excludes other instances.
  if (starting || state.status === 'running') {
    throw new LookupJobError(409, 'Lookup All is already running.');
  }
  starting = true;
  let held = false;
  try {
    held = await WorkerLock.acquire(LOCK_KEY, LOCK_OWNER, LOCK_TTL_MS);
  } catch (err) {
    starting = false;
    throw err;
  }
  if (!held) {
    starting = false;
    throw new LookupJobError(409, 'Lookup All is already running.');
  }

  try {
    const settings = await Settings.getSingleton();
    const maxAgeDays = settings.lookupMaxAgeDays || 30;
    const startedAt = new Date();
    const total = await Contact.countDocuments({ ...scope, ...needsLookupCondition(maxAgeDays, startedAt) });

    state = {
      status: 'running',
      scope: scopeLabel,
      total,
      processed: 0,
      lookedUp: 0,
      failed: 0,
      results: {},
      startedAt,
      finishedAt: null,
      startedBy: userId ? String(userId) : undefined,
      message: '',
    };
    running = runLookupAll({ scope, maxAgeDays, total, onFinished, backoffMs });
    return snapshot();
  } catch (err) {
    await WorkerLock.release(LOCK_KEY, LOCK_OWNER).catch(() => {});
    throw err;
  } finally {
    starting = false;
  }
}

function getLookupAllStatus() {
  return snapshot();
}

// Test seam: wait for the current run to finish.
function currentRun() {
  return running || Promise.resolve();
}

function resetForTests() {
  state = { status: 'idle' };
  running = null;
  starting = false;
}

module.exports = {
  TYPE_SPELLINGS,
  KNOWN_TYPES,
  LOOKUP_FILTERS,
  lookupCondition,
  withLookup,
  needsLookupCondition,
  emptyLookup,
  resetLookup,
  isRateLimited,
  lookupOne,
  startLookupAll,
  getLookupAllStatus,
  currentRun,
  resetForTests,
  LookupJobError,
  LOCK_KEY,
  isLookupFresh,
};
