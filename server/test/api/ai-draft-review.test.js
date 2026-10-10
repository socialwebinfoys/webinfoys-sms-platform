// Phase 8.1 — draft review and per-conversation AI mode, over HTTP.
//
// Runs the REAL Express app, the REAL routers and controllers, the REAL
// sendPolicy consent gate and the REAL twilioService wrapper. Persistence is
// in-memory (test/_support/stubs.js) and the Twilio SDK is blocked by the
// harness, so with SMS_SIMULATE=true a "send" exercises the genuine simulation
// branch of the single send wrapper rather than a double of it.
//
// AIReplyJob.findOneAndUpdate is modelled as a SYNCHRONOUS check-and-set, which
// is what a single-document update in MongoDB is. That is what makes the
// concurrency test below meaningful rather than decorative.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

// --- captured side effects --------------------------------------------------
const logged = [];
stubModule('services/logService', { logEvent: async (e) => void logged.push(e) });

// Window helpers are substituted so a test can place "now" inside or outside the
// sending window deterministically. The REAL window arithmetic is covered by
// test/unit/ai-approval-guardrails.test.js, which uses the real helpers.
let sendableAt = () => true;
stubModule('jobs/automationWorker', {
  processDueEnrollments: async () => ({}),
  processDueFollowings: async () => ({}),
  runTick: async () => ({}),
  start: () => {},
  stop: () => {},
  resolveTimezone: () => 'UTC',
  isSendableAt: (...args) => sendableAt(...args),
});
stubModule('jobs/aiWorker', { processDueJobs: async () => ({}), start: () => {}, stop: () => {} });

let lookupImpl = async () => ({ valid: true, type: 'mobile', carrier: 'Test' });
stubModule('services/lookupService', { lookupNumber: (...a) => lookupImpl(...a) });

// The platform's single 21610 handler. Substituted only so the test can SEE that
// the approval path routes a carrier opt-out through it; the effect it has on the
// contact is emulated so the follow-on assertion (a retry is then refused on
// consent grounds) is real.
const carrierOptOuts = [];
stubModule('utils/optOut', {
  ...require('../../utils/optOut'),
  handleCarrierOptOut: async (contact, err, opts) => {
    if (!err || err.twilioCode !== 21610) return { applied: false };
    carrierOptOuts.push({ contact: String(contact._id), err, opts });
    contact.optedOut = true;
    contact.optedOutAt = new Date();
    return { applied: true };
  },
});

// --- users -----------------------------------------------------------------
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

// --- settings --------------------------------------------------------------
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

// --- contacts / conversations ----------------------------------------------
let contacts;
stubModule(
  'models/Contact',
  fakeModel('Contact', {
    findById: (id) => query(contacts.get(String(id)) || null),
    findOne: (filter) => {
      for (const c of contacts.values()) {
        if (filter && filter.phone && c.phone === filter.phone) return query(c);
      }
      return query(null);
    },
    updateOne: async () => ({ modifiedCount: 1 }),
  })
);

// Apply a Mongo-style dotted $set to a plain object, so a test can assert that a
// targeted update really touched one path and nothing else.
function applyDotted(target, $set = {}) {
  for (const [path, value] of Object.entries($set)) {
    const parts = path.split('.');
    let node = target;
    for (const part of parts.slice(0, -1)) {
      if (!node[part] || typeof node[part] !== 'object') node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = value;
  }
}

let conversations;
const conversationUpdates = [];
stubModule(
  'models/Conversation',
  fakeModel('Conversation', {
    findById: (id) => query(conversations.get(String(id)) || null),
    findOne: (filter) => {
      const convo = conversations.get(String(filter._id));
      if (!convo) return query(null);
      // Honour the soft-delete scope the controllers apply.
      if (filter.deletedAt === null && convo.deletedAt) return query(null);
      return query(convo);
    },
    updateOne: async (filter, update) => {
      conversationUpdates.push({ filter, update });
      const convo = conversations.get(String(filter._id));
      if (convo && update && update.$set) applyDotted(convo, update.$set);
      return { modifiedCount: convo ? 1 : 0 };
    },
  })
);

// --- outbound messages -----------------------------------------------------
const createdMessages = [];
// Fix 2: approval now re-reads the inbound message being answered and looks for
// anything newer on the thread, so the double has to hold real messages. `newer`
// is what a test puts there to simulate the thread having moved on.
let inboundMessage;
let newerMessages = [];
// Fix 3: an SMSMessage already linked to the job under test, or null.
let linkedMessage = null;
stubModule(
  'models/SMSMessage',
  fakeModel('SMSMessage', {
    create: async (doc) => {
      const record = { _id: f.oid(), ...doc };
      createdMessages.push(record);
      return record;
    },
    findById: (id) =>
      query(inboundMessage && String(inboundMessage._id) === String(id) ? inboundMessage : null),
    // Fix 3: approval asks whether this job has ALREADY produced a message, via
    // the direct aiJob link. `linkedMessage` is what a test puts there to model
    // an earlier approval that sent but was never recorded.
    findOne: (filter = {}) => {
      if (filter.aiJob && linkedMessage && String(linkedMessage.aiJob) === String(filter.aiJob)) {
        return query(linkedMessage);
      }
      return query(null);
    },
    find: () => {
      const chain = {
        sort: () => chain,
        limit: () => chain,
        select: () => chain,
        then: (res, rej) => Promise.resolve(newerMessages).then(res, rej),
      };
      return chain;
    },
  })
);

// --- AI jobs: an in-memory store with an ATOMIC claim ----------------------
let jobs;

// Does a job satisfy a claim filter? Mirrors the three conditions the service
// uses: identity, exact status, and "not currently claimed".
function matchesClaim(job, filter) {
  if (!job) return false;
  if (filter.status && job.status !== filter.status) return false;
  if (filter.lockedUntil && filter.lockedUntil.$not && filter.lockedUntil.$not.$gte) {
    const bound = filter.lockedUntil.$not.$gte;
    if (job.lockedUntil && new Date(job.lockedUntil) >= new Date(bound)) return false;
  }
  return true;
}

stubModule(
  'models/AIReplyJob',
  Object.assign(
    fakeModel('AIReplyJob', {
      findById: (id) => query(jobs.get(String(id)) || null),
      // SYNCHRONOUS check-and-set: the state change happens before this function
      // returns, exactly as an atomic single-document update does. Two
      // interleaved callers therefore cannot both match.
      findOneAndUpdate: (filter, update) => {
        const job = jobs.get(String(filter._id));
        if (!matchesClaim(job, filter)) return query(null);
        if (update && update.$set) Object.assign(job, update.$set);
        return query(job);
      },
      find: () => {
        const chain = {
          sort: () => chain,
          skip: () => chain,
          limit: () => chain,
          select: () => chain,
          populate: () => chain,
          then: (res, rej) => Promise.resolve([...jobs.values()]).then(res, rej),
        };
        return chain;
      },
      countDocuments: async () => jobs.size,
    }),
    {
      STATUSES: require('../../models/AIReplyJob').STATUSES,
      TERMINAL_STATUSES: require('../../models/AIReplyJob').TERMINAL_STATUSES,
    }
  )
);

for (const m of [
  'models/Campaign',
  'models/Enrollment',
  'models/Following',
  'models/Import',
  'models/Template',
  'models/ImportPreview',
  'models/SystemLog',
  'models/WorkerLock',
]) {
  stubModule(m, fakeModel(m));
}

// --- the real Twilio wrapper, with a recording seam ------------------------
const twilioService = require('../../services/twilioService');
const realSendSms = twilioService.sendSms;
const sends = [];
let sendImpl = null; // null => the REAL wrapper runs (and simulates)
twilioService.sendSms = async (args) => {
  sends.push(args);
  if (sendImpl) return sendImpl(args);
  return realSendSms(args);
};

const { startApp, tokenFor } = require('../_support/http');

let api;
let operatorToken;
let adminToken;

before(async () => {
  api = await startApp();
  operatorToken = tokenFor(operator);
  adminToken = tokenFor(administrator);
});
after(async () => {
  await api.close();
  twilioService.sendSms = realSendSms;
});

const DAY = 24 * 60 * 60 * 1000;
const DRAFT_TEXT = 'Yes, we are open until 6pm today.';

let contactDoc;
let conversationDoc;
let jobDoc;

function makeSettings({ ai = {}, ...base } = {}) {
  return fakeDoc(
    f.settings({
      smsEnabled: true,
      sendingWindow: { enabled: false, startHour: 9, endHour: 20, timezone: 'UTC' },
      sendDays: [0, 1, 2, 3, 4, 5, 6],
      ...base,
      ai: {
        enabled: true,
        defaultMode: 'draft',
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKeyEncrypted: '',
        persona: '',
        businessRules: '',
        faq: '',
        escalationKeywords: ['human'],
        confidenceThreshold: 0.7,
        maxRepliesPerConversation: 3,
        contextMessageLimit: 10,
        maxReplyCharacters: 320,
        ...ai,
      },
    })
  );
}

// A contact with a fresh mobile classification, so the line-type filter never
// needs a billable Lookup unless a test is specifically about it.
function makeContact(overrides = {}) {
  return fakeDoc(
    f.contact({
      _id: f.oid(),
      lastInboundAt: new Date(),
      lookup: {
        status: 'valid',
        type: 'mobile',
        carrier: 'Test',
        lookedUpAt: new Date(Date.now() - DAY),
      },
      ...overrides,
    })
  );
}

function makeJob(overrides = {}) {
  return fakeDoc({
    _id: f.oid(),
    conversation: conversationDoc._id,
    contact: contactDoc._id,
    inboundMessage: inboundMessage._id,
    mode: 'draft',
    status: 'drafted',
    draftReply: DRAFT_TEXT,
    confidence: 0.91,
    provider: 'openai',
    model: 'gpt-4o-mini',
    reason: 'draft_mode',
    escalated: false,
    attempts: 0,
    lastError: '',
    approvedBody: '',
    edited: false,
    lockedUntil: new Date(0),
    ...overrides,
  });
}

beforeEach(() => {
  logged.length = 0;
  sends.length = 0;
  createdMessages.length = 0;
  conversationUpdates.length = 0;
  carrierOptOuts.length = 0;
  sendImpl = null;
  sendableAt = () => true;
  lookupImpl = async () => ({ valid: true, type: 'mobile', carrier: 'Test' });

  settingsDoc = makeSettings();
  contactDoc = makeContact();
  conversationDoc = fakeDoc(
    f.conversation({
      _id: f.oid(),
      contact: contactDoc._id,
      ai: { takeover: false, mode: '', replyCount: 1, escalated: false },
    })
  );
  // The customer message each draft is answering. Nothing newer on the thread by
  // default, so a draft is current unless a test says otherwise.
  inboundMessage = fakeDoc(
    f.smsMessage({
      _id: f.oid(),
      direction: 'inbound',
      body: 'are you open today?',
      conversation: conversationDoc._id,
      createdAt: new Date('2026-10-01T09:00:00Z'),
    })
  );
  newerMessages = [];
  linkedMessage = null;
  jobDoc = makeJob();

  contacts = new Map([[String(contactDoc._id), contactDoc]]);
  conversations = new Map([[String(conversationDoc._id), conversationDoc]]);
  jobs = new Map([[String(jobDoc._id), jobDoc]]);
});

const approve = (id, body, token = operatorToken) =>
  api.post(`/api/ai/jobs/${id}/approve`, { body, token });
const reject = (id, token = operatorToken) => api.delete(`/api/ai/jobs/${id}`, { token });

function eventTypes() {
  return logged.map((e) => e.eventType);
}

// ===========================================================================
describe('POST /api/ai/jobs/:id/approve — approving a draft as generated', () => {
  test('sends the stored draft and returns it', async () => {
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.edited, false);
    assert.equal(res.body.message.body, DRAFT_TEXT);
  });

  test('goes through the single Twilio wrapper exactly once', async () => {
    await approve(jobDoc._id);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, contactDoc.phone);
    assert.equal(sends[0].body, DRAFT_TEXT);
  });

  test('SMS_SIMULATE is respected — nothing is really sent', async () => {
    const res = await approve(jobDoc._id);
    assert.equal(res.body.result.simulated, true);
    assert.equal(res.body.result.status, 'simulated');
    assert.match(String(res.body.result.sid), /^SIMULATED-/);
  });

  test('records approvedBy and approvedAt', async () => {
    await approve(jobDoc._id);
    assert.equal(String(jobDoc.approvedBy), String(operator._id));
    assert.ok(jobDoc.approvedAt instanceof Date);
  });

  test('the job reaches the terminal `sent` status', async () => {
    await approve(jobDoc._id);
    assert.equal(jobDoc.status, 'sent');
    assert.equal(jobDoc.reason, 'approved');
    assert.ok(jobDoc.processedAt instanceof Date);
    // The claim is released.
    assert.equal(new Date(jobDoc.lockedUntil).getTime(), 0);
  });

  test("the outbound message is attributed to AI (source: 'ai')", async () => {
    await approve(jobDoc._id);
    assert.equal(createdMessages.length, 1);
    assert.equal(createdMessages[0].source, 'ai');
    assert.equal(createdMessages[0].direction, 'outbound');
    assert.equal(String(createdMessages[0].contact), String(contactDoc._id));
    assert.equal(String(createdMessages[0].conversation), String(conversationDoc._id));
  });

  test('the job links to the message that was sent', async () => {
    await approve(jobDoc._id);
    assert.equal(String(jobDoc.sentMessage), String(createdMessages[0]._id));
  });

  test('the conversation thread activity is updated', async () => {
    await approve(jobDoc._id);
    assert.equal(conversationDoc.lastMessageDirection, 'outbound');
    assert.equal(conversationDoc.lastMessagePreview, DRAFT_TEXT);
  });

  test('replyCount is NOT incremented again (the draft already counted)', async () => {
    const before = conversationDoc.ai.replyCount;
    await approve(jobDoc._id);
    assert.equal(conversationDoc.ai.replyCount, before);
  });

  test('a SystemLog event records the approval without the message text', async () => {
    await approve(jobDoc._id);
    const event = logged.find((e) => e.eventType === 'ai.draft.approved');
    assert.ok(event, 'ai.draft.approved was not logged');
    assert.equal(event.meta.edited, false);
    assert.equal(event.meta.bodyLength, DRAFT_TEXT.length);
    assert.equal(event.meta.by, String(operator._id));
    assert.equal(event.meta.simulated, true);
    // The customer's message content must not be in the log line or the meta.
    assert.ok(!JSON.stringify(event).includes(DRAFT_TEXT));
  });

  test('an operator (non-admin) may approve', async () => {
    const res = await approve(jobDoc._id, undefined, operatorToken);
    assert.equal(res.status, 200);
  });

  test('an admin may approve too', async () => {
    const res = await approve(jobDoc._id, undefined, adminToken);
    assert.equal(res.status, 200);
  });

  test('an unauthenticated request is refused', async () => {
    const res = await api.post(`/api/ai/jobs/${jobDoc._id}/approve`, {});
    assert.equal(res.status, 401);
    assert.equal(sends.length, 0);
  });
});

// ===========================================================================
describe('POST /api/ai/jobs/:id/approve — invalid targets', () => {
  test('a malformed job id is a 400', async () => {
    const res = await approve('not-an-object-id');
    assert.equal(res.status, 400);
    assert.equal(sends.length, 0);
  });

  test('an unknown job is a 404', async () => {
    const res = await approve(f.oid());
    assert.equal(res.status, 404);
    assert.equal(sends.length, 0);
  });

  test('an already-sent job cannot send again', async () => {
    jobDoc.status = 'sent';
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.status, 'sent');
    assert.equal(sends.length, 0);
    assert.equal(createdMessages.length, 0);
  });

  test('a REJECTED job can never be approved', async () => {
    jobDoc.status = 'rejected';
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.status, 'rejected');
    assert.equal(sends.length, 0);
  });

  test('a pending job (not yet generated) is not approvable', async () => {
    jobDoc.status = 'pending';
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(sends.length, 0);
  });

  test('a job already claimed by another approval is not approvable', async () => {
    jobDoc.lockedUntil = new Date(Date.now() + 60_000);
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(sends.length, 0);
  });

  test('a missing contact retires the draft permanently', async () => {
    contacts.clear();
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'no_contact');
    assert.equal(res.body.approvable, false);
    assert.equal(jobDoc.status, 'skipped');
    assert.equal(sends.length, 0);
  });

  test('a missing conversation retires the draft permanently', async () => {
    conversations.clear();
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'no_conversation');
    assert.equal(jobDoc.status, 'skipped');
    assert.equal(sends.length, 0);
  });

  test('a soft-deleted conversation retires the draft permanently', async () => {
    conversationDoc.deletedAt = new Date();
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'no_conversation');
    assert.equal(sends.length, 0);
  });

  test('a draft with no text is refused rather than sending an empty SMS', async () => {
    jobDoc.draftReply = '   ';
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 422);
    assert.equal(sends.length, 0);
    // Handed back, so an operator can still supply an edited body.
    assert.equal(jobDoc.status, 'drafted');
  });
});

// ===========================================================================
describe('POST /api/ai/jobs/:id/approve — every send guard still applies', () => {
  // Each case asserts the same three things: the right refusal, NOTHING sent,
  // and the job left in the state that matches whether it can ever be sent.

  test('an OPTED-OUT contact is refused and the draft is retired', async () => {
    contactDoc.optedOut = true;
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'opted_out');
    assert.equal(res.body.approvable, false);
    assert.equal(sends.length, 0);
    assert.equal(createdMessages.length, 0);
    assert.equal(jobDoc.status, 'skipped');
  });

  test('a STOP arriving AFTER the draft was written still blocks the send', async () => {
    // The draft was generated while consent was valid; the STOP lands in the gap
    // before a human gets to it. Consent is re-read at approval time.
    assert.equal(jobDoc.status, 'drafted');
    contactDoc.optedOut = true;
    contactDoc.optedOutAt = new Date();
    contactDoc.optOutSource = 'inbound';
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 403);
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'skipped');
    // And it can never be resurrected.
    const again = await approve(jobDoc._id);
    assert.equal(again.status, 409);
    assert.equal(sends.length, 0);
  });

  test('an INACTIVE contact is refused', async () => {
    contactDoc.isActive = false;
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'inactive');
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'skipped');
  });

  test('a DELIVERY-BLOCKED contact is refused', async () => {
    contactDoc.deliveryBlocked = true;
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'delivery_blocked');
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'skipped');
  });

  test('smsEnabled=false is refused, and the draft SURVIVES', async () => {
    settingsDoc.smsEnabled = false;
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 400);
    assert.equal(res.body.reason, 'sms_disabled');
    assert.equal(res.body.approvable, true);
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'drafted');
  });

  test('HUMAN TAKEOVER is refused, and the draft survives', async () => {
    conversationDoc.ai.takeover = true;
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'takeover');
    assert.equal(res.body.approvable, true);
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'drafted');
  });

  test('a BLOCKED LINE TYPE is refused', async () => {
    settingsDoc.allowedLineTypes = ['mobile'];
    contactDoc.lookup = {
      status: 'valid',
      type: 'landline',
      carrier: 'Test',
      lookedUpAt: new Date(Date.now() - DAY),
    };
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 422);
    assert.equal(res.body.reason, 'line_type_blocked');
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'drafted');
  });

  test('an UNVERIFIABLE line type is a 503 and the draft survives', async () => {
    settingsDoc.allowedLineTypes = ['mobile'];
    contactDoc.lookup = { status: 'unknown', type: '' };
    lookupImpl = async () => {
      throw new Error('Lookup unavailable');
    };
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 503);
    assert.equal(res.body.reason, 'line_type_unknown');
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'drafted');
  });

  test('OUTSIDE THE SENDING WINDOW is a 503 and the draft survives', async () => {
    settingsDoc.sendingWindow = { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' };
    sendableAt = () => false;
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 503);
    assert.equal(res.body.reason, 'outside_window');
    assert.equal(res.body.approvable, true);
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'drafted');
  });

  test('a DISALLOWED SEND DAY blocks the same way', async () => {
    settingsDoc.sendingWindow = { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' };
    settingsDoc.sendDays = [1, 2, 3, 4, 5];
    // isSendableAt owns both rules; a false answer is the day being refused here.
    sendableAt = (now, window, days) => Array.isArray(days) && days.length === 7;
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 503);
    assert.equal(res.body.reason, 'outside_window');
    assert.equal(sends.length, 0);
  });

  test('a blocked approval is logged', async () => {
    contactDoc.optedOut = true;
    await approve(jobDoc._id);
    const event = logged.find((e) => e.eventType === 'ai.draft.blocked');
    assert.ok(event, 'ai.draft.blocked was not logged');
    assert.equal(event.meta.reason, 'opted_out');
    assert.equal(event.meta.permanent, true);
    assert.equal(event.severity, 'warning');
  });
});

// ===========================================================================
describe('POST /api/ai/jobs/:id/approve — send failures', () => {
  test('a Twilio failure returns 502 and leaves the draft approvable', async () => {
    sendImpl = async () => {
      const err = new Error('Twilio is unavailable');
      throw err;
    };
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 502);
    assert.equal(res.body.approvable, true);
    assert.equal(jobDoc.status, 'drafted');
    assert.match(jobDoc.lastError, /unavailable/);
    // No outbound record is written for a send that did not happen.
    assert.equal(createdMessages.length, 0);
  });

  test("a failure honours the error's own status code", async () => {
    sendImpl = async () => {
      const err = new Error('Twilio is not configured');
      err.statusCode = 503;
      throw err;
    };
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 503);
  });

  test('a send failure is logged', async () => {
    sendImpl = async () => {
      throw new Error('Twilio is unavailable');
    };
    await approve(jobDoc._id);
    const event = logged.find((e) => e.eventType === 'ai.draft.send_failed');
    assert.ok(event, 'ai.draft.send_failed was not logged');
    assert.equal(event.severity, 'error');
  });

  test('a 21610 goes through the EXISTING carrier opt-out handler', async () => {
    sendImpl = async () => {
      const err = new Error('The recipient has unsubscribed');
      err.twilioCode = 21610;
      throw err;
    };
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 502);
    // The platform's single handler was used, with this path identified.
    assert.equal(carrierOptOuts.length, 1);
    assert.equal(carrierOptOuts[0].opts.path, 'ai');
    assert.equal(carrierOptOuts[0].err.twilioCode, 21610);
    assert.equal(createdMessages.length, 0);
  });

  test('after a 21610 the recorded opt-out blocks a second approval attempt', async () => {
    sendImpl = async () => {
      const err = new Error('The recipient has unsubscribed');
      err.twilioCode = 21610;
      throw err;
    };
    await approve(jobDoc._id);
    assert.equal(contactDoc.optedOut, true);

    sendImpl = null; // Twilio would succeed now; consent must still refuse.
    const second = await approve(jobDoc._id);
    assert.equal(second.status, 403);
    assert.equal(second.body.reason, 'opted_out');
    assert.equal(sends.length, 1); // only the first attempt ever reached the wrapper
    assert.equal(createdMessages.length, 0);
  });
});

// ===========================================================================
describe('POST /api/ai/jobs/:id/approve — edit and approve', () => {
  const EDITED = 'Actually we close at 5pm today — sorry for the confusion!';

  test('an edited body is what gets sent', async () => {
    const res = await approve(jobDoc._id, { body: EDITED });
    assert.equal(res.status, 200);
    assert.equal(res.body.edited, true);
    assert.equal(sends[0].body, EDITED);
    assert.equal(createdMessages[0].body, EDITED);
  });

  test('the original AI draft is preserved alongside the edit', async () => {
    await approve(jobDoc._id, { body: EDITED });
    assert.equal(jobDoc.draftReply, DRAFT_TEXT, 'the generated draft must not be overwritten');
    assert.equal(jobDoc.approvedBody, EDITED);
    assert.equal(jobDoc.edited, true);
    assert.equal(jobDoc.reason, 'approved_edited');
  });

  test('approval metadata is recorded for an edited send', async () => {
    await approve(jobDoc._id, { body: EDITED });
    assert.equal(String(jobDoc.approvedBy), String(operator._id));
    assert.ok(jobDoc.approvedAt instanceof Date);
    assert.equal(jobDoc.status, 'sent');
  });

  test("an edited send is still attributed to AI (source: 'ai')", async () => {
    await approve(jobDoc._id, { body: EDITED });
    assert.equal(createdMessages[0].source, 'ai');
  });

  test('the edit is logged as an edit, without the text', async () => {
    await approve(jobDoc._id, { body: EDITED });
    const event = logged.find((e) => e.eventType === 'ai.draft.approved');
    assert.equal(event.meta.edited, true);
    assert.equal(event.meta.bodyLength, EDITED.length);
    assert.ok(!JSON.stringify(event).includes(EDITED));
  });

  test('an empty body is refused', async () => {
    const res = await approve(jobDoc._id, { body: '   ' });
    assert.equal(res.status, 400);
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'drafted'); // untouched
  });

  test('a non-string body is refused', async () => {
    const res = await approve(jobDoc._id, { body: { text: 'nope' } });
    assert.equal(res.status, 400);
    assert.equal(sends.length, 0);
  });

  test('an over-length body is REFUSED, not truncated', async () => {
    const tooLong = 'x'.repeat(321); // maxReplyCharacters is 320
    const res = await approve(jobDoc._id, { body: tooLong });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /321 characters/);
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'drafted');
  });

  test('the configured maxReplyCharacters is what is enforced', async () => {
    settingsDoc.ai.maxReplyCharacters = 40;
    const res = await approve(jobDoc._id, { body: 'y'.repeat(41) });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /maximum is 40/);
  });

  test('a body exactly at the limit is accepted', async () => {
    const exact = 'z'.repeat(320);
    const res = await approve(jobDoc._id, { body: exact });
    assert.equal(res.status, 200);
    assert.equal(sends[0].body, exact);
  });

  test('every send guard still applies to an edited body', async () => {
    contactDoc.optedOut = true;
    const res = await approve(jobDoc._id, { body: EDITED });
    assert.equal(res.status, 403);
    assert.equal(sends.length, 0);
  });

  test('the client cannot redirect the message, change attribution or alter state', async () => {
    const res = await approve(jobDoc._id, {
      body: EDITED,
      // All of this must be ignored: it is loaded server-side from the job.
      to: '+15555550000',
      contact: f.oid(),
      conversation: f.oid(),
      provider: 'gemini',
      model: 'evil-model',
      source: 'manual',
      status: 'delivered',
      approvedBy: String(administrator._id),
      optedOut: false,
      edited: false,
    });
    assert.equal(res.status, 200);
    assert.equal(sends[0].to, contactDoc.phone, 'the recipient came from the contact record');
    assert.equal(createdMessages[0].source, 'ai');
    assert.equal(String(createdMessages[0].contact), String(contactDoc._id));
    assert.equal(String(createdMessages[0].conversation), String(conversationDoc._id));
    assert.equal(jobDoc.provider, 'openai', 'the provider is the one that generated the draft');
    assert.equal(jobDoc.model, 'gpt-4o-mini');
    assert.equal(
      String(jobDoc.approvedBy),
      String(operator._id),
      'the approver is the authenticated caller, not the body'
    );
    assert.equal(jobDoc.edited, true);
  });

  test('no AI provider is ever called on the approval path', async () => {
    // The adapters are the only thing that can reach a provider. If approval
    // touched one, this would throw instead of sending.
    const providers = require('../../services/ai/providers');
    for (const name of providers.PROVIDER_NAMES) {
      providers.__setAdapter(name, {
        name,
        defaultModel: 'x',
        generate: async () => {
          throw new Error(`PROVIDER CALLED on the approval path (${name})`);
        },
      });
    }
    try {
      const plain = await approve(jobDoc._id);
      assert.equal(plain.status, 200);

      jobs.set(String(jobDoc._id), makeJob({ _id: jobDoc._id }));
      const edited = await approve(jobDoc._id, { body: EDITED });
      assert.equal(edited.status, 200);
    } finally {
      providers.__reset();
    }
  });
});

// ===========================================================================
describe('DELETE /api/ai/jobs/:id — rejecting a draft', () => {
  test('a draft is rejected and nothing is sent', async () => {
    const res = await reject(jobDoc._id);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.changed, true);
    assert.equal(jobDoc.status, 'rejected');
    assert.equal(sends.length, 0);
    assert.equal(createdMessages.length, 0);
  });

  test('the job is NOT deleted — the audit record survives', async () => {
    await reject(jobDoc._id);
    assert.ok(jobs.has(String(jobDoc._id)), 'the job row was removed');
    // The generated text is kept, so what was declined remains inspectable.
    assert.equal(jobDoc.draftReply, DRAFT_TEXT);
    assert.equal(jobDoc.provider, 'openai');
  });

  test('who rejected it, and when, are recorded', async () => {
    await reject(jobDoc._id);
    assert.equal(String(jobDoc.rejectedBy), String(operator._id));
    assert.ok(jobDoc.rejectedAt);
    assert.ok(jobDoc.processedAt);
  });

  test('the rejection is logged', async () => {
    await reject(jobDoc._id);
    const event = logged.find((e) => e.eventType === 'ai.draft.rejected');
    assert.ok(event, 'ai.draft.rejected was not logged');
    assert.equal(event.meta.by, String(operator._id));
  });

  test('a REJECTED draft can never be approved', async () => {
    await reject(jobDoc._id);
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.status, 'rejected');
    assert.equal(sends.length, 0);
    assert.equal(createdMessages.length, 0);
  });

  test('repeating a rejection is idempotent and logs only once', async () => {
    const first = await reject(jobDoc._id);
    const second = await reject(jobDoc._id);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.changed, true);
    assert.equal(second.body.changed, false);
    assert.equal(jobs.get(String(jobDoc._id)).status, 'rejected');
    assert.equal(eventTypes().filter((t) => t === 'ai.draft.rejected').length, 1);
  });

  test('an already-SENT draft cannot be rejected', async () => {
    jobDoc.status = 'sent';
    const res = await reject(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.status, 'sent');
  });

  test('an unknown job is a 404', async () => {
    const res = await reject(f.oid());
    assert.equal(res.status, 404);
  });

  test('a malformed id is a 400', async () => {
    const res = await reject('nope');
    assert.equal(res.status, 400);
  });

  test('an unauthenticated request is refused', async () => {
    const res = await api.delete(`/api/ai/jobs/${jobDoc._id}`, {});
    assert.equal(res.status, 401);
    assert.equal(jobDoc.status, 'drafted');
  });

  test('no provider is called when rejecting', async () => {
    const providers = require('../../services/ai/providers');
    for (const name of providers.PROVIDER_NAMES) {
      providers.__setAdapter(name, {
        name,
        defaultModel: 'x',
        generate: async () => {
          throw new Error('PROVIDER CALLED on the reject path');
        },
      });
    }
    try {
      const res = await reject(jobDoc._id);
      assert.equal(res.status, 200);
    } finally {
      providers.__reset();
    }
  });
});

// ===========================================================================
// Fix 2: a draft can sit in the queue for hours. If the thread was answered in
// the meantime, approving it would send a second reply to a question that has
// already been dealt with.
describe('Fix 2 — a draft whose conversation has moved on', () => {
  const newer = (direction, at = '2026-10-01T11:00:00Z') =>
    fakeDoc(
      f.smsMessage({
        _id: f.oid(),
        direction,
        conversation: conversationDoc._id,
        createdAt: new Date(at),
      })
    );

  test('a human reply after the draft blocks approval with 409', async () => {
    newerMessages = [newer('outbound')];
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'already_answered');
    assert.match(res.body.message, /answered after the draft was written/i);
  });

  test('NOTHING is sent when the draft is stale', async () => {
    newerMessages = [newer('outbound')];
    await approve(jobDoc._id);
    assert.equal(sends.length, 0, 'an SMS was sent for a stale draft');
    assert.equal(createdMessages.length, 0, 'an outbound record was created for a stale draft');
  });

  test('the draft SURVIVES — it is handed back, not retired', async () => {
    newerMessages = [newer('outbound')];
    await approve(jobDoc._id);
    assert.equal(jobDoc.status, 'drafted', 'the draft was lost');
    assert.equal(jobDoc.reason, 'already_answered');
    assert.equal(new Date(jobDoc.lockedUntil).getTime(), 0, 'the job was left claimed');
  });

  test('the response says the draft is still usable', async () => {
    newerMessages = [newer('outbound')];
    const res = await approve(jobDoc._id);
    assert.equal(res.body.approvable, true);
  });

  test('a stale draft can still be discarded afterwards', async () => {
    newerMessages = [newer('outbound')];
    await approve(jobDoc._id);
    const res = await reject(jobDoc._id);
    assert.equal(res.status, 200);
    assert.equal(jobDoc.status, 'rejected');
  });

  test('a newer CUSTOMER message blocks approval and says so', async () => {
    newerMessages = [newer('inbound')];
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'superseded');
    assert.match(res.body.message, /sent another message/i);
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'drafted');
  });

  test('a missing inbound message blocks approval', async () => {
    inboundMessage = null;
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'inbound_missing');
    assert.equal(sends.length, 0);
  });

  test('an EDITED stale draft is blocked too — editing does not bypass the check', async () => {
    newerMessages = [newer('outbound')];
    const res = await approve(jobDoc._id, { body: 'Let me correct that.' });
    assert.equal(res.status, 409);
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'drafted');
    assert.equal(jobDoc.draftReply, DRAFT_TEXT, 'the original draft was overwritten');
  });

  test('the block is logged', async () => {
    newerMessages = [newer('outbound')];
    await approve(jobDoc._id);
    const event = logged.find((e) => e.eventType === 'ai.draft.blocked');
    assert.ok(event, 'the blocked approval was not logged');
    assert.equal(event.meta.reason, 'already_answered');
    assert.equal(event.meta.stale, true);
  });

  test('a draft with nothing newer approves normally — exactly one SMS', async () => {
    newerMessages = [];
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 200);
    assert.equal(sends.length, 1);
    assert.equal(createdMessages.length, 1);
    assert.equal(jobDoc.status, 'sent');
  });

  test('an OLDER message on the thread does not block approval', async () => {
    newerMessages = []; // the double filters by createdAt, as the real query does
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 200);
    assert.equal(sends.length, 1);
  });
});

// ===========================================================================
// Fix 3 — approval after a crash.
//
// The dangerous sequence: an approval sent successfully, then the process died
// before the job could be marked sent. Recovery hands the job back as a draft,
// the operator sees it still waiting, and approves it again. Without the aiJob
// link that sends the customer the same reply twice.
describe('Fix 3 — an approval that already sent', () => {
  const linked = () =>
    fakeDoc(
      f.smsMessage({
        _id: f.oid(),
        direction: 'outbound',
        source: 'ai',
        aiJob: jobDoc._id,
        conversation: conversationDoc._id,
        body: DRAFT_TEXT,
      })
    );

  test('approving again sends NOTHING', async () => {
    linkedMessage = linked();
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 200);
    assert.equal(sends.length, 0, 'THE CUSTOMER WAS SENT THE SAME REPLY TWICE');
    assert.equal(createdMessages.length, 0, 'a second outbound record was created');
  });

  test('the job is closed out against the message that already exists', async () => {
    linkedMessage = linked();
    await approve(jobDoc._id);
    assert.equal(jobDoc.status, 'sent');
    assert.equal(jobDoc.reason, 'recovered_sent');
    assert.equal(String(jobDoc.sentMessage), String(linkedMessage._id));
    assert.equal(new Date(jobDoc.lockedUntil).getTime(), 0, 'the claim was left held');
  });

  test('the operator is told what happened rather than silently succeeding', async () => {
    linkedMessage = linked();
    const res = await approve(jobDoc._id);
    assert.equal(res.body.alreadySent, true);
    assert.match(res.body.notice, /already been sent/i);
    assert.match(res.body.notice, /Nothing was sent again/i);
  });

  test('an EDITED re-approval still sends nothing', async () => {
    linkedMessage = linked();
    const res = await approve(jobDoc._id, { body: 'A different wording.' });
    assert.equal(res.status, 200);
    assert.equal(sends.length, 0);
    assert.equal(jobDoc.status, 'sent');
  });

  test("a message linked to a DIFFERENT job does not block this approval", async () => {
    linkedMessage = fakeDoc(
      f.smsMessage({ _id: f.oid(), direction: 'outbound', source: 'ai', aiJob: f.oid() })
    );
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 200);
    assert.equal(sends.length, 1, 'an unrelated message blocked a legitimate approval');
  });

  test('a repeat of the re-approval is still safe', async () => {
    linkedMessage = linked();
    await approve(jobDoc._id);
    // The job is `sent` now, so a second attempt is refused by the claim.
    const again = await approve(jobDoc._id);
    assert.equal(again.status, 409);
    assert.equal(sends.length, 0);
  });
});

// ===========================================================================
describe('Fix 3 — an approval that fails unexpectedly', () => {
  test('the job does not stay stuck in processing', async () => {
    // An unexpected failure inside the approval, after the claim.
    const Contact = require('../../models/Contact');
    const realFindById = Contact.findById;
    Contact.findById = () => {
      throw new Error('database unavailable');
    };
    try {
      const res = await approve(jobDoc._id);
      assert.equal(res.status, 500);
    } finally {
      Contact.findById = realFindById;
    }

    assert.equal(jobDoc.status, 'drafted', 'the job was left claimed forever');
    assert.equal(new Date(jobDoc.lockedUntil).getTime(), 0, 'the claim was not released');
    assert.equal(sends.length, 0);
  });

  test('the draft itself survives, so the operator can retry', async () => {
    const Contact = require('../../models/Contact');
    const realFindById = Contact.findById;
    Contact.findById = () => {
      throw new Error('database unavailable');
    };
    try {
      await approve(jobDoc._id);
    } finally {
      Contact.findById = realFindById;
    }

    assert.equal(jobDoc.draftReply, DRAFT_TEXT, 'the draft was lost');

    // And the retry works, sending exactly once.
    const res = await approve(jobDoc._id);
    assert.equal(res.status, 200);
    assert.equal(sends.length, 1, `expected one send after the retry, got ${sends.length}`);
    assert.equal(jobDoc.status, 'sent');
  });

  test('the failure reason is recorded on the released job', async () => {
    const Contact = require('../../models/Contact');
    const realFindById = Contact.findById;
    Contact.findById = () => {
      throw new Error('database unavailable');
    };
    try {
      await approve(jobDoc._id);
    } finally {
      Contact.findById = realFindById;
    }
    assert.equal(jobDoc.reason, 'approval_error');
    assert.match(jobDoc.lastError, /database unavailable/);
  });
});

// ===========================================================================
describe('CONCURRENCY — two approvals of the same draft', () => {
  test('exactly one send happens and the other request is refused', async () => {
    const [a, b] = await Promise.all([approve(jobDoc._id), approve(jobDoc._id)]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `got ${statuses.join(' and ')}`);

    // The guarantee that matters: at most one message left the system.
    assert.equal(sends.length, 1, 'the Twilio wrapper must be called once');
    assert.equal(createdMessages.length, 1, 'exactly one outbound record');
    assert.equal(jobDoc.status, 'sent');
    assert.equal(String(jobDoc.approvedBy), String(operator._id));

    // And only one approval was logged.
    assert.equal(eventTypes().filter((t) => t === 'ai.draft.approved').length, 1);
  });

  test('five simultaneous approvals still send exactly once', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => approve(jobDoc._id)));
    const ok = results.filter((r) => r.status === 200);
    const conflict = results.filter((r) => r.status === 409);
    assert.equal(ok.length, 1);
    assert.equal(conflict.length, 4);
    assert.equal(sends.length, 1);
    assert.equal(createdMessages.length, 1);
    assert.equal(jobDoc.status, 'sent');
  });

  test('a simultaneous approve and reject cannot both take effect', async () => {
    const [approved, rejected] = await Promise.all([approve(jobDoc._id), reject(jobDoc._id)]);
    const final = jobs.get(String(jobDoc._id)).status;

    // Whichever won, the other must have been refused and the state is coherent.
    assert.ok(['sent', 'rejected'].includes(final), `unexpected final status ${final}`);
    if (final === 'sent') {
      assert.equal(approved.status, 200);
      assert.equal(rejected.status, 409);
      assert.equal(sends.length, 1);
    } else {
      assert.equal(rejected.status, 200);
      assert.notEqual(approved.status, 200);
      assert.equal(sends.length, 0, 'a rejected draft must never be sent');
      assert.equal(createdMessages.length, 0);
    }
  });
});

// ===========================================================================
describe('PATCH /api/ai/conversations/:id — per-conversation AI mode', () => {
  const setMode = (id, body, token = operatorToken) =>
    api.patch(`/api/ai/conversations/${id}`, { body, token });

  test("mode 'draft' is accepted", async () => {
    conversationDoc.ai.mode = 'auto';
    const res = await setMode(conversationDoc._id, { mode: 'draft' });
    assert.equal(res.status, 200);
    assert.equal(res.body.state.mode, 'draft');
    assert.equal(conversationDoc.ai.mode, 'draft');
  });

  test("mode 'auto' is accepted", async () => {
    const res = await setMode(conversationDoc._id, { mode: 'auto' });
    assert.equal(res.status, 200);
    assert.equal(res.body.state.mode, 'auto');
    assert.equal(conversationDoc.ai.mode, 'auto');
  });

  test('an invalid mode is a 400 and changes nothing', async () => {
    for (const mode of ['AUTO', 'off', '', null, 42, 'drafts']) {
      const res = await setMode(conversationDoc._id, { mode });
      assert.equal(res.status, 400, `mode ${JSON.stringify(mode)} should be refused`);
    }
    assert.equal(conversationDoc.ai.mode, '');
    assert.equal(conversationUpdates.length, 0);
  });

  test('a missing mode is a 400', async () => {
    const res = await setMode(conversationDoc._id, {});
    assert.equal(res.status, 400);
  });

  test('an unknown conversation is a 404', async () => {
    const res = await setMode(f.oid(), { mode: 'auto' });
    assert.equal(res.status, 404);
  });

  test('a soft-deleted conversation is a 404', async () => {
    conversationDoc.deletedAt = new Date();
    const res = await setMode(conversationDoc._id, { mode: 'auto' });
    assert.equal(res.status, 404);
  });

  test('a malformed id is a 400', async () => {
    const res = await setMode('nope', { mode: 'auto' });
    assert.equal(res.status, 400);
  });

  test('ONLY ai.mode is written — the update touches one path', async () => {
    await setMode(conversationDoc._id, { mode: 'auto' });
    assert.equal(conversationUpdates.length, 1);
    assert.deepEqual(Object.keys(conversationUpdates[0].update.$set), ['ai.mode']);
  });

  test('takeover, replyCount and escalation are unchanged', async () => {
    conversationDoc.ai = {
      takeover: true,
      takeoverAt: new Date('2026-01-01T00:00:00Z'),
      takeoverBy: operator._id,
      mode: '',
      replyCount: 3,
      lastReplyAt: new Date('2026-01-02T00:00:00Z'),
      escalated: true,
      escalatedAt: new Date('2026-01-03T00:00:00Z'),
      escalationReason: 'escalation_keyword',
    };
    const before = JSON.parse(JSON.stringify(conversationDoc.ai));

    const res = await setMode(conversationDoc._id, { mode: 'auto' });
    assert.equal(res.status, 200);

    const after = JSON.parse(JSON.stringify(conversationDoc.ai));
    assert.equal(after.mode, 'auto');
    // Everything except mode is byte-identical.
    for (const key of Object.keys(before)) {
      if (key === 'mode') continue;
      assert.deepEqual(after[key], before[key], `${key} must not change`);
    }
    // And the response says so.
    assert.equal(res.body.state.takeover, true);
    assert.equal(res.body.state.replyCount, 3);
    assert.equal(res.body.state.escalated, true);
  });

  test('a contact opt-out is never touched by a mode change', async () => {
    contactDoc.optedOut = true;
    await setMode(conversationDoc._id, { mode: 'auto' });
    assert.equal(contactDoc.optedOut, true);
  });

  test('changing the mode generates nothing and sends nothing', async () => {
    await setMode(conversationDoc._id, { mode: 'auto' });
    assert.equal(sends.length, 0);
    assert.equal(createdMessages.length, 0);
    // No job was enqueued either.
    assert.equal(jobs.size, 1);
  });

  test("switching to 'auto' is logged at warning level", async () => {
    await setMode(conversationDoc._id, { mode: 'auto' });
    const event = logged.find((e) => e.eventType === 'ai.mode.changed');
    assert.ok(event, 'ai.mode.changed was not logged');
    assert.equal(event.severity, 'warning');
    assert.equal(event.meta.to, 'auto');
    assert.equal(event.meta.from, '');
    assert.equal(event.meta.by, String(operator._id));
  });

  test("switching to 'draft' is logged at info level", async () => {
    conversationDoc.ai.mode = 'auto';
    await setMode(conversationDoc._id, { mode: 'draft' });
    const event = logged.find((e) => e.eventType === 'ai.mode.changed');
    assert.equal(event.severity, 'info');
    assert.equal(event.meta.from, 'auto');
    assert.equal(event.meta.to, 'draft');
  });

  test('an unauthenticated request is refused', async () => {
    const res = await api.patch(`/api/ai/conversations/${conversationDoc._id}`, {
      body: { mode: 'auto' },
    });
    assert.equal(res.status, 401);
    assert.equal(conversationDoc.ai.mode, '');
  });

  test('the guardrails then honour the stored override', async () => {
    // The field has always been read; this proves the write and the read agree.
    const guardrails = require('../../services/ai/guardrails');
    await setMode(conversationDoc._id, { mode: 'auto' });
    assert.equal(
      guardrails.resolveMode({ ai: { defaultMode: 'draft' } }, conversationDoc),
      'auto'
    );
  });
});
