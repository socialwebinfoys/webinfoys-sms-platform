// Phase 8 — the AI worker: modes, retry/backoff, concurrency and idempotency.
//
// The provider is a fake adapter swapped into the registry, so the whole
// pipeline runs — guardrails, prompt, parser, send path — with no network, no
// credential and no cost. twilioService is substituted so "did this send?" is
// an assertion rather than an assumption.
'use strict';

require('../_support/env');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

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
  status: () => ({ configured: true, simulate: true, accountSid: 'AC****abcd', from: '' }),
  PERMANENT_CODES: new Set([21610, 21211, 21614, 21408]),
});

let lookupResult;
stubModule('services/lookupService', { lookupNumber: async (p) => lookupResult(p) });

// --- in-memory stores -----------------------------------------------------
let settingsDoc;
let contacts;
let conversations;
let jobs;
let messages;
let locks;

const RealSettings = require('../../models/Settings');
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    findOne: () => query(settingsDoc),
    getSingleton: async () => settingsDoc,
    resolveAllowedLineTypes: RealSettings.resolveAllowedLineTypes,
    LINE_TYPES: RealSettings.LINE_TYPES,
  })
);

stubModule(
  'models/Contact',
  fakeModel('Contact', {
    findById: (id) => query(contacts.get(String(id)) || null),
    findOne: (filter) =>
      query([...contacts.values()].find((c) => c.phone === (filter && filter.phone)) || null),
  })
);

stubModule(
  'models/Conversation',
  fakeModel('Conversation', {
    findById: (id) => query(conversations.get(String(id)) || null),
    updateOne: async (filter, update) => {
      const doc = conversations.get(String(filter._id));
      if (!doc) return { modifiedCount: 0 };
      doc.ai = doc.ai || {};
      if (update.$set) {
        for (const [k, v] of Object.entries(update.$set)) {
          if (k.startsWith('ai.')) doc.ai[k.slice(3)] = v;
          else doc[k] = v;
        }
      }
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          if (k.startsWith('ai.')) doc.ai[k.slice(3)] = (doc.ai[k.slice(3)] || 0) + v;
        }
      }
      return { modifiedCount: 1 };
    },
  })
);

stubModule(
  'models/SMSMessage',
  fakeModel('SMSMessage', {
    findById: (id) => query(messages.find((m) => String(m._id) === String(id)) || null),
    find: () => {
      const chain = {
        sort: () => chain,
        limit: () => chain,
        select: () => chain,
        then: (res, rej) => Promise.resolve([]).then(res, rej),
      };
      return chain;
    },
    create: async (doc) => {
      const saved = fakeDoc({ ...doc, _id: f.oid() });
      messages.push(saved);
      return saved;
    },
  })
);

// A faithful AIReplyJob double: honours the claim filter, including the
// absent-lockedUntil case, and the due query's sort+limit.
stubModule(
  'models/AIReplyJob',
  Object.assign(
    fakeModel('AIReplyJob', {
      find: (filter) => {
        let rows = jobs.filter((j) => {
          if (filter.status && j.status !== filter.status) return false;
          if (filter.nextAttemptAt && filter.nextAttemptAt.$lte) {
            return new Date(j.nextAttemptAt) <= new Date(filter.nextAttemptAt.$lte);
          }
          return true;
        });
        const chain = {
          sort: () => {
            rows = [...rows].sort((a, b) => new Date(a.nextAttemptAt) - new Date(b.nextAttemptAt));
            return chain;
          },
          limit: (n) => {
            rows = rows.slice(0, n);
            return chain;
          },
          select: () => chain,
          then: (res, rej) => Promise.resolve(rows).then(res, rej),
        };
        return chain;
      },
      findOneAndUpdate: async (filter, update) => {
        const job = jobs.find((j) => String(j._id) === String(filter._id));
        if (!job) return null;
        if (filter.status && job.status !== filter.status) return null;
        if (filter.lockedUntil && filter.lockedUntil.$not && filter.lockedUntil.$not.$gte) {
          const threshold = new Date(filter.lockedUntil.$not.$gte).getTime();
          const held = job.lockedUntil !== undefined && job.lockedUntil !== null;
          if (held && new Date(job.lockedUntil).getTime() >= threshold) return null;
        }
        if (update.$set) Object.assign(job, update.$set);
        return job;
      },
      create: async (doc) => {
        if (jobs.some((j) => String(j.inboundMessage) === String(doc.inboundMessage))) {
          const err = new Error('E11000 duplicate key error');
          err.code = 11000;
          throw err;
        }
        const saved = fakeDoc({ ...doc, _id: f.oid(), attempts: 0 });
        jobs.push(saved);
        return saved;
      },
    }),
    { STATUSES: ['pending', 'processing', 'drafted', 'sent', 'skipped', 'escalated', 'failed'] }
  )
);

const WorkerLock = require('../../models/WorkerLock');
WorkerLock.findOneAndUpdate = async (filter, update) => {
  const existing = locks.get(filter.key);
  if (existing) {
    const expired =
      filter.$or &&
      filter.$or.some(
        (c) => c.expiresAt && new Date(existing.expiresAt) <= new Date(c.expiresAt.$lte)
      );
    const sameOwner = filter.$or && filter.$or.some((c) => c.owner && c.owner === existing.owner);
    if (!expired && !sameOwner) {
      const err = new Error('E11000');
      err.code = 11000;
      throw err;
    }
  }
  const next = { ...(existing || {}), ...update.$set };
  locks.set(filter.key, next);
  return next;
};
WorkerLock.updateOne = async (filter, update) => {
  const existing = locks.get(filter.key);
  if (existing && existing.owner === filter.owner) Object.assign(existing, update.$set);
  return { modifiedCount: 1 };
};

stubModule('models/User', fakeModel('User'));
for (const m of ['models/Campaign', 'models/Enrollment', 'models/Following', 'models/Import', 'models/Template', 'models/ImportPreview', 'models/SystemLog']) {
  stubModule(m, fakeModel(m));
}

const providers = require('../../services/ai/providers');
const secretBox = require('../../utils/secretBox');
const aiWorker = require('../../jobs/aiWorker');
const aiService = require('../../services/ai/aiService');
const { ProviderError } = require('../../services/ai/providers/errors');

const DAY = 24 * 60 * 60 * 1000;
const ENCRYPTED_KEY = secretBox.encrypt('sk-test-not-a-real-key-0001');

// The fake provider. Swapped into the registry, so the production code path is
// unchanged — it still asks the registry for an adapter and calls generate().
let providerBehaviour;
let providerCalls;
function installFakeProvider() {
  providers.__setAdapter('openai', {
    name: 'openai',
    defaultModel: 'fake-model',
    generate: async (args) => {
      providerCalls.push(args);
      return providerBehaviour(args);
    },
  });
}

const okGeneration = (reply = 'We are open 9 to 5.', confidence = 0.95) => async () => ({
  provider: 'openai',
  model: 'fake-model',
  text: JSON.stringify({ reply, confidence, escalate: false }),
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

function aiConfig(overrides = {}) {
  return {
    enabled: true,
    defaultMode: 'draft',
    provider: 'openai',
    model: '',
    apiKeyEncrypted: ENCRYPTED_KEY,
    persona: 'Test persona',
    businessRules: '',
    faq: '',
    escalationKeywords: ['human'],
    confidenceThreshold: 0.7,
    maxRepliesPerConversation: 3,
    contextMessageLimit: 10,
    maxReplyCharacters: 320,
    ...overrides,
  };
}

function setup({ ai = {}, settings = {}, contact = {}, conversation = {}, job = {} } = {}) {
  settingsDoc = f.settings({
    sendingWindow: { enabled: false },
    sendDays: [0, 1, 2, 3, 4, 5, 6],
    ...settings,
    ai: aiConfig(ai),
  });

  const contactDoc = fakeDoc(
    f.contact({
      _id: f.oid(),
      lookup: { status: 'valid', type: 'mobile', lookedUpAt: new Date(Date.now() - DAY) },
      ...contact,
    })
  );
  contacts.set(String(contactDoc._id), contactDoc);

  const convoDoc = fakeDoc(
    f.conversation({
      _id: f.oid(),
      contact: contactDoc._id,
      ai: { takeover: false, replyCount: 0, escalated: false, mode: '', ...conversation },
    })
  );
  conversations.set(String(convoDoc._id), convoDoc);

  const inbound = fakeDoc(
    f.smsMessage({ _id: f.oid(), direction: 'inbound', body: 'what are your hours?' })
  );
  messages.push(inbound);

  const jobDoc = fakeDoc({
    _id: f.oid(),
    conversation: convoDoc._id,
    contact: contactDoc._id,
    inboundMessage: inbound._id,
    status: 'pending',
    mode: 'draft',
    attempts: 0,
    nextAttemptAt: new Date(0),
    lockedUntil: new Date(0),
    ...job,
  });
  jobs.push(jobDoc);

  return { contact: contactDoc, conversation: convoDoc, job: jobDoc, inbound };
}

beforeEach(() => {
  logged.length = 0;
  sendCalls = [];
  providerCalls = [];
  contacts = new Map();
  conversations = new Map();
  jobs = [];
  messages = [];
  locks = new Map();
  sendOutcome = () => ({ sid: 'SMai1', status: 'queued', simulated: false, from: '+15005550006' });
  lookupResult = async () => ({ valid: true, type: 'mobile', lookedUpAt: new Date() });
  providerBehaviour = okGeneration();
  providers.__reset();
  installFakeProvider();
});

// ---------------------------------------------------------------------------
describe('DRAFT mode never sends', () => {
  test('a reply is generated and stored, and nothing reaches Twilio', async () => {
    const { job, conversation } = setup({ job: { mode: 'draft' } });

    const summary = await aiWorker.processDueJobs(new Date());

    assert.equal(summary.drafted, 1);
    assert.equal(summary.sent, 0);
    assert.equal(sendCalls.length, 0, 'draft mode must never call the send path');
    assert.equal(job.status, 'drafted');
    assert.equal(job.draftReply, 'We are open 9 to 5.');
    assert.equal(job.confidence, 0.95);
    assert.equal(conversation.ai.replyCount, 1);
    assert.ok(logged.some((e) => e.eventType === 'ai.reply.drafted'));
  });

  test('draft mode still runs the compliance gate — an opted-out contact drafts nothing', async () => {
    const { job } = setup({ job: { mode: 'draft' }, contact: { optedOut: true } });

    await aiWorker.processDueJobs(new Date());

    assert.equal(job.status, 'skipped');
    assert.equal(job.reason, 'opted_out');
    assert.equal(providerCalls.length, 0, 'no provider spend on a contact we may not message');
  });

  test('draft mode ignores the confidence threshold (nothing is being sent)', async () => {
    providerBehaviour = okGeneration('low confidence answer', 0.1);
    const { job } = setup({ job: { mode: 'draft' }, ai: { confidenceThreshold: 0.9 } });

    await aiWorker.processDueJobs(new Date());

    assert.equal(job.status, 'drafted');
    assert.equal(sendCalls.length, 0);
  });
});

describe('AUTO mode sends only when every guard passes', () => {
  test('a confident reply is sent through the shared send path', async () => {
    const { job, conversation, contact } = setup({ job: { mode: 'auto' } });

    const summary = await aiWorker.processDueJobs(new Date());

    assert.equal(summary.sent, 1);
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].to, contact.phone);
    assert.equal(sendCalls[0].body, 'We are open 9 to 5.');
    assert.equal(job.status, 'sent');
    assert.equal(conversation.ai.replyCount, 1);
    assert.ok(logged.some((e) => e.eventType === 'ai.reply.sent'));
  });

  test("the sent message is recorded with source 'ai' and linked to the thread", async () => {
    const { conversation } = setup({ job: { mode: 'auto' } });
    await aiWorker.processDueJobs(new Date());
    const outbound = messages.find((m) => m.direction === 'outbound');
    assert.ok(outbound);
    assert.equal(outbound.source, 'ai');
    assert.equal(String(outbound.conversation), String(conversation._id));
  });

  test('LOW CONFIDENCE does not send — it escalates', async () => {
    providerBehaviour = okGeneration('not sure', 0.2);
    const { job, conversation } = setup({ job: { mode: 'auto' }, ai: { confidenceThreshold: 0.8 } });

    await aiWorker.processDueJobs(new Date());

    assert.equal(sendCalls.length, 0);
    assert.equal(job.status, 'escalated');
    assert.equal(job.reason, 'low_confidence');
    assert.equal(conversation.ai.escalated, true);
    assert.ok(logged.some((e) => e.eventType === 'ai.reply.escalated'));
  });

  test('the model asking for escalation does not send', async () => {
    providerBehaviour = async () => ({
      provider: 'openai',
      model: 'fake-model',
      text: '{"reply":"","escalate":true,"reason":"customer is upset"}',
    });
    const { job } = setup({ job: { mode: 'auto' } });

    await aiWorker.processDueJobs(new Date());

    assert.equal(sendCalls.length, 0);
    assert.equal(job.status, 'escalated');
    assert.equal(job.reason, 'model_escalated');
  });

  test('an OPTED-OUT contact is never messaged, whatever the mode', async () => {
    const { job } = setup({ job: { mode: 'auto' }, contact: { optedOut: true } });
    await aiWorker.processDueJobs(new Date());
    assert.equal(sendCalls.length, 0);
    assert.equal(job.status, 'skipped');
    assert.equal(job.reason, 'opted_out');
  });

  test('HUMAN TAKEOVER stops the assistant', async () => {
    const { job } = setup({ job: { mode: 'auto' }, conversation: { takeover: true } });
    await aiWorker.processDueJobs(new Date());
    assert.equal(sendCalls.length, 0);
    assert.equal(providerCalls.length, 0, 'takeover is checked before any provider spend');
    assert.equal(job.status, 'skipped');
    assert.equal(job.reason, 'takeover');
  });

  test('the REPLY LIMIT stops the assistant and escalates', async () => {
    const { job, conversation } = setup({
      job: { mode: 'auto' },
      ai: { maxRepliesPerConversation: 2 },
      conversation: { replyCount: 2 },
    });
    await aiWorker.processDueJobs(new Date());
    assert.equal(sendCalls.length, 0);
    assert.equal(job.status, 'escalated');
    assert.equal(job.reason, 'reply_limit');
    assert.equal(conversation.ai.escalated, true);
  });

  test('smsEnabled=false blocks the AI entirely', async () => {
    const { job } = setup({ job: { mode: 'auto' }, settings: { smsEnabled: false } });
    await aiWorker.processDueJobs(new Date());
    assert.equal(sendCalls.length, 0);
    assert.equal(job.status, 'skipped');
    assert.equal(job.reason, 'sms_disabled');
  });

  test('AI disabled globally skips everything', async () => {
    const { job } = setup({ job: { mode: 'auto' }, ai: { enabled: false } });
    await aiWorker.processDueJobs(new Date());
    assert.equal(providerCalls.length, 0);
    assert.equal(job.status, 'skipped');
    assert.equal(job.reason, 'ai_disabled');
  });

  test('a BLOCKED LINE TYPE yields a draft, not a send', async () => {
    const { job } = setup({
      job: { mode: 'auto' },
      settings: { allowedLineTypes: ['mobile'] },
      contact: { lookup: { status: 'valid', type: 'landline', lookedUpAt: new Date(Date.now() - DAY) } },
    });
    await aiWorker.processDueJobs(new Date());
    assert.equal(sendCalls.length, 0);
    assert.equal(job.status, 'drafted', 'the reply is still useful to a human');
    assert.equal(job.reason, 'line_type_blocked');
  });

  test('OUTSIDE THE SENDING WINDOW the job is retried, not failed', async () => {
    const { job } = setup({
      job: { mode: 'auto' },
      settings: { sendingWindow: { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' } },
    });

    await aiWorker.processDueJobs(new Date('2026-07-01T03:00:00Z'));

    assert.equal(sendCalls.length, 0);
    assert.equal(job.status, 'pending', 'a good reply at a bad hour waits');
    assert.equal(job.attempts, 1);
    assert.ok(new Date(job.nextAttemptAt) > new Date('2026-07-01T03:00:00Z'));
  });

  test('an ESCALATION KEYWORD in the inbound message skips generation', async () => {
    const { job } = setup({ job: { mode: 'auto' } });
    messages.find((m) => m.direction === 'inbound').body = 'I want to speak to a human';

    await aiWorker.processDueJobs(new Date());

    assert.equal(providerCalls.length, 0);
    assert.equal(job.status, 'escalated');
    assert.equal(job.reason, 'escalation_keyword');
  });
});

describe('carrier opt-out (21610) during an AI send', () => {
  test('uses the existing opt-out handling and does not retry', async () => {
    const { job, contact } = setup({ job: { mode: 'auto' } });
    sendOutcome = () => {
      const err = new Error('unsubscribed');
      err.twilioCode = 21610;
      err.permanent = true;
      throw err;
    };

    await aiWorker.processDueJobs(new Date());

    assert.equal(contact.optedOut, true, 'the platform opt-out path must have run');
    assert.equal(contact.optOutSource, 'carrier');
    assert.equal(job.status, 'failed');
    assert.ok(logged.some((e) => e.eventType === 'optout.received'));
  });
});

describe('retry and backoff', () => {
  function failWith(kind, message = 'provider blew up') {
    providerBehaviour = async () => {
      throw new ProviderError(message, { kind, provider: 'openai' });
    };
  }

  test('a TEMPORARY failure is retried with backoff', async () => {
    const { job } = setup({ job: { mode: 'auto' } });
    failWith('temporary');
    const now = new Date();

    await aiWorker.processDueJobs(now);

    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 1);
    assert.ok(new Date(job.nextAttemptAt).getTime() > now.getTime());
    assert.ok(logged.some((e) => e.eventType === 'ai.provider.error'));
  });

  test('a RATE LIMIT is retried', async () => {
    const { job } = setup({ job: { mode: 'auto' } });
    failWith('rate_limit');
    await aiWorker.processDueJobs(new Date());
    assert.equal(job.status, 'pending');
  });

  test('a TIMEOUT is retried', async () => {
    const { job } = setup({ job: { mode: 'auto' } });
    failWith('timeout');
    await aiWorker.processDueJobs(new Date());
    assert.equal(job.status, 'pending');
  });

  test('an AUTH failure stops immediately — retrying a bad key is pointless', async () => {
    const { job } = setup({ job: { mode: 'auto' } });
    failWith('auth', 'bad credentials');
    await aiWorker.processDueJobs(new Date());
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 0, 'a permanent error does not consume retry budget');
    assert.equal(job.reason, 'auth');
  });

  test('an INVALID REQUEST stops immediately', async () => {
    const { job } = setup({ job: { mode: 'auto' } });
    failWith('invalid_request');
    await aiWorker.processDueJobs(new Date());
    assert.equal(job.status, 'failed');
  });

  test('backoff grows exponentially', () => {
    const first = aiWorker.backoffMsFor(1);
    const second = aiWorker.backoffMsFor(2);
    const third = aiWorker.backoffMsFor(3);
    assert.equal(second, first * 2);
    assert.equal(third, first * 4);
  });

  test('retries are bounded — the job fails once the ceiling is reached', async () => {
    const { job } = setup({ job: { mode: 'auto', attempts: 2 } });
    failWith('temporary');
    await aiWorker.processDueJobs(new Date());
    assert.equal(job.status, 'failed');
    assert.equal(job.reason, 'max_retries');
  });

  test('a policy block is NEVER retried', async () => {
    const { job } = setup({ job: { mode: 'auto' }, contact: { optedOut: true } });
    await aiWorker.processDueJobs(new Date());
    assert.equal(job.status, 'skipped', 'skipped is terminal');
    assert.equal(job.attempts, 0);

    // A second pass must not pick it up again.
    providerCalls.length = 0;
    await aiWorker.processDueJobs(new Date());
    assert.equal(providerCalls.length, 0);
  });

  test('UNUSABLE model output is retried, not sent', async () => {
    const { job } = setup({ job: { mode: 'auto' } });
    providerBehaviour = async () => ({ provider: 'openai', model: 'fake', text: 'not json at all' });

    await aiWorker.processDueJobs(new Date());

    assert.equal(sendCalls.length, 0, 'invalid output must never reach a handset');
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 1);
  });

  test('a failed job never counts as a reply against the limit', async () => {
    const { conversation } = setup({ job: { mode: 'auto' } });
    failWith('auth');
    await aiWorker.processDueJobs(new Date());
    assert.equal(conversation.ai.replyCount, 0, 'an outage must not burn a customer allowance');
  });
});

describe('concurrency and idempotency', () => {
  test('two workers racing the same job: exactly one claim', async () => {
    const { job } = setup();
    const now = new Date();
    const results = await Promise.all([
      aiWorker.claimJob(job._id, now),
      aiWorker.claimJob(job._id, now),
      aiWorker.claimJob(job._id, now),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  test('a claimed job cannot be claimed again until the lease expires', async () => {
    const { job } = setup();
    assert.ok(await aiWorker.claimJob(job._id, new Date()));
    assert.equal(await aiWorker.claimJob(job._id, new Date()), null);
  });

  test('a legacy job with NO lockedUntil field is still claimable', async () => {
    const { job } = setup();
    delete job.lockedUntil;
    assert.ok(await aiWorker.claimJob(job._id, new Date()));
  });

  test('a terminal job is never re-claimed', async () => {
    const { job } = setup({ job: { status: 'sent' } });
    assert.equal(await aiWorker.claimJob(job._id, new Date()), null);
  });

  test('an overlapping pass no-ops instead of double-processing', async () => {
    setup({ job: { mode: 'auto' } });
    let release;
    const held = new Promise((r) => {
      release = r;
    });
    providerBehaviour = async () => {
      await held;
      return (await okGeneration()())
    };

    const first = aiWorker.processDueJobs(new Date());
    await new Promise((r) => setImmediate(r));
    const second = await aiWorker.processDueJobs(new Date());

    assert.equal(second.skipped, true);
    release();
    await first;
    assert.equal(sendCalls.length, 1, 'exactly one send, never two');
  });

  test('running the pass twice sends only once per job', async () => {
    setup({ job: { mode: 'auto' } });
    await aiWorker.processDueJobs(new Date());
    await aiWorker.processDueJobs(new Date());
    assert.equal(sendCalls.length, 1);
    assert.equal(providerCalls.length, 1);
  });

  test('a duplicate inbound message cannot create a second job', async () => {
    const { contact, conversation, inbound } = setup();
    settingsDoc.ai.enabled = true;

    const a = await aiService.enqueueForInboundMessage({
      contact,
      conversation,
      inboundMessage: inbound,
      settings: settingsDoc,
    });
    const b = await aiService.enqueueForInboundMessage({
      contact,
      conversation,
      inboundMessage: inbound,
      settings: settingsDoc,
    });

    assert.equal(a, null, 'the first job already existed from setup()');
    assert.equal(b, null);
    assert.equal(jobs.filter((j) => String(j.inboundMessage) === String(inbound._id)).length, 1);
  });

  test('the per-run budget is respected', async () => {
    setup({ job: { mode: 'draft' } });
    for (let i = 0; i < 5; i += 1) setup({ job: { mode: 'draft' } });
    const summary = await aiWorker.processDueJobs(new Date(), { budget: 2 });
    assert.equal(summary.considered, 2);
  });

  test('the tick takes and releases the global lease', async () => {
    setup({ job: { mode: 'draft' } });
    const result = await aiWorker.runTick(new Date());
    assert.equal(result.heldLease, true);
    const WorkerLockModel = require('../../models/WorkerLock');
    assert.equal(await WorkerLockModel.acquire(aiWorker.LOCK_KEY, 'other@host', 60000), true);
  });

  test('a tick that loses the lease does no work', async () => {
    setup({ job: { mode: 'auto' } });
    const WorkerLockModel = require('../../models/WorkerLock');
    await WorkerLockModel.acquire(aiWorker.LOCK_KEY, 'someone-else@host', 60000);

    const result = await aiWorker.runTick(new Date());

    assert.equal(result.heldLease, false);
    assert.equal(sendCalls.length, 0);
  });
});

describe('enqueue is safe by construction', () => {
  test('nothing is enqueued when AI is disabled', async () => {
    const { contact, conversation, inbound } = setup();
    jobs.length = 0;
    settingsDoc.ai.enabled = false;
    const job = await aiService.enqueueForInboundMessage({
      contact,
      conversation,
      inboundMessage: inbound,
      settings: settingsDoc,
    });
    assert.equal(job, null);
    assert.equal(jobs.length, 0);
  });

  test('nothing is enqueued while a human has taken over', async () => {
    const { contact, conversation, inbound } = setup({ conversation: { takeover: true } });
    jobs.length = 0;
    const job = await aiService.enqueueForInboundMessage({
      contact,
      conversation,
      inboundMessage: inbound,
      settings: settingsDoc,
    });
    assert.equal(job, null);
  });

  test('enqueue never throws, so it can never break webhook acknowledgement', async () => {
    await assert.doesNotReject(() =>
      aiService.enqueueForInboundMessage({ contact: null, conversation: null, inboundMessage: null })
    );
  });

  test('the resolved mode follows the thread override', async () => {
    const { contact, conversation, inbound } = setup({
      ai: { defaultMode: 'draft' },
      conversation: { mode: 'auto' },
    });
    jobs.length = 0;
    const job = await aiService.enqueueForInboundMessage({
      contact,
      conversation,
      inboundMessage: inbound,
      settings: settingsDoc,
    });
    assert.equal(job.mode, 'auto');
  });
});

describe('logging is safe', () => {
  test('no AI log event contains the api key or the encryption key', async () => {
    setup({ job: { mode: 'auto' } });
    await aiWorker.processDueJobs(new Date());
    const serialised = JSON.stringify(logged);
    assert.equal(serialised.includes('sk-test-not-a-real-key-0001'), false);
    assert.equal(serialised.includes(ENCRYPTED_KEY), false);
    assert.equal(serialised.includes(process.env.AI_ENCRYPTION_KEY), false);
  });

  test('a sent event carries useful, non-sensitive metadata', async () => {
    setup({ job: { mode: 'auto' } });
    await aiWorker.processDueJobs(new Date());
    const event = logged.find((e) => e.eventType === 'ai.reply.sent');
    assert.ok(event);
    assert.equal(event.meta.provider, 'openai');
    assert.equal(event.meta.mode, 'auto');
    assert.equal(event.meta.confidence, 0.95);
    assert.ok(event.meta.usage.totalTokens > 0);
    assert.ok(event.contact);
    assert.ok(event.conversation);
  });

  test('a skip records the machine-readable reason', async () => {
    setup({ job: { mode: 'auto' }, conversation: { takeover: true } });
    await aiWorker.processDueJobs(new Date());
    const event = logged.find((e) => e.eventType === 'ai.reply.skipped');
    assert.ok(event);
    assert.equal(event.meta.reason, 'takeover');
  });
});
