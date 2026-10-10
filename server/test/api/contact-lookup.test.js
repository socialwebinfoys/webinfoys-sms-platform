// Contact lookup workflow: Lookup All, the lookup-status filter and counts,
// Select-All / Delete Selected / Delete Invalid, and how deleting contacts keeps
// an imported list's batch allocation consistent.
//
// Contacts, imports and the worker lock live in the docStore, so filters and
// deletes act on real documents. Twilio Lookup is a scripted double: no number
// is ever sent to Twilio.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { stubModule, fakeModel, query } = require('../_support/stubs');
const { storeModel, same, tick } = require('../_support/docStore');
const f = require('../_support/factories');

const logged = [];
stubModule('services/logService', { logEvent: async (e) => void logged.push(e) });
stubModule('jobs/automationWorker', {
  processDueEnrollments: async () => ({}),
  processDueFollowings: async () => ({}),
  start: () => {},
  stop: () => {},
});

const operator = f.user();
const administrator = f.admin();
const usersById = new Map([
  [String(operator._id), operator],
  [String(administrator._id), administrator],
]);
stubModule('models/User', fakeModel('User', { findById: (id) => query(usersById.get(String(id)) || null) }));

// --- stores -------------------------------------------------------------------
let contacts = [];
let imports = [];
let enrollments = [];
let locks = [];
const ContactModel = stubModule('models/Contact', storeModel('Contact', () => contacts, (r) => { contacts = r; }));
const ImportModel = stubModule('models/Import', storeModel('Import', () => imports, (r) => { imports = r; }));
const EnrollmentModel = stubModule(
  'models/Enrollment',
  storeModel('Enrollment', () => enrollments, (r) => { enrollments = r; }, {
    insertMany: async (docs) => {
      const made = docs.map((d) => ({ ...d, _id: new mongoose.Types.ObjectId() }));
      enrollments.push(...made);
      return made;
    },
  })
);

// The REAL WorkerLock statics against a store, so the cross-instance exclusion
// of Lookup All is the production code path.
const RealWorkerLock = (() => {
  const { resolveAppModule } = require('../_support/stubs');
  const id = resolveAppModule('models/WorkerLock');
  delete require.cache[id];
  return require(id);
})();
RealWorkerLock.findOneAndUpdate = async (filter, update) => {
  await tick();
  const existing = locks.find((l) => l.key === filter.key);
  const now = Date.now();
  const free = !existing || new Date(existing.expiresAt).getTime() <= now || existing.owner === update.$set.owner;
  if (!free) {
    const err = new Error('E11000 duplicate key');
    err.code = 11000;
    throw err;
  }
  if (existing) Object.assign(existing, update.$set);
  else locks.push({ ...update.$set });
  return { ...update.$set };
};
RealWorkerLock.updateOne = async (filter, update) => {
  const l = locks.find((x) => x.key === filter.key && x.owner === filter.owner);
  if (l) Object.assign(l, update.$set);
  return { modifiedCount: l ? 1 : 0 };
};

let settingsDoc;
const RealSettings = require('../../models/Settings');
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    getSingleton: async () => settingsDoc,
    resolveAllowedLineTypes: RealSettings.resolveAllowedLineTypes,
    LINE_TYPES: RealSettings.LINE_TYPES,
    INBOX_REFRESH_OPTIONS: RealSettings.INBOX_REFRESH_OPTIONS,
  })
);

// Everything that must never be written by this feature.
const untouched = {};
for (const m of ['models/Campaign', 'models/Following', 'models/Conversation', 'models/SMSMessage', 'models/AIReplyJob', 'models/Template']) {
  untouched[m] = stubModule(m, fakeModel(m));
}
for (const m of ['models/SystemLog', 'models/ImportPreview']) stubModule(m, fakeModel(m));

// --- Twilio Lookup double -------------------------------------------------------
// Outcome per phone: { type } (valid), 'invalid', or an Error to throw.
let outcomes = new Map();
let lookupCalls = [];
let lookupGate = null;
const twilioSends = [];
stubModule('services/twilioService', {
  sendSms: async (a) => { twilioSends.push(a); return { sid: 'SM1', status: 'queued' }; },
  getClient: () => null,
  isConfigured: () => true,
  status: () => ({ configured: true, simulate: true }),
  PERMANENT_CODES: new Set([21610]),
});
stubModule('services/lookupService', {
  lookupNumber: async (phone) => {
    lookupCalls.push(phone);
    if (lookupGate) await lookupGate;
    const o = outcomes.has(phone) ? outcomes.get(phone) : { type: 'mobile' };
    const value = typeof o === 'function' ? o() : o;
    if (value instanceof Error) throw value;
    if (value === 'invalid') return { valid: false, phone, type: '', carrier: '', lookedUpAt: new Date() };
    return { valid: true, phone, type: value.type, carrier: 'Test', lookedUpAt: new Date() };
  },
  parseLineType: () => ({}),
});

const contactLookup = require('../../services/contactLookup');
const sendPolicy = require('../../services/sendPolicy');
const { startApp, tokenFor } = require('../_support/http');

let api;
let userToken;
let adminToken;
before(async () => {
  api = await startApp();
  userToken = tokenFor(operator);
  adminToken = tokenFor(administrator);
});
after(async () => {
  await api.close();
});

beforeEach(async () => {
  await contactLookup.currentRun();
  contactLookup.resetForTests();
  contacts = [];
  imports = [];
  enrollments = [];
  locks = [];
  outcomes = new Map();
  lookupCalls = [];
  lookupGate = null;
  twilioSends.length = 0;
  logged.length = 0;
  settingsDoc = f.settings({ lookupMaxAgeDays: 30 });
  Object.values(untouched).forEach((m) => m.__reset());
  ContactModel.__reset();
});

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
function addContact(overrides = {}) {
  seq += 1;
  const c = {
    _id: new mongoose.Types.ObjectId(),
    name: `Contact ${seq}`,
    phone: `+1415555${String(seq).padStart(4, '0')}`,
    email: `c${seq}@example.com`,
    tags: ['lead'],
    customFields: { plan: 'gold' },
    optedOut: false,
    isActive: true,
    deliveryBlocked: false,
    importBatch: null,
    lookup: { status: 'unknown', type: '', carrier: '', canonicalPhone: '', lastError: '' },
    ...overrides,
  };
  contacts.push(c);
  return c;
}
const fresh = (type, extra = {}) => ({ status: 'valid', type, carrier: 'X', lookedUpAt: new Date(), lastError: '', ...extra });
const invalid = () => ({ status: 'invalid', type: '', carrier: '', lookedUpAt: new Date(), lastError: '' });

function addImport(filename = 'leads.csv') {
  const imp = {
    _id: new mongoose.Types.ObjectId(),
    filename,
    allocation: { initializedAt: null, total: 0, allocated: 0, remaining: 0, excluded: 0, lockedUntil: null, lockOwner: null, batches: [] },
  };
  imports.push(imp);
  return imp;
}

// One contact of every lookup state, labelled by its expected bucket.
function seedEveryState(extra = {}) {
  return {
    mobile: addContact({ lookup: fresh('mobile'), ...extra }),
    landline: addContact({ lookup: fresh('landline'), ...extra }),
    fixedVoip: addContact({ lookup: fresh('fixedVoip'), ...extra }),
    nonFixedVoip: addContact({ lookup: fresh('nonFixedVoip'), ...extra }),
    simVoip: addContact({ lookup: fresh('voip'), ...extra }),
    tollFree: addContact({ lookup: fresh('tollFree'), ...extra }),
    invalid: addContact({ lookup: invalid(), ...extra }),
    unclassified: addContact({ lookup: fresh(''), ...extra }),
    failed: addContact({ lookup: { status: 'unknown', type: '', lastError: 'Lookup failed: Twilio down', lastAttemptAt: new Date() }, ...extra }),
    notChecked: addContact({ ...extra }),
    legacyNoLookup: addContact({ lookup: undefined, ...extra }),
  };
}

const idsOf = (res) => res.body.data.map((c) => String(c._id)).sort();
const ids = (...cs) => cs.map((c) => String(c._id)).sort();
const list = (qs, token = userToken) => api.get(`/api/contacts?${new URLSearchParams(qs)}`, { token });
const startAll = (body = {}, token = adminToken) => api.post('/api/contacts/lookup-all', { token, body });

// ===========================================================================
describe('Lookup All', () => {
  test('looks up every contact that needs it, through the existing service', async () => {
    const a = addContact();
    const b = addContact();
    const c = addContact();
    outcomes.set(a.phone, { type: 'mobile' });
    outcomes.set(b.phone, { type: 'landline' });
    outcomes.set(c.phone, 'invalid');

    const res = await startAll();
    assert.equal(res.status, 202, res.text);
    assert.equal(res.body.job.status, 'running');
    assert.equal(res.body.job.total, 3);
    await contactLookup.currentRun();

    assert.deepEqual(lookupCalls.sort(), [a.phone, b.phone, c.phone].sort());
    assert.deepEqual([a.lookup.status, a.lookup.type], ['valid', 'mobile']);
    assert.deepEqual([b.lookup.status, b.lookup.type], ['valid', 'landline']);
    assert.equal(c.lookup.status, 'invalid');
    assert.ok(a.lookup.lookedUpAt instanceof Date);

    const status = await api.get('/api/contacts/lookup-all/status', { token: userToken });
    assert.equal(status.body.job.status, 'done');
    assert.deepEqual([status.body.job.processed, status.body.job.lookedUp, status.body.job.failed], [3, 3, 0]);
    assert.deepEqual(status.body.job.results, { mobile: 1, landline: 1, invalid: 1 });
  });

  test('a fresh cached lookup is reused; only stale or unchecked numbers are looked up', async () => {
    const cached = addContact({ lookup: fresh('mobile') });
    const cachedInvalid = addContact({ lookup: invalid() });
    const stale = addContact({ lookup: fresh('landline', { lookedUpAt: new Date(Date.now() - 40 * DAY) }) });
    const unchecked = addContact();

    await startAll();
    await contactLookup.currentRun();
    assert.deepEqual(lookupCalls.sort(), [stale.phone, unchecked.phone].sort(), 'cache honoured');
    assert.equal(cached.lookup.type, 'mobile');
    assert.equal(cachedInvalid.lookup.status, 'invalid');
  });

  test('freshness is the send policy’s own rule', () => {
    const now = new Date();
    for (const days of [0, 29, 31, 400]) {
      const lookup = fresh('mobile', { lookedUpAt: new Date(now.getTime() - days * DAY) });
      const c = { phone: '+14155550000', lookup };
      const needs = require('../_support/docStore').matches(c, contactLookup.needsLookupCondition(30, now));
      assert.equal(needs, !sendPolicy.isLookupFresh(lookup, 30), `${days} days old`);
    }
  });

  test('only lookup.* is written — name, phone, email, tags and custom fields are untouched', async () => {
    const c = addContact();
    const before = { name: c.name, phone: c.phone, email: c.email, tags: [...c.tags], customFields: { ...c.customFields } };
    await startAll();
    await contactLookup.currentRun();
    for (const call of ContactModel.__callsTo('updateOne')) {
      for (const key of Object.keys(call.args[1].$set)) assert.ok(key.startsWith('lookup.'), `wrote ${key}`);
    }
    assert.deepEqual({ name: c.name, phone: c.phone, email: c.email, tags: c.tags, customFields: c.customFields }, before);
  });

  test('a lookup FAILURE is recorded as unknown — never as invalid', async () => {
    const down = addContact();
    const unparseable = addContact({ phone: '12' });
    const err = new Error('Lookup failed: Twilio Lookup API error');
    err.statusCode = 502;
    outcomes.set(down.phone, err);
    const bad = new Error('Invalid phone number');
    bad.statusCode = 400;
    outcomes.set(unparseable.phone, bad);

    await startAll();
    await contactLookup.currentRun();
    for (const c of [down, unparseable]) {
      assert.equal(c.lookup.status, 'unknown', 'status unchanged by a failure');
      assert.ok(c.lookup.lastError, 'the failure is recorded');
    }
    const job = contactLookup.getLookupAllStatus();
    assert.equal(job.failed, 2);
    const unknown = await list({ lookup: 'unknown' });
    assert.deepEqual(idsOf(unknown), ids(down, unparseable));
    assert.equal((await list({ lookup: 'invalid' })).body.data.length, 0);
  });

  test('a failure on a previously classified number keeps the old classification', async () => {
    const c = addContact({ lookup: fresh('mobile', { lookedUpAt: new Date(Date.now() - 60 * DAY) }) });
    outcomes.set(c.phone, Object.assign(new Error('Lookup failed: timeout'), { statusCode: 502 }));
    await startAll();
    await contactLookup.currentRun();
    assert.deepEqual([c.lookup.status, c.lookup.type], ['valid', 'mobile']);
    assert.match(c.lookup.lastError, /timeout/);
  });

  test('a rate limit is retried with back-off, then succeeds', async () => {
    const c = addContact();
    let n = 0;
    outcomes.set(c.phone, () => {
      n += 1;
      return n <= 2 ? Object.assign(new Error('Lookup failed: Too Many Requests'), { twilioCode: 20429 }) : { type: 'mobile' };
    });
    await contactLookup.startLookupAll({ scope: {}, backoffMs: 1 });
    await contactLookup.currentRun();
    assert.equal(n, 3);
    assert.equal(c.lookup.type, 'mobile');
  });

  test('a persistent rate limit stops the run early with a clear message, marking nothing invalid', async () => {
    for (let i = 0; i < 8; i += 1) addContact();
    outcomes = new Map(contacts.map((c) => [c.phone, Object.assign(new Error('429 Too Many Requests'), { twilioCode: 20429 })]));
    await contactLookup.startLookupAll({ scope: {}, backoffMs: 1 });
    await contactLookup.currentRun();
    const job = contactLookup.getLookupAllStatus();
    assert.equal(job.status, 'stopped');
    assert.match(job.message, /rate-limiting/);
    assert.ok(contacts.every((c) => c.lookup.status === 'unknown'));
  });

  test('no duplicate simultaneous run — a second start is refused while one is running', async () => {
    for (let i = 0; i < 5; i += 1) addContact();
    let release;
    lookupGate = new Promise((r) => { release = r; });
    try {
      const [x, y] = await Promise.all([startAll(), startAll()]);
      assert.deepEqual([x.status, y.status].sort(), [202, 409]);
      const again = await startAll();
      assert.equal(again.status, 409);
      assert.match(again.body.message, /already running/);
    } finally {
      // Never leave the run blocked: a failure here must not hang the suite.
      release();
      lookupGate = null;
    }
    await contactLookup.currentRun();
    assert.equal(lookupCalls.length, 5, 'each number looked up once');
    assert.equal(locks[0].expiresAt.getTime(), 0, 'the lock is released');
    assert.equal((await startAll()).status, 202, 'and a new run can start afterwards');
  });

  test('a run held by ANOTHER server instance is refused too', async () => {
    addContact();
    locks.push({ key: contactLookup.LOCK_KEY, owner: 'other-host', expiresAt: new Date(Date.now() + 60000) });
    const res = await startAll();
    assert.equal(res.status, 409);
    assert.equal(lookupCalls.length, 0);
  });

  test('scoped to one imported list when one is chosen', async () => {
    const imp = addImport();
    const inList = addContact({ import: imp._id });
    addContact();
    const res = await startAll({ import: String(imp._id) });
    assert.equal(res.body.job.scope, 'leads.csv');
    await contactLookup.currentRun();
    assert.deepEqual(lookupCalls, [inList.phone]);
  });

  test('is admin-only (Lookup is billable)', async () => {
    addContact();
    const res = await startAll({}, userToken);
    assert.equal(res.status, 403);
    assert.equal(lookupCalls.length, 0);
  });

  test('the send policy reads what Lookup All wrote — no second lookup at send time', async () => {
    const c = addContact();
    outcomes.set(c.phone, { type: 'mobile' });
    await startAll();
    await contactLookup.currentRun();
    const callsAfterRun = lookupCalls.length;
    settingsDoc = f.settings({ allowedLineTypes: ['mobile'], lookupMaxAgeDays: 30 });
    const decision = await sendPolicy.checkMobileOnly({ contact: { ...c, save: async () => {} } });
    assert.equal(decision.allowed, true);
    assert.equal(lookupCalls.length, callsAfterRun, 'the cached classification was used');
  });
});

// ===========================================================================
describe('the lookup-status filter', () => {
  test('every bucket selects exactly its contacts', async () => {
    const s = seedEveryState();
    const expect = {
      mobile: [s.mobile],
      landline: [s.landline],
      voip: [s.fixedVoip, s.nonFixedVoip, s.simVoip],
      tollFree: [s.tollFree],
      invalid: [s.invalid],
      unknown: [s.unclassified, s.failed],
      not_checked: [s.notChecked, s.legacyNoLookup],
    };
    for (const [key, members] of Object.entries(expect)) {
      const res = await list({ lookup: key, limit: '100' });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(idsOf(res), ids(...members), key);
    }
    assert.equal((await list({ limit: '100' })).body.data.length, 11, 'no filter = All');
  });

  test('the buckets cover every contact exactly once', async () => {
    seedEveryState();
    const res = await api.get('/api/contacts/lookup-summary', { token: userToken });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.total, 11);
    assert.deepEqual(res.body.counts, { mobile: 1, landline: 1, voip: 3, tollFree: 1, invalid: 1, unknown: 2, not_checked: 2 });
    assert.equal(Object.values(res.body.counts).reduce((a, b) => a + b, 0), res.body.total);
  });

  test('bucket spellings agree with the send policy’s line types', () => {
    const expected = { mobile: 'mobile', landline: 'landline', voip: ['fixedVoip', 'nonFixedVoip'], tollFree: 'tollFree' };
    for (const [bucket, spellings] of Object.entries(contactLookup.TYPE_SPELLINGS)) {
      for (const s of spellings) {
        const canon = sendPolicy.canonicalLineType(s);
        assert.ok([].concat(expected[bucket]).includes(canon), `${s} -> ${canon} is not ${bucket}`);
      }
    }
  });

  test('combines with search, tags, delivery state and pagination', async () => {
    for (let i = 0; i < 5; i += 1) addContact({ name: `Alpha ${i}`, lookup: fresh('mobile') });
    addContact({ name: 'Alpha blocked', lookup: fresh('mobile'), deliveryBlocked: true });
    addContact({ name: 'Alpha land', lookup: fresh('landline') });
    addContact({ name: 'Beta', lookup: fresh('mobile') });
    addContact({ name: 'Alpha untagged', lookup: fresh('mobile'), tags: [] });

    const page1 = await list({ lookup: 'mobile', search: 'alpha', tag: 'lead', deliveryBlocked: 'false', limit: '2', page: '1' });
    assert.equal(page1.body.pagination.total, 5);
    assert.equal(page1.body.pagination.pages, 3);
    const page3 = await list({ lookup: 'mobile', search: 'alpha', tag: 'lead', deliveryBlocked: 'false', limit: '2', page: '3' });
    assert.equal(page3.body.data.length, 1);

    const summary = await api.get('/api/contacts/lookup-summary?search=alpha&deliveryBlocked=false', { token: userToken });
    assert.deepEqual([summary.body.total, summary.body.counts.mobile, summary.body.counts.landline], [7, 6, 1]);
  });

  test('combines with an imported list’s batch views', async () => {
    const imp = addImport();
    const a = addContact({ import: imp._id, lookup: fresh('mobile') });
    addContact({ import: imp._id, lookup: invalid() });
    const c = addContact({ import: imp._id });
    const res = await list({ import: String(imp._id), batch: 'remaining', lookup: 'mobile' });
    assert.deepEqual(idsOf(res), ids(a));
    const nc = await list({ import: String(imp._id), batch: 'remaining', lookup: 'not_checked' });
    assert.deepEqual(idsOf(nc), ids(c));
    const inv = await list({ import: String(imp._id), batch: 'remaining', lookup: 'invalid' });
    assert.equal(inv.body.data.length, 0, 'invalid numbers are not in the remaining pool');
  });

  test('an unknown filter value is rejected', async () => {
    const res = await list({ lookup: 'valid' });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Allowed: mobile, landline, voip/);
  });

  test('the delivery-state filter is a separate concept and unchanged', async () => {
    const blockedButMobile = addContact({ lookup: fresh('mobile'), deliveryBlocked: true });
    addContact({ lookup: invalid(), deliveryBlocked: false });
    const res = await list({ deliveryBlocked: 'true' });
    assert.deepEqual(idsOf(res), ids(blockedButMobile));
  });
});

// ===========================================================================
describe('Delete Selected', () => {
  test('deletes exactly the chosen contacts and their enrollments — nothing else', async () => {
    const a = addContact();
    const b = addContact();
    const keep = addContact();
    enrollments.push({ _id: new mongoose.Types.ObjectId(), contact: a._id }, { _id: new mongoose.Types.ObjectId(), contact: keep._id });
    const res = await api.post('/api/contacts/bulk-delete', { token: adminToken, body: { ids: [String(a._id), String(b._id)] } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.deleted, 2);
    assert.equal(res.body.deletedEnrollments, 1);
    assert.deepEqual(contacts.map((c) => String(c._id)), [String(keep._id)]);
    assert.equal(enrollments.length, 1);
    assert.ok(same(enrollments[0].contact, keep._id));
  });

  test('Select All deletes only what matches the current filters, minus unticked', async () => {
    const s = seedEveryState();
    const extraInvalid = addContact({ lookup: invalid() });
    const unticked = addContact({ lookup: invalid() });
    const res = await api.post('/api/contacts/bulk-delete', {
      token: adminToken,
      body: { selectAll: true, filters: { lookup: 'invalid' }, excludeIds: [String(unticked._id)], expectedCount: 2 },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.deleted, 2);
    assert.ok(!contacts.some((c) => same(c._id, s.invalid._id) || same(c._id, extraInvalid._id)));
    assert.ok(contacts.some((c) => same(c._id, unticked._id)), 'the unticked one stays');
    assert.equal(contacts.length, 11, 'every other contact stays');
  });

  test('Select All refuses if the matching set changed since the operator confirmed', async () => {
    addContact({ lookup: invalid() });
    addContact({ lookup: invalid() });
    const res = await api.post('/api/contacts/bulk-delete', {
      token: adminToken,
      body: { selectAll: true, filters: { lookup: 'invalid' }, expectedCount: 1 },
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /2 now match, not 1. Nothing was deleted/);
    assert.equal(contacts.length, 2);
  });

  test('Select All requires the confirmed count', async () => {
    addContact();
    const res = await api.post('/api/contacts/bulk-delete', { token: adminToken, body: { selectAll: true, filters: {} } });
    assert.equal(res.status, 400);
    assert.equal(contacts.length, 1);
  });

  test('bad ids are refused and nothing is deleted', async () => {
    const a = addContact();
    for (const body of [{}, { ids: [] }, { ids: ['nope'] }, { ids: [String(a._id), { $ne: null }] }, { ids: Array.from({ length: 1001 }, () => String(new mongoose.Types.ObjectId())) }]) {
      const res = await api.post('/api/contacts/bulk-delete', { token: adminToken, body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(contacts.length, 1);
  });

  test('is admin-only', async () => {
    const a = addContact();
    const res = await api.post('/api/contacts/bulk-delete', { token: userToken, body: { ids: [String(a._id)] } });
    assert.equal(res.status, 403);
    assert.equal(contacts.length, 1);
  });
});

// ===========================================================================
describe('Delete all invalid', () => {
  test('deletes ONLY definitive invalid numbers — never unknown, unchecked, failed, landline or VoIP', async () => {
    const s = seedEveryState();
    const res = await api.post('/api/contacts/delete-invalid', { token: adminToken, body: { filters: {}, expectedCount: 1 } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.deleted, 1);
    assert.ok(!contacts.some((c) => same(c._id, s.invalid._id)));
    for (const key of ['failed', 'notChecked', 'legacyNoLookup', 'unclassified', 'landline', 'fixedVoip', 'nonFixedVoip', 'simVoip', 'tollFree', 'mobile']) {
      assert.ok(contacts.some((c) => same(c._id, s[key]._id)), `${key} must survive`);
    }
  });

  test('the invalid condition is forced: a client asking for "unknown" still deletes only invalid', async () => {
    const s = seedEveryState();
    const res = await api.post('/api/contacts/delete-invalid', {
      token: adminToken,
      body: { filters: { lookup: 'unknown' }, expectedCount: 1 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 1);
    assert.ok(contacts.some((c) => same(c._id, s.failed._id)), 'a failed lookup is never deleted as invalid');
    assert.ok(contacts.some((c) => same(c._id, s.unclassified._id)));
  });

  test('respects the other current filters (e.g. one imported list)', async () => {
    const imp = addImport();
    const mine = addContact({ import: imp._id, lookup: invalid() });
    const other = addContact({ lookup: invalid() });
    const res = await api.post('/api/contacts/delete-invalid', {
      token: adminToken,
      body: { filters: { import: String(imp._id) }, expectedCount: 1 },
    });
    assert.equal(res.body.deleted, 1);
    assert.ok(!contacts.some((c) => same(c._id, mine._id)));
    assert.ok(contacts.some((c) => same(c._id, other._id)), 'another list’s invalid contact is untouched');
  });

  test('refuses on a count mismatch, and is admin-only', async () => {
    addContact({ lookup: invalid() });
    const mismatch = await api.post('/api/contacts/delete-invalid', { token: adminToken, body: { filters: {}, expectedCount: 5 } });
    assert.equal(mismatch.status, 409);
    const forbidden = await api.post('/api/contacts/delete-invalid', { token: userToken, body: { filters: {}, expectedCount: 1 } });
    assert.equal(forbidden.status, 403);
    assert.equal(contacts.length, 1);
  });

  test('the cleaning flow: Lookup All → Invalid → delete → clean contacts remain', async () => {
    const good = [addContact(), addContact(), addContact()];
    const bad = [addContact(), addContact()];
    bad.forEach((c) => outcomes.set(c.phone, 'invalid'));
    await startAll();
    await contactLookup.currentRun();

    const summary = await api.get('/api/contacts/lookup-summary', { token: userToken });
    assert.equal(summary.body.counts.invalid, 2);
    const del = await api.post('/api/contacts/delete-invalid', {
      token: adminToken,
      body: { filters: { lookup: 'invalid' }, expectedCount: summary.body.counts.invalid },
    });
    assert.equal(del.body.deleted, 2);
    assert.deepEqual(contacts.map((c) => String(c._id)).sort(), ids(...good));
  });
});

// ===========================================================================
describe('imported lists and batch allocation stay consistent', () => {
  async function allocate(imp, body) {
    return api.post(`/api/contact-imports/${imp._id}/allocate`, { token: userToken, body });
  }
  const state = async (imp) => (await api.get(`/api/contact-imports/${imp._id}/allocation`, { token: userToken })).body.data;

  test('deleting invalid contacts: remaining pool and counts follow the real contacts', async () => {
    const imp = addImport();
    const members = [];
    for (let i = 0; i < 10; i += 1) members.push(addContact({ import: imp._id }));
    await allocate(imp, { mode: 'custom', count: 3 }); // rows 1-3 allocated
    // Lookup finds rows 2 (allocated), 5 and 8 (in the pool) invalid.
    for (const i of [1, 4, 7]) members[i].lookup = invalid();

    const del = await api.post('/api/contacts/delete-invalid', {
      token: adminToken,
      body: { filters: { import: String(imp._id) }, expectedCount: 3 },
    });
    assert.equal(del.status, 200, del.text);
    assert.equal(del.body.fromRemaining, 2);
    assert.equal(del.body.fromAllocated, 1);

    const s = await state(imp);
    assert.equal(s.remaining, 5, '10 - 3 allocated - 2 deleted from the pool');
    assert.equal(s.allocated, 3, 'allocation history is not rewritten');
    assert.equal(s.excluded, 0);
    assert.equal(s.total, 8);
    assert.deepEqual(s.batches.map((b) => b.size), [3], 'the batch record keeps its size');

    // The next batches never contain a deleted contact.
    const next = await allocate(imp, { mode: 'all' });
    assert.equal(next.body.batch.size, 5);
    const deletedIds = [1, 4, 7].map((i) => String(members[i]._id));
    const batchMembers = contacts.filter((c) => same(c.importBatch, next.body.batch._id)).map((c) => String(c._id));
    assert.equal(batchMembers.filter((id) => deletedIds.includes(id)).length, 0);
  });

  test('an invalid contact that is NOT deleted is excluded from every future batch', async () => {
    const imp = addImport();
    const members = [];
    for (let i = 0; i < 6; i += 1) members.push(addContact({ import: imp._id }));
    members[0].lookup = invalid();
    members[3].lookup = invalid();
    const failedLookup = members[4];
    failedLookup.lookup = { status: 'unknown', lastError: 'Lookup failed', lastAttemptAt: new Date() };

    const s0 = await state(imp);
    assert.deepEqual([s0.total, s0.remaining, s0.excluded], [6, 4, 2]);
    const all = await allocate(imp, { mode: 'all' });
    assert.equal(all.body.batch.size, 4);
    assert.equal(members[0].importBatch, null);
    assert.equal(members[3].importBatch, null);
    assert.ok(failedLookup.importBatch, 'a failed lookup is NOT treated as invalid');
    const again = await allocate(imp, { mode: 'all' });
    assert.equal(again.status, 409);
    assert.match(again.body.message, /2 invalid numbers are excluded/);
  });

  test('Lookup All finding new invalid numbers takes them out of the list’s pool', async () => {
    const imp = addImport();
    const members = [];
    for (let i = 0; i < 5; i += 1) members.push(addContact({ import: imp._id }));
    await state(imp); // initialise: 5 remaining
    outcomes.set(members[2].phone, 'invalid');
    await startAll({ import: String(imp._id) });
    await contactLookup.currentRun();
    const s = await state(imp);
    assert.deepEqual([s.total, s.remaining, s.excluded], [5, 4, 1]);
  });

  test('a single contact delete keeps the list’s counts consistent too', async () => {
    const imp = addImport();
    const a = addContact({ import: imp._id });
    addContact({ import: imp._id });
    await state(imp);
    const res = await api.delete(`/api/contacts/${a._id}`, { token: userToken });
    assert.equal(res.status, 200);
    const s = await state(imp);
    assert.deepEqual([s.total, s.remaining], [1, 1]);
  });

  test('an invalid number is never enrolled, but an unchecked one still is', async () => {
    const camp = { _id: new mongoose.Types.ObjectId(), name: 'C', steps: [{ _id: new mongoose.Types.ObjectId(), body: 'Hi', delayValue: 0, delayUnit: 'hours' }] };
    untouched['models/Campaign'].findById = async () => camp;
    const bad = addContact({ lookup: invalid() });
    const unchecked = addContact();
    const res = await api.post('/api/enrollments', {
      token: userToken,
      body: { campaignId: String(camp._id), contactIds: [String(bad._id), String(unchecked._id)] },
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.summary.enrolled, 1);
    assert.equal(res.body.summary.notEligible, 1);
    assert.ok(same(enrollments[0].contact, unchecked._id));
  });
});

// ===========================================================================
describe('existing data and behaviour are untouched', () => {
  test('bulk deletes never write campaigns, follow-ups, conversations, messages or AI data', async () => {
    seedEveryState();
    await api.post('/api/contacts/delete-invalid', { token: adminToken, body: { filters: {}, expectedCount: 1 } });
    const all = contacts.map((c) => String(c._id));
    await api.post('/api/contacts/bulk-delete', { token: adminToken, body: { ids: all.slice(0, 3) } });
    for (const [name, model] of Object.entries(untouched)) {
      const writes = model.__calls.filter((c) => !['find', 'findOne', 'findById', 'countDocuments', 'aggregate'].includes(c.method));
      assert.deepEqual(writes, [], `${name} must not be written`);
    }
    assert.equal(twilioSends.length, 0, 'no SMS sent');
  });

  test('the existing single delete still works, with its enrollment cascade', async () => {
    const a = addContact();
    enrollments.push({ _id: new mongoose.Types.ObjectId(), contact: a._id });
    const res = await api.delete(`/api/contacts/${a._id}`, { token: userToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.deletedEnrollments, 1);
    assert.equal(contacts.length, 0);
  });

  test('the mobile-only policy still blocks an invalid number on its own', async () => {
    settingsDoc = f.settings({ allowedLineTypes: ['mobile'], lookupMaxAgeDays: 30 });
    const c = addContact({ lookup: invalid() });
    const decision = await sendPolicy.checkMobileOnly({ contact: { ...c, save: async () => {} } });
    assert.equal(decision.allowed, false);
    assert.equal(decision.temporary, false);
    assert.equal(lookupCalls.length, 0);
  });

  test('without a lookup filter the contacts response is unchanged', async () => {
    addContact();
    const res = await list({});
    assert.deepEqual(Object.keys(res.body).sort(), ['data', 'pagination', 'success']);
  });
});
