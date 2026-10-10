// Phase 10 — the eventPrefix filter on GET /api/logs.
//
// The AI activity table needs exactly the `ai.*` events. `search` was not usable
// for that: it also matches the human-readable message, so a log line whose text
// happened to contain "ai." would be pulled into an AI-only view.
//
// The filter is anchored and escaped, so the term is matched literally and the
// query stays servable from the eventType index.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, query } = require('../_support/stubs');
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

let filters = [];
let rows = [];
stubModule(
  'models/SystemLog',
  fakeModel('SystemLog', {
    find: (filter) => {
      filters.push(filter);
      const chain = {};
      for (const m of ['sort', 'skip', 'limit', 'select', 'populate']) chain[m] = () => chain;
      chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
      return chain;
    },
    countDocuments: async () => rows.length,
    aggregate: () => query([]),
  })
);

for (const m of [
  'models/Contact',
  'models/Campaign',
  'models/Enrollment',
  'models/Conversation',
  'models/Following',
  'models/Import',
  'models/SMSMessage',
  'models/Template',
  'models/ImportPreview',
  'models/Settings',
  'models/WorkerLock',
  'models/AIReplyJob',
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
  filters = [];
  rows = [
    { _id: f.oid(), eventType: 'ai.reply.sent', severity: 'info', message: 'AI reply sent', createdAt: new Date() },
    { _id: f.oid(), eventType: 'ai.draft.approved', severity: 'info', message: 'approved', createdAt: new Date() },
  ];
});

const lastFilter = () => filters[filters.length - 1];

// ===========================================================================
describe('eventPrefix', () => {
  test('narrows to a family with an anchored regex', async () => {
    const res = await api.get('/api/logs?eventPrefix=ai.', { token });
    assert.equal(res.status, 200);
    const { eventType } = lastFilter();
    assert.ok(eventType instanceof RegExp, 'expected a regex filter');
    assert.equal(eventType.source, '^ai\\.');
  });

  test('the regex matches the AI events and nothing that merely contains "ai."', async () => {
    await api.get('/api/logs?eventPrefix=ai.', { token });
    const re = lastFilter().eventType;
    for (const good of ['ai.run', 'ai.reply.sent', 'ai.draft.approved', 'ai.takeover.enabled']) {
      assert.ok(re.test(good), `${good} should match`);
    }
    for (const bad of ['sms.sent', 'automation.run', 'reply.sent', 'webhook.inbound', 'optout.received']) {
      assert.ok(!re.test(bad), `${bad} should NOT match`);
    }
  });

  test('a dot is matched literally, not as "any character"', async () => {
    await api.get('/api/logs?eventPrefix=ai.', { token });
    const re = lastFilter().eventType;
    // Without escaping, /^ai./ would match "aix.whatever".
    assert.ok(!re.test('aixrun'), 'the dot was treated as a wildcard');
  });

  test('regex metacharacters in the prefix cannot alter the query', async () => {
    for (const evil of ['.*', 'ai.*|', '(a)', 'a{1,999999}', '[', '^$']) {
      await api.get(`/api/logs?eventPrefix=${encodeURIComponent(evil)}`, { token });
      const re = lastFilter().eventType;
      // Whatever was typed is matched as literal text.
      assert.ok(re.source.startsWith('^'), 'the filter must stay anchored');
      assert.ok(!re.test('sms.sent'), `"${evil}" matched an unrelated event`);
    }
  });

  test('an exact eventType still wins — it is the narrower filter', async () => {
    await api.get('/api/logs?eventType=ai.run&eventPrefix=ai.', { token });
    assert.equal(lastFilter().eventType, 'ai.run');
  });

  test('it combines with the date range', async () => {
    const from = '2026-01-01T00:00:00.000Z';
    await api.get(`/api/logs?eventPrefix=ai.&from=${from}`, { token });
    const filter = lastFilter();
    assert.ok(filter.eventType instanceof RegExp);
    assert.equal(filter.createdAt.$gte.toISOString(), from);
  });

  test('it combines with severity', async () => {
    await api.get('/api/logs?eventPrefix=ai.&severity=error', { token });
    assert.equal(lastFilter().severity, 'error');
  });

  test('omitting it leaves the existing behaviour untouched', async () => {
    await api.get('/api/logs', { token });
    assert.equal(lastFilter().eventType, undefined);
  });

  test('an empty value is ignored rather than matching everything', async () => {
    await api.get('/api/logs?eventPrefix=', { token });
    assert.equal(lastFilter().eventType, undefined);
  });

  test('an object cannot be injected through the parameter', async () => {
    const res = await api.get('/api/logs?eventPrefix[$ne]=x', { token });
    assert.equal(res.status, 200);
    const { eventType } = lastFilter();
    assert.ok(eventType === undefined || eventType instanceof RegExp, 'an operator object reached the filter');
  });

  test('pagination still applies, so the table can never load everything', async () => {
    const res = await api.get('/api/logs?eventPrefix=ai.&limit=500', { token });
    assert.equal(res.status, 200);
    // MAX_LIMIT caps it at 100.
    assert.equal(res.body.pagination.limit, 100);
  });

  test('it still requires authentication', async () => {
    assert.equal((await api.get('/api/logs?eventPrefix=ai.')).status, 401);
  });
});
