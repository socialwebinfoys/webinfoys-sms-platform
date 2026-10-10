// Phase 10 — Stage 3: the HTTP send paths (manual, retry, inbox reply) and
// Stage 4 consent enforcement on each of them.
//
// twilioService is substituted so Twilio outcomes (success, transient failure,
// permanent failure, 21610) can be driven deterministically. The send guards
// themselves (sendPolicy, optOut) are the real implementations.
//
// REPLY LINE-TYPE POLICY (Phase 10 decision): the line-type filter applies to
// inbox replies as well, EXCEPT for a contact who has messaged us
// (`lastInboundAt` set) — their number is proven able to receive SMS, so the
// classification must not stop an operator answering them.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

// --- doubles ---------------------------------------------------------------
const logged = [];
stubModule('services/logService', { logEvent: async (e) => void logged.push(e) });

let sendOutcome;
let sendCalls;
stubModule('services/twilioService', {
  sendSms: async (args) => {
    sendCalls.push(args);
    return sendOutcome(args);
  },
  isConfigured: () => true,
  status: () => ({ configured: true, simulate: true, accountSid: 'AC****abcd', from: '+15005550006' }),
  PERMANENT_CODES: new Set([21610, 21211, 21614, 21408]),
});

let lookupResult;
let lookupCalls;
stubModule('services/lookupService', {
  lookupNumber: async (phone) => {
    lookupCalls.push(phone);
    return lookupResult(phone);
  },
});

let contactsByPhone;
let contactsById;
stubModule(
  'models/Contact',
  fakeModel('Contact', {
    findById: (id) => query(contactsById.get(String(id)) || null),
    findOne: (filter) => query(contactsByPhone.get(filter && filter.phone) || null),
    updateOne: async () => ({ modifiedCount: 1 }),
  })
);

let createdMessages;
let messagesById;
stubModule(
  'models/SMSMessage',
  fakeModel('SMSMessage', {
    create: async (doc) => {
      const saved = fakeDoc({ ...doc, _id: f.oid() });
      createdMessages.push(saved);
      return saved;
    },
    findById: (id) => query(messagesById.get(String(id)) || null),
    findOne: () => query(null),
  })
);

let conversationsById;
stubModule(
  'models/Conversation',
  fakeModel('Conversation', {
    findOne: (filter) => query(conversationsById.get(String(filter._id)) || null),
    findById: (id) => query(conversationsById.get(String(id)) || null),
    updateOne: async () => ({ modifiedCount: 1 }),
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
  })
);

let templatesById;
stubModule(
  'models/Template',
  fakeModel('Template', { findById: (id) => query(templatesById.get(String(id)) || null) })
);

const operator = f.user();
stubModule(
  'models/User',
  fakeModel('User', { findById: (id) => query(String(id) === String(operator._id) ? operator : null) })
);

let enrollmentUpdates;
let followingUpdates;
stubModule(
  'models/Enrollment',
  fakeModel('Enrollment', {
    updateMany: async (filter, update) => {
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
  })
);
for (const m of ['models/Campaign', 'models/Import', 'models/ImportPreview', 'models/SystemLog']) {
  stubModule(m, fakeModel(m));
}
stubModule('jobs/automationWorker', {
  processDueEnrollments: async () => ({}),
  processDueFollowings: async () => ({}),
  start: () => {},
  stop: () => {},
});

const { startApp, tokenFor } = require('../_support/http');

let api;
let token;
const DAY = 24 * 60 * 60 * 1000;

const OK = () => ({ sid: 'SMsuccess1', status: 'queued', simulated: false, to: '', from: '+15005550006' });
function twilioError(message, { code, permanent, statusCode = 502 } = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.twilioCode = code;
  err.permanent = !!permanent;
  return err;
}

before(async () => {
  api = await startApp();
  token = tokenFor(operator);
});
after(async () => {
  await api.close();
});

// A contact with a fresh MOBILE classification, so the line-type filter has a
// definite answer without a Lookup call.
function mobileContact(overrides = {}) {
  return fakeDoc(
    f.contact({
      _id: f.oid(),
      lookup: {
        status: 'valid',
        type: 'mobile',
        carrier: 'Test',
        canonicalPhone: '+14155552671',
        lookedUpAt: new Date(Date.now() - DAY),
      },
      ...overrides,
    })
  );
}

function registerContact(contact) {
  contactsById.set(String(contact._id), contact);
  contactsByPhone.set(contact.phone, contact);
  return contact;
}

beforeEach(() => {
  logged.length = 0;
  sendCalls = [];
  lookupCalls = [];
  createdMessages = [];
  contactsByPhone = new Map();
  contactsById = new Map();
  messagesById = new Map();
  conversationsById = new Map();
  templatesById = new Map();
  enrollmentUpdates = [];
  followingUpdates = [];
  settingsDoc = fakeDoc(f.settings());
  sendOutcome = OK;
  lookupResult = async () => ({
    valid: true,
    phone: '+14155552671',
    type: 'mobile',
    carrier: 'Test',
    lookedUpAt: new Date(),
  });
});

// ===========================================================================
describe('Path 1 — POST /api/sms/send (manual)', () => {
  test('a successful send records the message and logs sms.sent', async () => {
    const contact = registerContact(mobileContact());
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hello' },
    });
    assert.equal(res.status, 201);
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].to, contact.phone);
    assert.equal(createdMessages.length, 1);
    assert.equal(createdMessages[0].source, 'manual');
    assert.ok(logged.some((e) => e.eventType === 'sms.sent'));
  });

  test('a body is required', async () => {
    const res = await api.post('/api/sms/send', { token, body: { to: '+14155552671' } });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });

  test('either a contactId or a to number is required', async () => {
    const res = await api.post('/api/sms/send', { token, body: { body: 'hi' } });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });

  test('an unknown contactId is 404', async () => {
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: f.oid(777), body: 'hi' },
    });
    assert.equal(res.status, 404);
    assert.equal(sendCalls.length, 0);
  });

  test('a malformed "to" number is 400 and nothing is sent', async () => {
    const res = await api.post('/api/sms/send', { token, body: { to: 'nope', body: 'hi' } });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
    assert.equal(createdMessages.length, 0);
  });

  test('smsEnabled=false blocks the send with 400 and records nothing', async () => {
    settingsDoc = fakeDoc(f.settings({ smsEnabled: false }));
    const contact = registerContact(mobileContact());
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hi' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /disabled in settings/);
    assert.equal(sendCalls.length, 0);
    assert.equal(createdMessages.length, 0, 'a disabled send must not be logged as a message');
  });

  test('an OPTED-OUT contact is refused with 403 and sms.blocked_optout', async () => {
    const contact = registerContact(mobileContact({ optedOut: true }));
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hi' },
    });
    assert.equal(res.status, 403);
    assert.equal(sendCalls.length, 0);
    assert.equal(createdMessages.length, 0);
    const event = logged.find((e) => e.eventType === 'sms.blocked_optout');
    assert.ok(event);
    assert.equal(event.meta.code, 'opted_out');
  });

  test('a RAW number belonging to an opted-out contact is refused too', async () => {
    registerContact(mobileContact({ optedOut: true }));
    const res = await api.post('/api/sms/send', {
      token,
      body: { to: '+14155552671', body: 'hi' },
    });
    assert.equal(res.status, 403);
    assert.equal(sendCalls.length, 0);
  });

  test('an INACTIVE contact is refused with 403', async () => {
    const contact = registerContact(mobileContact({ isActive: false }));
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hi' },
    });
    assert.equal(res.status, 403);
    assert.equal(sendCalls.length, 0);
  });

  test('a DELIVERY-BLOCKED contact is refused with 403', async () => {
    const contact = registerContact(mobileContact({ deliveryBlocked: true }));
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hi' },
    });
    assert.equal(res.status, 403);
    assert.equal(sendCalls.length, 0);
  });

  test('a BLOCKED LINE TYPE is refused with 422 and sms.blocked', async () => {
    settingsDoc = fakeDoc(f.settings({ allowedLineTypes: ['mobile'] }));
    const contact = registerContact(
      mobileContact({
        lookup: { status: 'valid', type: 'landline', lookedUpAt: new Date(Date.now() - DAY) },
      })
    );
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hi' },
    });
    assert.equal(res.status, 422);
    assert.match(res.body.message, /not an allowed line type/);
    assert.equal(sendCalls.length, 0);
    assert.equal(createdMessages.length, 0);
    const event = logged.find((e) => e.eventType === 'sms.blocked');
    assert.ok(event);
    assert.equal(event.meta.temporary, false);
    assert.equal(event.meta.type, 'landline');
  });

  test('an UNKNOWN line type is refused when not allowed', async () => {
    settingsDoc = fakeDoc(f.settings({ allowedLineTypes: ['mobile'] }));
    const contact = registerContact(
      mobileContact({ lookup: { status: 'valid', type: '', lookedUpAt: new Date(Date.now() - DAY) } })
    );
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hi' },
    });
    assert.equal(res.status, 422);
    assert.equal(sendCalls.length, 0);
  });

  test('a LOOKUP OUTAGE with no classification is refused with 503 (retryable)', async () => {
    settingsDoc = fakeDoc(f.settings({ allowedLineTypes: ['mobile'] }));
    lookupResult = async () => {
      throw twilioError('Lookup failed: upstream', { statusCode: 502 });
    };
    const contact = registerContact(fakeDoc(f.contact({ _id: f.oid() })));
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hi' },
    });
    assert.equal(res.status, 503, 'a transient classification failure must be retryable');
    assert.equal(sendCalls.length, 0);
    const event = logged.find((e) => e.eventType === 'sms.blocked');
    assert.equal(event.meta.temporary, true);
    assert.equal(event.severity, 'error');
  });

  test('a number Twilio reports INVALID is refused with 422', async () => {
    settingsDoc = fakeDoc(f.settings({ allowedLineTypes: ['mobile'] }));
    lookupResult = async () => ({ valid: false, phone: '+14155550000', type: '', lookedUpAt: new Date() });
    const contact = registerContact(fakeDoc(f.contact({ _id: f.oid() })));
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hi' },
    });
    assert.equal(res.status, 422);
    assert.equal(sendCalls.length, 0);
  });

  test('a TRANSIENT Twilio failure records a failed message and returns the upstream status', async () => {
    const contact = registerContact(mobileContact());
    sendOutcome = () => {
      throw twilioError('Failed to send SMS: service unavailable', { code: 20429 });
    };
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hi' },
    });
    assert.equal(res.status, 502);
    assert.equal(createdMessages.length, 1);
    assert.equal(createdMessages[0].status, 'failed');
    assert.ok(createdMessages[0].error);
    assert.ok(logged.some((e) => e.eventType === 'sms.failed'));
  });

  test('a PERMANENT Twilio failure (21211 invalid number) records the failure', async () => {
    const contact = registerContact(mobileContact());
    sendOutcome = () => {
      throw twilioError('Failed to send SMS: invalid number', { code: 21211, permanent: true });
    };
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hi' },
    });
    assert.equal(res.status, 502);
    assert.equal(createdMessages[0].status, 'failed');
    assert.equal(contactsById.get(String(contact._id)).optedOut, false, '21211 is not an opt-out');
  });

  test('a 21610 failure OPTS THE CONTACT OUT and cancels their automation', async () => {
    const contact = registerContact(mobileContact());
    sendOutcome = () => {
      throw twilioError('Failed to send SMS: unsubscribed', { code: 21610, permanent: true });
    };
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'hi' },
    });
    assert.equal(res.status, 502);
    assert.equal(contact.optedOut, true, 'a carrier unsubscribe must be recorded');
    assert.equal(contact.optOutSource, 'carrier');
    const event = logged.find((e) => e.eventType === 'optout.received');
    assert.ok(event);
    assert.equal(event.meta.path, 'manual');
    assert.ok(enrollmentUpdates.some((u) => u.update.$set.status === 'cancelled'));
    assert.ok(followingUpdates.length > 0);
  });

  test('after a 21610 the very next send to that contact is refused', async () => {
    const contact = registerContact(mobileContact());
    sendOutcome = () => {
      throw twilioError('unsubscribed', { code: 21610, permanent: true });
    };
    await api.post('/api/sms/send', { token, body: { contactId: String(contact._id), body: 'a' } });

    sendOutcome = OK;
    sendCalls = [];
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'b' },
    });
    assert.equal(res.status, 403, 'the withdrawn consent must now block the send');
    assert.equal(sendCalls.length, 0);
  });

  test('the send requires authentication', async () => {
    const res = await api.post('/api/sms/send', { body: { to: '+14155552671', body: 'hi' } });
    assert.equal(res.status, 401);
    assert.equal(sendCalls.length, 0);
  });
});

// ===========================================================================
describe('Path 2 — POST /api/sms/:id/retry', () => {
  function failedMessage(overrides = {}) {
    const msg = fakeDoc(
      f.smsMessage({
        _id: f.oid(),
        status: 'failed',
        body: 'original body',
        error: 'previous failure',
        ...overrides,
      })
    );
    messagesById.set(String(msg._id), msg);
    return msg;
  }

  test('a failed message is retried IN PLACE (one bubble, not two)', async () => {
    const contact = registerContact(mobileContact());
    const msg = failedMessage({ contact: contact._id });
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 200);
    assert.equal(sendCalls.length, 1);
    assert.equal(createdMessages.length, 0, 'a retry must not create a second message');
    assert.equal(msg.status, 'queued');
    assert.equal(msg.error, '');
    assert.ok(logged.some((e) => e.eventType === 'sms.retried'));
  });

  test('a message that is not failed cannot be retried', async () => {
    const contact = registerContact(mobileContact());
    const msg = failedMessage({ contact: contact._id, status: 'delivered' });
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Only failed messages can be retried/);
    assert.equal(sendCalls.length, 0);
  });

  test('an undelivered message IS retryable', async () => {
    const contact = registerContact(mobileContact());
    const msg = failedMessage({ contact: contact._id, status: 'undelivered' });
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 200);
  });

  test('an inbound message cannot be retried', async () => {
    const contact = registerContact(mobileContact());
    const msg = failedMessage({ contact: contact._id, direction: 'inbound' });
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });

  test('a soft-deleted message cannot be retried', async () => {
    const contact = registerContact(mobileContact());
    const msg = failedMessage({ contact: contact._id, deletedAt: new Date() });
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });

  test('a message with an empty body cannot be retried', async () => {
    const contact = registerContact(mobileContact());
    const msg = failedMessage({ contact: contact._id, body: '   ' });
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });

  test('smsEnabled=false blocks a retry', async () => {
    settingsDoc = fakeDoc(f.settings({ smsEnabled: false }));
    const contact = registerContact(mobileContact());
    const msg = failedMessage({ contact: contact._id });
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });

  test('a retry to an OPTED-OUT contact is refused — existing history is no shortcut', async () => {
    const contact = registerContact(mobileContact({ optedOut: true }));
    const msg = failedMessage({ contact: contact._id });
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 403);
    assert.equal(sendCalls.length, 0);
    const event = logged.find((e) => e.eventType === 'sms.blocked_optout');
    assert.equal(event.meta.path, 'retry');
  });

  test('a retry re-runs the LINE-TYPE filter', async () => {
    settingsDoc = fakeDoc(f.settings({ allowedLineTypes: ['mobile'] }));
    const contact = registerContact(
      mobileContact({
        lookup: { status: 'valid', type: 'tollFree', lookedUpAt: new Date(Date.now() - DAY) },
      })
    );
    const msg = failedMessage({ contact: contact._id });
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 422);
    assert.equal(sendCalls.length, 0);
    const event = logged.find((e) => e.eventType === 'sms.blocked');
    assert.equal(event.meta.path, 'retry');
  });

  test('a retry that hits 21610 opts the contact out', async () => {
    const contact = registerContact(mobileContact());
    const msg = failedMessage({ contact: contact._id });
    sendOutcome = () => {
      throw twilioError('unsubscribed', { code: 21610, permanent: true });
    };
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 502);
    assert.equal(contact.optedOut, true);
    const event = logged.find((e) => e.eventType === 'optout.received');
    assert.equal(event.meta.path, 'retry');
  });

  test('a retry whose contact has been deleted is 404', async () => {
    const msg = failedMessage({ contact: f.oid(888) });
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 404);
    assert.equal(sendCalls.length, 0);
  });

  test('a failed retry updates the SAME record and keeps it retryable', async () => {
    const contact = registerContact(mobileContact());
    const msg = failedMessage({ contact: contact._id });
    sendOutcome = () => {
      throw twilioError('still down', { code: 20429 });
    };
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 502);
    assert.equal(msg.status, 'failed');
    assert.equal(createdMessages.length, 0);
  });

  test('a retry requires authentication', async () => {
    const msg = failedMessage();
    const res = await api.post(`/api/sms/${msg._id}/retry`);
    assert.equal(res.status, 401);
    assert.equal(sendCalls.length, 0);
  });
});

// ===========================================================================
describe('Path 3 — POST /api/conversations/:id/reply', () => {
  function thread(contact, overrides = {}) {
    const convo = fakeDoc(
      f.conversation({ _id: f.oid(), contact: contact._id, contactPhone: contact.phone, ...overrides })
    );
    conversationsById.set(String(convo._id), convo);
    return convo;
  }

  test('a reply sends, records the message and updates the thread', async () => {
    const contact = registerContact(mobileContact());
    const convo = thread(contact);
    const res = await api.post(`/api/conversations/${convo._id}/reply`, {
      token,
      body: { body: 'thanks for getting in touch' },
    });
    assert.equal(res.status, 201);
    assert.equal(sendCalls.length, 1);
    assert.equal(createdMessages[0].source, 'reply');
    assert.equal(convo.lastMessageDirection, 'outbound');
    assert.equal(convo.lastMessagePreview, 'thanks for getting in touch');
    assert.ok(logged.some((e) => e.eventType === 'reply.sent'));
  });

  test('an outbound reply does NOT create unread state', async () => {
    const contact = registerContact(mobileContact());
    const convo = thread(contact, { unreadCount: 0 });
    await api.post(`/api/conversations/${convo._id}/reply`, { token, body: { body: 'hi' } });
    assert.equal(convo.unreadCount, 0);
  });

  test('a reply requires a body or a templateId', async () => {
    const contact = registerContact(mobileContact());
    const convo = thread(contact);
    const res = await api.post(`/api/conversations/${convo._id}/reply`, { token, body: {} });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });

  test('a template is rendered SERVER-SIDE against the real contact', async () => {
    const contact = registerContact(mobileContact({ name: 'Ada Lovelace' }));
    const convo = thread(contact);
    const template = { _id: f.oid(), body: 'Hello {{first_name}}, your code is {{code}}' };
    templatesById.set(String(template._id), template);
    const res = await api.post(`/api/conversations/${convo._id}/reply`, {
      token,
      body: { templateId: String(template._id), body: 'CLIENT SUPPLIED TEXT' },
    });
    assert.equal(res.status, 201);
    // The unresolved {{code}} renders empty and the result is trimmed.
    assert.equal(sendCalls[0].body, 'Hello Ada Lovelace, your code is');
    assert.equal(
      sendCalls[0].body.includes('CLIENT SUPPLIED TEXT'),
      false,
      'the template must win over anything the client sent'
    );
  });

  test('an unknown templateId is 400 and nothing is sent', async () => {
    const contact = registerContact(mobileContact());
    const convo = thread(contact);
    const res = await api.post(`/api/conversations/${convo._id}/reply`, {
      token,
      body: { templateId: f.oid(999) },
    });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });

  test('a template that renders empty is refused', async () => {
    const contact = registerContact(mobileContact({ name: '' }));
    const convo = thread(contact);
    const template = { _id: f.oid(), body: '{{first_name}}' };
    templatesById.set(String(template._id), template);
    const res = await api.post(`/api/conversations/${convo._id}/reply`, {
      token,
      body: { templateId: String(template._id) },
    });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });

  test('a soft-deleted thread cannot be replied to', async () => {
    const contact = registerContact(mobileContact());
    const convo = thread(contact, { deletedAt: new Date() });
    // The controller filters on { deletedAt: null }; emulate that lookup miss.
    conversationsById.delete(String(convo._id));
    const res = await api.post(`/api/conversations/${convo._id}/reply`, {
      token,
      body: { body: 'hi' },
    });
    assert.equal(res.status, 404);
    assert.equal(sendCalls.length, 0);
  });

  test('smsEnabled=false blocks a reply', async () => {
    settingsDoc = fakeDoc(f.settings({ smsEnabled: false }));
    const contact = registerContact(mobileContact());
    const convo = thread(contact);
    const res = await api.post(`/api/conversations/${convo._id}/reply`, {
      token,
      body: { body: 'hi' },
    });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
    assert.equal(createdMessages.length, 0);
  });

  test('a reply to an OPTED-OUT contact is refused with 403', async () => {
    const contact = registerContact(mobileContact({ optedOut: true }));
    const convo = thread(contact);
    const res = await api.post(`/api/conversations/${convo._id}/reply`, {
      token,
      body: { body: 'hi' },
    });
    assert.equal(res.status, 403);
    assert.equal(sendCalls.length, 0);
    assert.equal(createdMessages.length, 0);
    const event = logged.find((e) => e.eventType === 'sms.blocked_optout');
    assert.equal(event.meta.path, 'reply');
  });

  test('a reply to a DELIVERY-BLOCKED contact is refused with 403', async () => {
    const contact = registerContact(mobileContact({ deliveryBlocked: true }));
    const convo = thread(contact);
    const res = await api.post(`/api/conversations/${convo._id}/reply`, {
      token,
      body: { body: 'hi' },
    });
    assert.equal(res.status, 403);
    assert.equal(sendCalls.length, 0);
  });

  test('a reply that hits 21610 opts the contact out', async () => {
    const contact = registerContact(mobileContact());
    const convo = thread(contact);
    sendOutcome = () => {
      throw twilioError('unsubscribed', { code: 21610, permanent: true });
    };
    const res = await api.post(`/api/conversations/${convo._id}/reply`, {
      token,
      body: { body: 'hi' },
    });
    assert.equal(res.status, 502);
    assert.equal(contact.optedOut, true);
    const event = logged.find((e) => e.eventType === 'optout.received');
    assert.equal(event.meta.path, 'reply');
  });

  test('a failed reply records a failed message and logs reply.failed', async () => {
    const contact = registerContact(mobileContact());
    const convo = thread(contact);
    sendOutcome = () => {
      throw twilioError('carrier down', { code: 30008 });
    };
    const res = await api.post(`/api/conversations/${convo._id}/reply`, {
      token,
      body: { body: 'hi' },
    });
    assert.equal(res.status, 502);
    assert.equal(createdMessages[0].status, 'failed');
    assert.ok(logged.some((e) => e.eventType === 'reply.failed'));
  });

  // --- Phase 10 decision: the line-type filter applies to replies, except for
  // a contact who has demonstrably received SMS from us by replying to one.
  describe('line-type policy on replies (DEFECT-2 regression)', () => {
    test('a reply to a BLOCKED line type with no inbound history is refused', async () => {
      settingsDoc = fakeDoc(f.settings({ allowedLineTypes: ['mobile'] }));
      const contact = registerContact(
        mobileContact({
          lookup: { status: 'valid', type: 'landline', lookedUpAt: new Date(Date.now() - DAY) },
        })
      );
      delete contact.lastInboundAt;
      const convo = thread(contact);
      const res = await api.post(`/api/conversations/${convo._id}/reply`, {
        token,
        body: { body: 'hi' },
      });
      assert.equal(res.status, 422, 'the admin line-type policy must apply to replies too');
      assert.equal(sendCalls.length, 0);
      assert.equal(createdMessages.length, 0);
      const event = logged.find((e) => e.eventType === 'sms.blocked');
      assert.ok(event, 'expected an sms.blocked event');
      assert.equal(event.meta.path, 'reply');
    });

    test('a reply to a contact who HAS messaged us is allowed despite the line type', async () => {
      settingsDoc = fakeDoc(f.settings({ allowedLineTypes: ['mobile'] }));
      const contact = registerContact(
        mobileContact({
          lookup: { status: 'valid', type: 'landline', lookedUpAt: new Date(Date.now() - DAY) },
          lastInboundAt: new Date(),
        })
      );
      const convo = thread(contact);
      const res = await api.post(`/api/conversations/${convo._id}/reply`, {
        token,
        body: { body: 'answering your question' },
      });
      assert.equal(res.status, 201, 'an operator must be able to answer an inbound message');
      assert.equal(sendCalls.length, 1);
    });

    test('a proven-deliverable contact costs no Lookup call on reply', async () => {
      settingsDoc = fakeDoc(f.settings({ allowedLineTypes: ['mobile'] }));
      const contact = registerContact(
        fakeDoc(f.contact({ _id: f.oid(), lastInboundAt: new Date() }))
      );
      const convo = thread(contact);
      const res = await api.post(`/api/conversations/${convo._id}/reply`, {
        token,
        body: { body: 'hi' },
      });
      assert.equal(res.status, 201);
      assert.deepEqual(lookupCalls, [], 'the exemption must short-circuit before Lookup');
    });

    test('the consent gate still applies to a proven-deliverable contact', async () => {
      settingsDoc = fakeDoc(f.settings({ allowedLineTypes: ['mobile'] }));
      const contact = registerContact(
        mobileContact({ optedOut: true, lastInboundAt: new Date() })
      );
      const convo = thread(contact);
      const res = await api.post(`/api/conversations/${convo._id}/reply`, {
        token,
        body: { body: 'hi' },
      });
      assert.equal(res.status, 403, 'the exemption must never override consent');
      assert.equal(sendCalls.length, 0);
    });

    test('with the filter OFF, any line type can be replied to', async () => {
      settingsDoc = fakeDoc(f.settings()); // mobileOnly false, no allowedLineTypes
      const contact = registerContact(
        mobileContact({
          lookup: { status: 'valid', type: 'landline', lookedUpAt: new Date(Date.now() - DAY) },
        })
      );
      delete contact.lastInboundAt;
      const convo = thread(contact);
      const res = await api.post(`/api/conversations/${convo._id}/reply`, {
        token,
        body: { body: 'hi' },
      });
      assert.equal(res.status, 201);
    });
  });
});

// ===========================================================================
describe('cross-path invariants', () => {
  test('NO send path creates an SMSMessage when the send is blocked by a guard', async () => {
    settingsDoc = fakeDoc(f.settings({ allowedLineTypes: ['mobile'] }));
    const contact = registerContact(mobileContact({ optedOut: true }));
    const convo = fakeDoc(f.conversation({ _id: f.oid(), contact: contact._id }));
    conversationsById.set(String(convo._id), convo);
    const msg = fakeDoc(f.smsMessage({ _id: f.oid(), status: 'failed', contact: contact._id }));
    messagesById.set(String(msg._id), msg);

    await api.post('/api/sms/send', { token, body: { contactId: String(contact._id), body: 'a' } });
    await api.post(`/api/sms/${msg._id}/retry`, { token });
    await api.post(`/api/conversations/${convo._id}/reply`, { token, body: { body: 'c' } });

    assert.equal(createdMessages.length, 0, 'a blocked send must leave no message record');
    assert.equal(sendCalls.length, 0, 'nothing may reach Twilio');
  });

  test('every send path consults the master smsEnabled switch', async () => {
    settingsDoc = fakeDoc(f.settings({ smsEnabled: false }));
    const contact = registerContact(mobileContact());
    const convo = fakeDoc(f.conversation({ _id: f.oid(), contact: contact._id }));
    conversationsById.set(String(convo._id), convo);
    const msg = fakeDoc(f.smsMessage({ _id: f.oid(), status: 'failed', contact: contact._id }));
    messagesById.set(String(msg._id), msg);

    const results = [
      await api.post('/api/sms/send', { token, body: { contactId: String(contact._id), body: 'a' } }),
      await api.post(`/api/sms/${msg._id}/retry`, { token }),
      await api.post(`/api/conversations/${convo._id}/reply`, { token, body: { body: 'c' } }),
    ];
    for (const res of results) {
      assert.equal(res.status, 400, `expected a 400, got ${res.status}`);
      assert.match(res.body.message, /disabled in settings/);
    }
    assert.equal(sendCalls.length, 0);
  });

  test('every send path records a carrier opt-out on 21610', async () => {
    for (const pathName of ['manual', 'retry', 'reply']) {
      logged.length = 0;
      contactsByPhone = new Map();
      contactsById = new Map();
      const contact = registerContact(mobileContact());
      sendOutcome = () => {
        throw twilioError('unsubscribed', { code: 21610, permanent: true });
      };

      if (pathName === 'manual') {
        await api.post('/api/sms/send', {
          token,
          body: { contactId: String(contact._id), body: 'a' },
        });
      } else if (pathName === 'retry') {
        const msg = fakeDoc(
          f.smsMessage({ _id: f.oid(), status: 'failed', contact: contact._id, body: 'x' })
        );
        messagesById.set(String(msg._id), msg);
        await api.post(`/api/sms/${msg._id}/retry`, { token });
      } else {
        const convo = fakeDoc(f.conversation({ _id: f.oid(), contact: contact._id }));
        conversationsById.set(String(convo._id), convo);
        await api.post(`/api/conversations/${convo._id}/reply`, { token, body: { body: 'c' } });
      }

      assert.equal(contact.optedOut, true, `${pathName} did not record the carrier opt-out`);
      assert.equal(contact.optOutSource, 'carrier');
      const event = logged.find((e) => e.eventType === 'optout.received');
      assert.ok(event, `${pathName} did not log optout.received`);
      assert.equal(event.meta.path, pathName);
    }
  });
});

// ===========================================================================
// Merge fields on the manual paths. They use the SAME resolver as campaigns,
// follow-ups and the preview endpoint, so what an operator previews is what is
// sent, and a merge field typed by hand is never sent as literal text.
describe('merge fields on the manual paths', () => {
  const dental = () => registerContact(mobileContact({ name: 'Austin City Dental', phone: '+15121234567' }));
  function thread(contact) {
    const convo = fakeDoc(f.conversation({ _id: f.oid(), contact: contact._id, contactPhone: contact.phone }));
    conversationsById.set(String(convo._id), convo);
    return convo;
  }
  const preview = async (body, contact) =>
    (await api.post('/api/templates/preview', { token, body: { body, contactId: String(contact._id) } })).body.rendered;

  test('manual send: {{first_name}} and {{name}} resolve to the full contact name', async () => {
    const contact = dental();
    const res = await api.post('/api/sms/send', {
      token,
      body: { contactId: String(contact._id), body: 'Hi {{first_name}} — {{name}} / {{phone}}' },
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(sendCalls[0].body, 'Hi Austin City Dental — Austin City Dental / +15121234567');
    assert.equal(createdMessages[0].body, sendCalls[0].body, 'the recorded message is what was sent');
  });

  test('manual send to a raw number that IS a contact uses that contact', async () => {
    registerContact(mobileContact({ name: 'Austin City Dental', phone: '+15122345678' }));
    await api.post('/api/sms/send', { token, body: { to: '(512) 234-5678', body: 'Hi {{name}}' } });
    assert.equal(sendCalls[0].body, 'Hi Austin City Dental');
  });

  test('manual send to a number with no contact: placeholders are removed, never sent literally', async () => {
    const res = await api.post('/api/sms/send', { token, body: { to: '+14155552671', body: 'Hi {{first_name}}, your order is ready' } });
    assert.equal(res.status, 201, res.text);
    assert.equal(sendCalls[0].body, 'Hi, your order is ready');
  });

  test('manual send: a message that is ONLY an unresolvable field is refused, nothing sent', async () => {
    const res = await api.post('/api/sms/send', { token, body: { to: '+14155552671', body: '{{first_name}}' } });
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
    assert.equal(createdMessages.length, 0);
  });

  test('manual send: text without merge fields is sent byte-for-byte', async () => {
    const contact = dental();
    const body = 'Two  spaces ,  odd spacing {x} !  ';
    await api.post('/api/sms/send', { token, body: { contactId: String(contact._id), body } });
    assert.equal(sendCalls[0].body, body);
  });

  test('inbox reply: a typed merge field is filled in for THIS contact', async () => {
    const contact = dental();
    const convo = thread(contact);
    const res = await api.post(`/api/conversations/${convo._id}/reply`, { token, body: { body: 'Thanks {{First Name}}!' } });
    assert.equal(res.status, 201, res.text);
    assert.equal(sendCalls[0].body, 'Thanks Austin City Dental!');
  });

  test('inbox reply: a contact with no name never receives a literal placeholder', async () => {
    const contact = registerContact(mobileContact({ name: '', phone: '+15121234567' }));
    const convo = thread(contact);
    await api.post(`/api/conversations/${convo._id}/reply`, { token, body: { body: 'Hi {{first_name}}, are you open?' } });
    assert.equal(sendCalls[0].body, 'Hi, are you open?');
  });

  test('inbox reply: a plain typed reply is unchanged', async () => {
    const contact = dental();
    const convo = thread(contact);
    await api.post(`/api/conversations/${convo._id}/reply`, { token, body: { body: 'See you at 3,  thanks' } });
    assert.equal(sendCalls[0].body, 'See you at 3,  thanks');
  });

  test('the PREVIEW equals what is actually sent — template reply, typed reply and manual send', async () => {
    const contact = registerContact(
      mobileContact({ name: 'Austin City Dental', phone: '+15121234567', customFields: { city: 'Austin' } })
    );
    const convo = thread(contact);
    const body = 'Hi {{first_name}}, is {{Name}} in {{city}} taking patients? {{missing}}';
    const expected = await preview(body, contact);
    assert.equal(expected, 'Hi Austin City Dental, is Austin City Dental in Austin taking patients?');

    const template = { _id: f.oid(), body };
    templatesById.set(String(template._id), template);
    await api.post(`/api/conversations/${convo._id}/reply`, { token, body: { templateId: String(template._id) } });
    await api.post(`/api/conversations/${convo._id}/reply`, { token, body: { body } });
    await api.post('/api/sms/send', { token, body: { contactId: String(contact._id), body } });

    assert.equal(sendCalls.length, 3);
    for (const call of sendCalls) assert.equal(call.body, expected);
  });

  test('none of this performs a Lookup or reaches real Twilio', async () => {
    const contact = dental();
    const convo = thread(contact);
    await api.post('/api/sms/send', { token, body: { contactId: String(contact._id), body: 'Hi {{name}}' } });
    await api.post(`/api/conversations/${convo._id}/reply`, { token, body: { body: 'Hi {{name}}' } });
    assert.equal(lookupCalls.length, 0, 'no billable Lookup');
    assert.equal(sendCalls.length, 2, 'only the stubbed sender was called');
  });
});

// ===========================================================================
// A number Twilio Lookup DEFINITIVELY reported invalid is never sent to, on any
// of the three HTTP send paths, whatever the line-type filter is set to. The
// block comes from the shared consent gate, so it is identical on each path.
describe('a definitively invalid number is never sent to (manual, retry, reply)', () => {
  const ALL_TYPES = ['mobile', 'landline', 'fixedVoip', 'nonFixedVoip', 'tollFree', 'unknown'];
  const POLICIES = {
    'mobileOnly=false (the default)': () => f.settings({ mobileOnly: false }),
    'every line type allowed': () => f.settings({ allowedLineTypes: [...ALL_TYPES] }),
    'mobile only': () => f.settings({ allowedLineTypes: ['mobile'] }),
  };
  const invalidContact = (over = {}) =>
    registerContact(
      fakeDoc(f.contact({ _id: f.oid(), lookup: { status: 'invalid', type: '', lookedUpAt: new Date(Date.now() - DAY) }, ...over }))
    );
  function thread(contact) {
    const convo = fakeDoc(f.conversation({ _id: f.oid(), contact: contact._id, contactPhone: contact.phone }));
    conversationsById.set(String(convo._id), convo);
    return convo;
  }
  function failedMessage(contact) {
    const msg = fakeDoc(f.smsMessage({ _id: f.oid(), status: 'failed', body: 'original', contact: contact._id }));
    messagesById.set(String(msg._id), msg);
    return msg;
  }
  // Each path, as a function of the contact.
  const PATHS = {
    manual: (c) => api.post('/api/sms/send', { token, body: { contactId: String(c._id), body: 'hi' } }),
    'manual (raw number)': (c) => api.post('/api/sms/send', { token, body: { to: c.phone, body: 'hi' } }),
    retry: (c) => api.post(`/api/sms/${failedMessage(c)._id}/retry`, { token }),
    reply: (c) => api.post(`/api/conversations/${thread(c)._id}/reply`, { token, body: { body: 'hi' } }),
  };

  for (const [policyLabel, policy] of Object.entries(POLICIES)) {
    for (const [pathLabel, send] of Object.entries(PATHS)) {
      test(`${pathLabel}: blocked with ${policyLabel}`, async () => {
        settingsDoc = fakeDoc(policy());
        const res = await send(invalidContact());

        assert.equal(res.status, 403, res.text);
        assert.match(res.body.message, /invalid/i);
        assert.equal(sendCalls.length, 0, 'nothing may reach Twilio');
        assert.equal(createdMessages.length, 0, 'a blocked send leaves no message record');
        assert.deepEqual(lookupCalls, [], 'the cached result is used; no billable Lookup');
        const event = logged.find((e) => e.meta && e.meta.code === 'invalid_number');
        assert.ok(event, 'the block is logged with its reason code');
        assert.equal(event.status, 'blocked');
      });
    }
  }

  test('retry: the failed message is left as it was', async () => {
    const contact = invalidContact();
    const msg = failedMessage(contact);
    const res = await api.post(`/api/sms/${msg._id}/retry`, { token });
    assert.equal(res.status, 403);
    assert.equal(msg.status, 'failed');
    assert.equal(msg.__saves, 0);
  });

  test('reply: a contact who has messaged us is NOT exempt — the line-type exemption does not cover an invalid number', async () => {
    settingsDoc = fakeDoc(f.settings({ mobileOnly: false }));
    const contact = invalidContact({ lastInboundAt: new Date() });
    const convo = thread(contact);
    const res = await api.post(`/api/conversations/${convo._id}/reply`, { token, body: { body: 'hi' } });
    assert.equal(res.status, 403);
    assert.equal(sendCalls.length, 0);
    assert.equal(convo.__saves, 0, 'the thread is not touched');
  });

  // The other side: nothing short of a definitive result is treated as invalid.
  const NOT_INVALID = {
    'not checked': { status: 'unknown', type: '', lastError: '' },
    'a failed lookup attempt': { status: 'unknown', type: '', lastError: 'Lookup failed: Twilio 503', lastAttemptAt: new Date() },
    'valid but unclassifiable (Unknown)': { status: 'valid', type: '', lookedUpAt: new Date() },
    landline: { status: 'valid', type: 'landline', lookedUpAt: new Date() },
  };
  for (const [label, lookup] of Object.entries(NOT_INVALID)) {
    test(`${label} is NOT treated as invalid: every path still sends with the filter off`, async () => {
      settingsDoc = fakeDoc(f.settings({ mobileOnly: false }));
      for (const [pathLabel, send] of Object.entries(PATHS)) {
        contactsById = new Map();
        contactsByPhone = new Map();
        const contact = registerContact(fakeDoc(f.contact({ _id: f.oid(), lookup })));
        const res = await send(contact);
        assert.ok(res.status === 200 || res.status === 201, `${pathLabel}: ${res.status} ${res.text}`);
      }
      assert.equal(sendCalls.length, Object.keys(PATHS).length);
      assert.deepEqual(lookupCalls, [], 'and no Lookup is spent');
    });
  }

  test('a temporary Lookup failure is still a retryable 503, not an "invalid" block', async () => {
    settingsDoc = fakeDoc(f.settings({ allowedLineTypes: ['mobile'] }));
    lookupResult = async () => {
      throw twilioError('Lookup failed: upstream', { statusCode: 502 });
    };
    const contact = registerContact(fakeDoc(f.contact({ _id: f.oid() })));
    const res = await api.post('/api/sms/send', { token, body: { contactId: String(contact._id), body: 'hi' } });
    assert.equal(res.status, 503);
    assert.equal(contact.lookup.status, 'unknown', 'the failure did not mark the number invalid');
    assert.equal(logged.some((e) => e.meta && e.meta.code === 'invalid_number'), false);
  });
});
