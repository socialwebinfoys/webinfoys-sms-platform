// Fix 3 — recovering AI jobs stranded in `processing`.
//
// A job is claimed by moving it to `processing` with a lease. If the process
// dies between the claim and the final write, nothing clears it: the job is
// never retried, never sent and never visible as failed.
//
// The single most important claim in this file: RECOVERY MUST NEVER CAUSE A
// SECOND SMS. The dangerous crash is the one that happens after Twilio accepted
// a message but before the job was marked sent — the work is done, the
// bookkeeping is not, and a naive retry would send the customer the same reply
// twice. That exact sequence is reconstructed and asserted below.
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

// Honours the aiJob lookup and the Fix 2 staleness query, so both behaviours
// under test are exercised against a faithful double.
stubModule(
  'models/SMSMessage',
  fakeModel('SMSMessage', {
    findById: (id) => query(messages.find((m) => String(m._id) === String(id)) || null),
    findOne: (filter = {}) => {
      let rows = messages;
      if (filter.aiJob) rows = rows.filter((m) => String(m.aiJob) === String(filter.aiJob));
      return query(rows[0] || null);
    },
    find: (filter = {}) => {
      let rows = messages;
      if (filter.conversation) {
        rows = rows.filter((m) => String(m.conversation) === String(filter.conversation));
      }
      if (filter.contact) rows = rows.filter((m) => String(m.contact) === String(filter.contact));
      if (filter.createdAt && filter.createdAt.$gt) {
        rows = rows.filter((m) => new Date(m.createdAt) > new Date(filter.createdAt.$gt));
      }
      if (filter.deletedAt === null) rows = rows.filter((m) => !m.deletedAt);
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

// Records every conditional update so the concurrency assertions can check that
// the stale-claim condition really was part of the filter.
const updateOneCalls = [];
stubModule(
  'models/AIReplyJob',
  Object.assign(
    fakeModel('AIReplyJob', {
      find: (filter = {}) => {
        let rows = jobs.filter((j) => (filter.status ? j.status === filter.status : true));
        if (filter.nextAttemptAt && filter.nextAttemptAt.$lte) {
          rows = rows.filter((j) => new Date(j.nextAttemptAt) <= new Date(filter.nextAttemptAt.$lte));
        }
        if (filter.lockedUntil && filter.lockedUntil.$lt) {
          rows = rows.filter((j) => new Date(j.lockedUntil) < new Date(filter.lockedUntil.$lt));
        }
        let limited = rows;
        const chain = {
          sort: () => chain,
          limit: (n) => {
            limited = rows.slice(0, n);
            return chain;
          },
          select: () => chain,
          populate: () => chain,
          then: (res, rej) => Promise.resolve(limited).then(res, rej),
        };
        return chain;
      },
      // The real conditional update, applied synchronously so a racing claim in
      // the same tick is modelled exactly as a single-document update behaves.
      updateOne: async (filter, update) => {
        updateOneCalls.push({ filter, update });
        const job = jobs.find((j) => String(j._id) === String(filter._id));
        if (!job) return { modifiedCount: 0 };
        if (filter.status && job.status !== filter.status) return { modifiedCount: 0 };
        if (filter.lockedUntil && filter.lockedUntil.$lt) {
          if (!(new Date(job.lockedUntil) < new Date(filter.lockedUntil.$lt))) {
            return { modifiedCount: 0 };
          }
        }
        if (update && update.$set) Object.assign(job, update.$set);
        return { modifiedCount: 1 };
      },
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
const aiWorker = require('../../jobs/aiWorker');
const { config } = require('../../config/env');

let providerCalls;
let providerBehaviour;
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

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-10-01T10:00:00Z');
const EXPIRED = new Date(Date.now() - 10 * 60 * 1000); // lease ran out ten minutes ago
const HELD = new Date(Date.now() + 4 * 60 * 1000); // still leased

function aiConfig(overrides = {}) {
  return {
    enabled: true,
    defaultMode: 'auto',
    provider: 'openai',
    model: 'fake-model',
    apiKeyEncrypted: require('../../utils/secretBox').encrypt('sk-test-key-for-recovery-suite'),
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

// A conversation with one inbound message, and a job in whatever state a test needs.
function setup({ job = {}, ai = {} } = {}) {
  const contactDoc = fakeDoc(
    f.contact({
      _id: f.oid(),
      lastInboundAt: T0,
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
      createdAt: T0,
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
    draftReply: '',
    nextAttemptAt: new Date(0),
    lockedUntil: new Date(0),
    ...job,
  });
  jobs.push(jobDoc);

  settingsDoc = fakeDoc(f.settings({ ai: aiConfig(ai), sendingWindow: { enabled: false } }));
  return { contact: contactDoc, conversation: convoDoc, job: jobDoc, inbound };
}

beforeEach(() => {
  logged.length = 0;
  sendCalls = [];
  providerCalls = [];
  updateOneCalls.length = 0;
  contacts = new Map();
  conversations = new Map();
  jobs = [];
  messages = [];
  locks = new Map();
  providerBehaviour = okGeneration();
  settingsDoc = fakeDoc(f.settings({ ai: aiConfig() }));
});

// ===========================================================================
describe('recovery outcomes', () => {
  test('expired claim, nothing sent, attempts remain → pending / recovered', async () => {
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED, attempts: 0 } });

    const summary = await aiWorker.recoverStuckJobs(new Date());

    assert.equal(summary.considered, 1);
    assert.equal(summary.recoveredPending, 1);
    assert.equal(job.status, 'pending');
    assert.equal(job.reason, 'recovered');
    assert.equal(new Date(job.lockedUntil).getTime(), 0, 'the stale lock was not cleared');
  });

  test('a recovered job is due immediately', async () => {
    const now = new Date();
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    await aiWorker.recoverStuckJobs(now);
    assert.equal(new Date(job.nextAttemptAt).getTime(), now.getTime());
  });

  test('expired claim with an EXISTING AI message → sent / recovered_sent', async () => {
    const { job, conversation, contact } = setup({
      job: { status: 'processing', lockedUntil: EXPIRED },
    });
    const sent = fakeDoc(
      f.smsMessage({
        _id: f.oid(),
        direction: 'outbound',
        source: 'ai',
        aiJob: job._id,
        conversation: conversation._id,
        contact: contact._id,
      })
    );
    messages.push(sent);

    const summary = await aiWorker.recoverStuckJobs(new Date());

    assert.equal(summary.recoveredSent, 1);
    assert.equal(job.status, 'sent');
    assert.equal(job.reason, 'recovered_sent');
    assert.equal(String(job.sentMessage), String(sent._id), 'the job was not linked to its message');
    assert.ok(job.processedAt);
  });

  test('recovery of an already-sent job calls NEITHER Twilio NOR the provider', async () => {
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    messages.push(fakeDoc(f.smsMessage({ _id: f.oid(), direction: 'outbound', source: 'ai', aiJob: job._id })));

    await aiWorker.recoverStuckJobs(new Date());

    assert.equal(sendCalls.length, 0, 'RECOVERY SENT A SECOND SMS');
    assert.equal(providerCalls.length, 0, 'recovery called the AI provider');
  });

  test('expired claim holding a DRAFT → drafted / recovered_approval', async () => {
    const { job } = setup({
      job: { status: 'processing', lockedUntil: EXPIRED, draftReply: 'We are open until 6pm.' },
    });

    const summary = await aiWorker.recoverStuckJobs(new Date());

    assert.equal(summary.recoveredApproval, 1);
    assert.equal(job.status, 'drafted');
    assert.equal(job.reason, 'recovered_approval');
    assert.equal(job.draftReply, 'We are open until 6pm.', 'the draft was lost');
    assert.equal(new Date(job.lockedUntil).getTime(), 0);
    assert.equal(sendCalls.length, 0);
  });

  test('expired claim at MAX ATTEMPTS → failed / recovered_max_attempts', async () => {
    const { job } = setup({
      job: { status: 'processing', lockedUntil: EXPIRED, attempts: config.ai.maxRetries },
    });

    const summary = await aiWorker.recoverStuckJobs(new Date());

    assert.equal(summary.recoveredFailed, 1);
    assert.equal(job.status, 'failed');
    assert.equal(job.reason, 'recovered_max_attempts');
    assert.equal(sendCalls.length, 0);
  });

  test('an UNEXPIRED claim is left completely untouched', async () => {
    const { job } = setup({ job: { status: 'processing', lockedUntil: HELD } });

    const summary = await aiWorker.recoverStuckJobs(new Date());

    assert.equal(summary.considered, 0, 'a live claim was picked up by recovery');
    assert.equal(job.status, 'processing');
    assert.equal(job.lockedUntil, HELD);
  });

  test('jobs in other states are never touched', async () => {
    for (const status of ['pending', 'drafted', 'sent', 'skipped', 'escalated', 'failed', 'rejected']) {
      jobs.length = 0;
      messages.length = 0;
      setup({ job: { status, lockedUntil: EXPIRED } });
      const summary = await aiWorker.recoverStuckJobs(new Date());
      assert.equal(summary.considered, 0, `${status} was picked up by recovery`);
      assert.equal(jobs[0].status, status);
    }
  });
});

// ===========================================================================
describe('the decision order', () => {
  test('an existing message WINS over a draft — it must not be re-offered', async () => {
    const { job } = setup({
      job: { status: 'processing', lockedUntil: EXPIRED, draftReply: 'a draft is present' },
    });
    messages.push(fakeDoc(f.smsMessage({ _id: f.oid(), direction: 'outbound', source: 'ai', aiJob: job._id })));

    await aiWorker.recoverStuckJobs(new Date());

    assert.equal(job.status, 'sent', 'a job that had already sent was offered for approval again');
    assert.equal(job.reason, 'recovered_sent');
  });

  test('an existing message WINS over max attempts — it is not reported as a failure', async () => {
    const { job } = setup({
      job: { status: 'processing', lockedUntil: EXPIRED, attempts: 99 },
    });
    messages.push(fakeDoc(f.smsMessage({ _id: f.oid(), direction: 'outbound', source: 'ai', aiJob: job._id })));

    await aiWorker.recoverStuckJobs(new Date());
    assert.equal(job.status, 'sent');
  });

  test('a draft WINS over max attempts — the operator can still use it', async () => {
    const { job } = setup({
      job: { status: 'processing', lockedUntil: EXPIRED, draftReply: 'ready to review', attempts: 99 },
    });
    await aiWorker.recoverStuckJobs(new Date());
    assert.equal(job.status, 'drafted');
    assert.equal(job.reason, 'recovered_approval');
  });

  test("another job's message does not count as this job's", async () => {
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    messages.push(
      fakeDoc(f.smsMessage({ _id: f.oid(), direction: 'outbound', source: 'ai', aiJob: f.oid() }))
    );
    await aiWorker.recoverStuckJobs(new Date());
    assert.equal(job.status, 'pending', 'an unrelated message was treated as this job’s send');
  });

  test('an old message with NO aiJob field does not count as a send', async () => {
    // Backward compatibility: rows written before Fix 3 have no link, and
    // "no linked message" must read as "nothing was sent".
    const { job, conversation } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    messages.push(
      fakeDoc(f.smsMessage({ _id: f.oid(), direction: 'outbound', source: 'ai', conversation: conversation._id }))
    );
    await aiWorker.recoverStuckJobs(new Date());
    assert.equal(job.status, 'pending');
  });
});

// ===========================================================================
describe('bounds and logging', () => {
  test('recovery handles at most 50 jobs in one pass', async () => {
    for (let i = 0; i < 60; i += 1) {
      setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    }
    const summary = await aiWorker.recoverStuckJobs(new Date());
    assert.equal(aiWorker.RECOVERY_LIMIT, 50);
    assert.equal(summary.considered, 50, 'recovery was not bounded');
    assert.equal(jobs.filter((j) => j.status === 'processing').length, 10, 'the rest must wait for the next pass');
  });

  test('the remainder is picked up on the next pass', async () => {
    for (let i = 0; i < 60; i += 1) setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    await aiWorker.recoverStuckJobs(new Date());
    const second = await aiWorker.recoverStuckJobs(new Date());
    assert.equal(second.considered, 10);
    assert.equal(jobs.filter((j) => j.status === 'processing').length, 0);
  });

  test('each recovery is logged with its reason, and no secret', async () => {
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED, attempts: 1 } });
    await aiWorker.recoverStuckJobs(new Date());

    const event = logged.find((e) => e.eventType === 'ai.job.recovered');
    assert.ok(event, 'the recovery was not logged');
    assert.equal(event.meta.reason, 'recovered');
    assert.equal(event.meta.jobId, String(job._id));
    assert.equal(event.meta.attempts, 1);

    const dump = JSON.stringify(logged);
    assert.ok(!dump.includes('sk-'), 'a key-shaped value reached the log');
    assert.ok(!dump.includes('apiKey'));
    assert.ok(!dump.includes('what are your hours'), 'the customer message reached the log');
  });

  test('a max-attempts recovery is logged at error level — it needs attention', async () => {
    setup({ job: { status: 'processing', lockedUntil: EXPIRED, attempts: config.ai.maxRetries } });
    await aiWorker.recoverStuckJobs(new Date());
    const event = logged.find((e) => e.eventType === 'ai.job.recovered');
    assert.equal(event.severity, 'error');
  });

  test('nothing to recover logs nothing', async () => {
    setup();
    const summary = await aiWorker.recoverStuckJobs(new Date());
    assert.equal(summary.considered, 0);
    assert.equal(logged.filter((e) => e.eventType === 'ai.job.recovered').length, 0);
  });
});

// ===========================================================================
// THE CONDITIONAL WRITE. Recovery reads a list, then writes one job at a time —
// so between the read and the write another worker can legitimately re-claim a
// job. The write must then match nothing.
describe('concurrency — recovery must never overwrite live work', () => {
  test('every recovery write carries the stale-claim condition', async () => {
    setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    await aiWorker.recoverStuckJobs(new Date());

    assert.equal(updateOneCalls.length, 1);
    const { filter } = updateOneCalls[0];
    assert.equal(filter.status, 'processing', 'the write did not require the job to still be processing');
    assert.ok(filter.lockedUntil && filter.lockedUntil.$lt, 'the write did not require an expired lease');
  });

  test('a job re-claimed between the read and the write is NOT overwritten', async () => {
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    const now = new Date();

    // Worker B re-claims it the instant after worker A listed it. Modelled by
    // moving the lease forward before A's conditional write runs.
    const realUpdateOne = require('../../models/AIReplyJob').updateOne;
    let intercepted = false;
    require('../../models/AIReplyJob').updateOne = async (filter, update) => {
      if (!intercepted) {
        intercepted = true;
        job.lockedUntil = new Date(now.getTime() + 5 * 60 * 1000); // B's fresh lease
      }
      return realUpdateOne(filter, update);
    };

    try {
      const summary = await aiWorker.recoverStuckJobs(now);
      assert.equal(summary.contended, 1, 'the contended write was not detected');
      assert.equal(summary.recoveredPending, 0);
      // B's state survives untouched.
      assert.equal(job.status, 'processing', "worker A overwrote worker B's claim");
      assert.ok(new Date(job.lockedUntil) > now, "worker A cleared worker B's lease");
    } finally {
      require('../../models/AIReplyJob').updateOne = realUpdateOne;
    }
  });

  test('a job finished by another worker first is NOT reopened', async () => {
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    const now = new Date();

    const realUpdateOne = require('../../models/AIReplyJob').updateOne;
    let intercepted = false;
    require('../../models/AIReplyJob').updateOne = async (filter, update) => {
      if (!intercepted) {
        intercepted = true;
        job.status = 'sent'; // another worker completed it
        job.reason = '';
      }
      return realUpdateOne(filter, update);
    };

    try {
      const summary = await aiWorker.recoverStuckJobs(now);
      assert.equal(summary.contended, 1);
      assert.equal(job.status, 'sent', 'recovery reopened a completed job');
      assert.equal(job.reason, '', 'recovery stamped its reason over a completed job');
    } finally {
      require('../../models/AIReplyJob').updateOne = realUpdateOne;
    }
  });

  test('two recovery passes racing the same job produce ONE transition', async () => {
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    const now = new Date();

    const [a, b] = await Promise.all([
      aiWorker.recoverStuckJobs(now),
      aiWorker.recoverStuckJobs(now),
    ]);

    const recovered = (a.recoveredPending || 0) + (b.recoveredPending || 0);
    assert.equal(recovered, 1, `expected exactly one recovery, got ${recovered}`);
    assert.equal(job.status, 'pending');
  });
});

// ===========================================================================
// THE SCENARIO THE WHOLE FIX EXISTS FOR.
describe('CRASH AFTER SENDING — exactly one SMS', () => {
  test('a crash between the send and the job update does not produce a second SMS', async () => {
    const { job } = setup();

    // 1-4. A normal pass: generate, send, record the message with its aiJob link.
    await aiWorker.processDueJobs(new Date());
    assert.equal(sendCalls.length, 1, 'setup failed: the first pass did not send');
    assert.equal(job.status, 'sent');
    const sentMessage = messages.find((m) => m.direction === 'outbound');
    assert.ok(sentMessage, 'no outbound message was recorded');
    assert.equal(String(sentMessage.aiJob), String(job._id), 'the message was not linked to its job');

    // 5. THE CRASH: the SMS is out and recorded, but the job never reached its
    //    final write — so it is still sitting in `processing` with a dead lease.
    job.status = 'processing';
    job.lockedUntil = EXPIRED;
    job.reason = '';
    job.sentMessage = undefined;

    // 6-10. Restart. Recovery runs, finds the message, and closes the job out.
    const summary = await aiWorker.recoverStuckJobs(new Date());

    assert.equal(summary.recoveredSent, 1);
    assert.equal(job.status, 'sent');
    assert.equal(job.reason, 'recovered_sent');
    assert.equal(String(job.sentMessage), String(sentMessage._id));

    // THE ASSERTION THAT MATTERS.
    assert.equal(sendCalls.length, 1, `THE CUSTOMER WAS SENT ${sendCalls.length} MESSAGES`);
    assert.equal(messages.filter((m) => m.direction === 'outbound').length, 1);
  });

  test('and a following worker pass still sends nothing more', async () => {
    const { job } = setup();
    await aiWorker.processDueJobs(new Date());
    job.status = 'processing';
    job.lockedUntil = EXPIRED;

    await aiWorker.recoverStuckJobs(new Date());
    await aiWorker.processDueJobs(new Date());

    assert.equal(sendCalls.length, 1, 'a later pass sent a duplicate');
    assert.equal(job.status, 'sent');
  });

  test('a crash BEFORE the send still lets the reply go out exactly once', async () => {
    // The other half of the story: recovery must not be so cautious that a job
    // which never sent is abandoned.
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });

    await aiWorker.recoverStuckJobs(new Date());
    assert.equal(job.status, 'pending');

    await aiWorker.processDueJobs(new Date());
    assert.equal(sendCalls.length, 1, 'the recovered job never sent');
    assert.equal(job.status, 'sent');
  });
});

// ===========================================================================
describe('recovery is wired into the worker tick', () => {
  test('a worker pass recovers before it processes the queue', async () => {
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });

    // One call does both: recovery returns it to pending, and the same pass does
    // not pick it up (the due list was read after recovery, so it is eligible).
    const summary = await aiWorker.processDueJobs(new Date());

    assert.ok(summary.recovery, 'the pass did not report a recovery phase');
    assert.equal(summary.recovery.recoveredPending, 1);
    assert.equal(job.status, 'sent', 'the recovered job was not then processed');
    assert.equal(sendCalls.length, 1);
  });

  test('recovery runs even when the send budget is zero', async () => {
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    const summary = await aiWorker.processDueJobs(new Date(), { budget: 0 });
    assert.equal(summary.recovery.recoveredPending, 1, 'a zero budget skipped recovery');
    assert.equal(job.status, 'pending');
    assert.equal(sendCalls.length, 0);
  });

  test('a recovery failure does not stop the queue being served', async () => {
    setup(); // a normal pending job
    const AIReplyJob = require('../../models/AIReplyJob');
    const realFind = AIReplyJob.find;
    let first = true;
    AIReplyJob.find = (filter) => {
      if (first && filter && filter.status === 'processing') {
        first = false;
        throw new Error('recovery query failed');
      }
      return realFind(filter);
    };
    try {
      const summary = await aiWorker.processDueJobs(new Date());
      assert.ok(summary.recovery.error, 'the recovery failure was not reported');
      assert.equal(sendCalls.length, 1, 'a recovery failure stopped the pass');
    } finally {
      AIReplyJob.find = realFind;
    }
  });

  test('the worker tick holds the lease while recovering', async () => {
    setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    const result = await aiWorker.runTick(new Date());
    assert.equal(result.heldLease, true);
    assert.ok(result.summary.recovery, 'recovery did not run inside the tick');
  });

  test('a tick that cannot take the lease recovers nothing', async () => {
    locks.set(aiWorker.LOCK_KEY, true); // another instance holds it
    const { job } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    const result = await aiWorker.runTick(new Date());
    assert.equal(result.heldLease, false);
    assert.equal(job.status, 'processing', 'recovery ran without the lease');
  });
});

// ===========================================================================
// Fix 2 must survive Fix 3: a recovered job goes back through the NORMAL
// pipeline, staleness checks and all. Recovery must never be a way around them.
describe('Fix 2 compatibility — a recovered job is still stale-checked', () => {
  test('a recovered job whose thread was answered does NOT send', async () => {
    const { job, conversation, contact } = setup({
      job: { status: 'processing', lockedUntil: EXPIRED },
    });
    // A human answered while the job was stranded.
    messages.push(
      fakeDoc(
        f.smsMessage({
          _id: f.oid(),
          direction: 'outbound',
          source: 'reply',
          conversation: conversation._id,
          contact: contact._id,
          createdAt: new Date(T0.getTime() + 60000),
        })
      )
    );

    await aiWorker.recoverStuckJobs(new Date());
    assert.equal(job.status, 'pending', 'recovery should return it to the queue');

    await aiWorker.processDueJobs(new Date());

    assert.equal(sendCalls.length, 0, 'a recovered job bypassed the staleness check');
    assert.equal(job.status, 'skipped');
    assert.equal(job.reason, 'already_answered');
  });

  test('a recovered job on a superseded message does NOT send', async () => {
    const { job, conversation, contact } = setup({
      job: { status: 'processing', lockedUntil: EXPIRED },
    });
    messages.push(
      fakeDoc(
        f.smsMessage({
          _id: f.oid(),
          direction: 'inbound',
          conversation: conversation._id,
          contact: contact._id,
          createdAt: new Date(T0.getTime() + 60000),
        })
      )
    );

    await aiWorker.recoverStuckJobs(new Date());
    await aiWorker.processDueJobs(new Date());

    assert.equal(sendCalls.length, 0);
    assert.equal(job.reason, 'superseded');
  });

  test('a recovered job on a taken-over thread does NOT send', async () => {
    const { job, conversation } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    conversation.ai.takeover = true;

    await aiWorker.recoverStuckJobs(new Date());
    await aiWorker.processDueJobs(new Date());

    assert.equal(sendCalls.length, 0);
    assert.equal(job.reason, 'takeover');
  });

  test('a recovered job for an opted-out contact does NOT send', async () => {
    const { job, contact } = setup({ job: { status: 'processing', lockedUntil: EXPIRED } });
    contact.optedOut = true;

    await aiWorker.recoverStuckJobs(new Date());
    await aiWorker.processDueJobs(new Date());

    assert.equal(sendCalls.length, 0);
    assert.equal(job.reason, 'opted_out');
  });
});
