// Inbox filters and paging: GET /api/conversations and
// GET /api/conversations/:id/messages, through the REAL app, routes, auth and
// controller, over the in-memory docStore (real filter semantics: $in, $or,
// regex, multi-key sort, distinct).
//
// What is proved:
//   * each of the Inbox's eight filters returns exactly the threads it should,
//     from the real schema fields — delivery status on SMSMessage, consent on
//     Contact.optedOut, and the thread's own unread/needs-reply/assignee/status;
//   * a delivered message is never "undelivered", only a delivery receipt
//     (status 'delivered') counts as delivered, and a soft-deleted message
//     counts for neither;
//   * a thread with both a delivered and a failed message is in BOTH filters;
//   * opted-out threads stay listed, and their STOP history stays readable;
//   * search narrows every filter;
//   * paging the list and paging a thread's history never repeats or drops a
//     record, even when timestamps tie;
//   * nothing is written by any of it.
'use strict';

require('../_support/env');

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, query } = require('../_support/stubs');
const { storeModel } = require('../_support/docStore');
const f = require('../_support/factories');

stubModule('services/logService', { logEvent: async () => {} });
stubModule('jobs/automationWorker', {
  processDueEnrollments: async () => ({}),
  processDueFollowings: async () => ({}),
  start: () => {},
  stop: () => {},
});

const me = f.user({ name: 'Me' });
const colleague = f.user({ name: 'Colleague' });
const usersById = new Map([[String(me._id), me], [String(colleague._id), colleague]]);
stubModule('models/User', fakeModel('User', { findById: (id) => query(usersById.get(String(id)) || null) }));

let contacts = [];
let conversations = [];
let messages = [];
// Every write method is wrapped so the test can assert that reading never writes.
const writes = [];
const recordWrites = (name, model) => {
  for (const m of ['create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteMany', 'findByIdAndDelete']) {
    const original = model[m];
    model[m] = (...args) => { writes.push(`${name}.${m}`); return original(...args); };
  }
  return model;
};
stubModule('models/Contact', recordWrites('Contact', storeModel('Contact', () => contacts, (r) => { contacts = r; })));
stubModule('models/Conversation', recordWrites('Conversation', storeModel('Conversation', () => conversations, (r) => { conversations = r; })));
stubModule('models/SMSMessage', recordWrites('SMSMessage', storeModel('SMSMessage', () => messages, (r) => { messages = r; })));

const { startApp, tokenFor } = require('../_support/http');

// --- fixture: one thread per situation ------------------------------------------
const T0 = Date.parse('2026-10-01T12:00:00Z');
const at = (min) => new Date(T0 + min * 60000);

const people = {};
function thread(key, { contact = {}, convo = {}, msgs = [] }) {
  const c = f.contact({ name: key, phone: `+1415555${String(Object.keys(people).length).padStart(4, '0')}`, ...contact });
  const conv = f.conversation({
    contact: c._id,
    contactName: c.name,
    contactPhone: c.phone,
    status: 'open',
    assignedTo: null,
    unreadCount: 0,
    lastMessageDirection: 'outbound',
    lastMessageAt: at(Object.keys(people).length),
    deletedAt: null,
    ...convo,
  });
  contacts.push(c);
  conversations.push(conv);
  msgs.forEach((m, i) => messages.push(f.smsMessage({
    contact: c._id,
    conversation: conv._id,
    direction: 'outbound',
    status: 'delivered',
    body: `${key} ${i}`,
    createdAt: at(i),
    deletedAt: null,
    ...m,
  })));
  people[key] = { contact: c, convo: conv };
}

thread('Delivered Dana', { msgs: [{ status: 'delivered' }, { status: 'sent' }] });
thread('Failed Fay', { msgs: [{ status: 'delivered' }, { status: 'failed', error: 'send failed' }] });
thread('Undelivered Uma', { msgs: [{ status: 'undelivered', errorCode: 30005 }] });
// Their only failure was soft-deleted by an admin — hidden, so it does not count.
thread('Hidden-failure Hal', { msgs: [{ status: 'failed', deletedAt: at(9) }, { status: 'delivered' }] });
// An INBOUND row with an odd status is not an outbound delivery failure.
// INBOUND rows are never outbound delivery results, whatever their status.
thread('Inbound Ivy', { msgs: [{ direction: 'inbound', status: 'failed' }, { direction: 'inbound', status: 'delivered' }] });
// Sent but never confirmed by the carrier: neither delivered nor undelivered.
thread('Sent-only Sid', { msgs: [{ status: 'sent' }, { status: 'queued' }, { status: 'simulated' }] });
// Their only delivered message was soft-deleted — hidden, so it does not count.
thread('Hidden-delivery Hope', { msgs: [{ status: 'delivered', deletedAt: at(9) }] });
thread('Stopped Sam', {
  contact: { optedOut: true, optedOutAt: at(5), optOutSource: 'keyword' },
  msgs: [{ status: 'delivered' }, { direction: 'inbound', status: 'received', body: 'STOP' }],
});
// Opted out AND had a failure: in both filters.
thread('Carrier Cleo', {
  contact: { optedOut: true, optOutSource: 'carrier' },
  msgs: [{ status: 'undelivered', errorCode: 21610 }],
});
// Sent STOP and later START: opted back in, so not in the opt-out filter.
thread('Restarted Rex', {
  contact: { optedOut: false, optedInAt: at(8) },
  msgs: [{ direction: 'inbound', status: 'received', body: 'STOP' }, { direction: 'inbound', status: 'received', body: 'START' }],
});
thread('Unread Una', { convo: { unreadCount: 2, lastMessageDirection: 'inbound' }, msgs: [{ direction: 'inbound', status: 'received' }] });
// Last message is theirs but already read: needs a reply, not unread.
thread('Waiting Walt', { convo: { lastMessageDirection: 'inbound' }, msgs: [{ direction: 'inbound', status: 'received' }] });
thread('Mine Mo', { convo: { assignedTo: me._id } });
thread('Theirs Tia', { convo: { assignedTo: colleague._id } });
thread('Closed Cal', { convo: { status: 'closed' }, msgs: [{ status: 'failed' }] });
// Soft-deleted thread: in no filter at all.
thread('Deleted Del', { contact: { optedOut: true }, convo: { deletedAt: at(3), unreadCount: 1 }, msgs: [{ status: 'failed' }] });

const ALL_VISIBLE = Object.keys(people).filter((k) => k !== 'Deleted Del');

let app;
let token;
before(async () => {
  app = await startApp();
  token = tokenFor(me);
});
after(async () => { await app.close(); });

// The Inbox dropdown's eight options, exactly as the client sends them.
const FILTERS = {
  all: {},
  delivered: { delivery: 'delivered' },
  undelivered: { delivery: 'undelivered' },
  optedOut: { optedOut: 'true' },
  unread: { unread: 'true' },
  needsReply: { needsReply: 'true' },
  mine: { assigned: 'me' },
  closed: { status: 'closed' },
};

async function names(params, { limit = 100 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit), ...params }).toString();
  const res = await app.get(`/api/conversations?${qs}`, { token });
  assert.equal(res.status, 200, res.text);
  return { names: res.body.data.map((c) => c.contactName).sort(), body: res.body };
}

describe('the eight Inbox filters', () => {
  test('All messages: every visible thread — delivered, undelivered, opted out, open and closed', async () => {
    const { names: got, body } = await names(FILTERS.all);
    assert.deepEqual(got, [...ALL_VISIBLE].sort());
    assert.equal(body.pagination.total, ALL_VISIBLE.length);
  });

  test('Delivered: only threads with a visible OUTBOUND message the carrier confirmed delivered', async () => {
    const { names: got, body } = await names(FILTERS.delivered);
    assert.deepEqual(got, ['Delivered Dana', 'Failed Fay', 'Hidden-failure Hal', 'Stopped Sam']);
    assert.equal(body.pagination.total, 4, 'the count matches the rows');
  });

  test('sent, queued, simulated, inbound and soft-deleted messages are not "delivered"', async () => {
    const { names: got } = await names(FILTERS.delivered);
    for (const no of ['Sent-only Sid', 'Hidden-delivery Hope', 'Inbound Ivy', 'Undelivered Uma', 'Carrier Cleo', 'Closed Cal']) {
      assert.equal(got.includes(no), false, no);
    }
  });

  test('a thread with a delivered AND a failed message is listed under both filters, once each', async () => {
    const delivered = (await names(FILTERS.delivered)).names;
    const undelivered = (await names(FILTERS.undelivered)).names;
    assert.equal(delivered.filter((n) => n === 'Failed Fay').length, 1);
    assert.equal(undelivered.filter((n) => n === 'Failed Fay').length, 1);
    assert.equal((await names(FILTERS.all)).names.filter((n) => n === 'Failed Fay').length, 1);
  });

  test('Delivered combines with the opt-out filter like Undelivered does', async () => {
    assert.deepEqual((await names({ delivery: 'delivered', optedOut: 'true' })).names, ['Stopped Sam']);
  });

  test('Undelivered: only threads with a visible failed/undelivered OUTBOUND message', async () => {
    const { names: got, body } = await names(FILTERS.undelivered);
    assert.deepEqual(got, ['Carrier Cleo', 'Closed Cal', 'Failed Fay', 'Undelivered Uma']);
    assert.equal(body.pagination.total, 4, 'the count matches the rows');
  });

  test('a delivered message is never classified as undelivered', async () => {
    const { names: got } = await names(FILTERS.undelivered);
    for (const ok of ['Delivered Dana', 'Hidden-failure Hal', 'Inbound Ivy', 'Stopped Sam', 'Sent-only Sid', 'Hidden-delivery Hope']) {
      assert.equal(got.includes(ok), false, ok);
    }
  });

  test('STOP / Opted out: the Contact.optedOut flag, whatever the source', async () => {
    const { names: got } = await names(FILTERS.optedOut);
    assert.deepEqual(got, ['Carrier Cleo', 'Stopped Sam']);
  });

  test('a STOP followed by START is opted back in and not listed as opted out', async () => {
    const { names: got } = await names(FILTERS.optedOut);
    assert.equal(got.includes('Restarted Rex'), false);
  });

  test('Unread, Needs reply, Assigned to me and Closed keep their existing meaning', async () => {
    assert.deepEqual((await names(FILTERS.unread)).names, ['Unread Una']);
    assert.deepEqual((await names(FILTERS.needsReply)).names, ['Unread Una', 'Waiting Walt']);
    assert.deepEqual((await names(FILTERS.mine)).names, ['Mine Mo']);
    assert.deepEqual((await names(FILTERS.closed)).names, ['Closed Cal']);
  });

  test('a soft-deleted thread appears under no filter', async () => {
    for (const params of Object.values(FILTERS)) {
      assert.equal((await names(params)).names.includes('Deleted Del'), false, JSON.stringify(params));
    }
  });

  test('delivery and opt-out can be combined: both must hold', async () => {
    assert.deepEqual((await names({ delivery: 'undelivered', optedOut: 'true' })).names, ['Carrier Cleo']);
  });

  test('unknown values are ignored rather than guessed at', async () => {
    assert.equal((await names({ delivery: 'bogus', optedOut: 'yes' })).names.length, ALL_VISIBLE.length);
  });
});

describe('search works with every filter', () => {
  test('a name search narrows each filter to its matching rows', async () => {
    const expected = {
      all: ['Carrier Cleo', 'Closed Cal'],
      delivered: [],
      undelivered: ['Carrier Cleo', 'Closed Cal'],
      optedOut: ['Carrier Cleo'],
      unread: [],
      needsReply: [],
      mine: [],
      closed: ['Closed Cal'],
    };
    for (const [key, params] of Object.entries(FILTERS)) {
      assert.deepEqual((await names({ ...params, search: 'cl' })).names, expected[key], key);
    }
  });

  test('a partial phone number matches, and regex characters are literal', async () => {
    const phone = people['Stopped Sam'].contact.phone;
    assert.deepEqual((await names({ ...FILTERS.optedOut, search: phone.slice(-4) })).names, ['Stopped Sam']);
    assert.deepEqual((await names({ ...FILTERS.all, search: '.*' })).names, []);
  });
});

describe('opted-out history is preserved and readable', () => {
  test("the STOP message is still in an opted-out contact's thread", async () => {
    const res = await app.get(`/api/conversations/${people['Stopped Sam'].convo._id}/messages`, { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((m) => m.body), ['Stopped Sam 0', 'STOP']);
  });

  test('filtering and reading never wrote anything', () => {
    assert.deepEqual(writes, []);
  });
});

describe('list paging never repeats or drops a thread', () => {
  test('pages of 3 over threads whose lastMessageAt ties', async () => {
    const saved = conversations;
    const tie = at(100);
    conversations = Array.from({ length: 10 }, (_, i) => f.conversation({
      contact: f.contact()._id,
      contactName: `Tie ${i}`,
      lastMessageAt: i < 7 ? tie : at(i),
      deletedAt: null,
    }));
    try {
      const seen = [];
      for (let page = 1; page <= 4; page += 1) {
        const res = await app.get(`/api/conversations?limit=3&page=${page}`, { token });
        assert.equal(res.body.pagination.total, 10);
        seen.push(...res.body.data.map((c) => c.contactName));
      }
      assert.equal(seen.length, 10);
      assert.equal(new Set(seen).size, 10, 'no duplicates');
      // Newest first; the seven tied threads follow in _id order (descending).
      assert.deepEqual(seen.slice(0, 7), ['Tie 6', 'Tie 5', 'Tie 4', 'Tie 3', 'Tie 2', 'Tie 1', 'Tie 0']);
    } finally {
      conversations = saved;
    }
  });
});

describe('thread history paging (load older)', () => {
  const convo = f.conversation({ contactName: 'History', deletedAt: null });
  before(() => {
    conversations.push(convo);
    // 12 messages in order; h03-h07 share one timestamp, and with pages of 4
    // that tie straddles a page boundary.
    const same = at(410);
    for (let i = 0; i < 12; i += 1) {
      messages.push(f.smsMessage({
        contact: convo.contact,
        conversation: convo._id,
        direction: i % 2 ? 'inbound' : 'outbound',
        status: i % 2 ? 'received' : 'delivered',
        body: `h${String(i).padStart(2, '0')}`,
        createdAt: i < 3 ? at(400 + i) : i <= 7 ? same : at(420 + i),
        deletedAt: null,
      }));
    }
  });

  async function walk(useId) {
    const got = [];
    let cursor = '';
    for (let n = 0; n < 10; n += 1) {
      const res = await app.get(`/api/conversations/${convo._id}/messages?limit=4${cursor}`, { token });
      assert.equal(res.status, 200, res.text);
      got.unshift(...res.body.data.map((m) => m.body));
      if (!res.body.hasMore) break;
      cursor = `&before=${encodeURIComponent(new Date(res.body.oldest).toISOString())}`
        + (useId ? `&beforeId=${res.body.oldestId}` : '');
    }
    return got;
  }

  test('with the (createdAt, _id) cursor every message arrives exactly once, in order', async () => {
    const got = await walk(true);
    assert.deepEqual(got, Array.from({ length: 12 }, (_, i) => `h${String(i).padStart(2, '0')}`));
  });

  test('each page is chronological and the newest page is first', async () => {
    const res = await app.get(`/api/conversations/${convo._id}/messages?limit=4`, { token });
    const times = res.body.data.map((m) => Date.parse(m.createdAt));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.equal(res.body.data.at(-1).body, 'h11');
    assert.equal(res.body.hasMore, true);
  });

  test('the legacy timestamp-only cursor still works (it is what older clients send)', async () => {
    const res = await app.get(
      `/api/conversations/${convo._id}/messages?limit=4&before=${encodeURIComponent(at(402).toISOString())}`,
      { token }
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((m) => m.body), ['h00', 'h01']);
  });

  test('a malformed beforeId is refused', async () => {
    const res = await app.get(
      `/api/conversations/${convo._id}/messages?before=${encodeURIComponent(at(1).toISOString())}&beforeId=nope`,
      { token }
    );
    assert.equal(res.status, 400);
  });
});

describe('access', () => {
  test('the filters require a signed-in user', async () => {
    assert.equal((await app.get('/api/conversations?delivery=undelivered')).status, 401);
    assert.equal((await app.get('/api/conversations?optedOut=true')).status, 401);
  });
});
