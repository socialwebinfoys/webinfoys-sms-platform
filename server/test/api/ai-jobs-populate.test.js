// Phase 9 — the one backend change: GET /api/ai/jobs populates the names the
// draft queue has to show.
//
// WHY IT WAS NEEDED. The queue lists drafts and must say who each one is for.
// Before this, `contact` and `conversation` came back as bare ObjectIds, so the
// only way to render a name was one request per row — the N+1 the frontend brief
// forbids. Populate costs one extra query per path regardless of page size.
//
// WHAT THIS TEST GUARDS. That the populate is actually applied, with a NARROW
// projection, and that nothing else about the response changed. A wider
// projection here would quietly start exposing contact fields through a new
// endpoint, which is exactly the kind of drift a test should catch.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

stubModule('services/logService', { logEvent: async () => {} });
stubModule('jobs/automationWorker', {
  processDueEnrollments: async () => ({}),
  processDueFollowings: async () => ({}),
  runTick: async () => ({}),
  start: () => {},
  stop: () => {},
  resolveTimezone: () => 'UTC',
  isSendableAt: () => true,
});
stubModule('jobs/aiWorker', { processDueJobs: async () => ({}), start: () => {}, stop: () => {} });
stubModule('services/lookupService', { lookupNumber: async () => ({ valid: true, type: 'mobile' }) });

const operator = f.user();
stubModule(
  'models/User',
  fakeModel('User', { findById: (id) => (String(id) === String(operator._id) ? query(operator) : query(null)) })
);

let settingsDoc;
const RealSettings = require('../../models/Settings');
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    findOne: () => {
      const chain = {
        select: () => chain,
        then: (res, rej) => Promise.resolve(settingsDoc).then(res, rej),
      };
      return chain;
    },
    getSingleton: async () => settingsDoc,
    resolveAllowedLineTypes: RealSettings.resolveAllowedLineTypes,
    LINE_TYPES: RealSettings.LINE_TYPES,
  })
);

// Records every chained call so the test can assert the query that was BUILT,
// not merely the rows that came back.
let jobRows = [];
let chainCalls = [];
stubModule(
  'models/AIReplyJob',
  Object.assign(
    fakeModel('AIReplyJob', {
      find: (filter) => {
        chainCalls.push({ method: 'find', args: [filter] });
        const chain = {};
        for (const method of ['sort', 'skip', 'limit', 'select', 'populate']) {
          chain[method] = (...args) => {
            chainCalls.push({ method, args });
            return chain;
          };
        }
        chain.then = (res, rej) => Promise.resolve(jobRows).then(res, rej);
        return chain;
      },
      countDocuments: async () => jobRows.length,
    }),
    { STATUSES: require('../../models/AIReplyJob').STATUSES }
  )
);

for (const m of [
  'models/Contact',
  'models/Conversation',
  'models/Campaign',
  'models/Enrollment',
  'models/Following',
  'models/Import',
  'models/SMSMessage',
  'models/Template',
  'models/ImportPreview',
  'models/SystemLog',
  'models/WorkerLock',
]) {
  stubModule(m, fakeModel(m));
}

const { startApp, tokenFor } = require('../_support/http');

let api;
let token;

before(async () => {
  api = await startApp();
  token = tokenFor(operator);
});
after(async () => {
  await api.close();
});

beforeEach(() => {
  chainCalls = [];
  settingsDoc = fakeDoc(f.settings({ ai: { enabled: false, defaultMode: 'draft', provider: 'openai' } }));
  jobRows = [
    {
      _id: f.oid(),
      status: 'drafted',
      mode: 'draft',
      draftReply: 'We are open until 6pm.',
      confidence: 0.9,
      provider: 'openai',
      model: 'gpt-4o-mini',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      // What populate would produce.
      contact: { _id: f.oid(), name: 'Ada Lovelace', phone: '+14155552671' },
      conversation: { _id: f.oid(), contactName: 'Ada Lovelace', contactPhone: '+14155552671', status: 'open' },
    },
  ];
});

const populateCalls = () => chainCalls.filter((c) => c.method === 'populate');

// ===========================================================================
describe('GET /api/ai/jobs populates the queue', () => {
  test('contact is populated with a narrow projection', async () => {
    const res = await api.get('/api/ai/jobs', { token });
    assert.equal(res.status, 200);

    const call = populateCalls().find((c) => c.args[0] === 'contact');
    assert.ok(call, 'contact was not populated — the queue would need one request per row');
    const fields = String(call.args[1] || '').split(/\s+/).filter(Boolean);
    assert.ok(fields.includes('name'), 'the queue needs the contact name');
    assert.ok(fields.includes('phone'), 'the queue needs the phone number');
  });

  test('conversation is populated with the denormalised display fields', async () => {
    await api.get('/api/ai/jobs', { token });
    const call = populateCalls().find((c) => c.args[0] === 'conversation');
    assert.ok(call, 'conversation was not populated');
    const fields = String(call.args[1] || '').split(/\s+/).filter(Boolean);
    assert.ok(fields.includes('contactName'));
    assert.ok(fields.includes('contactPhone'));
  });

  test('the projections are NARROW — no bulk document exposure', async () => {
    await api.get('/api/ai/jobs', { token });
    for (const call of populateCalls()) {
      const projection = call.args[1];
      assert.ok(projection, `${call.args[0]} was populated with no projection at all`);
      const fields = String(projection).split(/\s+/).filter(Boolean);
      assert.ok(fields.length > 0 && fields.length <= 6, `${call.args[0]} projection is too broad`);
      // Nothing sensitive may be pulled in through this new path.
      for (const forbidden of ['password', 'apiKey', 'apiKeyEncrypted', 'customFields', 'notes']) {
        assert.ok(!fields.includes(forbidden), `${forbidden} must not be exposed here`);
      }
    }
  });

  test('exactly two populates — one query per path, not one per row', async () => {
    await api.get('/api/ai/jobs', { token });
    assert.equal(populateCalls().length, 2);
  });

  test('the response still has its Phase 8 shape', async () => {
    const res = await api.get('/api/ai/jobs', { token });
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
    assert.deepEqual(Object.keys(res.body.pagination).sort(), ['limit', 'page', 'pages', 'total']);
  });

  test('the populated names reach the client', async () => {
    const res = await api.get('/api/ai/jobs', { token });
    const row = res.body.data[0];
    assert.equal(row.contact.name, 'Ada Lovelace');
    assert.equal(row.contact.phone, '+14155552671');
    assert.equal(row.conversation.contactName, 'Ada Lovelace');
  });

  test('the existing sort, skip and limit are unchanged', async () => {
    await api.get('/api/ai/jobs?page=2&limit=10', { token });
    const sort = chainCalls.find((c) => c.method === 'sort');
    const skip = chainCalls.find((c) => c.method === 'skip');
    const limit = chainCalls.find((c) => c.method === 'limit');
    assert.deepEqual(sort.args[0], { createdAt: -1 }, 'newest first must be preserved');
    assert.equal(skip.args[0], 10);
    assert.equal(limit.args[0], 10);
  });

  test('the existing filters still work', async () => {
    await api.get('/api/ai/jobs?status=drafted', { token });
    const find = chainCalls.find((c) => c.method === 'find');
    assert.equal(find.args[0].status, 'drafted');
  });

  test('an invalid status is still rejected', async () => {
    const res = await api.get('/api/ai/jobs?status=not_a_status', { token });
    assert.equal(res.status, 400);
  });

  test('it still requires authentication', async () => {
    const res = await api.get('/api/ai/jobs');
    assert.equal(res.status, 401);
  });

  test('an operator (non-admin) may still read the queue', async () => {
    const res = await api.get('/api/ai/jobs', { token });
    assert.equal(res.status, 200);
  });
});
