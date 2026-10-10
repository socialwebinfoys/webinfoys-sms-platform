// A number Twilio Lookup DEFINITIVELY reported invalid is not available for
// enrollment or follow-ups, cannot be reactivated, and loses that status only
// when its phone number actually changes.
//
//   * Enrollment picker, Select All and hand-built requests — for a batch-bound
//     campaign and for a plain CSV campaign.
//   * PATCH /api/enrollments/:id — reactivation checks current eligibility.
//   * PUT /api/contacts/:id — a changed number resets the cached lookup.
//   * POST/PUT /api/followings — invalid contacts are never added.
//
// Only `lookup.status === 'invalid'` counts. Mobile, landline, VoIP, an
// unclassifiable number, a failed lookup and an unchecked number all stay
// available. Contacts, lists, campaigns, enrollments and follow-ups live in the
// docStore so the real filters select real documents; Twilio and Lookup are
// doubles — nothing is sent and nothing is looked up for real.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { stubModule, fakeModel, query } = require('../_support/stubs');
const { storeModel, same, matches } = require('../_support/docStore');
const f = require('../_support/factories');

stubModule('services/logService', { logEvent: async () => {} });
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

let contacts = [];
let imports = [];
let enrollments = [];
let campaigns = [];
let followings = [];
stubModule('models/Contact', storeModel('Contact', () => contacts, (r) => { contacts = r; }));
stubModule('models/Import', storeModel('Import', () => imports, (r) => { imports = r; }));
stubModule('models/Campaign', storeModel('Campaign', () => campaigns, (r) => { campaigns = r; }));
stubModule('models/Following', storeModel('Following', () => followings, (r) => { followings = r; }));
stubModule(
  'models/Enrollment',
  storeModel('Enrollment', () => enrollments, (r) => { enrollments = r; }, {
    insertMany: async (docs) => {
      const made = docs.map((d) => ({ ...d, _id: new mongoose.Types.ObjectId() }));
      enrollments.push(...made);
      return made;
    },
  })
);

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
const ConversationModel = stubModule('models/Conversation', fakeModel('Conversation'));
stubModule('models/WorkerLock', fakeModel('WorkerLock', { acquire: async () => true, release: async () => true }));
for (const m of ['models/SMSMessage', 'models/AIReplyJob', 'models/SystemLog', 'models/Template', 'models/ImportPreview']) {
  stubModule(m, fakeModel(m));
}

// Twilio and Lookup doubles. A send is a test failure; Lookup answers "mobile".
const twilioSends = [];
let lookupCalls = [];
let lookupAnswer;
stubModule('services/twilioService', {
  sendSms: async (a) => { twilioSends.push(a); throw new Error('no SMS may be sent by these tests'); },
  getClient: () => null,
  isConfigured: () => true,
  status: () => ({ configured: true, simulate: true }),
  PERMANENT_CODES: new Set([21610]),
});
stubModule('services/lookupService', {
  lookupNumber: async (phone) => {
    lookupCalls.push(phone);
    return lookupAnswer(phone);
  },
  parseLineType: () => ({}),
});

const sendPolicy = require('../../services/sendPolicy');
const contactLookup = require('../../services/contactLookup');
const { startApp, tokenFor } = require('../_support/http');

let api;
let token;
let adminToken;
before(async () => {
  api = await startApp();
  token = tokenFor(operator);
  adminToken = tokenFor(administrator);
});
after(async () => {
  await api.close();
});

const DAY = 24 * 60 * 60 * 1000;
const LOOKED_UP = new Date(Date.now() - DAY);
// One contact per lookup state. Only `invalid` is a definitive invalid result.
const STATES = {
  mobile: { status: 'valid', type: 'mobile', carrier: 'X', canonicalPhone: '', lookedUpAt: LOOKED_UP, lastError: '' },
  landline: { status: 'valid', type: 'landline', carrier: 'X', canonicalPhone: '', lookedUpAt: LOOKED_UP, lastError: '' },
  voip: { status: 'valid', type: 'nonFixedVoip', carrier: 'X', canonicalPhone: '', lookedUpAt: LOOKED_UP, lastError: '' },
  unknownType: { status: 'valid', type: '', carrier: '', canonicalPhone: '', lookedUpAt: LOOKED_UP, lastError: '' },
  failed: { status: 'unknown', type: '', lastError: 'Lookup failed: timeout', lastAttemptAt: LOOKED_UP },
  notChecked: { status: 'unknown', type: '', lastError: '' },
  invalid: { status: 'invalid', type: '', carrier: '', canonicalPhone: '', lookedUpAt: LOOKED_UP, lastError: '' },
};
const ELIGIBLE = ['failed', 'landline', 'mobile', 'notChecked', 'unknownType', 'voip'];

let seq = 0;
let list;
let batch;
let byState;
// A list of 14 contacts: 7 allocated to Batch 1 (one per state) and 7 still in
// the pool (one per state).
function seed() {
  contacts = [];
  imports = [];
  enrollments = [];
  campaigns = [];
  followings = [];
  lookupCalls = [];
  twilioSends.length = 0;
  ConversationModel.__reset();
  contactLookup.resetForTests();
  settingsDoc = f.settings({ lookupMaxAgeDays: 30 });
  lookupAnswer = async (phone) => ({ valid: true, phone, type: 'mobile', carrier: 'Test', lookedUpAt: new Date() });

  const batchId = new mongoose.Types.ObjectId();
  list = {
    _id: new mongoose.Types.ObjectId(),
    filename: 'leads.csv',
    allocation: {
      initializedAt: new Date(), total: 14, allocated: 7, remaining: 7, excluded: 0, lockedUntil: null, lockOwner: null,
      batches: [{ _id: batchId, mode: 'custom', requested: 7, size: 7, from: 1, to: 7, status: 'complete' }],
    },
  };
  imports.push(list);
  batch = list.allocation.batches[0];
  byState = { inBatch: {}, outside: {} };
  for (const where of ['inBatch', 'outside']) {
    for (const [state, lookup] of Object.entries(STATES)) {
      seq += 1;
      const c = {
        _id: new mongoose.Types.ObjectId(),
        name: `${state} ${where}`,
        phone: `+1512234${String(5000 + seq)}`,
        email: `c${seq}@example.com`,
        tags: ['lead'],
        customFields: { city: 'Austin' },
        timezone: 'America/Chicago',
        import: list._id,
        importBatch: where === 'inBatch' ? batchId : null,
        optedOut: false,
        isActive: true,
        deliveryBlocked: false,
        lookup: { ...lookup },
      };
      contacts.push(c);
      byState[where][state] = c;
    }
  }
}
beforeEach(seed);

const steps = () => [{ _id: new mongoose.Types.ObjectId(), body: 'Hi', delayValue: 0, delayUnit: 'hours' }];
function campaign(extra) {
  const c = { _id: new mongoose.Types.ObjectId(), name: 'C', isActive: true, steps: steps(), import: list._id, batch: null, ...extra };
  campaigns.push(c);
  return c;
}
const stored = (c) => contacts.find((x) => same(x._id, c._id));
const names = (res) => res.body.data.map((c) => c.name).sort();
const enrolledNames = () => enrollments.map((e) => contacts.find((c) => same(c._id, e.contact)).name).sort();
const id = (c) => String(c._id);
const picker = (camp, qs = 'limit=100') => api.get(`/api/campaigns/${camp._id}/eligible-contacts?${qs}`, { token });
const enroll = (body) => api.post('/api/enrollments', { token, body });
// The list with no batches at all: a plain CSV-based campaign.
function csvOnly() {
  list.allocation.batches = [];
  contacts.forEach((c) => { c.importBatch = null; });
}

// ===========================================================================
describe('Enrollment — a BATCH-bound campaign', () => {
  test('the picker lists every lookup state except invalid', async () => {
    const res = await picker(campaign({ batch: batch._id }));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(names(res), ELIGIBLE.map((s) => `${s} inBatch`).sort());
  });

  test('the "Select all (N)" count excludes the invalid contact', async () => {
    const res = await picker(campaign({ batch: batch._id }));
    assert.equal(res.body.pagination.total, 6, '7 batch members, 1 invalid');
  });

  test('searching the picker cannot surface the invalid contact', async () => {
    const res = await picker(campaign({ batch: batch._id }), 'search=invalid');
    assert.equal(res.body.data.length, 0);
    assert.equal(res.body.pagination.total, 0);
  });

  test('Select All enrolls the six eligible members and not the invalid one', async () => {
    const camp = campaign({ batch: batch._id });
    const res = await enroll({ campaignId: id(camp), selectAll: true });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.summary.enrolled, 6);
    assert.deepEqual(enrolledNames(), ELIGIBLE.map((s) => `${s} inBatch`).sort());
  });

  test('a hand-built request naming the invalid contact enrolls nothing and says why', async () => {
    const camp = campaign({ batch: batch._id });
    const res = await enroll({ campaignId: id(camp), contactIds: [id(byState.inBatch.invalid)] });
    assert.equal(res.status, 201, 'the existing contract: skipped and reported, not an HTTP error');
    assert.equal(res.body.summary.enrolled, 0);
    assert.equal(res.body.summary.notEligible, 1);
    assert.deepEqual(res.body.summary.errors, [
      { contactId: id(byState.inBatch.invalid), reason: 'Number is invalid (Twilio Lookup)' },
    ]);
    assert.equal(enrollments.length, 0);
  });

  test('a single contactId for the invalid contact is refused the same way', async () => {
    const camp = campaign({ batch: batch._id });
    const res = await enroll({ campaignId: id(camp), contactId: id(byState.inBatch.invalid) });
    assert.equal(res.body.summary.notEligible, 1);
    assert.equal(enrollments.length, 0);
  });

  test('a MIXED request still enrolls the valid contacts', async () => {
    const camp = campaign({ batch: batch._id });
    const wanted = ['invalid', 'mobile', 'landline', 'notChecked'].map((s) => id(byState.inBatch[s]));
    const res = await enroll({ campaignId: id(camp), contactIds: wanted });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.summary.total, 4);
    assert.equal(res.body.summary.enrolled, 3);
    assert.equal(res.body.summary.notEligible, 1);
    assert.deepEqual(enrolledNames(), ['landline inBatch', 'mobile inBatch', 'notChecked inBatch']);
  });

  for (const state of ELIGIBLE) {
    test(`a ${state} contact is enrollable — it is not "invalid"`, async () => {
      const camp = campaign({ batch: batch._id });
      const res = await enroll({ campaignId: id(camp), contactIds: [id(byState.inBatch[state])] });
      assert.equal(res.body.summary.enrolled, 1, res.text);
      assert.equal(res.body.summary.notEligible, 0);
    });
  }

  test('the batch boundary is unchanged: one outsider still rejects the whole request', async () => {
    const camp = campaign({ batch: batch._id });
    const res = await enroll({
      campaignId: id(camp),
      contactIds: [id(byState.inBatch.mobile), id(byState.outside.mobile)],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'outside_batch');
    assert.equal(enrollments.length, 0);
  });

  test('a batch chosen at enrollment time (campaign on the whole list) excludes invalid too', async () => {
    const camp = campaign();
    const needsBatch = await enroll({ campaignId: id(camp), selectAll: true });
    assert.equal(needsBatch.status, 400);
    assert.equal(needsBatch.body.code, 'batch_required', 'unchanged');

    const res = await enroll({ campaignId: id(camp), batchId: id(batch), selectAll: true });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(enrolledNames(), ELIGIBLE.map((s) => `${s} inBatch`).sort());
  });

  test('Lookup marking a member invalid AFTER the page loaded: the stale selection is not enrolled', async () => {
    const camp = campaign({ batch: batch._id });
    const shown = await picker(camp);
    const mobile = shown.body.data.find((c) => c.name === 'mobile inBatch');
    stored(mobile).lookup = { ...STATES.invalid };
    const res = await enroll({ campaignId: id(camp), contactIds: [String(mobile._id)] });
    assert.equal(res.body.summary.enrolled, 0);
    assert.equal(res.body.summary.notEligible, 1);
  });
});

// ===========================================================================
describe('Enrollment — a CSV-based campaign (a list with no batches)', () => {
  beforeEach(csvOnly);

  test('the picker and its count exclude both invalid contacts', async () => {
    const res = await picker(campaign());
    assert.equal(res.body.pagination.total, 12, '14 contacts, 2 invalid');
    assert.equal(names(res).some((n) => n.startsWith('invalid')), false);
    assert.equal(names(res).length, 12);
  });

  test('Select All enrolls the 12 eligible contacts and neither invalid one', async () => {
    const res = await enroll({ campaignId: id(campaign()), selectAll: true });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.summary.enrolled, 12);
    assert.equal(enrolledNames().some((n) => n.startsWith('invalid')), false);
  });

  test('Select All with exclusions still never adds an invalid contact', async () => {
    const res = await enroll({
      campaignId: id(campaign()),
      selectAll: true,
      excludeContactIds: [id(byState.inBatch.mobile)],
    });
    assert.equal(res.body.summary.enrolled, 11);
    assert.equal(enrolledNames().some((n) => n.startsWith('invalid')), false);
  });

  test('hand-built ids: invalid skipped and reported, valid ones in the same request enrolled', async () => {
    const res = await enroll({
      campaignId: id(campaign()),
      contactIds: [id(byState.outside.invalid), id(byState.inBatch.invalid), id(byState.outside.voip), id(byState.inBatch.failed)],
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.summary.enrolled, 2);
    assert.equal(res.body.summary.notEligible, 2);
    assert.deepEqual(enrolledNames(), ['failed inBatch', 'voip outside']);
  });

  test('a legacy campaign with no contact list at all excludes invalid as well', async () => {
    const camp = campaign({ import: null });
    const res = await enroll({ campaignId: id(camp), selectAll: true });
    assert.equal(res.body.summary.enrolled, 12);
    const manual = await enroll({ campaignId: id(campaign({ import: null })), contactIds: [id(byState.outside.invalid)] });
    assert.equal(manual.body.summary.notEligible, 1);
  });

  test('none of this sends a message or spends a Lookup', async () => {
    const camp = campaign();
    await picker(camp);
    await enroll({ campaignId: id(camp), selectAll: true });
    assert.equal(twilioSends.length, 0);
    assert.deepEqual(lookupCalls, []);
  });
});

// ===========================================================================
describe('Enrollment reactivation — PATCH /api/enrollments/:id', () => {
  const NEXT = new Date('2026-01-01T00:00:00Z');
  function enrollment(contact, status, extra = {}) {
    const e = {
      _id: new mongoose.Types.ObjectId(),
      contact: contact._id,
      campaign: new mongoose.Types.ObjectId(),
      status,
      nextRunAt: NEXT,
      stopReason: status === 'cancelled' ? 'invalid_number' : '',
      lastError: '',
      sentSteps: [{ stepIndex: 0, twilioSid: 'SMearlier' }],
      ...extra,
    };
    enrollments.push(e);
    return e;
  }
  const patch = (e, status, t = token) => api.patch(`/api/enrollments/${e._id}`, { token: t, body: { status } });
  const row = (e) => enrollments.find((x) => same(x._id, e._id));

  for (const from of ['cancelled', 'paused']) {
    test(`a ${from} enrollment of an INVALID contact is not reactivated`, async () => {
      const e = enrollment(byState.inBatch.invalid, from);
      const res = await patch(e, 'active');

      assert.equal(res.status, 409, res.text);
      assert.equal(res.body.success, false);
      assert.equal(res.body.code, 'invalid_number');
      assert.match(res.body.message, /cannot be reactivated/);
      assert.match(res.body.message, /invalid/i);
      // The enrollment is preserved exactly.
      assert.equal(row(e).status, from);
      assert.equal(new Date(row(e).nextRunAt).getTime(), NEXT.getTime());
      assert.equal(row(e).sentSteps.length, 1);
      assert.equal(res.body.data.status, from, 'the response shows the unchanged enrollment');
    });
  }

  test('the same holds with the line-type filter off and with every type allowed', async () => {
    for (const s of [f.settings({ mobileOnly: false }), f.settings({ allowedLineTypes: [...RealSettings.LINE_TYPES] })]) {
      settingsDoc = s;
      const e = enrollment(byState.inBatch.invalid, 'cancelled');
      assert.equal((await patch(e, 'active')).status, 409);
      assert.equal(row(e).status, 'cancelled');
    }
  });

  test('a paused enrollment of a valid contact resumes as before, due now', async () => {
    const e = enrollment(byState.inBatch.mobile, 'paused');
    const before = Date.now();
    const res = await patch(e, 'active');
    assert.equal(res.status, 200, res.text);
    assert.equal(row(e).status, 'active');
    assert.ok(new Date(row(e).nextRunAt).getTime() >= before, 'resuming makes the next step due now');
  });

  for (const state of ['landline', 'voip', 'unknownType', 'failed', 'notChecked']) {
    test(`a cancelled enrollment of a ${state} contact CAN be reactivated — it is not "invalid"`, async () => {
      const e = enrollment(byState.inBatch[state], 'cancelled');
      const res = await patch(e, 'active');
      assert.equal(res.status, 200, res.text);
      assert.equal(row(e).status, 'active');
    });
  }

  test('reactivation works again once Lookup no longer reports the number invalid', async () => {
    const e = enrollment(byState.inBatch.invalid, 'cancelled');
    assert.equal((await patch(e, 'active')).status, 409);
    stored(byState.inBatch.invalid).lookup = { ...STATES.mobile };
    assert.equal((await patch(e, 'active')).status, 200);
    assert.equal(row(e).status, 'active');
  });

  test('the other reasons a contact cannot be messaged block reactivation too, each named', async () => {
    const cases = [
      [{ optedOut: true }, 'opted_out', /opted out/],
      [{ isActive: false }, 'inactive', /inactive/],
      [{ deliveryBlocked: true }, 'delivery_blocked', /failing to be delivered/],
    ];
    for (const [change, code, text] of cases) {
      const contact = byState.outside.mobile;
      Object.assign(stored(contact), { optedOut: false, isActive: true, deliveryBlocked: false }, change);
      const e = enrollment(contact, 'paused');
      const res = await patch(e, 'active');
      assert.equal(res.status, 409);
      assert.equal(res.body.code, code);
      assert.match(res.body.message, text);
      assert.equal(row(e).status, 'paused');
    }
  });

  test('an enrollment whose contact was deleted is not reactivated', async () => {
    const e = enrollment({ _id: new mongoose.Types.ObjectId() }, 'paused');
    const res = await patch(e, 'active');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'no_contact');
    assert.equal(row(e).status, 'paused');
  });

  test('pausing and cancelling an invalid contact’s enrollment is still allowed', async () => {
    const active = enrollment(byState.inBatch.invalid, 'active');
    assert.equal((await patch(active, 'paused')).status, 200);
    assert.equal(row(active).status, 'paused');
    assert.equal((await patch(active, 'cancelled')).status, 200);
    assert.equal(row(active).status, 'cancelled');
  });

  test('existing rules are unchanged: completed/failed rows, bad statuses, missing rows, auth', async () => {
    const done = enrollment(byState.inBatch.mobile, 'completed');
    assert.equal((await patch(done, 'active')).status, 400);
    const failed = enrollment(byState.inBatch.mobile, 'failed');
    assert.equal((await patch(failed, 'active')).status, 400);
    assert.equal((await patch(done, 'bogus')).status, 400);
    assert.equal((await patch({ _id: new mongoose.Types.ObjectId() }, 'active')).status, 404);
    assert.equal((await api.patch(`/api/enrollments/${done._id}`, { body: { status: 'active' } })).status, 401);
  });

  test('reactivating never sends and never spends a Lookup', async () => {
    await patch(enrollment(byState.inBatch.invalid, 'cancelled'), 'active');
    await patch(enrollment(byState.inBatch.notChecked, 'cancelled'), 'active');
    assert.equal(twilioSends.length, 0);
    assert.deepEqual(lookupCalls, []);
  });
});

// ===========================================================================
describe('Changing a contact’s phone number resets its lookup — PUT /api/contacts/:id', () => {
  const put = (c, body) => api.put(`/api/contacts/${c._id}`, { token, body });
  const NEW_NUMBER = '+15122349999';

  test('an INVALID contact given a new number is no longer invalid', async () => {
    const c = byState.inBatch.invalid;
    const res = await put(c, { phone: NEW_NUMBER });
    assert.equal(res.status, 200, res.text);
    const now = stored(c);
    assert.equal(now.phone, NEW_NUMBER);
    assert.equal(now.lookup.status, 'unknown');
    assert.equal(now.lookup.type, '');
    assert.equal(now.lookup.carrier, '');
    assert.equal(now.lookup.canonicalPhone, '');
    assert.equal(now.lookup.lookedUpAt, undefined, 'the old number’s lookup time is gone');
    assert.equal(now.lookup.lastError, '');
    assert.equal(res.body.data.lookup.status, 'unknown');
    assert.equal(sendPolicy.isLookupInvalid(now), false);
    assert.equal((await sendPolicy.checkCanSend({ contact: now })).allowed, true);
  });

  test('a VALID MOBILE result is not carried over to the new number', async () => {
    const c = byState.inBatch.mobile;
    await put(c, { phone: NEW_NUMBER });
    assert.deepEqual(
      { status: stored(c).lookup.status, type: stored(c).lookup.type },
      { status: 'unknown', type: '' },
      'the new number has not been classified'
    );
  });

  test('a failed-lookup note about the old number is cleared as well', async () => {
    const c = byState.inBatch.failed;
    await put(c, { phone: NEW_NUMBER });
    assert.equal(stored(c).lookup.lastError, '');
    assert.equal(stored(c).lookup.lastAttemptAt, undefined);
  });

  test('name, email, tags, custom fields, timezone, list and batch are untouched', async () => {
    const c = byState.inBatch.invalid;
    const before = { ...stored(c) };
    await put(c, { phone: NEW_NUMBER });
    const now = stored(c);
    for (const key of ['name', 'email', 'timezone', 'optedOut', 'isActive', 'deliveryBlocked']) {
      assert.equal(now[key], before[key], key);
    }
    assert.deepEqual(now.tags, ['lead']);
    assert.deepEqual(now.customFields, { city: 'Austin' });
    assert.ok(same(now.import, before.import));
    assert.ok(same(now.importBatch, before.importBatch));
  });

  for (const sameNumber of ['(512) 234-0001', '512-234-0001', '+1 512 234 0001', '15122340001', '+15122340001']) {
    test(`the SAME number written as "${sameNumber}" keeps the cached lookup`, async () => {
      const c = byState.inBatch.mobile;
      stored(c).phone = '+15122340001';
      const res = await put(c, { phone: sameNumber });
      assert.equal(res.status, 200, res.text);
      assert.equal(stored(c).phone, '+15122340001');
      assert.deepEqual(stored(c).lookup, STATES.mobile, 'nothing about the lookup changed');
    });
  }

  test('the same number does not un-block an invalid contact either', async () => {
    const c = byState.inBatch.invalid;
    await put(c, { phone: c.phone });
    assert.equal(stored(c).lookup.status, 'invalid');
  });

  test('an edit that does not include the phone keeps the lookup', async () => {
    const c = byState.inBatch.landline;
    const res = await put(c, { name: 'Renamed', tags: ['vip'] });
    assert.equal(res.status, 200, res.text);
    assert.equal(stored(c).name, 'Renamed');
    assert.deepEqual(stored(c).lookup, STATES.landline);
  });

  test('a rejected change (number already used, or unparseable) resets nothing', async () => {
    const c = byState.inBatch.invalid;
    const clash = await put(c, { phone: byState.inBatch.mobile.phone });
    assert.equal(clash.status, 409);
    const bad = await put(c, { phone: 'not a number' });
    assert.equal(bad.status, 400);
    assert.equal(stored(c).phone, c.phone);
    assert.equal(stored(c).lookup.status, 'invalid');
  });

  test('the Inbox copy of the phone is still synced', async () => {
    await put(byState.inBatch.mobile, { phone: NEW_NUMBER });
    const sync = ConversationModel.__callsTo('updateOne')[0];
    assert.ok(sync, 'Conversation.updateOne was called');
    assert.equal(sync.args[1].$set.contactPhone, NEW_NUMBER);
  });

  test('the new number is looked up again: Lookup All picks the contact up', async () => {
    const c = byState.inBatch.mobile;
    assert.equal(matches(stored(c), contactLookup.needsLookupCondition(30)), false, 'fresh before the change');
    await put(c, { phone: NEW_NUMBER });
    assert.equal(matches(stored(c), contactLookup.needsLookupCondition(30)), true, 'needs a lookup after it');

    lookupAnswer = async (phone) => ({ valid: true, phone, type: 'landline', carrier: 'New', lookedUpAt: new Date() });
    const res = await api.post('/api/contacts/lookup-all', {
      token: adminToken,
      body: { import: id(list), batch: id(batch) },
    });
    assert.equal(res.status, 202, res.text);
    await contactLookup.currentRun();
    assert.ok(lookupCalls.includes(NEW_NUMBER), 'the NEW number was looked up');
    assert.equal(lookupCalls.includes(c.phone), false, 'the old number was not');
    assert.equal(stored(c).lookup.type, 'landline', 'and the new result is what is stored');
  });

  test('the new number is looked up again at send time when the line-type filter is on', async () => {
    settingsDoc = f.settings({ allowedLineTypes: ['mobile'] });
    const c = byState.inBatch.mobile;
    await put(c, { phone: NEW_NUMBER });
    lookupAnswer = async (phone) => ({ valid: true, phone, type: 'landline', carrier: 'New', lookedUpAt: new Date() });
    const decision = await sendPolicy.checkMobileOnly({ contact: { ...stored(c), save: async () => {} } });
    assert.deepEqual(lookupCalls, [NEW_NUMBER]);
    assert.equal(decision.allowed, false, 'the old "mobile" result did not let the new landline through');
  });

  test('a corrected number makes the contact enrollable and reactivatable again', async () => {
    const c = byState.inBatch.invalid;
    const camp = campaign({ batch: batch._id });
    const cancelled = { _id: new mongoose.Types.ObjectId(), contact: c._id, campaign: new mongoose.Types.ObjectId(), status: 'cancelled' };
    enrollments.push(cancelled);

    await put(c, { phone: NEW_NUMBER });

    assert.ok(names(await picker(camp)).includes('invalid inBatch'), 'back in the picker');
    const res = await api.patch(`/api/enrollments/${cancelled._id}`, { token, body: { status: 'active' } });
    assert.equal(res.status, 200, res.text);
  });

  test('changing a phone never sends and never spends a Lookup by itself', async () => {
    await put(byState.inBatch.invalid, { phone: NEW_NUMBER });
    assert.equal(twilioSends.length, 0);
    assert.deepEqual(lookupCalls, []);
  });
});

// ===========================================================================
describe('Follow-ups — invalid contacts are never added', () => {
  const create = (body) => api.post('/api/followings', { token, body: { name: 'F', importId: id(list), body: 'Hello', ...body } });
  const savedIds = () => followings[0].contactIds.map(String).sort();
  const idsOf = (states, where = 'inBatch') => states.map((s) => id(byState[where][s])).sort();

  test('Select All takes every contact of the list except the invalid ones', async () => {
    const res = await create({ selectAll: true });
    assert.equal(res.status, 201, res.text);
    assert.equal(followings.length, 1);
    assert.deepEqual(savedIds(), [...idsOf(ELIGIBLE), ...idsOf(ELIGIBLE, 'outside')].sort());
    assert.equal(followings[0].status, 'draft', 'still never auto-sent on create');
  });

  test('an explicit selection drops the invalid contact, keeps the rest and reports the count', async () => {
    const res = await create({ contactIds: idsOf(['invalid', 'mobile', 'landline', 'failed', 'notChecked']) });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.notEligible, 1);
    assert.deepEqual(savedIds(), idsOf(['mobile', 'landline', 'failed', 'notChecked']));
  });

  test('a selection of ONLY invalid contacts is refused, and nothing is created', async () => {
    const res = await create({ contactIds: [id(byState.inBatch.invalid), id(byState.outside.invalid)] });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /invalid number/);
    assert.equal(followings.length, 0);
  });

  test('editing the selection cannot add an invalid contact, and sent history is kept', async () => {
    const sent = byState.inBatch.mobile;
    followings.push({
      _id: new mongoose.Types.ObjectId(),
      name: 'Existing',
      import: list._id,
      contactIds: [sent._id],
      delayValue: 0,
      delayUnit: 'hours',
      body: 'Hello',
      status: 'paused',
      stopOnReply: true,
      recipients: [{ contact: sent._id, status: 'sent', twilioSid: 'SMearlier', attempts: 0, lastError: '' }],
    });
    const res = await api.put(`/api/followings/${followings[0]._id}`, {
      token,
      body: { contactIds: [id(sent), id(byState.inBatch.invalid), id(byState.inBatch.voip)] },
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(savedIds(), idsOf(['mobile', 'voip']));
    const recipients = followings[0].recipients;
    assert.deepEqual(recipients.map((r) => String(r.contact)).sort(), idsOf(['mobile', 'voip']));
    const history = recipients.find((r) => same(r.contact, sent._id));
    assert.equal(history.status, 'sent');
    assert.equal(history.twilioSid, 'SMearlier');
    assert.equal(recipients.find((r) => same(r.contact, byState.inBatch.voip._id)).status, 'pending');
  });

  test('opted-out, inactive and delivery-blocked contacts are still excluded as before', async () => {
    stored(byState.inBatch.mobile).optedOut = true;
    stored(byState.inBatch.landline).isActive = false;
    stored(byState.inBatch.voip).deliveryBlocked = true;
    const res = await create({ contactIds: idsOf(['mobile', 'landline', 'voip', 'invalid', 'notChecked']) });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.notEligible, 4);
    assert.deepEqual(savedIds(), idsOf(['notChecked']));
  });

  test('creating a follow-up never sends and never spends a Lookup', async () => {
    await create({ selectAll: true });
    assert.equal(twilioSends.length, 0);
    assert.deepEqual(lookupCalls, []);
  });
});
