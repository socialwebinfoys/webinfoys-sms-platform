// Fix 2 — a manual reply stands the assistant down.
//
// When an operator answers a thread by hand, two things must happen, and only
// one of them is configurable:
//
//   ALWAYS  — queued and drafted AI replies for that conversation are cancelled.
//             This is the double-reply bug itself, so it is not a preference.
//   DEFAULT — the thread is handed to that operator (takeover), unless
//             autoTakeoverOnManualReply is explicitly switched off.
//
// And the condition on both: the manual message must actually have been sent. A
// failed send must leave the assistant exactly as it was.
//
// The real Express app, the real reply controller and the real twilioService
// wrapper run here; with SMS_SIMULATE=true the wrapper simulates, so a "send"
// exercises the shipped code path without touching Twilio.
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
  runTick: async () => ({}),
  start: () => {},
  stop: () => {},
  resolveTimezone: () => 'UTC',
  isSendableAt: () => true,
});
stubModule('jobs/aiWorker', { processDueJobs: async () => ({}), start: () => {}, stop: () => {} });
stubModule('services/lookupService', {
  lookupNumber: async () => ({ valid: true, type: 'mobile', carrier: 'Test' }),
});

const operator = f.user({ name: 'Grace Hopper' });
const administrator = f.admin();
const usersById = new Map([
  [String(operator._id), operator],
  [String(administrator._id), administrator],
]);
stubModule(
  'models/User',
  fakeModel('User', {
    findById: (id) => query(usersById.get(String(id)) || null),
    find: () => query([...usersById.values()]),
  })
);

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

let contactDoc;
stubModule(
  'models/Contact',
  fakeModel('Contact', {
    findById: (id) => query(String(contactDoc._id) === String(id) ? contactDoc : null),
    findOne: () => query(contactDoc),
    updateOne: async () => ({ modifiedCount: 1 }),
  })
);

let conversationDoc;
const conversationUpdates = [];
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
stubModule(
  'models/Conversation',
  fakeModel('Conversation', {
    findOne: (filter) => {
      if (String(filter._id) !== String(conversationDoc._id)) return query(null);
      if (filter.deletedAt === null && conversationDoc.deletedAt) return query(null);
      return query(conversationDoc);
    },
    findById: () => query(conversationDoc),
    updateOne: async (filter, update) => {
      conversationUpdates.push({ filter, update });
      if (update && update.$set) applyDotted(conversationDoc, update.$set);
      return { modifiedCount: 1 };
    },
  })
);

const createdMessages = [];
stubModule(
  'models/SMSMessage',
  fakeModel('SMSMessage', {
    create: async (doc) => {
      const record = fakeDoc({ _id: f.oid(), createdAt: new Date(), ...doc });
      createdMessages.push(record);
      return record;
    },
    findById: () => query(null),
    find: () => {
      const chain = {
        sort: () => chain,
        limit: () => chain,
        select: () => chain,
        then: (res, rej) => Promise.resolve([]).then(res, rej),
      };
      return chain;
    },
    countDocuments: async () => 0,
  })
);

// The AI jobs for this conversation, with a faithful updateMany that honours the
// status filter — so "only pending and drafted were cancelled" is a real
// assertion rather than a restatement of the code.
let aiJobs;
const updateManyCalls = [];
stubModule(
  'models/AIReplyJob',
  Object.assign(
    fakeModel('AIReplyJob', {
      updateMany: async (filter, update) => {
        updateManyCalls.push({ filter, update });
        let modifiedCount = 0;
        for (const job of aiJobs) {
          if (filter.conversation && String(job.conversation) !== String(filter.conversation)) continue;
          if (filter.status && filter.status.$in && !filter.status.$in.includes(job.status)) continue;
          if (update && update.$set) Object.assign(job, update.$set);
          modifiedCount += 1;
        }
        return { modifiedCount };
      },
      find: () => {
        const chain = {
          sort: () => chain,
          skip: () => chain,
          limit: () => chain,
          select: () => chain,
          populate: () => chain,
          then: (res, rej) => Promise.resolve(aiJobs).then(res, rej),
        };
        return chain;
      },
    }),
    { STATUSES: require('../../models/AIReplyJob').STATUSES }
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

// The real wrapper, with a seam for the failure case.
const twilioService = require('../../services/twilioService');
const realSendSms = twilioService.sendSms;
const sends = [];
let sendImpl = null;
twilioService.sendSms = async (args) => {
  sends.push(args);
  if (sendImpl) return sendImpl(args);
  return realSendSms(args);
};

const { REASONS } = require('../../services/ai/guardrails');
const { startApp, tokenFor } = require('../_support/http');

let api;
let token;

before(async () => {
  api = await startApp();
  token = tokenFor(operator);
});
after(async () => {
  await api.close();
  twilioService.sendSms = realSendSms;
});

const DAY = 24 * 60 * 60 * 1000;

function makeJob(status, overrides = {}) {
  return fakeDoc({
    _id: f.oid(),
    conversation: conversationDoc._id,
    contact: contactDoc._id,
    inboundMessage: f.oid(),
    status,
    mode: 'draft',
    draftReply: 'We are open until 6pm.',
    reason: status === 'drafted' ? 'draft_mode' : '',
    lockedUntil: new Date(0),
    ...overrides,
  });
}

beforeEach(() => {
  logged.length = 0;
  sends.length = 0;
  createdMessages.length = 0;
  conversationUpdates.length = 0;
  updateManyCalls.length = 0;
  sendImpl = null;

  settingsDoc = fakeDoc(
    f.settings({
      smsEnabled: true,
      ai: {
        enabled: true,
        defaultMode: 'draft',
        provider: 'openai',
        autoTakeoverOnManualReply: true,
        maxRepliesPerConversation: 3,
        confidenceThreshold: 0.7,
        contextMessageLimit: 10,
        maxReplyCharacters: 320,
        escalationKeywords: [],
      },
    })
  );

  contactDoc = fakeDoc(
    f.contact({
      _id: f.oid(),
      lastInboundAt: new Date(),
      lookup: { status: 'valid', type: 'mobile', lookedUpAt: new Date(Date.now() - DAY) },
    })
  );
  conversationDoc = fakeDoc(
    f.conversation({
      _id: f.oid(),
      contact: contactDoc._id,
      ai: { takeover: false, takeoverAt: undefined, mode: '', replyCount: 1, escalated: false },
    })
  );
  aiJobs = [];
});

const reply = (body = 'Yes, we are open until 6pm.') =>
  api.post(`/api/conversations/${conversationDoc._id}/reply`, { body: { body }, token });

const jobsByStatus = (status) => aiJobs.filter((j) => j.status === status);

// ===========================================================================
describe('a successful manual reply, setting ON', () => {
  test('the reply itself still works exactly as before', async () => {
    const res = await reply();
    assert.equal(res.status, 201);
    assert.equal(sends.length, 1);
    assert.equal(createdMessages.length, 1);
    assert.equal(createdMessages[0].source, 'reply');
  });

  test('the conversation is handed to the operator', async () => {
    await reply();
    assert.equal(conversationDoc.ai.takeover, true);
    assert.ok(conversationDoc.ai.takeoverAt instanceof Date);
    assert.equal(String(conversationDoc.ai.takeoverBy), String(operator._id));
  });

  test('a PENDING AI job is cancelled', async () => {
    aiJobs = [makeJob('pending')];
    await reply();
    assert.equal(aiJobs[0].status, 'skipped');
    assert.equal(aiJobs[0].reason, REASONS.HUMAN_REPLIED);
  });

  test('a DRAFTED AI job is cancelled', async () => {
    aiJobs = [makeJob('drafted')];
    await reply();
    assert.equal(aiJobs[0].status, 'skipped');
    assert.equal(aiJobs[0].reason, 'human_replied');
  });

  test('several queued and drafted jobs are all cancelled', async () => {
    aiJobs = [makeJob('pending'), makeJob('drafted'), makeJob('pending')];
    await reply();
    assert.equal(jobsByStatus('skipped').length, 3);
    for (const job of aiJobs) assert.equal(job.reason, REASONS.HUMAN_REPLIED);
  });

  test('a cancelled job has its lock released so it can never be claimed again', async () => {
    aiJobs = [makeJob('pending', { lockedUntil: new Date(Date.now() + 60000) })];
    await reply();
    assert.equal(new Date(aiJobs[0].lockedUntil).getTime(), 0, 'the claim lease was not released');
    assert.ok(aiJobs[0].processedAt, 'the job was not marked processed');
  });

  test('a job already PROCESSING is deliberately left alone', async () => {
    // It is mid-flight; the pre-send staleness check is what stops it, not this.
    aiJobs = [makeJob('processing')];
    await reply();
    assert.equal(aiJobs[0].status, 'processing', 'an in-flight job must not be rewritten');
  });

  test('terminal jobs are not disturbed', async () => {
    aiJobs = [makeJob('sent'), makeJob('rejected'), makeJob('escalated'), makeJob('failed')];
    const before = aiJobs.map((j) => j.status);
    await reply();
    assert.deepEqual(aiJobs.map((j) => j.status), before);
  });

  test('only this conversation is affected', async () => {
    const otherJob = makeJob('pending', { conversation: f.oid() });
    aiJobs = [makeJob('pending'), otherJob];
    await reply();
    assert.equal(otherJob.status, 'pending', "another thread's queued reply was cancelled");
  });

  test('the cancellation filter asks for pending and drafted only', async () => {
    aiJobs = [makeJob('pending')];
    await reply();
    assert.equal(updateManyCalls.length, 1);
    assert.deepEqual(updateManyCalls[0].filter.status.$in.sort(), ['drafted', 'pending']);
  });

  test('the stand-down is logged', async () => {
    aiJobs = [makeJob('pending')];
    await reply();
    const event = logged.find((e) => e.eventType === 'ai.takeover.auto');
    assert.ok(event, 'ai.takeover.auto was not logged');
    assert.equal(event.severity, 'info');
    assert.equal(event.status, 'takeover');
    assert.match(event.message, /Grace Hopper/);
    assert.match(event.message, /stood down/i);
    assert.equal(String(event.conversation), String(conversationDoc._id));
    assert.equal(event.meta.cancelledJobs, 1);
    assert.equal(event.meta.takeover, true);
  });

  test('the existing reply.sent log is still written', async () => {
    await reply();
    assert.ok(logged.some((e) => e.eventType === 'reply.sent'), 'the reply log was lost');
  });

  test('takeover only touches the AI takeover fields', async () => {
    conversationDoc.ai = {
      takeover: false,
      mode: 'auto',
      replyCount: 7,
      escalated: true,
      escalationReason: 'escalation_keyword',
    };
    await reply();
    assert.equal(conversationDoc.ai.takeover, true);
    assert.equal(conversationDoc.ai.mode, 'auto', 'the per-conversation mode was changed');
    assert.equal(conversationDoc.ai.replyCount, 7, 'the reply count was changed');
    assert.equal(conversationDoc.ai.escalated, true, 'the escalation state was changed');
    const aiUpdate = conversationUpdates.find((u) => u.update.$set && u.update.$set['ai.takeover']);
    assert.deepEqual(
      Object.keys(aiUpdate.update.$set).sort(),
      ['ai.takeover', 'ai.takeoverAt', 'ai.takeoverBy']
    );
  });
});

// ===========================================================================
describe('a successful manual reply, setting OFF', () => {
  beforeEach(() => {
    settingsDoc.ai.autoTakeoverOnManualReply = false;
  });

  test('queued and drafted jobs are STILL cancelled', async () => {
    aiJobs = [makeJob('pending'), makeJob('drafted')];
    await reply();
    assert.equal(jobsByStatus('skipped').length, 2, 'cancellation must not be configurable');
    for (const job of aiJobs) assert.equal(job.reason, REASONS.HUMAN_REPLIED);
  });

  test('the conversation is NOT taken over', async () => {
    aiJobs = [makeJob('pending')];
    await reply();
    assert.equal(conversationDoc.ai.takeover, false, 'takeover was applied with the setting off');
    assert.equal(conversationDoc.ai.takeoverAt, undefined);
  });

  test('an existing takeover is left exactly as it was', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    conversationDoc.ai.takeover = true;
    conversationDoc.ai.takeoverAt = at;
    await reply();
    assert.equal(conversationDoc.ai.takeover, true);
    assert.equal(conversationDoc.ai.takeoverAt, at, 'the takeover timestamp was overwritten');
  });

  test('the log records that no takeover was applied', async () => {
    aiJobs = [makeJob('pending')];
    await reply();
    const event = logged.find((e) => e.eventType === 'ai.takeover.auto');
    assert.ok(event);
    assert.equal(event.meta.takeover, false);
    assert.equal(event.meta.cancelledJobs, 1);
  });

  test('an absent setting behaves as ON — an old settings document is unchanged', async () => {
    delete settingsDoc.ai.autoTakeoverOnManualReply;
    await reply();
    assert.equal(conversationDoc.ai.takeover, true);
  });
});

// ===========================================================================
describe('a FAILED manual reply changes nothing', () => {
  beforeEach(() => {
    sendImpl = async () => {
      const err = new Error('Twilio is unavailable');
      throw err;
    };
  });

  test('the request still reports the failure', async () => {
    const res = await reply();
    assert.equal(res.status, 502);
  });

  test('the conversation is NOT taken over', async () => {
    await reply();
    assert.equal(conversationDoc.ai.takeover, false, 'a failed send took the thread over');
  });

  test('AI jobs are NOT cancelled', async () => {
    aiJobs = [makeJob('pending'), makeJob('drafted')];
    await reply();
    assert.equal(aiJobs[0].status, 'pending', 'a failed send cancelled queued AI work');
    assert.equal(aiJobs[1].status, 'drafted');
    assert.equal(updateManyCalls.length, 0);
  });

  test('no stand-down is logged', async () => {
    aiJobs = [makeJob('pending')];
    await reply();
    assert.ok(!logged.some((e) => e.eventType === 'ai.takeover.auto'));
  });
});

// ===========================================================================
describe('a BLOCKED manual reply changes nothing', () => {
  test('an opted-out contact is refused, and the assistant is untouched', async () => {
    contactDoc.optedOut = true;
    aiJobs = [makeJob('pending')];
    const res = await reply();
    assert.equal(res.status, 403);
    assert.equal(sends.length, 0);
    assert.equal(aiJobs[0].status, 'pending');
    assert.equal(conversationDoc.ai.takeover, false);
  });

  test('smsEnabled=false is refused, and the assistant is untouched', async () => {
    settingsDoc.smsEnabled = false;
    aiJobs = [makeJob('drafted')];
    const res = await reply();
    assert.equal(res.status, 400);
    assert.equal(aiJobs[0].status, 'drafted');
    assert.equal(conversationDoc.ai.takeover, false);
  });

  test('an empty body is refused before anything happens', async () => {
    aiJobs = [makeJob('pending')];
    const res = await api.post(`/api/conversations/${conversationDoc._id}/reply`, {
      body: { body: '   ' },
      token,
    });
    assert.equal(res.status, 400);
    assert.equal(aiJobs[0].status, 'pending');
  });
});

// ===========================================================================
describe('the stand-down can never break the reply', () => {
  test('a cancellation failure still returns 201 — the message was delivered', async () => {
    const AIReplyJob = require('../../models/AIReplyJob');
    const realUpdateMany = AIReplyJob.updateMany;
    AIReplyJob.updateMany = async () => {
      throw new Error('database unavailable');
    };
    try {
      const res = await reply();
      assert.equal(res.status, 201, 'a stand-down failure turned a sent SMS into an error');
      assert.equal(sends.length, 1);
    } finally {
      AIReplyJob.updateMany = realUpdateMany;
    }
  });
});

// ===========================================================================
describe('release still works after an automatic takeover', () => {
  test('releasing hands the thread back without resurrecting cancelled work', async () => {
    aiJobs = [makeJob('pending')];
    await reply();
    assert.equal(conversationDoc.ai.takeover, true);
    assert.equal(aiJobs[0].status, 'skipped');

    const res = await api.delete(`/api/ai/conversations/${conversationDoc._id}/takeover`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.takeover, false);
    // The cancelled job stays cancelled — releasing must not revive it.
    assert.equal(aiJobs[0].status, 'skipped', 'releasing resurrected a cancelled job');
    assert.equal(aiJobs[0].reason, REASONS.HUMAN_REPLIED);
  });
});
