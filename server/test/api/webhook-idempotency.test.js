// Bug #2 — inbound webhook idempotency.
//
// Twilio retries a webhook whenever it does not receive a timely 2xx, so the same
// MessageSid can arrive twice, or twice at once. Every effect of an inbound
// message is a business effect — a stored message, an unread badge, thread
// state, an opt-out transition, a log entry — and each must happen exactly once.
//
// The SMSMessage double below reproduces the real guarantee rather than assuming
// it: an in-memory unique constraint on (direction:'inbound', twilioSid) that
// mirrors the partial unique index on the model, so the upsert in the controller
// behaves here as it does against MongoDB, including the E11000 race.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

const AUTH_TOKEN = 'bug2-webhook-auth-token';

const logged = [];
stubModule('services/logService', { logEvent: async (e) => void logged.push(e) });

let contacts;
let messages; // every SMSMessage row created
let conversations;
let enrollmentUpdates;
let followingUpdates;

stubModule(
  'models/Contact',
  fakeModel('Contact', {
    findOneAndUpdate: async (filter) => {
      const phone = filter.phone;
      if (!contacts.has(phone)) contacts.set(phone, fakeDoc(f.contact({ phone, _id: f.oid() })));
      return contacts.get(phone);
    },
    findOne: async (filter) => contacts.get(filter && filter.phone) || null,
    findById: async (id) =>
      [...contacts.values()].find((c) => String(c._id) === String(id)) || null,
    updateOne: async (filter, update) => {
      const doc = [...contacts.values()].find((c) => String(c._id) === String(filter._id));
      if (doc && update.$set) Object.assign(doc, update.$set);
      return { modifiedCount: doc ? 1 : 0 };
    },
  })
);

// Mirrors the model's partial unique index: unique on twilioSid among INBOUND
// rows with a non-empty sid.
function uniqueKey(doc) {
  if (doc.direction !== 'inbound') return null;
  const sid = String(doc.twilioSid || '');
  return sid ? `inbound:${sid}` : null;
}
const takenKeys = new Set();

stubModule(
  'models/SMSMessage',
  fakeModel('SMSMessage', {
    create: async (doc) => {
      const key = uniqueKey(doc);
      if (key && takenKeys.has(key)) {
        const err = new Error('E11000 duplicate key error');
        err.code = 11000;
        throw err;
      }
      if (key) takenKeys.add(key);
      const saved = fakeDoc({ ...doc, _id: f.oid() });
      messages.push(saved);
      return saved;
    },
    updateOne: async (filter, update, options = {}) => {
      const existing = messages.find(
        (m) => m.direction === filter.direction && m.twilioSid === filter.twilioSid
      );
      if (existing) {
        // $setOnInsert on a match writes nothing.
        return { matchedCount: 1, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
      }
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const doc = { ...(update.$setOnInsert || {}) };
      const key = uniqueKey(doc);
      if (key && takenKeys.has(key)) {
        const err = new Error('E11000 duplicate key error');
        err.code = 11000;
        throw err;
      }
      if (key) takenKeys.add(key);
      const saved = fakeDoc({ ...doc, _id: f.oid() });
      messages.push(saved);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: saved._id };
    },
    findOne: async (filter) => {
      if (filter.twilioSid !== undefined) {
        return messages.find((m) => m.twilioSid === filter.twilioSid) || null;
      }
      return null;
    },
    findOneAndUpdate: async () => null,
  })
);

stubModule(
  'models/Conversation',
  fakeModel('Conversation', {
    findOrCreateForContact: async (contact) => {
      const id = String(contact._id || contact);
      if (!conversations.has(id)) {
        conversations.set(
          id,
          fakeDoc(
            f.conversation({
              _id: f.oid(),
              contact: id,
              contactName: contact.name || '',
              contactPhone: contact.phone || '',
              unreadCount: 0,
              lastMessagePreview: '',
              lastMessageDirection: '',
            })
          )
        );
      }
      return conversations.get(id);
    },
    findByIdAndUpdate: async (id, update) => {
      const convo = [...conversations.values()].find((c) => String(c._id) === String(id));
      if (!convo) return null;
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) convo[k] = (convo[k] || 0) + v;
      }
      if (update.$set) Object.assign(convo, update.$set);
      return convo;
    },
    findOne: async () => null,
  })
);

stubModule(
  'models/Enrollment',
  fakeModel('Enrollment', {
    updateMany: async (filter, update) => {
      enrollmentUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    },
    updateOne: async () => ({ modifiedCount: 0 }),
  })
);
stubModule(
  'models/Following',
  fakeModel('Following', {
    updateMany: async (filter, update) => {
      followingUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    },
    updateOne: async () => ({ modifiedCount: 0 }),
  })
);

const RealSettings = require('../../models/Settings');
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    getSingleton: async () => fakeDoc(f.settings()),
    resolveAllowedLineTypes: RealSettings.resolveAllowedLineTypes,
    LINE_TYPES: RealSettings.LINE_TYPES,
  })
);
stubModule('models/User', fakeModel('User', { findById: () => query(null) }));
for (const m of ['models/Campaign', 'models/Import', 'models/Template', 'models/ImportPreview', 'models/SystemLog']) {
  stubModule(m, fakeModel(m));
}

const { config } = require('../../config/env');
const { startApp } = require('../_support/http');

let api;
const INBOUND = '/api/webhooks/twilio/inbound';

function twilioSignature(authToken, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

async function postInbound(params) {
  const url = `${api.base}${INBOUND}`;
  return api.post(INBOUND, {
    raw: new URLSearchParams(params).toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilioSignature(AUTH_TOKEN, url, params),
    },
  });
}

before(async () => {
  config.twilio.authToken = AUTH_TOKEN;
  api = await startApp();
});
after(async () => {
  await api.close();
});

beforeEach(() => {
  contacts = new Map();
  messages = [];
  conversations = new Map();
  enrollmentUpdates = [];
  followingUpdates = [];
  logged.length = 0;
  takenKeys.clear();
});

const inboundCount = (sid) =>
  messages.filter((m) => m.direction === 'inbound' && m.twilioSid === sid).length;
const theConversation = () => [...conversations.values()][0];

describe('first delivery behaves exactly as before', () => {
  test('creates one message, one contact, one conversation', async () => {
    const res = await postInbound({
      From: '+14155552671',
      To: '+15005550006',
      Body: 'hello there',
      MessageSid: 'SMfirst001',
    });

    assert.equal(res.status, 200);
    assert.equal(inboundCount('SMfirst001'), 1);
    assert.equal(contacts.size, 1);
    assert.equal(conversations.size, 1);
    assert.equal(theConversation().unreadCount, 1);
    assert.equal(theConversation().lastMessagePreview, 'hello there');
    assert.ok(logged.some((e) => e.eventType === 'webhook.inbound'));
  });
});

describe('an exact duplicate is a complete no-op', () => {
  const params = {
    From: '+14155552671',
    To: '+15005550006',
    Body: 'hello there',
    MessageSid: 'SMdup001',
  };

  test('only ONE SMSMessage exists', async () => {
    await postInbound(params);
    await postInbound(params);
    assert.equal(inboundCount('SMdup001'), 1);
    assert.equal(messages.length, 1);
  });

  test('the duplicate still returns 200 with empty TwiML', async () => {
    await postInbound(params);
    const res = await postInbound(params);
    assert.equal(res.status, 200, 'a non-2xx would make Twilio retry forever');
    assert.match(res.text, /<Response><\/Response>/);
  });

  test('unread count increments only once', async () => {
    await postInbound(params);
    await postInbound(params);
    await postInbound(params);
    assert.equal(theConversation().unreadCount, 1);
  });

  test('conversation last-message state updates only once', async () => {
    await postInbound(params);
    const convo = theConversation();
    const firstAt = convo.lastMessageAt;

    await postInbound(params);

    assert.equal(convo.lastMessagePreview, 'hello there');
    assert.equal(convo.lastMessageDirection, 'inbound');
    assert.equal(convo.lastMessageAt, firstAt, 'the thread timestamp must not move on a replay');
  });

  test('a duplicate does not re-open a thread an admin has closed', async () => {
    await postInbound(params);
    const convo = theConversation();
    convo.status = 'closed';
    convo.deletedAt = new Date();

    await postInbound(params);

    assert.equal(convo.status, 'closed', 'a replay must not resurrect the thread');
    assert.ok(convo.deletedAt, 'nor undo a soft delete');
  });

  test('the duplicate is recorded as webhook.duplicate, not as a second webhook.inbound', async () => {
    await postInbound(params);
    logged.length = 0;
    await postInbound(params);

    assert.equal(logged.filter((e) => e.eventType === 'webhook.inbound').length, 0);
    const dup = logged.find((e) => e.eventType === 'webhook.duplicate');
    assert.ok(dup, 'the replay should be observable');
    assert.equal(dup.twilioSid, 'SMdup001');
    assert.equal(dup.severity, 'info');
  });

  test('automation is not stopped a second time', async () => {
    await postInbound(params);
    const afterFirst = enrollmentUpdates.length;
    await postInbound(params);
    assert.equal(enrollmentUpdates.length, afterFirst, 'compliance must run once per message');
  });
});

describe('a duplicate arriving after a restart is still a duplicate', () => {
  test('the decision comes from stored state, not from process memory', async () => {
    const params = {
      From: '+14155552671',
      Body: 'persisted',
      MessageSid: 'SMrestart001',
    };
    await postInbound(params);
    assert.equal(inboundCount('SMrestart001'), 1);

    // Simulate a restart: nothing is cached in the app, and the unique-key set
    // is rebuilt from the stored rows exactly as an index would be.
    takenKeys.clear();
    for (const m of messages) {
      const key = uniqueKey(m);
      if (key) takenKeys.add(key);
    }

    await postInbound(params);

    assert.equal(inboundCount('SMrestart001'), 1);
    assert.equal(theConversation().unreadCount, 1);
  });
});

describe('concurrent identical requests', () => {
  test('two simultaneous deliveries produce exactly one message and one unread', async () => {
    const params = { From: '+14155552671', Body: 'race', MessageSid: 'SMrace001' };

    const [a, b] = await Promise.all([postInbound(params), postInbound(params)]);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(inboundCount('SMrace001'), 1, 'the unique constraint must settle the race');
    assert.equal(theConversation().unreadCount, 1);
  });

  test('five simultaneous deliveries still produce exactly one', async () => {
    const params = { From: '+14155552671', Body: 'stampede', MessageSid: 'SMrace002' };

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => postInbound(params)));

    assert.deepEqual([...new Set(results.map((r) => r.status))], [200]);
    assert.equal(inboundCount('SMrace002'), 1);
    assert.equal(theConversation().unreadCount, 1);
  });

  test('the loser of the race reports a duplicate rather than erroring', async () => {
    const params = { From: '+14155552671', Body: 'race3', MessageSid: 'SMrace003' };
    await Promise.all([postInbound(params), postInbound(params)]);
    assert.equal(logged.filter((e) => e.eventType === 'webhook.inbound').length, 1);
    assert.equal(logged.filter((e) => e.eventType === 'webhook.duplicate').length, 1);
  });
});

describe('duplicate STOP must not re-apply the opt-out', () => {
  const params = { From: '+14155552671', Body: 'STOP', MessageSid: 'SMstop001' };

    test('the first STOP opts the contact out', async () => {
    await postInbound(params);
    const contact = contacts.get('+14155552671');
    assert.equal(contact.optedOut, true);
    assert.equal(contact.optOutSource, 'keyword');
    assert.equal(logged.filter((e) => e.eventType === 'optout.received').length, 1);
  });

  test('a duplicate STOP does not log a second opt-out event', async () => {
    await postInbound(params);
    logged.length = 0;
    await postInbound(params);
    assert.equal(logged.filter((e) => e.eventType === 'optout.received').length, 0);
  });

  test('a duplicate STOP does not mutate the opt-out timestamp again', async () => {
    await postInbound(params);
    const contact = contacts.get('+14155552671');
    const firstOptOutAt = contact.optedOutAt;
    const savesAfterFirst = contact.__saves;

    await postInbound(params);

    assert.equal(contact.optedOutAt, firstOptOutAt, 'consent state must not be rewritten');
    assert.equal(contact.__saves, savesAfterFirst, 'no second write to the contact');
  });

  test('a duplicate STOP does not re-cancel enrollments or re-skip follow-ups', async () => {
    await postInbound(params);
    const enrollmentsAfterFirst = enrollmentUpdates.length;
    const followingsAfterFirst = followingUpdates.length;

    await postInbound(params);

    assert.equal(enrollmentUpdates.length, enrollmentsAfterFirst);
    assert.equal(followingUpdates.length, followingsAfterFirst);
  });

  test('only one STOP message is stored as the compliance record', async () => {
    await postInbound(params);
    await postInbound(params);
    assert.equal(inboundCount('SMstop001'), 1);
  });
});

describe('duplicate START must not re-apply the opt-in', () => {
  test('the first START opts the contact back in; a duplicate does not log again', async () => {
    await postInbound({ From: '+14155552671', Body: 'STOP', MessageSid: 'SMs1' });
    await postInbound({ From: '+14155552671', Body: 'START', MessageSid: 'SMs2' });

    const contact = contacts.get('+14155552671');
    assert.equal(contact.optedOut, false);
    assert.equal(logged.filter((e) => e.eventType === 'optin.received').length, 1);

    logged.length = 0;
    await postInbound({ From: '+14155552671', Body: 'START', MessageSid: 'SMs2' });

    assert.equal(logged.filter((e) => e.eventType === 'optin.received').length, 0);
    assert.equal(logged.filter((e) => e.eventType === 'webhook.duplicate').length, 1);
  });

  test('a duplicate START does not rewrite optedInAt', async () => {
    await postInbound({ From: '+14155552671', Body: 'START', MessageSid: 'SMs3' });
    const contact = contacts.get('+14155552671');
    const firstOptedInAt = contact.optedInAt;

    await postInbound({ From: '+14155552671', Body: 'START', MessageSid: 'SMs3' });

    assert.equal(contact.optedInAt, firstOptedInAt);
  });
});

describe('distinct messages are still processed independently', () => {
  test('two different SIDs both land and both count', async () => {
    await postInbound({ From: '+14155552671', Body: 'one', MessageSid: 'SMa' });
    await postInbound({ From: '+14155552671', Body: 'two', MessageSid: 'SMb' });

    assert.equal(messages.length, 2);
    assert.equal(theConversation().unreadCount, 2);
    assert.equal(theConversation().lastMessagePreview, 'two');
  });

  test('the same body from the same number with a different SID is NOT a duplicate', async () => {
    await postInbound({ From: '+14155552671', Body: 'same text', MessageSid: 'SMx1' });
    await postInbound({ From: '+14155552671', Body: 'same text', MessageSid: 'SMx2' });
    assert.equal(messages.length, 2, 'de-duplication must key on the SID, never on content');
  });

  test('an inbound with NO MessageSid is still recorded (it just cannot be de-duplicated)', async () => {
    await postInbound({ From: '+14155552671', Body: 'no sid' });
    assert.equal(messages.length, 1);
    assert.equal(theConversation().unreadCount, 1);
    assert.ok(logged.some((e) => e.eventType === 'webhook.inbound'));
  });
});
