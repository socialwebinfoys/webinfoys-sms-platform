// Batches as the real unit of work.
//
// A list of 30 contacts is split into Batch 1 (10) and Batch 2 (15), leaving 5
// in the remaining pool — through the REAL allocation API. Every test then
// checks that Lookup All, the lookup filter, campaigns, enrollment, Select All
// and batch deletion act on exactly the chosen batch's persisted members, and
// that the backend refuses anything outside it.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { stubModule, fakeModel, query, resolveAppModule } = require('../_support/stubs');
const { storeModel, same, tick } = require('../_support/docStore');
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

// --- stores -------------------------------------------------------------------
let contacts = [];
let imports = [];
let enrollments = [];
let campaigns = [];
let locks = [];
stubModule('models/Contact', storeModel('Contact', () => contacts, (r) => { contacts = r; }));
stubModule('models/Import', storeModel('Import', () => imports, (r) => { imports = r; }));
stubModule('models/Campaign', storeModel('Campaign', () => campaigns, (r) => { campaigns = r; }));
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
const RealWorkerLock = (() => {
  const id = resolveAppModule('models/WorkerLock');
  delete require.cache[id];
  return require(id);
})();
RealWorkerLock.findOneAndUpdate = async (filter, update) => {
  await tick();
  const existing = locks.find((l) => l.key === filter.key);
  const free = !existing || new Date(existing.expiresAt).getTime() <= Date.now() || existing.owner === update.$set.owner;
  if (!free) throw Object.assign(new Error('E11000'), { code: 11000 });
  if (existing) Object.assign(existing, update.$set);
  else locks.push({ ...update.$set });
  return { ...update.$set };
};
RealWorkerLock.updateOne = async (filter, update) => {
  const l = locks.find((x) => x.key === filter.key && x.owner === filter.owner);
  if (l) Object.assign(l, update.$set);
  return { modifiedCount: l ? 1 : 0 };
};

const RealSettings = require('../../models/Settings');
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    getSingleton: async () => f.settings({ lookupMaxAgeDays: 30 }),
    resolveAllowedLineTypes: RealSettings.resolveAllowedLineTypes,
    LINE_TYPES: RealSettings.LINE_TYPES,
    INBOX_REFRESH_OPTIONS: RealSettings.INBOX_REFRESH_OPTIONS,
  })
);
const untouched = {};
for (const m of ['models/Following', 'models/Conversation', 'models/SMSMessage', 'models/AIReplyJob']) {
  untouched[m] = stubModule(m, fakeModel(m));
}
for (const m of ['models/SystemLog', 'models/Template', 'models/ImportPreview']) stubModule(m, fakeModel(m));

let outcomes = new Map();
let lookupCalls = [];
stubModule('services/twilioService', {
  sendSms: async () => { throw new Error('no SMS in tests'); },
  getClient: () => null,
  isConfigured: () => true,
  status: () => ({ configured: true, simulate: true }),
  PERMANENT_CODES: new Set([21610]),
});
stubModule('services/lookupService', {
  lookupNumber: async (phone) => {
    lookupCalls.push(phone);
    const o = outcomes.get(phone) || { type: 'mobile' };
    if (o instanceof Error) throw o;
    if (o === 'invalid') return { valid: false, phone, type: '', carrier: '', lookedUpAt: new Date() };
    return { valid: true, phone, type: o.type, carrier: 'T', lookedUpAt: new Date() };
  },
  parseLineType: () => ({}),
});

const contactLookup = require('../../services/contactLookup');
const { enrollContactIds } = require('../../controllers/enrollmentController');
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

// --- the scenario: 30 contacts -> Batch 1 (10), Batch 2 (15), Remaining (5) ----
let list;
let b1;
let b2;
let seq = 0;
function addList(n, filename) {
  const imp = {
    _id: new mongoose.Types.ObjectId(),
    filename,
    allocation: { initializedAt: null, total: 0, allocated: 0, remaining: 0, excluded: 0, lockedUntil: null, lockOwner: null, batches: [] },
  };
  imports.push(imp);
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    contacts.push({
      _id: new mongoose.Types.ObjectId(),
      name: `Dentist ${seq}`,
      phone: `+1512555${String(seq).padStart(4, '0')}`,
      import: imp._id,
      importBatch: null,
      optedOut: false,
      isActive: true,
      deliveryBlocked: false,
      tags: [],
      lookup: { status: 'unknown', type: '', lastError: '' },
    });
  }
  return imp;
}
const allocate = (imp, body) => api.post(`/api/contact-imports/${imp._id}/allocate`, { token: userToken, body });
const members = (batch) => contacts.filter((c) => same(c.importBatch, batch._id));
const remainingPool = (imp) => contacts.filter((c) => same(c.import, imp._id) && !c.importBatch);
const ids = (cs) => cs.map((c) => String(c._id)).sort();

beforeEach(async () => {
  await contactLookup.currentRun();
  contactLookup.resetForTests();
  contacts = [];
  imports = [];
  enrollments = [];
  campaigns = [];
  locks = [];
  outcomes = new Map();
  lookupCalls = [];
  Object.values(untouched).forEach((m) => m.__reset());
  list = addList(30, 'Dentists_in_Austin_Texas.csv');
  b1 = (await allocate(list, { mode: 'custom', count: 10 })).body.batch;
  b2 = (await allocate(list, { mode: 'custom', count: 15 })).body.batch;
});

const steps = () => [{ _id: new mongoose.Types.ObjectId(), body: 'Hi {{first_name}}', delayValue: 0, delayUnit: 'hours' }];
function addCampaign(extra = {}) {
  const c = { _id: new mongoose.Types.ObjectId(), name: 'Spring', description: '', isActive: true, steps: steps(), import: list._id, batch: null, ...extra };
  campaigns.push(c);
  return c;
}

// ===========================================================================
describe('the scenario', () => {
  test('Batch 1 = 10, Batch 2 = 15, Remaining = 5 — disjoint persisted membership', () => {
    assert.equal(members(b1).length, 10);
    assert.equal(members(b2).length, 15);
    assert.equal(remainingPool(list).length, 5);
    const all = [...ids(members(b1)), ...ids(members(b2))];
    assert.equal(new Set(all).size, 25, 'no contact is in two batches');
  });

  test('the list exposes its batches with live counts, for every CSV -> Batch selector', async () => {
    const res = await api.get(`/api/contact-imports/${list._id}/allocation`, { token: userToken });
    assert.deepEqual(
      res.body.data.batches.map((b) => [b.number, b.size, b.contacts, b.status]),
      [[1, 10, 10, 'complete'], [2, 15, 15, 'complete']]
    );
    assert.equal(res.body.data.remaining, 5);
    assert.equal(String(res.body.data.currentBatch._id), String(b2._id));
    assert.equal(res.body.data.contacts, 30, 'live contacts of the list');
  });
});

// ===========================================================================
describe('Lookup All is batch-scoped', () => {
  test('with Batch 2 chosen, exactly Batch 2 is looked up — never Batch 1 or the remaining pool', async () => {
    const res = await api.post('/api/contacts/lookup-all', { token: adminToken, body: { import: String(list._id), batch: String(b2._id) } });
    assert.equal(res.status, 202, res.text);
    assert.equal(res.body.job.total, 15);
    assert.equal(res.body.job.scope, 'Batch 2 of Dentists_in_Austin_Texas.csv');
    await contactLookup.currentRun();
    assert.deepEqual(lookupCalls.sort(), members(b2).map((c) => c.phone).sort());
    assert.ok(members(b1).every((c) => c.lookup.status === 'unknown'), 'Batch 1 untouched');
    assert.ok(remainingPool(list).every((c) => c.lookup.status === 'unknown'), 'remaining untouched');
  });

  test('"current" resolves to the latest batch on the server', async () => {
    await api.post('/api/contacts/lookup-all', { token: adminToken, body: { import: String(list._id), batch: 'current' } });
    await contactLookup.currentRun();
    assert.deepEqual(lookupCalls.sort(), members(b2).map((c) => c.phone).sort());
  });

  test('a batch of ANOTHER list, or a batch without a list, is refused', async () => {
    const other = addList(5, 'other.csv');
    const ob = (await allocate(other, { mode: 'all' })).body.batch;
    const foreign = await api.post('/api/contacts/lookup-all', { token: adminToken, body: { import: String(list._id), batch: String(ob._id) } });
    assert.equal(foreign.status, 400);
    const noList = await api.post('/api/contacts/lookup-all', { token: adminToken, body: { batch: String(b2._id) } });
    assert.equal(noList.status, 400);
    assert.equal(lookupCalls.length, 0);
  });

  test('"needs a lookup" is counted for the chosen batch only', async () => {
    const res = await api.get(`/api/contacts/lookup-summary?import=${list._id}&batch=${b2._id}`, { token: userToken });
    assert.equal(res.body.needsLookup, 15);
    assert.equal(res.body.total, 15);
  });

  test('two simultaneous Lookup All for a batch: one runs, one is refused', async () => {
    const body = { import: String(list._id), batch: String(b2._id) };
    const [x, y] = await Promise.all([
      api.post('/api/contacts/lookup-all', { token: adminToken, body }),
      api.post('/api/contacts/lookup-all', { token: adminToken, body }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [202, 409]);
    await contactLookup.currentRun();
    assert.equal(lookupCalls.length, 15, 'each number once');
  });
});

// ===========================================================================
describe('the lookup-status filter within a batch', () => {
  beforeEach(() => {
    const m1 = members(b1);
    const m2 = members(b2);
    m1[0].lookup = { status: 'invalid', type: '', lookedUpAt: new Date(), lastError: '' };
    for (const i of [0, 1, 2]) m2[i].lookup = { status: 'invalid', type: '', lookedUpAt: new Date(), lastError: '' };
    m2[3].lookup = { status: 'unknown', type: '', lastError: 'Lookup failed: timeout', lastAttemptAt: new Date() };
    m2[4].lookup = { status: 'valid', type: 'landline', lookedUpAt: new Date(), lastError: '' };
    remainingPool(list)[0].lookup = { status: 'invalid', type: '', lookedUpAt: new Date(), lastError: '' };
  });
  const view = (qs) => api.get(`/api/contacts?${new URLSearchParams({ import: String(list._id), limit: '100', ...qs })}`, { token: userToken });

  test('Invalid in Batch 2 shows ONLY Batch 2’s invalid contacts', async () => {
    const res = await view({ batch: String(b2._id), lookup: 'invalid' });
    assert.deepEqual(res.body.data.map((c) => String(c._id)).sort(), ids(members(b2).slice(0, 3)));
  });

  test('a failed lookup is Unknown, not Invalid', async () => {
    const res = await view({ batch: String(b2._id), lookup: 'unknown' });
    assert.deepEqual(res.body.data.map((c) => String(c._id)), [String(members(b2)[3]._id)]);
  });

  test('counts are for the batch', async () => {
    const res = await api.get(`/api/contacts/lookup-summary?import=${list._id}&batch=${b2._id}`, { token: userToken });
    assert.equal(res.body.total, 15);
    assert.deepEqual([res.body.counts.invalid, res.body.counts.unknown, res.body.counts.landline, res.body.counts.not_checked], [3, 1, 1, 10]);
  });

  test('with search and pagination', async () => {
    const page2 = await view({ batch: String(b2._id), lookup: 'not_checked', limit: '4', page: '2' });
    assert.equal(page2.body.pagination.total, 10);
    assert.equal(page2.body.data.length, 4);
    assert.ok(page2.body.data.every((c) => same(c.importBatch, b2._id)));
    const s = await view({ batch: String(b2._id), search: members(b2)[5].name });
    assert.deepEqual(s.body.data.map((c) => String(c._id)), [String(members(b2)[5]._id)]);
  });

  test('Select All + Delete removes exactly Batch 2’s 3 invalid contacts', async () => {
    const res = await api.post('/api/contacts/delete-invalid', {
      token: adminToken,
      body: { filters: { import: String(list._id), batch: String(b2._id), lookup: 'invalid' }, expectedCount: 3 },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.deleted, 3);
    assert.equal(members(b2).length, 12);
    assert.equal(members(b1).length, 10, 'Batch 1’s invalid contact is untouched');
    assert.equal(remainingPool(list).length, 5, 'the pool’s invalid contact is untouched');
    const state = await api.get(`/api/contact-imports/${list._id}/allocation`, { token: userToken });
    const batch2 = state.body.data.batches.find((b) => same(b._id, b2._id));
    assert.deepEqual([batch2.size, batch2.contacts], [15, 12], 'history keeps 15; 12 still exist');
  });
});

// ===========================================================================
describe('campaigns are for one batch', () => {
  const create = (body) => api.post('/api/campaigns', { token: userToken, body: { name: 'C', steps: [{ body: 'Hi', delayValue: 0, delayUnit: 'hours' }], ...body } });

  test('a list with batches requires the batch', async () => {
    const res = await create({ import: String(list._id) });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /select the batch/);
    assert.equal(campaigns.length, 0);
  });

  test('Batch 2 is stored; the campaign describes itself as Batch 2', async () => {
    const res = await create({ import: String(list._id), batch: String(b2._id) });
    assert.equal(res.status, 201, res.text);
    assert.ok(same(campaigns[0].batch, b2._id));
    const got = await api.get(`/api/campaigns/${campaigns[0]._id}`, { token: userToken });
    assert.deepEqual([got.body.data.batchInfo.number, got.body.data.batchInfo.contacts], [2, 15]);
  });

  test('a batch of another list, a made-up batch, or a deleted batch is refused', async () => {
    const other = addList(3, 'other.csv');
    const ob = (await allocate(other, { mode: 'all' })).body.batch;
    for (const batch of [String(ob._id), String(new mongoose.Types.ObjectId())]) {
      const res = await create({ import: String(list._id), batch });
      assert.equal(res.status, 400, batch);
    }
    await api.delete(`/api/contact-imports/${list._id}/batches/${b1._id}`, { token: adminToken });
    const deleted = await create({ import: String(list._id), batch: String(b1._id) });
    assert.equal(deleted.status, 400);
    assert.match(deleted.body.message, /deleted/);
  });

  test('a list WITHOUT batches still works on the whole list, as before', async () => {
    const plain = addList(4, 'plain.csv');
    const res = await create({ import: String(plain._id) });
    assert.equal(res.status, 201, res.text);
    assert.equal(campaigns[0].batch, null);
  });

  test('editing only the steps of an older whole-list campaign is not blocked', async () => {
    const legacy = addCampaign();
    const res = await api.put(`/api/campaigns/${legacy._id}`, {
      token: userToken,
      body: { import: String(list._id), batch: null, steps: [{ body: 'Edited', delayValue: 0, delayUnit: 'hours' }] },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(campaigns[0].steps[0].body, 'Edited');
  });
});

// ===========================================================================
describe('enrollment is batch-bounded', () => {
  test('the picker for a Batch 2 campaign lists ONLY Batch 2 (never all 30)', async () => {
    const camp = addCampaign({ batch: b2._id });
    const res = await api.get(`/api/campaigns/${camp._id}/eligible-contacts?limit=100`, { token: userToken });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.pagination.total, 15);
    assert.deepEqual(res.body.data.map((c) => String(c._id)).sort(), ids(members(b2)));
    assert.equal(res.body.scope.batch.number, 2);
    assert.equal(res.body.scope.fixed, true);
  });

  test('the picker refuses another batch for a Batch 2 campaign', async () => {
    const camp = addCampaign({ batch: b2._id });
    const res = await api.get(`/api/campaigns/${camp._id}/eligible-contacts?batch=${b1._id}`, { token: userToken });
    assert.equal(res.status, 400);
  });

  test('Select All enrolls exactly Batch 2', async () => {
    const camp = addCampaign({ batch: b2._id });
    const res = await api.post('/api/enrollments', { token: userToken, body: { campaignId: String(camp._id), selectAll: true } });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.summary.enrolled, 15);
    assert.deepEqual(enrollments.map((e) => String(e.contact)).sort(), ids(members(b2)));
  });

  test('one contact from outside the batch rejects the WHOLE request', async () => {
    const camp = addCampaign({ batch: b2._id });
    const picked = [...members(b2).slice(0, 3), members(b1)[0]].map((c) => String(c._id));
    const res = await api.post('/api/enrollments', { token: userToken, body: { campaignId: String(camp._id), contactIds: picked } });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /1 selected contact is not in Batch 2 of Dentists_in_Austin_Texas\.csv\. Nothing was enrolled\./);
    assert.equal(enrollments.length, 0);
    const pool = await api.post('/api/enrollments', { token: userToken, body: { campaignId: String(camp._id), contactIds: [String(remainingPool(list)[0]._id)] } });
    assert.equal(pool.status, 400, 'a remaining (unallocated) contact is outside too');
  });

  test('explicit Batch 2 contacts are enrolled', async () => {
    const camp = addCampaign({ batch: b2._id });
    const picked = members(b2).slice(0, 4).map((c) => String(c._id));
    const res = await api.post('/api/enrollments', { token: userToken, body: { campaignId: String(camp._id), contactIds: picked } });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.summary.enrolled, 4);
  });

  test('an older whole-list campaign must pick a batch: no batch -> refused, never the whole list', async () => {
    const camp = addCampaign();
    const picker = await api.get(`/api/campaigns/${camp._id}/eligible-contacts`, { token: userToken });
    assert.equal(picker.body.requiresBatch, true);
    assert.equal(picker.body.data.length, 0, 'no fallback to the whole list');
    assert.deepEqual(picker.body.scope.batches.map((b) => b.number), [1, 2]);
    const none = await api.post('/api/enrollments', { token: userToken, body: { campaignId: String(camp._id), selectAll: true } });
    assert.equal(none.status, 400);
    assert.equal(none.body.code, 'batch_required');
    const withB1 = await api.post('/api/enrollments', { token: userToken, body: { campaignId: String(camp._id), selectAll: true, batchId: String(b1._id) } });
    assert.equal(withB1.status, 201);
    assert.deepEqual(enrollments.map((e) => String(e.contact)).sort(), ids(members(b1)));
  });

  test('the shared pipeline refuses outsiders for a batch campaign, even for enroll-after-import', async () => {
    const camp = addCampaign({ batch: b2._id });
    const summary = await enrollContactIds({
      campaign: camp,
      targetIds: [String(members(b1)[0]._id)],
      ignoreImportScope: true,
    });
    assert.equal(summary.enrolled, 0);
    assert.equal(summary.notEligible, 1);
    assert.match(summary.errors[0].reason, /not in this campaign's batch/);
  });

  test('a new batch can never be poured into a batch-bound campaign', async () => {
    const camp = addCampaign({ batch: b2._id });
    const res = await allocate(list, { mode: 'all', campaignId: String(camp._id) });
    assert.equal(res.status, 400);
    assert.equal(remainingPool(list).length, 5, 'nothing was allocated');
  });
});

// ===========================================================================
describe('deleting a finished batch', () => {
  const del = (batch, token = adminToken) => api.delete(`/api/contact-imports/${list._id}/batches/${batch._id}`, { token });

  test('removes the grouping only — every contact, and the counts, stay', async () => {
    const before = contacts.length;
    const res = await del(b1);
    assert.equal(res.status, 200, res.text);
    assert.match(res.body.message, /Batch 1 deleted\. Its contacts were kept\./);
    assert.equal(contacts.length, before, 'no master contact deleted');
    assert.equal(members(b1).length, 10, 'members keep their marker');
    const b = res.body.data.batches.find((x) => same(x._id, b1._id));
    assert.equal(b.status, 'deleted');
    assert.deepEqual([res.body.data.allocated, res.body.data.remaining], [25, 5]);
    for (const [name, model] of Object.entries(untouched)) {
      const writes = model.__calls.filter((c) => !['find', 'findOne', 'findById', 'countDocuments'].includes(c.method));
      assert.deepEqual(writes, [], `${name} untouched`);
    }
  });

  test('its contacts never return to the pool and are never allocated again', async () => {
    await del(b1);
    const next = await allocate(list, { mode: 'all' });
    assert.equal(next.body.batch.size, 5);
    assert.ok(members(next.body.batch).every((c) => !ids(members(b1)).includes(String(c._id))));
  });

  test('a deleted batch leaves every selector, but other batches are unaffected', async () => {
    await del(b1);
    const view = await api.get(`/api/contacts?import=${list._id}&batch=${b1._id}`, { token: userToken });
    assert.equal(view.status, 400);
    assert.match(view.body.message, /Batch 1 has been deleted/);
    const b2view = await api.get(`/api/contacts?import=${list._id}&batch=${b2._id}&limit=100`, { token: userToken });
    assert.equal(b2view.body.pagination.total, 15);
  });

  test('a campaign on the deleted batch keeps its history but cannot enroll more', async () => {
    const camp = addCampaign({ batch: b1._id });
    enrollments.push({ _id: new mongoose.Types.ObjectId(), contact: members(b1)[0]._id, campaign: camp._id, status: 'completed' });
    const res = await del(b1);
    assert.equal(res.status, 200, 'completed enrollments do not block');
    assert.equal(enrollments.length, 1, 'enrollment history kept');
    const got = await api.get(`/api/campaigns/${camp._id}`, { token: userToken });
    assert.equal(got.body.data.batchInfo.status, 'deleted', 'no broken reference');
    const more = await api.post('/api/enrollments', { token: userToken, body: { campaignId: String(camp._id), selectAll: true } });
    assert.equal(more.status, 400);
    assert.match(more.body.message, /has been deleted/);
  });

  test('refused while the batch still has active or paused enrollments', async () => {
    const camp = addCampaign({ batch: b1._id });
    enrollments.push({ _id: new mongoose.Types.ObjectId(), contact: members(b1)[0]._id, campaign: camp._id, status: 'active' });
    const res = await del(b1);
    assert.equal(res.status, 409);
    assert.match(res.body.message, /1 active or paused enrollment/);
    assert.equal(imports[0].allocation.batches[0].status, 'complete');
  });

  test('admin-only; deleting twice, or simultaneously, deletes once', async () => {
    assert.equal((await del(b1, userToken)).status, 403);
    const [x, y] = await Promise.all([del(b1), del(b1)]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal((await del(b1)).status, 409);
  });
});

// ===========================================================================
describe('concurrency', () => {
  test('simultaneous allocations never overlap', async () => {
    const big = addList(40, 'big.csv');
    const [x, y, z] = await Promise.all([
      allocate(big, { mode: 'custom', count: 10 }),
      allocate(big, { mode: 'custom', count: 12 }),
      allocate(big, { mode: 'custom', count: 7 }),
    ]);
    const sets = [x, y, z].map((r) => ids(members(r.body.batch)));
    assert.deepEqual(sets.map((s) => s.length), [10, 12, 7]);
    assert.equal(new Set(sets.flat()).size, 29, 'no contact in two batches');
  });
});
