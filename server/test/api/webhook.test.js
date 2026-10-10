// Phase 10 — Stage 2G (webhook security) and Stage 7 (delivery receipts).
//
// Signatures are computed here from Twilio's published algorithm rather than
// with the SDK helper, so the SDK's validation is checked against an independent
// implementation instead of against itself.
//
// The SMSMessage double faithfully reproduces the controller's ATOMIC rank gate
// (`$or: [{status in lower}, {status nin known}]`), because that conditional
// update is the whole out-of-order / duplicate defence under test.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

const AUTH_TOKEN = 'phase10-webhook-auth-token';

// --- doubles ---------------------------------------------------------------
const logged = [];
stubModule('services/logService', { logEvent: async (e) => void logged.push(e) });

// Contacts, keyed by phone and by id.
let contacts;
let createdMessages;
let messages; // id -> message doc
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
    findOne: async (filter) => {
      if (filter.phone) return contacts.get(filter.phone) || null;
      return null;
    },
    findById: async (id) =>
      [...contacts.values()].find((c) => String(c._id) === String(id)) || null,
    updateOne: async () => ({ modifiedCount: 1 }),
  })
);

stubModule(
  'models/SMSMessage',
  fakeModel('SMSMessage', {
    create: async (doc) => {
      const saved = fakeDoc({ ...doc, _id: f.oid() });
      createdMessages.push(saved);
      if (doc.twilioSid) messages.set(String(saved._id), saved);
      return saved;
    },
    // Bug #2: the inbound handler now inserts through an upsert keyed on the
    // MessageSid, so the double has to implement it. Matching an existing row
    // means "replay" and must report upsertedCount 0; inserting reports 1.
    // Idempotency itself is covered in depth in webhook-idempotency.test.js.
    updateOne: async (filter, update, options = {}) => {
      const existing = [...messages.values()].find(
        (m) => m.direction === filter.direction && m.twilioSid === filter.twilioSid
      );
      if (existing) {
        return { matchedCount: 1, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
      }
      if (!options.upsert) {
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
      }
      const saved = fakeDoc({ ...(update.$setOnInsert || {}), _id: f.oid() });
      createdMessages.push(saved);
      if (saved.twilioSid) messages.set(String(saved._id), saved);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: saved._id };
    },
    findOne: async (filter) => {
      if (filter.twilioSid !== undefined) {
        return [...messages.values()].find((m) => m.twilioSid === filter.twilioSid) || null;
      }
      return null;
    },
    // Reproduce the controller's conditional (rank-gated) atomic update.
    findOneAndUpdate: async (filter, update) => {
      const doc = messages.get(String(filter._id));
      if (!doc) return null;
      const or = filter.$or || [];
      const lower = (or[0] && or[0].status && or[0].status.$in) || [];
      const known = (or[1] && or[1].status && or[1].status.$nin) || [];
      const currentRanksLower = lower.includes(doc.status);
      const currentIsUnrecognised = !known.includes(doc.status);
      if (!currentRanksLower && !currentIsUnrecognised) return null; // not strictly higher
      Object.assign(doc, update.$set);
      return doc;
    },
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
    updateOne: async (filter, update) => {
      enrollmentUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    },
  })
);

stubModule(
  'models/Following',
  fakeModel('Following', {
    updateMany: async (filter, update) => {
      followingUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    },
    updateOne: async (filter, update) => {
      followingUpdates.push({ filter, update });
      return { modifiedCount: 1 };
    },
  })
);

const RealSettings = require('../../models/Settings');
let settingsDoc;
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    getSingleton: async () => settingsDoc,
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
const STATUS = '/api/webhooks/twilio/status';

// Twilio's documented signature: HMAC-SHA1 over the full URL concatenated with
// each POST parameter's key and value, sorted by key, base64-encoded.
function twilioSignature(authToken, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function form(params) {
  return new URLSearchParams(params).toString();
}

async function postSigned(path, params, { signature, token = AUTH_TOKEN } = {}) {
  const url = `${api.base}${path}`;
  const sig = signature !== undefined ? signature : twilioSignature(token, url, params);
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sig !== null) headers['x-twilio-signature'] = sig;
  return api.post(path, { raw: form(params), headers });
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
  createdMessages = [];
  messages = new Map();
  conversations = new Map();
  enrollmentUpdates = [];
  followingUpdates = [];
  logged.length = 0;
  settingsDoc = fakeDoc(f.settings());
  config.webhook.validate = true;
  config.webhook.baseUrl = '';
});

// ---------------------------------------------------------------------------
describe('Stage 2G — webhook signature validation', () => {
  const params = { From: '+14155552671', To: '+15005550006', Body: 'hello', MessageSid: 'SM1' };

  test('a correctly signed inbound request is accepted', async () => {
    const res = await postSigned(INBOUND, params);
    assert.equal(res.status, 200);
    assert.match(res.text, /<Response><\/Response>/);
  });

  test('an INVALID signature is rejected with 403 and nothing is recorded', async () => {
    const res = await postSigned(INBOUND, params, { signature: 'YmFkLXNpZ25hdHVyZQ==' });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /Invalid Twilio signature/);
    assert.equal(createdMessages.length, 0, 'an unsigned request must not create a message');
    assert.equal(contacts.size, 0, 'an unsigned request must not create a contact');
  });

  test('a MISSING signature header is rejected with 403', async () => {
    const res = await postSigned(INBOUND, params, { signature: null });
    assert.equal(res.status, 403);
    assert.equal(createdMessages.length, 0);
  });

  test('a signature computed with the WRONG auth token is rejected', async () => {
    const res = await postSigned(INBOUND, params, { token: 'not-the-real-token' });
    assert.equal(res.status, 403);
  });

  test('a signature valid for DIFFERENT parameters is rejected (tamper detection)', async () => {
    const url = `${api.base}${INBOUND}`;
    const sig = twilioSignature(AUTH_TOKEN, url, { ...params, Body: 'original' });
    const res = await postSigned(INBOUND, { ...params, Body: 'tampered' }, { signature: sig });
    assert.equal(res.status, 403);
  });

  test('a signature valid for a DIFFERENT url is rejected', async () => {
    const sig = twilioSignature(AUTH_TOKEN, `${api.base}/api/webhooks/twilio/elsewhere`, params);
    const res = await postSigned(INBOUND, params, { signature: sig });
    assert.equal(res.status, 403);
  });

  test('the STATUS endpoint enforces the signature too', async () => {
    const statusParams = { MessageSid: 'SM1', MessageStatus: 'delivered' };
    const bad = await postSigned(STATUS, statusParams, { signature: 'bm9wZQ==' });
    assert.equal(bad.status, 403);
    const good = await postSigned(STATUS, statusParams);
    assert.equal(good.status, 200);
  });

  test('with no auth token configured the webhook answers 503, never "open"', async () => {
    config.twilio.authToken = '';
    try {
      const res = await postSigned(INBOUND, params);
      assert.equal(res.status, 503);
      assert.match(res.body.message, /not configured/);
      assert.equal(createdMessages.length, 0);
    } finally {
      config.twilio.authToken = AUTH_TOKEN;
    }
  });

  test('TWILIO_VALIDATE_WEBHOOK=false bypasses validation (local testing only)', async () => {
    config.webhook.validate = false;
    const res = await postSigned(INBOUND, params, { signature: null });
    assert.equal(res.status, 200);
  });

  test('an explicit TWILIO_WEBHOOK_BASE_URL is used to rebuild the signed URL', async () => {
    config.webhook.baseUrl = 'https://api.example.com';
    const signedForPublicUrl = twilioSignature(
      AUTH_TOKEN,
      `https://api.example.com${INBOUND}`,
      params
    );
    const res = await postSigned(INBOUND, params, { signature: signedForPublicUrl });
    assert.equal(res.status, 200, 'a signature for the public URL must validate behind a proxy');
  });

  test('a malformed/empty payload with a valid signature still answers 200 (never a retry storm)', async () => {
    const res = await postSigned(INBOUND, {});
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
describe('inbound SMS handling', () => {
  test('an unknown number creates a contact, a conversation and an inbound message', async () => {
    const res = await postSigned(INBOUND, {
      From: '+14155552671',
      To: '+15005550006',
      Body: 'hello there',
      MessageSid: 'SMin1',
    });
    assert.equal(res.status, 200);
    assert.equal(contacts.size, 1);
    assert.equal(conversations.size, 1);
    assert.equal(createdMessages.length, 1);
    assert.equal(createdMessages[0].direction, 'inbound');
    assert.equal(createdMessages[0].body, 'hello there');
  });

  test('the thread unread count is incremented and the preview updated', async () => {
    await postSigned(INBOUND, { From: '+14155552671', Body: 'first', MessageSid: 'SMa' });
    await postSigned(INBOUND, { From: '+14155552671', Body: 'second', MessageSid: 'SMb' });
    const convo = [...conversations.values()][0];
    assert.equal(convo.unreadCount, 2, 'two inbound messages must both count');
    assert.equal(convo.lastMessagePreview, 'second');
    assert.equal(convo.lastMessageDirection, 'inbound');
  });

  test('an inbound message reopens a closed thread AND clears a soft delete', async () => {
    await postSigned(INBOUND, { From: '+14155552671', Body: 'x', MessageSid: 'SM1' });
    const convo = [...conversations.values()][0];
    convo.status = 'closed';
    convo.deletedAt = new Date();
    await postSigned(INBOUND, { From: '+14155552671', Body: 'y', MessageSid: 'SM2' });
    assert.equal(convo.status, 'open');
    assert.equal(convo.deletedAt, null, 'a reply must not land in a hidden thread');
  });

  test('a webhook.inbound event is logged', async () => {
    await postSigned(INBOUND, { From: '+14155552671', Body: 'x', MessageSid: 'SM1' });
    assert.ok(logged.some((e) => e.eventType === 'webhook.inbound'));
  });

  test('an inbound STOP opts the contact out and cancels their automation', async () => {
    await postSigned(INBOUND, { From: '+14155552671', Body: 'STOP', MessageSid: 'SM1' });
    const contact = contacts.get('+14155552671');
    assert.equal(contact.optedOut, true);
    assert.equal(contact.optOutSource, 'keyword');
    assert.ok(contact.optedOutAt instanceof Date);

    const cancel = enrollmentUpdates.find((u) => u.update.$set.status === 'cancelled');
    assert.ok(cancel, 'active and paused enrollments must be cancelled');
    assert.deepEqual(cancel.filter.status, { $in: ['active', 'paused'] });
    assert.equal(cancel.update.$set.stopReason, 'opted_out');

    assert.ok(followingUpdates.length > 0, 'pending follow-up recipients must be skipped');
    const optOutEvent = logged.find((e) => e.eventType === 'optout.received');
    assert.ok(optOutEvent);
    assert.equal(optOutEvent.meta.source, 'keyword');
  });

  test('an inbound START opts the contact back in but does NOT re-enroll them', async () => {
    await postSigned(INBOUND, { From: '+14155552671', Body: 'STOP', MessageSid: 'SM1' });
    enrollmentUpdates.length = 0;
    await postSigned(INBOUND, { From: '+14155552671', Body: 'START', MessageSid: 'SM2' });
    const contact = contacts.get('+14155552671');
    assert.equal(contact.optedOut, false);
    assert.ok(contact.optedInAt instanceof Date);
    assert.equal(
      enrollmentUpdates.some((u) => u.update.$set && u.update.$set.status === 'active'),
      false,
      'opting back in must never resurrect a cancelled enrollment'
    );
    assert.ok(logged.some((e) => e.eventType === 'optin.received'));
  });

  test('opting out keeps optOutSource as history after opting back in', async () => {
    await postSigned(INBOUND, { From: '+14155552671', Body: 'STOP', MessageSid: 'SM1' });
    await postSigned(INBOUND, { From: '+14155552671', Body: 'START', MessageSid: 'SM2' });
    assert.equal(contacts.get('+14155552671').optOutSource, 'keyword');
  });

  test('an ORDINARY reply stops drip automation without opting the contact out', async () => {
    await postSigned(INBOUND, {
      From: '+14155552671',
      Body: 'Sounds good, thanks!',
      MessageSid: 'SM1',
    });
    const contact = contacts.get('+14155552671');
    assert.equal(contact.optedOut, false, 'a normal reply is not an opt-out');
    const replied = enrollmentUpdates.find((u) => u.update.$set.status === 'replied');
    assert.ok(replied, 'active enrollments must move to replied');
    assert.deepEqual(replied.filter.status, 'active');
    assert.equal(replied.update.$set.stopReason, 'replied');
  });

  test('"yes" is an ordinary reply: it stops automation and does NOT opt the contact in', async () => {
    await postSigned(INBOUND, { From: '+14155552671', Body: 'yes', MessageSid: 'SM1' });
    assert.ok(enrollmentUpdates.some((u) => u.update.$set.status === 'replied'));
    assert.equal(logged.some((e) => e.eventType === 'optin.received'), false);
  });

  test('HELP also stops drip automation (only STOP/START short-circuit)', async () => {
    await postSigned(INBOUND, { From: '+14155552671', Body: 'HELP', MessageSid: 'SM1' });
    assert.ok(enrollmentUpdates.some((u) => u.update.$set.status === 'replied'));
  });

  test('only follow-ups configured to stop on reply are skipped by an ordinary reply', async () => {
    await postSigned(INBOUND, { From: '+14155552671', Body: 'thanks', MessageSid: 'SM1' });
    const update = followingUpdates[0];
    assert.ok(update, 'expected a Following update');
    assert.deepEqual(update.filter.stopOnReply, { $ne: false });
  });

  test('an OPT-OUT skips pending follow-ups regardless of stopOnReply (consent overrides config)', async () => {
    await postSigned(INBOUND, { From: '+14155552671', Body: 'STOP', MessageSid: 'SM1' });
    const update = followingUpdates[0];
    assert.ok(update);
    assert.equal('stopOnReply' in update.filter, false, 'consent must not respect that switch');
  });

  test('a compliance failure never fails the webhook (Twilio would duplicate the message)', async () => {
    const Enrollment = require('../../models/Enrollment');
    const original = Enrollment.updateMany;
    Enrollment.updateMany = async () => {
      throw new Error('database unavailable');
    };
    try {
      const res = await postSigned(INBOUND, {
        From: '+14155552671',
        Body: 'STOP',
        MessageSid: 'SM1',
      });
      assert.equal(res.status, 200, 'the webhook must still acknowledge');
      assert.ok(
        logged.some((e) => e.eventType === 'webhook.inbound' && e.severity === 'error'),
        'the failure must be recorded'
      );
    } finally {
      Enrollment.updateMany = original;
    }
  });

  test('the reply is acknowledged with EMPTY TwiML — the app sends no auto-reply', async () => {
    const res = await postSigned(INBOUND, { From: '+14155552671', Body: 'hi', MessageSid: 'SM1' });
    assert.match(res.headers.get('content-type'), /text\/xml/);
    assert.equal(res.text.includes('<Message>'), false, 'no outbound message may be returned');
    assert.match(res.text, /<Response><\/Response>/);
  });
});

// ---------------------------------------------------------------------------
describe('Stage 7 — delivery status callbacks', () => {
  function seedMessage(overrides = {}) {
    const doc = fakeDoc(
      f.smsMessage({ _id: f.oid(), twilioSid: 'SMdelivery1', status: 'queued', ...overrides })
    );
    messages.set(String(doc._id), doc);
    return doc;
  }

  async function receipt(params) {
    return postSigned(STATUS, params);
  }

  test('queued -> sent is applied', async () => {
    const msg = seedMessage({ status: 'queued' });
    const res = await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'sent' });
    assert.equal(res.status, 200);
    assert.equal(msg.status, 'sent');
    assert.ok(msg.statusUpdatedAt instanceof Date);
  });

  test('sent -> delivered is applied and stamps deliveredAt', async () => {
    const msg = seedMessage({ status: 'sent' });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'delivered' });
    assert.equal(msg.status, 'delivered');
    assert.ok(msg.deliveredAt instanceof Date);
  });

  test('a delivered receipt for a KNOWN contact logs delivery.delivered', async () => {
    const contact = fakeDoc(f.contact({ _id: f.oid() }));
    contacts.set(contact.phone, contact);
    const msg = seedMessage({ status: 'sent', contact: contact._id });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'delivered' });
    assert.ok(logged.some((e) => e.eventType === 'delivery.delivered'));
  });

  test('a delivered receipt for an UNKNOWN contact still updates the message', async () => {
    // message.contact is unset and the number matches no contact: the message
    // must still advance, it simply has no contact health to update.
    const msg = seedMessage({ status: 'sent', to: '+19998887777' });
    delete msg.contact;
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'delivered' });
    assert.equal(msg.status, 'delivered');
  });

  test('accepted and sending are accepted as intermediate states', async () => {
    const a = seedMessage({ status: 'accepted', twilioSid: 'SMa' });
    await receipt({ MessageSid: 'SMa', MessageStatus: 'sending' });
    assert.equal(a.status, 'sending');
  });

  test('an OUT-OF-ORDER receipt (sent after delivered) is IGNORED', async () => {
    const msg = seedMessage({ status: 'delivered' });
    const res = await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'sent' });
    assert.equal(res.status, 200, 'it must still acknowledge so Twilio stops retrying');
    assert.equal(msg.status, 'delivered', 'a late "sent" must not overwrite "delivered"');
    assert.ok(logged.some((e) => e.eventType === 'delivery.ignored'));
  });

  test('a DUPLICATE delivered receipt is a no-op', async () => {
    const msg = seedMessage({ status: 'delivered' });
    logged.length = 0;
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'delivered' });
    assert.equal(msg.status, 'delivered');
    const ignored = logged.find((e) => e.eventType === 'delivery.ignored');
    assert.ok(ignored, 'the duplicate must be logged as ignored, not applied twice');
  });

  test('a duplicate FAILURE receipt cannot increment the failure counter twice', async () => {
    const contact = fakeDoc(f.contact({ _id: f.oid() }));
    contacts.set(contact.phone, contact);
    const msg = seedMessage({ status: 'queued', contact: contact._id });

    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'undelivered', ErrorCode: '30003' });
    assert.equal(contact.deliveryFailureCount, 1);

    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'undelivered', ErrorCode: '30003' });
    assert.equal(contact.deliveryFailureCount, 1, 'the counter must stay honest under retries');
  });

  test('a permanent error code blocks the contact on the first receipt', async () => {
    const contact = fakeDoc(f.contact({ _id: f.oid() }));
    contacts.set(contact.phone, contact);
    const msg = seedMessage({ status: 'sent', contact: contact._id });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'failed', ErrorCode: '30005' });
    assert.equal(contact.deliveryBlocked, true);
    assert.ok(logged.some((e) => e.eventType === 'delivery.blocked'));
  });

  test('a transient failure below the threshold does not block', async () => {
    const contact = fakeDoc(f.contact({ _id: f.oid() }));
    contacts.set(contact.phone, contact);
    const msg = seedMessage({ status: 'sent', contact: contact._id });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'undelivered', ErrorCode: '30003' });
    assert.equal(contact.deliveryBlocked, false);
    assert.ok(logged.some((e) => e.eventType === 'delivery.failed'));
  });

  test('a 21610 receipt is routed to OPT-OUT, not to the delivery-failure counter', async () => {
    const contact = fakeDoc(f.contact({ _id: f.oid() }));
    contacts.set(contact.phone, contact);
    const msg = seedMessage({ status: 'sent', contact: contact._id });

    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'undelivered', ErrorCode: '21610' });

    assert.equal(contact.optedOut, true, 'a carrier unsubscribe is consent');
    assert.equal(contact.optOutSource, 'carrier');
    assert.equal(contact.deliveryBlocked, false, 'it must NOT be treated as a deliverability block');
    assert.equal(contact.deliveryFailureCount, 0, 'it must not count as a failure');
    const event = logged.find((e) => e.eventType === 'optout.received');
    assert.ok(event);
    assert.equal(event.meta.via, 'status_callback');
    assert.equal(event.meta.twilioCode, 21610);
  });

  test('a receipt for an UNKNOWN sid is acknowledged and logged, never an error', async () => {
    const res = await receipt({ MessageSid: 'SMnever-seen', MessageStatus: 'delivered' });
    assert.equal(res.status, 200);
    const event = logged.find((e) => e.eventType === 'delivery.ignored');
    assert.ok(event);
    assert.equal(event.status, 'unknown_message');
  });

  test('a receipt with a MISSING sid is acknowledged and logged', async () => {
    const res = await receipt({ MessageStatus: 'delivered' });
    assert.equal(res.status, 200);
    assert.ok(logged.some((e) => e.eventType === 'delivery.ignored' && e.status === 'ignored'));
  });

  test('a receipt with a MISSING status is acknowledged and logged', async () => {
    const res = await receipt({ MessageSid: 'SMx' });
    assert.equal(res.status, 200);
    assert.ok(logged.some((e) => e.eventType === 'delivery.ignored'));
  });

  test('an UNRECOGNISED status is ignored rather than stored', async () => {
    const msg = seedMessage({ status: 'sent' });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'teleported' });
    assert.equal(msg.status, 'sent', 'an unknown status ranks 0 and must not be applied');
  });

  test('a legacy row with an unrecognised status can still be advanced', async () => {
    const msg = seedMessage({ status: 'some-legacy-value' });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'delivered' });
    assert.equal(msg.status, 'delivered');
  });

  test('a delivered receipt resets a prior failure streak', async () => {
    const contact = fakeDoc(f.contact({ _id: f.oid(), deliveryFailureCount: 2 }));
    contacts.set(contact.phone, contact);
    const msg = seedMessage({ status: 'sent', contact: contact._id });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'delivered' });
    assert.equal(contact.deliveryFailureCount, 0);
  });

  test('the outcome is propagated to the enrollment step that produced the message', async () => {
    const msg = seedMessage({ status: 'sent' });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'delivered' });
    const update = enrollmentUpdates.find((u) => u.filter['sentSteps.twilioSid']);
    assert.ok(update, 'the enrollment step status should be updated');
    assert.equal(update.update.$set['sentSteps.$[s].status'], 'delivered');
  });

  test('a DELIVERED receipt leaves a follow-up recipient as "sent" (its enum has no delivered)', async () => {
    const msg = seedMessage({ status: 'sent' });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'delivered' });
    assert.equal(followingUpdates.length, 0, 'no Following write is expected for a success');
  });

  test('a FAILED receipt marks the follow-up recipient failed', async () => {
    const msg = seedMessage({ status: 'sent' });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'failed', ErrorCode: '30008' });
    const update = followingUpdates.find((u) => u.filter['recipients.twilioSid']);
    assert.ok(update);
    assert.equal(update.update.$set['recipients.$[r].status'], 'failed');
  });

  test('a propagation failure does not fail the webhook', async () => {
    const Enrollment = require('../../models/Enrollment');
    const original = Enrollment.updateOne;
    Enrollment.updateOne = async () => {
      throw new Error('propagation exploded');
    };
    try {
      const msg = seedMessage({ status: 'sent' });
      const res = await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'delivered' });
      assert.equal(res.status, 200);
    } finally {
      Enrollment.updateOne = original;
    }
  });

  test('the status endpoint never sends an SMS: it returns empty TwiML', async () => {
    const msg = seedMessage({ status: 'sent' });
    const res = await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'delivered' });
    assert.match(res.text, /<Response><\/Response>/);
    assert.equal(createdMessages.length, 0, 'no new message may be created by a receipt');
  });

  test('an ErrorCode is recorded on the message', async () => {
    const msg = seedMessage({ status: 'sent' });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'failed', ErrorCode: '30007' });
    assert.equal(msg.errorCode, 30007);
  });

  test('a non-numeric ErrorCode does not corrupt the record', async () => {
    const msg = seedMessage({ status: 'sent' });
    await receipt({ MessageSid: msg.twilioSid, MessageStatus: 'failed', ErrorCode: 'not-a-number' });
    assert.equal(msg.status, 'failed');
    assert.equal(Number.isNaN(msg.errorCode), false, 'NaN must never be stored');
  });

  const terminalStates = ['delivered', 'undelivered', 'failed', 'canceled'];
  for (const first of terminalStates) {
    for (const second of terminalStates) {
      if (first === second) continue;
      test(`a ${second} receipt after ${first} is ignored (terminal states share the top rank)`, async () => {
        const msg = seedMessage({ status: first, twilioSid: `SM-${first}-${second}` });
        await receipt({ MessageSid: msg.twilioSid, MessageStatus: second });
        assert.equal(msg.status, first);
      });
    }
  }
});

// ===========================================================================
// A reply must land on the EXISTING contact and its ONE conversation — matched
// on the normalized number, and regardless of whether the contact has a name.
describe('inbound reply matching', () => {
  const PHONE = '+15122345678';
  const reply = (extra = {}) => ({ From: PHONE, To: '+15005550006', Body: 'Yes, call me', MessageSid: 'SMreply1', ...extra });

  // An existing contact with its conversation, as an earlier outbound left them.
  function existing({ name }) {
    const contact = fakeDoc(f.contact({ _id: f.oid(), phone: PHONE, name }));
    contacts.set(PHONE, contact);
    const convo = fakeDoc(
      f.conversation({
        _id: f.oid(),
        contact: String(contact._id),
        contactName: name,
        contactPhone: PHONE,
        unreadCount: 0,
        lastMessagePreview: 'Hi, quick question about your practice.',
        lastMessageDirection: 'outbound',
        lastMessageAt: new Date(Date.now() - 60 * 60 * 1000),
      })
    );
    conversations.set(String(contact._id), convo);
    return { contact, convo };
  }

  for (const [label, name] of [['a named contact', 'Austin City Dental'], ['a contact with NO name', ''], ['a contact with a blank name', '   ']]) {
    test(`a reply from ${label} reuses the contact and its conversation`, async () => {
      const { contact, convo } = existing({ name });
      const before = convo.lastMessageAt.getTime();

      const res = await postSigned(INBOUND, reply());
      assert.equal(res.status, 200);

      assert.equal(contacts.size, 1, 'no duplicate contact');
      assert.equal(conversations.size, 1, 'no duplicate conversation');
      const inbound = createdMessages.find((m) => m.direction === 'inbound');
      assert.equal(String(inbound.contact), String(contact._id));
      assert.equal(String(inbound.conversation), String(convo._id));
      // The thread's preview and latest-message info are updated.
      assert.equal(convo.lastMessagePreview, 'Yes, call me');
      assert.equal(convo.lastMessageDirection, 'inbound');
      assert.ok(convo.lastMessageAt.getTime() > before);
      assert.equal(convo.unreadCount, 1);
      // The contact's name is exactly what it was — never overwritten.
      assert.equal(contact.name, name);
    });
  }

  test('the sender is matched on the NORMALIZED number, however it arrives', async () => {
    const { contact, convo } = existing({ name: 'Austin City Dental' });
    for (const [i, From] of ['15122345678', '(512) 234-5678', ' +1 512-234-5678 '].entries()) {
      const res = await postSigned(INBOUND, reply({ From, MessageSid: `SMfmt${i}` }));
      assert.equal(res.status, 200);
    }
    assert.equal(contacts.size, 1, 'three formats of one number are one contact');
    assert.equal(conversations.size, 1);
    assert.equal(convo.unreadCount, 3);
    assert.ok(createdMessages.every((m) => String(m.contact) === String(contact._id)));
  });

  test('the webhook only ever writes the phone, and only on insert — never a name', async () => {
    existing({ name: 'Austin City Dental' });
    await postSigned(INBOUND, reply());
    const Contact = require('../../models/Contact');
    const upserts = Contact.__callsTo('findOneAndUpdate');
    const [filter, update] = upserts[upserts.length - 1].args;
    assert.deepEqual(filter, { phone: PHONE });
    assert.deepEqual(update, { $setOnInsert: { phone: PHONE } });
  });

  test('a duplicate delivery of the same MessageSid is still handled once', async () => {
    const { convo } = existing({ name: '' });
    await postSigned(INBOUND, reply());
    const again = await postSigned(INBOUND, reply());
    assert.equal(again.status, 200);
    assert.equal(createdMessages.filter((m) => m.direction === 'inbound').length, 1);
    assert.equal(convo.unreadCount, 1, 'the replay did not repeat any effect');
    assert.ok(logged.some((e) => e.eventType === 'webhook.duplicate'));
  });

  test('the signature is still required', async () => {
    existing({ name: 'Austin City Dental' });
    const res = await postSigned(INBOUND, reply(), { signature: 'YmFk' });
    assert.equal(res.status, 403);
    assert.equal(createdMessages.length, 0);
  });
});
