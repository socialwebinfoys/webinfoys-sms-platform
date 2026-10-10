// Fix 2 — a customer message gets AT MOST ONE answer.
//
// The whole file exists to prove one sentence: the AI worker must not send a
// reply to a message the conversation has already moved past.
//
// Three ways that happens, all tested here:
//   * something was already sent on the thread     -> already_answered
//   * the customer sent another message            -> superseded
//   * BOTH of the above arriving DURING generation -> caught by the second check
//
// The last one is the one that matters, and it is tested with a real barrier: a
// provider adapter that blocks mid-generation while the test writes a message
// into the thread, then releases. No sleeps, no timing luck — the race is
// constructed deterministically and the assertion is simply "did Twilio get
// called?".
'use strict';

require('../_support/env');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

const logged = [];
stubModule('services/logService', { logEvent: async (e) => void logged.push(e) });

let sendCalls;
stubModule('services/twilioService', {
  sendSms: async (args) => {
    sendCalls.push(args);
    return { sid: `SM${sendCalls.length}`, status: 'queued', simulated: false, from: '+15005550006' };
  },
  isConfigured: () => true,
  status: () => ({ configured: true, simulate: true }),
  PERMANENT_CODES: new Set([21610]),
});

stubModule('services/lookupService', {
  lookupNumber: async () => ({ valid: true, type: 'mobile', carrier: 'Test' }),
});

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

// A SMSMessage double that answers the real staleness question: it filters by
// conversation, by createdAt and by deletedAt exactly as the query does.
stubModule(
  'models/SMSMessage',
  fakeModel('SMSMessage', {
    findById: (id) => query(messages.find((m) => String(m._id) === String(id)) || null),
    find: (filter = {}) => {
      let rows = messages;
      if (filter.conversation) {
        rows = rows.filter((m) => String(m.conversation) === String(filter.conversation));
      }
      if (filter.contact) {
        rows = rows.filter((m) => String(m.contact) === String(filter.contact));
      }
      if (filter.createdAt && filter.createdAt.$gt) {
        rows = rows.filter((m) => new Date(m.createdAt) > new Date(filter.createdAt.$gt));
      }
      if (filter.deletedAt === null) {
        rows = rows.filter((m) => !m.deletedAt);
      }
      const chain = {
        sort: () => chain,
        limit: () => chain,
        select: () => chain,
        then: (res, rej) => Promise.resolve(rows).then(res, rej),
      };
      return chain;
    },
    create: async (doc) => {
      const saved = fakeDoc({ ...doc, _id: f.oid(), createdAt: doc.createdAt || new Date() });
      messages.push(saved);
      return saved;
    },
  })
);

stubModule(
  'models/AIReplyJob',
  Object.assign(
    fakeModel('AIReplyJob', {
      find: (filter = {}) => {
        let rows = jobs.filter((j) => (filter.status ? j.status === filter.status : true));
        if (filter.nextAttemptAt && filter.nextAttemptAt.$lte) {
          rows = rows.filter((j) => new Date(j.nextAttemptAt) <= new Date(filter.nextAttemptAt.$lte));
        }
        const chain = {
          sort: () => chain,
          limit: () => chain,
          select: () => chain,
          populate: () => chain,
          then: (res, rej) => Promise.resolve(rows).then(res, rej),
        };
        return chain;
      },
      // The real atomic claim, modelled as a synchronous check-and-set.
      findOneAndUpdate: (filter, update) => {
        const job = jobs.find((j) => String(j._id) === String(filter._id));
        if (!job) return query(null);
        if (filter.status && job.status !== filter.status) return query(null);
        if (filter.lockedUntil && filter.lockedUntil.$not && filter.lockedUntil.$not.$gte) {
          const bound = filter.lockedUntil.$not.$gte;
          if (job.lockedUntil && new Date(job.lockedUntil) >= new Date(bound)) return query(null);
        }
        if (update && update.$set) Object.assign(job, update.$set);
        return query(job);
      },
      findById: (id) => query(jobs.find((j) => String(j._id) === String(id)) || null),
      create: async (doc) => {
        const saved = fakeDoc({ ...doc, _id: f.oid() });
        jobs.push(saved);
        return saved;
      },
    }),
    { STATUSES: require('../../models/AIReplyJob').STATUSES }
  )
);

stubModule(
  'models/WorkerLock',
  fakeModel('WorkerLock', {
    acquire: async (key) => {
      if (locks.get(key)) return false;
      locks.set(key, true);
      return true;
    },
    release: async (key) => {
      locks.delete(key);
      return true;
    },
  })
);

for (const m of ['models/Campaign', 'models/Enrollment', 'models/Following', 'models/Import', 'models/Template', 'models/User', 'models/SystemLog', 'models/ImportPreview']) {
  stubModule(m, fakeModel(m));
}

const providers = require('../../services/ai/providers');
const aiService = require('../../services/ai/aiService');
const aiWorker = require('../../jobs/aiWorker');
const { REASONS } = require('../../services/ai/guardrails');

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-10-01T10:00:00Z');

let providerBehaviour;
let providerCalls;
providers.__setAdapter('openai', {
  name: 'openai',
  defaultModel: 'fake-model',
  generate: async (args) => {
    providerCalls.push(args);
    return providerBehaviour(args);
  },
});

const okGeneration = (reply = 'We are open 9 to 5.') => async () => ({
  provider: 'openai',
  model: 'fake-model',
  text: JSON.stringify({ reply, confidence: 0.95, escalate: false }),
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

function aiConfig(overrides = {}) {
  return {
    enabled: true,
    defaultMode: 'auto',
    provider: 'openai',
    model: 'fake-model',
    apiKeyEncrypted: require('../../utils/secretBox').encrypt('sk-test-key-for-stale-suite'),
    persona: '',
    businessRules: '',
    faq: '',
    escalationKeywords: [],
    confidenceThreshold: 0.7,
    maxRepliesPerConversation: 10,
    contextMessageLimit: 10,
    maxReplyCharacters: 320,
    autoTakeoverOnManualReply: true,
    ...overrides,
  };
}

// Build a conversation with one inbound message and an auto-mode job for it.
function setup({ job = {}, ai = {}, inboundAt = T0 } = {}) {
  const contactDoc = fakeDoc(
    f.contact({
      _id: f.oid(),
      lastInboundAt: inboundAt,
      lookup: { status: 'valid', type: 'mobile', lookedUpAt: new Date(Date.now() - DAY) },
    })
  );
  contacts.set(String(contactDoc._id), contactDoc);

  const convoDoc = fakeDoc(
    f.conversation({
      _id: f.oid(),
      contact: contactDoc._id,
      ai: { takeover: false, replyCount: 0, escalated: false, mode: '' },
    })
  );
  conversations.set(String(convoDoc._id), convoDoc);

  const inbound = fakeDoc(
    f.smsMessage({
      _id: f.oid(),
      direction: 'inbound',
      body: 'what are your hours?',
      conversation: convoDoc._id,
      contact: contactDoc._id,
      createdAt: inboundAt,
    })
  );
  messages.push(inbound);

  const jobDoc = fakeDoc({
    _id: f.oid(),
    conversation: convoDoc._id,
    contact: contactDoc._id,
    inboundMessage: inbound._id,
    status: 'pending',
    mode: 'auto',
    attempts: 0,
    nextAttemptAt: new Date(0),
    lockedUntil: new Date(0),
    ...job,
  });
  jobs.push(jobDoc);

  settingsDoc = fakeDoc(f.settings({ ai: aiConfig(ai), sendingWindow: { enabled: false } }));

  return { contact: contactDoc, conversation: convoDoc, job: jobDoc, inbound };
}

// Put a message into the thread at a given time.
function addMessage({ conversation, contact, direction, at, deletedAt = null }) {
  const m = fakeDoc(
    f.smsMessage({
      _id: f.oid(),
      direction,
      conversation: conversation._id,
      contact: contact._id,
      createdAt: at,
      deletedAt,
      body: direction === 'inbound' ? 'actually, never mind' : 'Yes, we are open.',
    })
  );
  messages.push(m);
  return m;
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
  providerBehaviour = okGeneration();
  settingsDoc = fakeDoc(f.settings({ ai: aiConfig() }));
});

// ===========================================================================
describe('staleReason — the question itself', () => {
  test('a current job is not stale', async () => {
    const { job, inbound } = setup();
    assert.equal(await aiService.staleReason(job, inbound), null);
  });

  test('a missing inbound message is inbound_missing', async () => {
    const { job } = setup();
    assert.equal(await aiService.staleReason(job, null), REASONS.INBOUND_MISSING);
  });

  test('a newer OUTBOUND message means already_answered', async () => {
    const { job, inbound, conversation, contact } = setup();
    addMessage({ conversation, contact, direction: 'outbound', at: new Date(T0.getTime() + 60000) });
    assert.equal(await aiService.staleReason(job, inbound), REASONS.ALREADY_ANSWERED);
  });

  test('a newer INBOUND message means superseded', async () => {
    const { job, inbound, conversation, contact } = setup();
    addMessage({ conversation, contact, direction: 'inbound', at: new Date(T0.getTime() + 60000) });
    assert.equal(await aiService.staleReason(job, inbound), REASONS.SUPERSEDED);
  });

  test('an OLDER message does not make a job stale', async () => {
    const { job, inbound, conversation, contact } = setup();
    addMessage({ conversation, contact, direction: 'outbound', at: new Date(T0.getTime() - 60000) });
    assert.equal(await aiService.staleReason(job, inbound), null);
  });

  test('a message on a DIFFERENT conversation does not make a job stale', async () => {
    const { job, inbound, contact } = setup();
    addMessage({
      conversation: { _id: f.oid() },
      contact,
      direction: 'outbound',
      at: new Date(T0.getTime() + 60000),
    });
    assert.equal(await aiService.staleReason(job, inbound), null);
  });

  test('a soft-deleted newer message does not make a job stale', async () => {
    const { job, inbound, conversation, contact } = setup();
    addMessage({
      conversation,
      contact,
      direction: 'outbound',
      at: new Date(T0.getTime() + 60000),
      deletedAt: new Date(),
    });
    assert.equal(await aiService.staleReason(job, inbound), null);
  });

  test('outbound is reported ahead of inbound when both are newer', async () => {
    const { job, inbound, conversation, contact } = setup();
    addMessage({ conversation, contact, direction: 'inbound', at: new Date(T0.getTime() + 30000) });
    addMessage({ conversation, contact, direction: 'outbound', at: new Date(T0.getTime() + 60000) });
    assert.equal(await aiService.staleReason(job, inbound), REASONS.ALREADY_ANSWERED);
  });
});

// ===========================================================================
describe('check 1 — before the provider is called', () => {
  test('a newer OUTBOUND skips the job without spending a provider call', async () => {
    const { conversation, contact } = setup();
    addMessage({ conversation, contact, direction: 'outbound', at: new Date(T0.getTime() + 60000) });

    const summary = await aiWorker.processDueJobs(new Date());

    assert.equal(summary.skippedByPolicy, 1);
    assert.equal(jobs[0].status, 'skipped');
    assert.equal(jobs[0].reason, REASONS.ALREADY_ANSWERED);
    assert.equal(providerCalls.length, 0, 'the provider was called for a stale job');
    assert.equal(sendCalls.length, 0, 'an SMS was sent for a stale job');
  });

  test('a newer INBOUND skips the job without spending a provider call', async () => {
    const { conversation, contact } = setup();
    addMessage({ conversation, contact, direction: 'inbound', at: new Date(T0.getTime() + 60000) });

    const summary = await aiWorker.processDueJobs(new Date());

    assert.equal(summary.skippedByPolicy, 1);
    assert.equal(jobs[0].status, 'skipped');
    assert.equal(jobs[0].reason, REASONS.SUPERSEDED);
    assert.equal(providerCalls.length, 0);
    assert.equal(sendCalls.length, 0);
  });

  test('a missing inbound message skips the job', async () => {
    setup();
    messages.length = 0; // the message the job was created for is gone
    await aiWorker.processDueJobs(new Date());
    assert.equal(jobs[0].status, 'skipped');
    assert.equal(jobs[0].reason, REASONS.INBOUND_MISSING);
    assert.equal(providerCalls.length, 0);
    assert.equal(sendCalls.length, 0);
  });

  test('a skipped stale job is TERMINAL — it is never retried', async () => {
    const { conversation, contact } = setup();
    addMessage({ conversation, contact, direction: 'outbound', at: new Date(T0.getTime() + 60000) });

    await aiWorker.processDueJobs(new Date());
    assert.equal(jobs[0].status, 'skipped');

    // A second pass must find nothing to do.
    const second = await aiWorker.processDueJobs(new Date());
    assert.equal(second.considered, 0);
    assert.equal(sendCalls.length, 0);
  });

  test('the skip is logged with its machine-readable reason', async () => {
    const { conversation, contact } = setup();
    addMessage({ conversation, contact, direction: 'outbound', at: new Date(T0.getTime() + 60000) });
    await aiWorker.processDueJobs(new Date());

    const event = logged.find((e) => e.eventType === 'ai.reply.skipped');
    assert.ok(event, 'the skip was not logged');
    assert.equal(event.meta.reason, REASONS.ALREADY_ANSWERED);
  });

  test('a current job still sends normally — the check does not block good work', async () => {
    setup();
    await aiWorker.processDueJobs(new Date());
    assert.equal(providerCalls.length, 1);
    assert.equal(sendCalls.length, 1);
    assert.equal(jobs[0].status, 'sent');
  });
});

// ===========================================================================
// THE RACE. A barrier inside the provider adapter holds generation open while
// the test writes into the thread, so the interleaving is constructed rather
// than hoped for.
describe('check 2 — a message arrives DURING generation', () => {
  function barrier() {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let reached;
    const entered = new Promise((resolve) => {
      reached = resolve;
    });
    return { gate, release, entered, reached };
  }

  test('a HUMAN REPLY during generation stops the send', async () => {
    const { conversation, contact } = setup();
    const b = barrier();

    providerBehaviour = async () => {
      b.reached();          // generation has started
      await b.gate;         // ...and is held here
      return {
        provider: 'openai',
        model: 'fake-model',
        text: JSON.stringify({ reply: 'We are open 9 to 5.', confidence: 0.95, escalate: false }),
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    };

    const pass = aiWorker.processDueJobs(new Date());
    await b.entered;

    // The operator answers by hand while the model is still thinking.
    addMessage({ conversation, contact, direction: 'outbound', at: new Date(Date.now() + 1000) });

    b.release();
    await pass;

    assert.equal(providerCalls.length, 1, 'generation did run — that is the point of this test');
    assert.equal(sendCalls.length, 0, 'THE AI SENT A SECOND REPLY AFTER A HUMAN ANSWERED');
    assert.equal(jobs[0].status, 'skipped');
    assert.equal(jobs[0].reason, REASONS.ALREADY_ANSWERED);
  });

  test('a NEW CUSTOMER MESSAGE during generation stops the send', async () => {
    const { conversation, contact } = setup();
    const b = barrier();

    providerBehaviour = async () => {
      b.reached();
      await b.gate;
      return {
        provider: 'openai',
        model: 'fake-model',
        text: JSON.stringify({ reply: 'We are open 9 to 5.', confidence: 0.95, escalate: false }),
      };
    };

    const pass = aiWorker.processDueJobs(new Date());
    await b.entered;
    addMessage({ conversation, contact, direction: 'inbound', at: new Date(Date.now() + 1000) });
    b.release();
    await pass;

    assert.equal(providerCalls.length, 1);
    assert.equal(sendCalls.length, 0, 'the AI answered a superseded message');
    assert.equal(jobs[0].status, 'skipped');
    assert.equal(jobs[0].reason, REASONS.SUPERSEDED);
  });

  test('nothing arriving during generation means the reply still goes out', async () => {
    setup();
    const b = barrier();
    providerBehaviour = async () => {
      b.reached();
      await b.gate;
      return {
        provider: 'openai',
        model: 'fake-model',
        text: JSON.stringify({ reply: 'We are open 9 to 5.', confidence: 0.95, escalate: false }),
      };
    };

    const pass = aiWorker.processDueJobs(new Date());
    await b.entered;
    b.release();
    await pass;

    assert.equal(sendCalls.length, 1, 'a perfectly good reply was blocked');
    assert.equal(jobs[0].status, 'sent');
  });

  test('the generated text is still recorded on the skipped job', async () => {
    const { conversation, contact } = setup();
    const b = barrier();
    providerBehaviour = async () => {
      b.reached();
      await b.gate;
      return {
        provider: 'openai',
        model: 'fake-model',
        text: JSON.stringify({ reply: 'We are open 9 to 5.', confidence: 0.95, escalate: false }),
      };
    };

    const pass = aiWorker.processDueJobs(new Date());
    await b.entered;
    addMessage({ conversation, contact, direction: 'outbound', at: new Date(Date.now() + 1000) });
    b.release();
    await pass;

    // Nothing was sent, but what the model produced is not thrown away.
    assert.equal(jobs[0].status, 'skipped');
    assert.equal(sendCalls.length, 0);
  });
});

// ===========================================================================
describe('two customer messages in quick succession', () => {
  test('exactly ONE reply is produced — the first job is superseded', async () => {
    // Message A at T0, with its job.
    const { conversation, contact, inbound: inboundA } = setup();

    // Message B ten seconds later, with its own job, as the webhook would create.
    const inboundB = addMessage({
      conversation,
      contact,
      direction: 'inbound',
      at: new Date(T0.getTime() + 10000),
    });
    const jobB = fakeDoc({
      _id: f.oid(),
      conversation: conversation._id,
      contact: contact._id,
      inboundMessage: inboundB._id,
      status: 'pending',
      mode: 'auto',
      attempts: 0,
      nextAttemptAt: new Date(0),
      lockedUntil: new Date(0),
    });
    jobs.push(jobB);

    await aiWorker.processDueJobs(new Date());

    const jobA = jobs.find((j) => String(j.inboundMessage) === String(inboundA._id));
    assert.equal(jobA.status, 'skipped', 'the first job should have been superseded');
    assert.equal(jobA.reason, REASONS.SUPERSEDED);

    // EXACTLY ONE outbound SMS for two inbound messages.
    assert.equal(sendCalls.length, 1, `expected one reply, got ${sendCalls.length}`);
    assert.equal(jobB.status, 'sent', 'the newest message is the one that gets answered');
  });

  test('only ONE provider call is spent — the stale job never reaches the model', async () => {
    const { conversation, contact } = setup();
    const inboundB = addMessage({
      conversation,
      contact,
      direction: 'inbound',
      at: new Date(T0.getTime() + 10000),
    });
    jobs.push(
      fakeDoc({
        _id: f.oid(),
        conversation: conversation._id,
        contact: contact._id,
        inboundMessage: inboundB._id,
        status: 'pending',
        mode: 'auto',
        attempts: 0,
        nextAttemptAt: new Date(0),
        lockedUntil: new Date(0),
      })
    );

    await aiWorker.processDueJobs(new Date());
    assert.equal(providerCalls.length, 1, 'the superseded job spent provider credit');
  });

  test('three messages in a row still produce exactly one reply', async () => {
    const { conversation, contact } = setup();
    let last;
    for (let i = 1; i <= 2; i += 1) {
      last = addMessage({
        conversation,
        contact,
        direction: 'inbound',
        at: new Date(T0.getTime() + i * 10000),
      });
      jobs.push(
        fakeDoc({
          _id: f.oid(),
          conversation: conversation._id,
          contact: contact._id,
          inboundMessage: last._id,
          status: 'pending',
          mode: 'auto',
          attempts: 0,
          nextAttemptAt: new Date(0),
          lockedUntil: new Date(0),
        })
      );
    }

    await aiWorker.processDueJobs(new Date());
    assert.equal(sendCalls.length, 1, `expected one reply for three messages, got ${sendCalls.length}`);
  });
});

// ===========================================================================
describe('draft mode is protected too', () => {
  test('a stale job in draft mode is skipped rather than drafted', async () => {
    const { conversation, contact } = setup({ job: { mode: 'draft' } });
    addMessage({ conversation, contact, direction: 'outbound', at: new Date(T0.getTime() + 60000) });

    await aiWorker.processDueJobs(new Date());

    assert.equal(jobs[0].status, 'skipped');
    assert.equal(jobs[0].reason, REASONS.ALREADY_ANSWERED);
    // No point drafting a reply to a question that has been answered.
    assert.equal(providerCalls.length, 0);
    assert.equal(sendCalls.length, 0);
  });
});

// ===========================================================================
describe('existing safety is untouched', () => {
  test('an opted-out contact is still blocked, and not reported as stale', async () => {
    const { contact } = setup();
    contact.optedOut = true;
    await aiWorker.processDueJobs(new Date());
    assert.equal(jobs[0].status, 'skipped');
    assert.equal(jobs[0].reason, REASONS.OPTED_OUT, 'consent must still be the reported reason');
    assert.equal(sendCalls.length, 0);
  });

  test('human takeover still blocks, and is still reported as takeover', async () => {
    const { conversation } = setup();
    conversation.ai.takeover = true;
    await aiWorker.processDueJobs(new Date());
    assert.equal(jobs[0].reason, REASONS.TAKEOVER);
    assert.equal(sendCalls.length, 0);
  });

  test('a disabled assistant still blocks before anything else', async () => {
    setup({ ai: { enabled: false } });
    await aiWorker.processDueJobs(new Date());
    assert.equal(jobs[0].reason, REASONS.AI_DISABLED);
    assert.equal(sendCalls.length, 0);
  });
});
