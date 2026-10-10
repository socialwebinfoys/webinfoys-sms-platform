// Phase 10 — AI analytics (GET /api/analytics/ai).
//
// The headline guarantee under test: EVERY NUMBER IS TRACEABLE, AND NOTHING IS
// COUNTED TWICE. Sends come from AIReplyJob.status and never from the
// `ai.reply.sent` log line, because both exist for the same event.
//
// The second guarantee: a job with no confidence is never read as 0. Phase 9
// fixed that in the UI; the aggregation must not reintroduce it.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

stubModule('services/logService', { logEvent: async () => {} });
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
stubModule('services/lookupService', { lookupNumber: async () => ({ valid: true, type: 'mobile' }) });

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

// --- aggregation doubles ----------------------------------------------------
// The controller fires several aggregations in parallel. Each is identified by
// what its pipeline ASKS FOR, so a test states its fixtures by meaning rather
// than by call order — and a reordering of the Promise.all cannot silently
// mis-assign them.
let jobPipelines = [];
let logPipelines = [];
let aiFixtures;

function classifyJobPipeline(pipeline) {
  const json = JSON.stringify(pipeline);
  if (json.includes('$bucket')) return 'confidenceBands';
  if (json.includes('atOrAbove')) return 'threshold';
  if (json.includes('"$count"')) return 'conversations';
  if (json.includes('"_id":"$status"')) return 'status';
  if (json.includes('"provider":"$provider"')) return 'providers';
  if (json.includes('"reason":"$reason"')) return 'reasons';
  if (json.includes('promptTokens')) return 'usage';
  if (json.includes('"avg"')) return 'confidence';
  return 'unknown';
}

stubModule(
  'models/AIReplyJob',
  Object.assign(
    fakeModel('AIReplyJob', {
      aggregate: (pipeline) => {
        const kind = classifyJobPipeline(pipeline);
        jobPipelines.push({ kind, pipeline });
        return query(aiFixtures.jobs[kind] || []);
      },
    }),
    { STATUSES: require('../../models/AIReplyJob').STATUSES }
  )
);

stubModule(
  'models/SystemLog',
  fakeModel('SystemLog', {
    aggregate: (pipeline) => {
      logPipelines.push(pipeline);
      return query(aiFixtures.events || []);
    },
  })
);

let conversationCounts = [];
stubModule(
  'models/Conversation',
  fakeModel('Conversation', {
    countDocuments: async (filter) => {
      conversationCounts.push(filter);
      if (filter && filter['ai.escalated']) return aiFixtures.conversationsEscalated || 0;
      if (filter && filter['ai.takeover']) return aiFixtures.conversationsTakeover || 0;
      return 0;
    },
    aggregate: () => query([]),
  })
);

for (const m of [
  'models/Contact',
  'models/Campaign',
  'models/Enrollment',
  'models/Following',
  'models/Import',
  'models/SMSMessage',
  'models/Template',
  'models/ImportPreview',
  'models/WorkerLock',
]) {
  stubModule(m, fakeModel(m));
}

const { startApp, tokenFor } = require('../_support/http');

let api;
let token;
let adminToken;

before(async () => {
  api = await startApp();
  token = tokenFor(operator);
  adminToken = tokenFor(administrator);
});
after(async () => {
  await api.close();
});

// A representative period: 10 reply attempts with a mix of outcomes.
function defaultFixtures() {
  return {
    jobs: {
      status: [
        { _id: 'sent', n: 4, approved: 3, edited: 1 },
        { _id: 'drafted', n: 2, approved: 0, edited: 0 },
        { _id: 'skipped', n: 2, approved: 0, edited: 0 },
        { _id: 'escalated', n: 1, approved: 0, edited: 0 },
        { _id: 'failed', n: 1, approved: 0, edited: 0 },
      ],
      confidence: [{ _id: null, n: 6, avg: 0.8, min: 0.45, max: 0.97 }],
      confidenceBands: [
        { _id: 0.4, n: 1 },
        { _id: 0.6, n: 1 },
        { _id: 0.8, n: 4 },
      ],
      threshold: [{ _id: null, atOrAbove: 5, below: 1 }],
      providers: [
        { _id: { provider: 'openai', model: 'gpt-4o-mini' }, jobs: 7, sent: 3, failed: 1, totalTokens: 1400 },
        { _id: { provider: 'groq', model: 'llama-3.3-70b-versatile' }, jobs: 3, sent: 1, failed: 0, totalTokens: 600 },
      ],
      usage: [
        { _id: null, promptTokens: 1500, completionTokens: 500, totalTokens: 2000, jobsWithUsage: 8 },
      ],
      reasons: [
        { _id: { reason: 'opted_out', status: 'skipped' }, n: 2 },
        { _id: { reason: 'escalation_keyword', status: 'escalated' }, n: 1 },
        { _id: { reason: 'max_retries', status: 'failed' }, n: 1 },
      ],
      conversations: [{ n: 6 }],
    },
    events: [
      { _id: { eventType: 'ai.run', severity: 'info' }, n: 12 },
      { _id: { eventType: 'ai.reply.sent', severity: 'info' }, n: 1 },
      { _id: { eventType: 'ai.draft.approved', severity: 'info' }, n: 3 },
      { _id: { eventType: 'ai.draft.rejected', severity: 'info' }, n: 1 },
      { _id: { eventType: 'ai.takeover.enabled', severity: 'info' }, n: 2 },
      { _id: { eventType: 'ai.takeover.released', severity: 'info' }, n: 1 },
      { _id: { eventType: 'ai.provider.error', severity: 'error' }, n: 5 },
      { _id: { eventType: 'ai.settings.updated', severity: 'warning' }, n: 2 },
    ],
    conversationsEscalated: 3,
    conversationsTakeover: 1,
  };
}

beforeEach(() => {
  jobPipelines = [];
  logPipelines = [];
  conversationCounts = [];
  aiFixtures = defaultFixtures();
  settingsDoc = fakeDoc(
    f.settings({
      ai: { enabled: true, defaultMode: 'draft', provider: 'openai', confidenceThreshold: 0.7 },
    })
  );
});

const get = (qs = '', t = token) => api.get(`/api/analytics/ai${qs}`, { token: t });
const pipelineOf = (kind) => (jobPipelines.find((p) => p.kind === kind) || {}).pipeline;

// ===========================================================================
describe('authorization', () => {
  test('requires authentication', async () => {
    const res = await api.get('/api/analytics/ai');
    assert.equal(res.status, 401);
  });

  test('any authenticated operator may read it, like the rest of analytics', async () => {
    assert.equal((await get('', token)).status, 200);
  });

  test('an admin may read it too', async () => {
    assert.equal((await get('', adminToken)).status, 200);
  });
});

// ===========================================================================
describe('date range', () => {
  test('defaults to all time', async () => {
    const res = await get();
    assert.equal(res.body.range, 'all');
    assert.equal(res.body.rangeStart, null);
  });

  test('today, 7d and 30d are accepted and narrow the queries', async () => {
    for (const range of ['today', '7d', '30d']) {
      jobPipelines = [];
      const res = await get(`?range=${range}`);
      assert.equal(res.body.range, range);
      assert.ok(res.body.rangeStart, `${range} produced no start date`);
      const match = pipelineOf('status')[0].$match;
      assert.ok(match.createdAt && match.createdAt.$gte, `${range} did not filter by createdAt`);
    }
  });

  test('an unknown range falls back to all time rather than erroring', async () => {
    for (const bad of ['yesterday', 'DROP', '', '7', '../../etc']) {
      const res = await get(`?range=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.range, 'all');
    }
  });

  test('a range object cannot be injected into the filter', async () => {
    const res = await get('?range[$ne]=x');
    assert.equal(res.status, 200);
    assert.equal(res.body.range, 'all');
  });

  test('the range is applied to EVERY job aggregation, not just the first', async () => {
    await get('?range=7d');
    const ranged = jobPipelines.filter(
      (p) => p.pipeline[0].$match && p.pipeline[0].$match.createdAt
    );
    assert.equal(ranged.length, jobPipelines.length, 'an aggregation ignored the date range');
  });

  test('the range is applied to the SystemLog aggregation too', async () => {
    await get('?range=30d');
    assert.ok(logPipelines[0][0].$match.createdAt.$gte instanceof Date);
  });

  test('todayts boundary is midnight UTC, matching the existing analytics', async () => {
    const res = await get('?range=today');
    const start = new Date(res.body.rangeStart);
    assert.equal(start.getUTCHours(), 0);
    assert.equal(start.getUTCMinutes(), 0);
    assert.equal(start.getUTCSeconds(), 0);
    assert.equal(start.getUTCMilliseconds(), 0);
  });
});

// ===========================================================================
describe('reply outcomes come from AIReplyJob only', () => {
  test('statuses are partitioned, and the total is their sum', async () => {
    const { jobs } = (await get()).body;
    assert.equal(jobs.total, 10);
    assert.equal(jobs.byStatus.sent, 4);
    assert.equal(jobs.byStatus.drafted, 2);
    assert.equal(jobs.byStatus.skipped, 2);
    assert.equal(jobs.byStatus.escalated, 1);
    assert.equal(jobs.byStatus.failed, 1);
    const summed = Object.values(jobs.byStatus).reduce((a, b) => a + b, 0);
    assert.equal(summed, jobs.total, 'the statuses must account for every job exactly once');
  });

  test('NO DOUBLE COUNTING: the ai.reply.sent log line does not add to sends', async () => {
    // The fixture logs one ai.reply.sent AND has 4 jobs with status sent. If the
    // controller added them, sent would read 5.
    const { jobs } = (await get()).body;
    assert.equal(jobs.sent, 4, 'sends must be counted from the job status alone');
  });

  test('human approvals are separated from automatic sends', async () => {
    const { jobs } = (await get()).body;
    assert.equal(jobs.sentApproved, 3);
    assert.equal(jobs.sentAuto, 1);
    assert.equal(jobs.sentApproved + jobs.sentAuto, jobs.sent);
  });

  test('edited approvals are reported', async () => {
    assert.equal((await get()).body.jobs.edited, 1);
  });

  test('all statuses appear even when none occurred, so a 0 reads as 0', async () => {
    const { jobs } = (await get()).body;
    for (const s of ['pending', 'processing', 'drafted', 'sent', 'skipped', 'escalated', 'failed', 'rejected']) {
      assert.equal(typeof jobs.byStatus[s], 'number', `${s} is missing from byStatus`);
    }
    assert.equal(jobs.byStatus.rejected, 0);
  });

  test('an unknown status from a newer backend is kept, not dropped', async () => {
    aiFixtures.jobs.status.push({ _id: 'teleported', n: 2, approved: 0, edited: 0 });
    const { jobs } = (await get()).body;
    assert.equal(jobs.byStatus.teleported, 2);
    assert.equal(jobs.total, 12, 'an unknown status must still count toward the total');
  });

  test('rates share one denominator and never exceed 1', async () => {
    const { jobs } = (await get()).body;
    assert.equal(jobs.sentRate, 0.4);
    assert.equal(jobs.skipRate, 0.2);
    assert.equal(jobs.escalationRate, 0.1);
    assert.equal(jobs.failureRate, 0.1);
    for (const key of ['sentRate', 'skipRate', 'escalationRate', 'failureRate', 'rejectionRate']) {
      assert.ok(jobs[key] >= 0 && jobs[key] <= 1, `${key} is out of range`);
    }
  });
});

// ===========================================================================
describe('empty data', () => {
  beforeEach(() => {
    aiFixtures = {
      jobs: { status: [], confidence: [], confidenceBands: [], threshold: [], providers: [], usage: [], reasons: [], conversations: [] },
      events: [],
      conversationsEscalated: 0,
      conversationsTakeover: 0,
    };
  });

  test('returns 200 with zeroes rather than failing', async () => {
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.body.jobs.total, 0);
  });

  test('NO DIVISION BY ZERO — every rate is 0, never NaN or Infinity', async () => {
    const { jobs } = (await get()).body;
    for (const key of ['sentRate', 'skipRate', 'escalationRate', 'failureRate', 'rejectionRate']) {
      assert.equal(jobs[key], 0, `${key} should be 0 with no data`);
      assert.ok(Number.isFinite(jobs[key]));
    }
  });

  test('average confidence is NULL, not 0 — there is nothing to average', async () => {
    const { confidence } = (await get()).body;
    assert.equal(confidence.measured, 0);
    assert.equal(confidence.average, null, 'no data must not be reported as 0% confidence');
    assert.equal(confidence.min, null);
    assert.equal(confidence.max, null);
  });

  test('token usage reads 0 rather than being absent', async () => {
    const { usage } = (await get()).body;
    assert.equal(usage.totalTokens, 0);
    assert.equal(usage.promptTokens, 0);
    assert.equal(usage.completionTokens, 0);
  });

  test('lists are empty arrays, so the UI can render an empty state', async () => {
    const body = (await get()).body;
    assert.deepEqual(body.providers, []);
    assert.deepEqual(body.reasons, []);
    assert.deepEqual(body.activity.byEventType, []);
  });
});

// ===========================================================================
describe('confidence', () => {
  test('only measured jobs are averaged', async () => {
    const { confidence, jobs } = (await get()).body;
    assert.equal(confidence.measured, 6);
    assert.equal(confidence.missing, jobs.total - 6);
    assert.equal(confidence.average, 0.8);
  });

  test('the aggregation EXCLUDES jobs with no numeric confidence', async () => {
    await get();
    // The guarantee is in the pipeline: a $type check, not a null-to-zero default.
    const match = pipelineOf('confidence')[0].$match;
    assert.deepEqual(match.confidence, { $type: 'number' });
  });

  test('missing confidence is reported as missing, never folded into the average', async () => {
    aiFixtures.jobs.confidence = [{ _id: null, n: 2, avg: 0.9, min: 0.85, max: 0.95 }];
    const { confidence } = (await get()).body;
    assert.equal(confidence.average, 0.9, 'the average must come from the 2 measured jobs only');
    assert.equal(confidence.measured, 2);
    assert.equal(confidence.missing, 8);
  });

  test('the configured threshold is reported, not a hardcoded one', async () => {
    settingsDoc = fakeDoc(f.settings({ ai: { confidenceThreshold: 0.55 } }));
    const { confidence } = (await get()).body;
    assert.equal(confidence.threshold, 0.55);
    const match = pipelineOf('threshold')[1].$group.atOrAbove.$sum.$cond[0];
    assert.deepEqual(match, { $gte: ['$confidence', 0.55] }, 'the split must use the configured value');
  });

  test('an unconfigured threshold falls back to the schema default of 0.7', async () => {
    settingsDoc = fakeDoc(f.settings({ ai: {} }));
    assert.equal((await get()).body.confidence.threshold, 0.7);
  });

  test('missing settings do not break the endpoint', async () => {
    settingsDoc = null;
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.body.confidence.threshold, 0.7);
  });

  test('the threshold split is reported', async () => {
    const { confidence } = (await get()).body;
    assert.equal(confidence.atOrAboveThreshold, 5);
    assert.equal(confidence.belowThreshold, 1);
    assert.equal(confidence.atOrAboveThreshold + confidence.belowThreshold, confidence.measured);
  });

  test('the distribution covers 0 to 1 with no gaps, and empty bands read 0', async () => {
    const { confidence } = (await get()).body;
    assert.equal(confidence.distribution.length, 5);
    assert.equal(confidence.distribution[0].from, 0);
    assert.equal(confidence.distribution[4].to, 1, 'the top band must end at 1, not 1.0001');
    for (let i = 1; i < confidence.distribution.length; i += 1) {
      assert.equal(confidence.distribution[i].from, confidence.distribution[i - 1].to);
    }
    assert.equal(confidence.distribution[0].n, 0, 'a band with no jobs reads 0');
    assert.equal(confidence.distribution[4].n, 4);
    const summed = confidence.distribution.reduce((a, b) => a + b.n, 0);
    assert.equal(summed, confidence.measured);
  });
});

// ===========================================================================
describe('providers and models', () => {
  test('only providers present in the data are reported', async () => {
    const { providers } = (await get()).body;
    assert.equal(providers.length, 2);
    assert.deepEqual(providers.map((p) => p.provider), ['openai', 'groq']);
    // gemini is configured but unused — it must not appear with a fake zero.
    assert.ok(!providers.some((p) => p.provider === 'gemini'));
  });

  test('each row carries its model and counts', async () => {
    const [openai] = (await get()).body.providers;
    assert.equal(openai.model, 'gpt-4o-mini');
    assert.equal(openai.jobs, 7);
    assert.equal(openai.sent, 3);
    assert.equal(openai.failed, 1);
    assert.equal(openai.totalTokens, 1400);
  });

  test('a blank provider is excluded from the breakdown', async () => {
    await get();
    assert.deepEqual(pipelineOf('providers')[0].$match.provider, { $nin: ['', null] });
  });

  test('the breakdown is bounded, not unlimited', async () => {
    await get();
    const limit = pipelineOf('providers').find((s) => s.$limit);
    assert.ok(limit && limit.$limit <= 50, 'the provider breakdown must be bounded');
  });

  test('NO API KEY, encrypted or otherwise, appears anywhere in the response', async () => {
    const res = await get();
    const body = JSON.stringify(res.body);
    for (const forbidden of ['apiKey', 'apiKeyEncrypted', 'sk-', 'masked', 'encryptionConfigured']) {
      assert.ok(!body.includes(forbidden), `${forbidden} leaked into AI analytics`);
    }
  });

  test('no persona, FAQ or business rules leak through the settings read', async () => {
    settingsDoc = fakeDoc(
      f.settings({
        ai: {
          confidenceThreshold: 0.7,
          persona: 'SECRET-PERSONA',
          faq: 'SECRET-FAQ',
          businessRules: 'SECRET-RULES',
          apiKeyEncrypted: 'v1.aaa.bbb.ccc',
        },
      })
    );
    const body = JSON.stringify((await get()).body);
    for (const secret of ['SECRET-PERSONA', 'SECRET-FAQ', 'SECRET-RULES', 'v1.aaa']) {
      assert.ok(!body.includes(secret), `${secret} leaked`);
    }
  });
});

// ===========================================================================
describe('token usage', () => {
  test('prompt, completion and total are reported separately', async () => {
    const { usage } = (await get()).body;
    assert.equal(usage.promptTokens, 1500);
    assert.equal(usage.completionTokens, 500);
    assert.equal(usage.totalTokens, 2000);
  });

  test('how many jobs actually reported usage is stated', async () => {
    const { usage, jobs } = (await get()).body;
    assert.equal(usage.jobsWithUsage, 8);
    assert.equal(usage.jobsWithoutUsage, jobs.total - 8);
  });

  test('NO COST is reported — this platform has no pricing model', async () => {
    const res = await get();
    // `notes` is excluded on purpose: it is the written explanation that no cost
    // is calculated, so it legitimately contains the word. What must not exist is
    // a cost FIGURE among the metrics.
    const { notes, ...metrics } = res.body;
    const body = JSON.stringify(metrics);
    assert.ok(!/"cost"/i.test(body), 'a cost metric was invented');
    assert.ok(!/\$\d/.test(body), 'a currency amount appeared');
    assert.ok(!/"price"/i.test(body));
    assert.ok(!/"spend"/i.test(body));
    // And the disclaimer is actually present.
    assert.match(notes.cost, /no provider pricing model/i);
  });
});

// ===========================================================================
describe('skip and failure reasons', () => {
  test('actual stored reason tokens are returned with their status', async () => {
    const { reasons } = (await get()).body;
    assert.deepEqual(reasons[0], { reason: 'opted_out', status: 'skipped', n: 2 });
    assert.equal(reasons.length, 3);
  });

  test('only non-sent outcomes contribute a reason', async () => {
    await get();
    const match = pipelineOf('reasons')[0].$match;
    assert.deepEqual(match.status.$in.sort(), ['escalated', 'failed', 'rejected', 'skipped']);
  });

  test('blank reasons are excluded rather than shown as an empty row', async () => {
    await get();
    assert.deepEqual(pipelineOf('reasons')[0].$match.reason, { $nin: ['', null] });
  });

  test('the reason list is bounded', async () => {
    await get();
    assert.ok(pipelineOf('reasons').some((s) => s.$limit));
  });

  test('no error text or stack trace is exposed through reasons', async () => {
    aiFixtures.jobs.reasons = [
      { _id: { reason: 'send_failed', status: 'failed' }, n: 1 },
    ];
    const body = JSON.stringify((await get()).body);
    assert.ok(!body.includes('at /'), 'a stack trace frame appeared');
    assert.ok(!body.includes('lastError'));
  });
});

// ===========================================================================
describe('human handoff', () => {
  test('takeovers come from SystemLog, escalations from the jobs', async () => {
    const { handoff } = (await get()).body;
    assert.equal(handoff.takeoversEnabled, 2);
    assert.equal(handoff.takeoversReleased, 1);
    assert.equal(handoff.escalatedJobs, 1);
  });

  test('conversations touched by AI is reported as context', async () => {
    assert.equal((await get()).body.handoff.conversationsWithAiActivity, 6);
  });

  test('NO takeover RATE is invented — the populations differ', async () => {
    const { handoff, notes } = (await get()).body;
    assert.equal(handoff.takeoverRate, undefined, 'a misleading rate was calculated');
    assert.match(notes.takeoverRate, /not calculated/i);
  });

  test('point-in-time counts are reported and labelled as such', async () => {
    const { handoff, notes } = (await get()).body;
    assert.equal(handoff.conversationsEscalatedNow, 3);
    assert.equal(handoff.conversationsUnderTakeoverNow, 1);
    assert.match(notes.pointInTime, /not affected by the selected range/i);
  });

  test('deleted conversations are excluded from the point-in-time counts', async () => {
    await get();
    for (const filter of conversationCounts) {
      assert.equal(filter.deletedAt, null, 'a soft-deleted conversation was counted');
    }
  });
});

// ===========================================================================
describe('activity from SystemLog', () => {
  test('only ai.* events are aggregated', async () => {
    await get();
    assert.deepEqual(logPipelines[0][0].$match.eventType, { $regex: '^ai\\.' });
  });

  test('named activity counts are derived from the actual event types', async () => {
    const { activity } = (await get()).body;
    assert.equal(activity.runs, 12);
    assert.equal(activity.providerErrors, 5);
    assert.equal(activity.settingsChanges, 2);
    assert.equal(activity.draftsApproved, 3);
    assert.equal(activity.draftsRejected, 1);
  });

  test('the full event breakdown is returned with severity', async () => {
    const { activity } = (await get()).body;
    assert.equal(activity.byEventType.length, 8);
    const err = activity.byEventType.find((e) => e.eventType === 'ai.provider.error');
    assert.equal(err.severity, 'error');
  });

  test('an unseen event type simply reads 0', async () => {
    aiFixtures.events = [{ _id: { eventType: 'ai.run', severity: 'info' }, n: 1 }];
    const { activity } = (await get()).body;
    assert.equal(activity.runs, 1);
    assert.equal(activity.providerErrors, 0);
    assert.equal(activity.draftsApproved, 0);
  });

  test('an event type this build does not know is still listed', async () => {
    aiFixtures.events.push({ _id: { eventType: 'ai.brand.new', severity: 'info' }, n: 7 });
    const { activity } = (await get()).body;
    assert.ok(activity.byEventType.some((e) => e.eventType === 'ai.brand.new' && e.n === 7));
  });
});

// ===========================================================================
describe('the response documents its own limits', () => {
  test('it states which source powers which metric', async () => {
    const { notes } = (await get()).body;
    assert.match(notes.sources, /AIReplyJob/);
    assert.match(notes.sources, /SystemLog/);
    assert.match(notes.sources, /counted once/i);
  });

  test('it states that no cost model exists', async () => {
    assert.match((await get()).body.notes.cost, /no provider pricing model/i);
  });

  test('it reports when it was generated and over what window', async () => {
    const res = await get('?range=7d');
    assert.ok(res.body.generatedAt);
    assert.ok(res.body.rangeStart);
    assert.equal(res.body.range, '7d');
  });
});
