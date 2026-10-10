// Inbox bulk deletion: POST /api/conversations/bulk-delete and
// POST /api/conversations/delete-all.
//
// Both reuse the single delete's semantics — the THREAD is soft-deleted and
// hidden, every SMSMessage is preserved — so the assertions here are as much
// about what is NOT touched (messages, contacts, campaigns, enrollments,
// follow-ups, settings) as about what is.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
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
stubModule(
  'models/User',
  fakeModel('User', { findById: (id) => query(usersById.get(String(id)) || null) })
);

// --- conversations: an in-memory store honouring the conditional filters ----
let conversations = [];
const matches = (doc, filter = {}) => {
  if (filter._id !== undefined && String(doc._id) !== String(filter._id)) return false;
  if ('deletedAt' in filter) {
    const want = filter.deletedAt;
    if (want === null && doc.deletedAt) return false;
    if (want && want.$ne === null && !doc.deletedAt) return false;
  }
  if (filter.unreadCount && filter.unreadCount.$gt !== undefined) {
    if (!(doc.unreadCount > filter.unreadCount.$gt)) return false;
  }
  if (filter.updatedAt && filter.updatedAt.$gt) {
    if (!(new Date(doc.updatedAt) > new Date(filter.updatedAt.$gt))) return false;
  }
  return true;
};
// Mongoose's timestamps option bumps updatedAt on every update; so does this.
const touch = (doc, set) => Object.assign(doc, set, { updatedAt: new Date(Date.now() + 1) });

const Conversation = stubModule(
  'models/Conversation',
  fakeModel('Conversation', {
    findOneAndUpdate: async (filter, update) => {
      // Yield first, so two simultaneous requests genuinely interleave.
      await new Promise((r) => setImmediate(r));
      const doc = conversations.find((c) => matches(c, filter));
      if (!doc) return null;
      touch(doc, update.$set);
      return doc;
    },
    updateMany: async (filter, update) => {
      const hit = conversations.filter((c) => matches(c, filter));
      hit.forEach((c) => touch(c, update.$set));
      return { matchedCount: hit.length, modifiedCount: hit.length };
    },
    countDocuments: async (filter) => conversations.filter((c) => matches(c, filter)).length,
    find: (filter) => query(conversations.filter((c) => matches(c, filter))),
  })
);

// --- everything that must NOT be touched ------------------------------------
// Each records its calls; the tests assert no write method was ever called.
const untouched = {};
for (const m of [
  'models/SMSMessage',
  'models/Contact',
  'models/Campaign',
  'models/Enrollment',
  'models/Following',
  'models/Settings',
  'models/AIReplyJob',
]) {
  untouched[m] = stubModule(m, fakeModel(m));
}
for (const m of ['models/SystemLog', 'models/Import', 'models/Template', 'models/ImportPreview']) {
  stubModule(m, fakeModel(m));
}
const WRITES = [
  'create', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
  'findByIdAndDelete', 'findOneAndDelete', 'findByIdAndUpdate', 'findOneAndUpdate',
];
function assertNothingElseWritten() {
  for (const [name, model] of Object.entries(untouched)) {
    const writes = model.__calls.filter((c) => WRITES.includes(c.method));
    assert.deepEqual(writes, [], `${name} must not be written to`);
  }
}

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

beforeEach(() => {
  logged.length = 0;
  Conversation.__reset();
  Object.values(untouched).forEach((m) => m.__reset());
  conversations = [
    fakeDoc(f.conversation({ _id: f.oid(), contactPhone: '+14155550001', unreadCount: 2, updatedAt: new Date(0) })),
    fakeDoc(f.conversation({ _id: f.oid(), contactPhone: '+14155550002', unreadCount: 0, updatedAt: new Date(0) })),
    fakeDoc(f.conversation({ _id: f.oid(), contactPhone: '+14155550003', unreadCount: 1, updatedAt: new Date(0) })),
  ];
});

const idOf = (i) => String(conversations[i]._id);
const bulk = (body, token = adminToken) =>
  api.post('/api/conversations/bulk-delete', { token, body });
const deleteAll = (body, token = adminToken) =>
  api.post('/api/conversations/delete-all', { token, body });

// ---------------------------------------------------------------------------
describe('authorization (same rule as the single delete: admin only)', () => {
  test('bulk-delete: a non-admin is rejected with 403 and nothing changes', async () => {
    const res = await bulk({ ids: [idOf(0)] }, userToken);
    assert.equal(res.status, 403);
    assert.ok(conversations.every((c) => !c.deletedAt));
  });

  test('delete-all: a non-admin is rejected with 403 and nothing changes', async () => {
    const res = await deleteAll({ confirm: 'DELETE_ALL' }, userToken);
    assert.equal(res.status, 403);
    assert.ok(conversations.every((c) => !c.deletedAt));
  });

  test('both require a session', async () => {
    assert.equal((await api.post('/api/conversations/bulk-delete', { body: { ids: [idOf(0)] } })).status, 401);
    assert.equal((await api.post('/api/conversations/delete-all', { body: { confirm: 'DELETE_ALL' } })).status, 401);
  });
});

// ---------------------------------------------------------------------------
describe('Delete Selected', () => {
  test('one conversation: soft-deleted, by whom, and nothing else', async () => {
    const res = await bulk({ ids: [idOf(0)] });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.deleted, 1);
    assert.deepEqual(res.body.deletedIds, [idOf(0)]);
    assert.ok(conversations[0].deletedAt instanceof Date);
    assert.equal(String(conversations[0].deletedBy), String(administrator._id));
    assert.equal(conversations[1].deletedAt, null, 'unselected threads are untouched');
    assert.equal(conversations[2].deletedAt, null);
  });

  test('several conversations at once', async () => {
    const res = await bulk({ ids: [idOf(0), idOf(2)] });
    assert.equal(res.body.deleted, 2);
    assert.ok(conversations[0].deletedAt && conversations[2].deletedAt);
    assert.equal(conversations[1].deletedAt, null);
  });

  test('writes the existing conversation.deleted audit event per thread, marked bulk', async () => {
    await bulk({ ids: [idOf(0), idOf(1)] });
    const events = logged.filter((e) => e.eventType === 'conversation.deleted');
    assert.equal(events.length, 2);
    for (const e of events) {
      assert.equal(e.severity, 'warning');
      assert.equal(e.meta.bulk, true);
      assert.equal(e.meta.messagesPreserved, true);
      assert.equal(e.meta.byUserId, String(administrator._id));
    }
    assert.match(events[0].message, /\+14155550001/);
  });

  test('returns the remaining unread count for the sidebar badge', async () => {
    const res = await bulk({ ids: [idOf(0)] }); // thread 0 had unread messages
    assert.equal(res.body.unreadConversations, 1, 'only thread 2 is still unread');
  });

  test('messages, contacts, campaigns, enrollments, follow-ups, settings and AI jobs are untouched', async () => {
    await bulk({ ids: [idOf(0), idOf(1), idOf(2)] });
    assertNothingElseWritten();
  });

  test('is idempotent: repeating it deletes nothing more and logs nothing more', async () => {
    await bulk({ ids: [idOf(0), idOf(1)] });
    const firstDeletedAt = conversations[0].deletedAt;
    logged.length = 0;

    const res = await bulk({ ids: [idOf(0), idOf(1)] });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 0);
    assert.equal(res.body.skipped, 2);
    assert.equal(conversations[0].deletedAt, firstDeletedAt, 'the original deletion stands');
    assert.equal(logged.length, 0);
  });

  test('a repeated id in one request is deleted and logged once', async () => {
    const res = await bulk({ ids: [idOf(0), idOf(0), idOf(0)] });
    assert.equal(res.body.deleted, 1);
    assert.equal(logged.filter((e) => e.eventType === 'conversation.deleted').length, 1);
  });

  test('a well-formed id that does not exist is skipped, not an error', async () => {
    const res = await bulk({ ids: [idOf(0), f.oid()] });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 1);
    assert.equal(res.body.skipped, 1);
  });

  test('two simultaneous identical requests delete — and log — each thread once', async () => {
    const [a, b] = await Promise.all([bulk({ ids: [idOf(0), idOf(1)] }), bulk({ ids: [idOf(0), idOf(1)] })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.deleted + b.body.deleted, 2);
    assert.equal(logged.filter((e) => e.eventType === 'conversation.deleted').length, 2);
  });

  // Built lazily: the conversations only exist once beforeEach has run.
  const invalid = [
    ['no body', () => undefined],
    ['no ids', () => ({})],
    ['ids not an array', () => ({ ids: idOf(0) })],
    ['an empty array', () => ({ ids: [] })],
    ['a malformed id', () => ({ ids: ['not-an-id'] })],
    ['a numeric id', () => ({ ids: [12345] })],
    ['an operator object', () => ({ ids: [{ $ne: null }] })],
    ['one bad id among good ones', () => ({ ids: [idOf(0), 'nope', idOf(1)] })],
    ['more than 500 ids', () => ({ ids: Array.from({ length: 501 }, () => f.oid()) })],
  ];
  for (const [label, makeBody] of invalid) {
    test(`rejects ${label} with 400 and changes nothing`, async () => {
      const res = await bulk(makeBody());
      assert.equal(res.status, 400);
      assert.ok(conversations.every((c) => !c.deletedAt), 'all-or-nothing validation');
      assert.equal(Conversation.__callsTo('findOneAndUpdate').length, 0);
      assert.equal(logged.length, 0);
    });
  }
});

// ---------------------------------------------------------------------------
describe('Delete All', () => {
  test('requires the explicit confirmation token', async () => {
    for (const body of [undefined, {}, { confirm: true }, { confirm: 'yes' }, { confirm: 'delete_all' }]) {
      const res = await deleteAll(body);
      assert.equal(res.status, 400);
    }
    assert.ok(conversations.every((c) => !c.deletedAt));
  });

  test('soft-deletes every visible conversation in one server-side update', async () => {
    const res = await deleteAll({ confirm: 'DELETE_ALL' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.deleted, 3);
    assert.equal(res.body.unreadConversations, 0);
    assert.ok(conversations.every((c) => c.deletedAt instanceof Date));
    assert.equal(Conversation.__callsTo('updateMany').length, 1, 'no per-id round trips');
    assert.deepEqual(Conversation.__callsTo('updateMany')[0].args[0], { deletedAt: null });
  });

  test('records one summary audit event with the count and the operator', async () => {
    await deleteAll({ confirm: 'DELETE_ALL' });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].eventType, 'conversation.deleted_all');
    assert.equal(logged[0].meta.count, 3);
    assert.equal(logged[0].meta.messagesPreserved, true);
    assert.equal(logged[0].meta.byUserId, String(administrator._id));
  });

  test('leaves an already-deleted thread exactly as it was', async () => {
    const earlier = new Date('2026-01-01');
    conversations[1].deletedAt = earlier;
    const res = await deleteAll({ confirm: 'DELETE_ALL' });
    assert.equal(res.body.deleted, 2);
    assert.equal(conversations[1].deletedAt, earlier);
  });

  test('is idempotent: a second Delete All deletes nothing', async () => {
    await deleteAll({ confirm: 'DELETE_ALL' });
    const res = await deleteAll({ confirm: 'DELETE_ALL' });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 0);
  });

  test('messages, contacts, campaigns, enrollments, follow-ups, settings and AI jobs are untouched', async () => {
    await deleteAll({ confirm: 'DELETE_ALL' });
    assertNothingElseWritten();
  });
});

// ---------------------------------------------------------------------------
describe('polling after a deletion', () => {
  test('/changes reports threads deleted since the last poll, so other Inboxes drop them', async () => {
    const since = new Date().toISOString();
    await bulk({ ids: [idOf(0)] });
    const res = await api.get(`/api/conversations/changes?since=${encodeURIComponent(since)}`, { token: userToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.removed, 1);
    assert.ok(!res.body.data.some((c) => String(c._id) === idOf(0)), 'a deleted thread is never listed');
  });

  test('/changes reports nothing removed when nothing was', async () => {
    const since = new Date().toISOString();
    const res = await api.get(`/api/conversations/changes?since=${encodeURIComponent(since)}`, { token: userToken });
    assert.equal(res.body.removed, 0);
  });

  test('the unread count drops deleted threads', async () => {
    await deleteAll({ confirm: 'DELETE_ALL' });
    const res = await api.get('/api/conversations/unread-count', { token: userToken });
    assert.equal(res.body.count, 0);
  });
});
