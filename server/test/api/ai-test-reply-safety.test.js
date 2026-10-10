// Phase 10 — POST /api/ai/test cannot send anything.
//
// The Test Reply screen is a sandbox, and the only thing that makes that true is
// the backend. This file proves it STRUCTURALLY rather than by reading the code:
// twilioService, SMSMessage, Conversation, Contact, Enrollment and the AI worker
// are all replaced with doubles that RECORD every call, and a successful test
// generation must leave every one of them untouched.
//
// It also proves the endpoint's contract (what it returns, and what it refuses)
// and that a provider key never reaches the response.
'use strict';

require('../_support/env');

// This file drives the endpoint dozens of times as one admin, and the per-admin
// budget would start returning 429 part-way through. The limiter has its own
// dedicated file (ai-test-rate-limit.test.js); here it is raised out of the way
// so these tests measure what they are about. Set before config/env is loaded.
process.env.AI_TEST_RATE_LIMIT_MAX = '500';

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

// --- the things that must never be touched --------------------------------
const twilioCalls = [];
stubModule('services/twilioService', {
  sendSms: async (args) => {
    twilioCalls.push(args);
    throw new Error('TEST REPLY SENT AN SMS — this must be impossible');
  },
  isConfigured: () => false,
  getStatus: () => ({ configured: false }),
});

const workerCalls = [];
stubModule('jobs/aiWorker', {
  processDueJobs: async () => {
    workerCalls.push('processDueJobs');
    return {};
  },
  runTick: async () => {
    workerCalls.push('runTick');
    return {};
  },
  start: () => {},
  stop: () => {},
});

const optOutCalls = [];
stubModule('utils/optOut', {
  ...require('../../utils/optOut'),
  handleCarrierOptOut: async (...args) => {
    optOutCalls.push(args);
    return { applied: false };
  },
  applyOptOut: async (...args) => {
    optOutCalls.push(args);
    return {};
  },
});

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
const settingsModel = fakeModel('Settings', {
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
});
stubModule('models/Settings', settingsModel);

// Every persistence model that a send would have to touch. Each records its
// calls, so "nothing was written" is an assertion rather than a belief.
const smsMessageModel = fakeModel('SMSMessage');
const conversationModel = fakeModel('Conversation');
const contactModel = fakeModel('Contact');
const enrollmentModel = fakeModel('Enrollment');
const aiJobModel = Object.assign(fakeModel('AIReplyJob'), {
  STATUSES: require('../../models/AIReplyJob').STATUSES,
});
stubModule('models/SMSMessage', smsMessageModel);
stubModule('models/Conversation', conversationModel);
stubModule('models/Contact', contactModel);
stubModule('models/Enrollment', enrollmentModel);
stubModule('models/AIReplyJob', aiJobModel);

for (const m of [
  'models/Campaign',
  'models/Following',
  'models/Import',
  'models/Template',
  'models/ImportPreview',
  'models/SystemLog',
  'models/WorkerLock',
]) {
  stubModule(m, fakeModel(m));
}

const secretBox = require('../../utils/secretBox');
const providers = require('../../services/ai/providers');
const { startApp, tokenFor } = require('../_support/http');

const TEST_KEY = 'sk-phase10-not-a-real-key-000000000000';

let api;
let adminToken;
let operatorToken;
let providerCalls = [];
let providerImpl;

before(async () => {
  api = await startApp();
  adminToken = tokenFor(administrator);
  operatorToken = tokenFor(operator);

  // The one seam where a provider would be reached. Replaced, so no network call
  // is possible and every argument it receives can be inspected.
  for (const name of providers.PROVIDER_NAMES) {
    providers.__setAdapter(name, {
      name,
      defaultModel: 'test-model',
      generate: async (args) => {
        providerCalls.push({ name, args });
        return providerImpl(name, args);
      },
    });
  }
});
after(async () => {
  providers.__reset();
  await api.close();
});

// Everything a write would record. Checked after every successful test call.
function writeCalls() {
  const calls = [];
  for (const [label, model] of [
    ['SMSMessage', smsMessageModel],
    ['Conversation', conversationModel],
    ['Contact', contactModel],
    ['Enrollment', enrollmentModel],
    ['AIReplyJob', aiJobModel],
  ]) {
    for (const call of model.__calls) {
      if (['create', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
           'findOneAndUpdate', 'findByIdAndUpdate', 'findOneAndDelete', 'findByIdAndDelete',
          ].includes(call.method)) {
        calls.push(`${label}.${call.method}`);
      }
    }
  }
  return calls;
}

beforeEach(() => {
  logged.length = 0;
  twilioCalls.length = 0;
  workerCalls.length = 0;
  optOutCalls.length = 0;
  providerCalls = [];
  for (const m of [smsMessageModel, conversationModel, contactModel, enrollmentModel, aiJobModel]) {
    m.__reset();
  }
  providerImpl = () => ({
    provider: 'openai',
    model: 'test-model',
    text: JSON.stringify({
      reply: 'We are open until 6pm today.',
      confidence: 0.9,
      escalate: false,
      reason: '',
    }),
    usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
  });
  settingsDoc = fakeDoc(
    f.settings({
      ai: {
        enabled: false, // deliberately OFF: testing must not depend on it
        defaultMode: 'draft',
        provider: 'openai',
        model: 'test-model',
        apiKeyEncrypted: secretBox.encrypt(TEST_KEY),
        persona: 'Be brief.',
        businessRules: '',
        faq: '',
        escalationKeywords: [],
        confidenceThreshold: 0.7,
        maxRepliesPerConversation: 3,
        contextMessageLimit: 10,
        maxReplyCharacters: 320,
      },
    })
  );
});

const runTest = (message, token = adminToken) =>
  api.post('/api/ai/test', { body: { message }, token });

// ===========================================================================
describe('TEST REPLY CANNOT SEND — the guarantee', () => {
  test('a successful test never calls the Twilio wrapper', async () => {
    const res = await runTest('are you open today?');
    assert.equal(res.status, 200);
    assert.equal(twilioCalls.length, 0, 'Test Reply reached twilioService');
  });

  test('a successful test writes NOTHING to any collection', async () => {
    const res = await runTest('are you open today?');
    assert.equal(res.status, 200);
    assert.deepEqual(writeCalls(), [], `Test Reply performed writes: ${writeCalls().join(', ')}`);
  });

  test('no outbound SMSMessage is created', async () => {
    await runTest('hello');
    assert.equal(smsMessageModel.__callsTo('create').length, 0);
  });

  test('no conversation is created or modified', async () => {
    await runTest('hello');
    assert.equal(conversationModel.__callsTo('create').length, 0);
    assert.equal(conversationModel.__callsTo('updateOne').length, 0);
    assert.equal(conversationModel.__callsTo('findOneAndUpdate').length, 0);
  });

  test('no contact is created or modified', async () => {
    await runTest('hello');
    assert.equal(contactModel.__callsTo('create').length, 0);
    assert.equal(contactModel.__callsTo('updateOne').length, 0);
  });

  test('no AI job is enqueued, so the worker has nothing to pick up', async () => {
    await runTest('hello');
    assert.equal(aiJobModel.__callsTo('create').length, 0);
  });

  test('no enrollment is created — a test cannot enrol anyone', async () => {
    await runTest('hello');
    assert.equal(enrollmentModel.__callsTo('create').length, 0);
  });

  test('the AI worker is never triggered', async () => {
    await runTest('hello');
    assert.deepEqual(workerCalls, []);
  });

  test('the opt-out system is never invoked', async () => {
    await runTest('hello');
    assert.deepEqual(optOutCalls, []);
  });

  test('the response states plainly that nothing was sent', async () => {
    const res = await runTest('are you open today?');
    assert.equal(res.body.sent, false, 'the endpoint must report sent:false');
  });

  test('ten consecutive tests still send nothing and write nothing', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await runTest(`message ${i}`);
      assert.equal(res.status, 200);
    }
    assert.equal(twilioCalls.length, 0);
    assert.deepEqual(writeCalls(), []);
  });

  test('a test works with AI globally DISABLED, and does not enable it', async () => {
    assert.equal(settingsDoc.ai.enabled, false);
    const res = await runTest('are you open?');
    assert.equal(res.status, 200);
    assert.equal(settingsDoc.ai.enabled, false, 'running a test switched AI on');
    assert.equal(settingsDoc.__saves, 0, 'running a test saved settings');
  });
});

// ===========================================================================
describe('the generation contract', () => {
  test('a valid message returns the parsed reply and metadata', async () => {
    const res = await runTest('are you open today?');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.reply, 'We are open until 6pm today.');
    assert.equal(res.body.confidence, 0.9);
    assert.equal(res.body.shouldEscalate, false);
    assert.equal(res.body.provider, 'openai');
    assert.equal(res.body.model, 'test-model');
    assert.deepEqual(res.body.usage, { promptTokens: 120, completionTokens: 30, totalTokens: 150 });
  });

  test('the customer message reaches the provider, through the real prompt builder', async () => {
    await runTest('do you deliver on Sundays?');
    assert.equal(providerCalls.length, 1);
    assert.match(providerCalls[0].args.user, /do you deliver on Sundays\?/);
    // And the configured persona is included, so a test reflects real behaviour.
    assert.match(providerCalls[0].args.system, /Be brief\./);
  });

  test('an escalation signal is returned rather than hidden', async () => {
    providerImpl = () => ({
      provider: 'openai',
      model: 'test-model',
      text: JSON.stringify({ reply: '', confidence: 0.2, escalate: true, reason: 'legal question' }),
    });
    const res = await runTest('I want to speak to your lawyer');
    assert.equal(res.status, 200);
    assert.equal(res.body.shouldEscalate, true);
    assert.equal(res.body.reason, 'legal question');
  });

  test('an empty message is refused', async () => {
    for (const message of ['', '   ', '\n\t ']) {
      const res = await runTest(message);
      assert.equal(res.status, 400, `"${message}" should be refused`);
      assert.equal(providerCalls.length, 0, 'a blank message reached the provider');
    }
  });

  test('a missing message is refused', async () => {
    const res = await api.post('/api/ai/test', { body: {}, token: adminToken });
    assert.equal(res.status, 400);
  });

  test('unusable model output is a 422, and nothing is sent', async () => {
    providerImpl = () => ({ provider: 'openai', model: 'test-model', text: 'not json at all' });
    const res = await runTest('hello');
    assert.equal(res.status, 422);
    assert.equal(twilioCalls.length, 0);
    assert.deepEqual(writeCalls(), []);
  });

  test('a provider failure is a 502 with a safe message', async () => {
    providerImpl = () => {
      const { ProviderError } = require('../../services/ai/providers/errors');
      throw new ProviderError('OpenAI returned 500: upstream is unavailable', {
        kind: 'temporary',
        provider: 'openai',
      });
    };
    const res = await runTest('hello');
    assert.equal(res.status, 502);
    assert.match(res.body.message, /upstream is unavailable/);
    assert.equal(twilioCalls.length, 0);
  });

  test('no provider configured is a 400 before any call is attempted', async () => {
    settingsDoc = fakeDoc(f.settings({ ai: { enabled: false, provider: '' } }));
    const res = await runTest('hello');
    assert.equal(res.status, 400);
    assert.equal(providerCalls.length, 0);
  });
});

// ===========================================================================
describe('authorization and rate limiting are unchanged', () => {
  test('an unauthenticated request is refused', async () => {
    const res = await api.post('/api/ai/test', { body: { message: 'hi' } });
    assert.equal(res.status, 401);
    assert.equal(providerCalls.length, 0);
  });

  test('a non-admin operator is refused', async () => {
    const res = await runTest('hi', operatorToken);
    assert.equal(res.status, 403);
    assert.equal(providerCalls.length, 0, 'a non-admin spent provider credit');
  });
});

// ===========================================================================
describe('no secret ever reaches the response or the log', () => {
  test('the API key is not in the response', async () => {
    const res = await runTest('are you open today?');
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes(TEST_KEY), 'the provider API key leaked into the response');
    assert.ok(!body.includes('sk-'), 'something key-shaped leaked');
    assert.ok(!body.includes('apiKeyEncrypted'));
  });

  test('the key IS handed to the adapter, and nowhere else', async () => {
    await runTest('hello');
    // It must reach the provider — that is the point — but only there.
    assert.equal(providerCalls[0].args.apiKey, TEST_KEY);
  });

  test('a provider error quoting the key is scrubbed before it is returned', async () => {
    providerImpl = () => {
      const { ProviderError, safeDetail } = require('../../services/ai/providers/errors');
      throw new ProviderError(`OpenAI returned 401: invalid key ${safeDetail(TEST_KEY, TEST_KEY)}`, {
        kind: 'auth',
        provider: 'openai',
      });
    };
    const res = await runTest('hello');
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes(TEST_KEY), 'the key came back in an error message');
  });

  test('no log entry written by a test carries the key', async () => {
    providerImpl = () => {
      const { ProviderError } = require('../../services/ai/providers/errors');
      throw new ProviderError('OpenAI returned 401', { kind: 'auth', provider: 'openai' });
    };
    await runTest('hello');
    const dump = JSON.stringify(logged);
    assert.ok(!dump.includes(TEST_KEY));
    assert.ok(!dump.includes('sk-'));
  });

  test('the persona and FAQ are not echoed back to the client', async () => {
    settingsDoc = fakeDoc(
      f.settings({
        ai: {
          enabled: false,
          provider: 'openai',
          model: 'test-model',
          apiKeyEncrypted: secretBox.encrypt(TEST_KEY),
          persona: 'SECRET-PERSONA-TEXT',
          faq: 'SECRET-FAQ-TEXT',
          businessRules: 'SECRET-RULES-TEXT',
          maxReplyCharacters: 320,
          contextMessageLimit: 10,
        },
      })
    );
    const res = await runTest('hello');
    const body = JSON.stringify(res.body);
    for (const secret of ['SECRET-PERSONA-TEXT', 'SECRET-FAQ-TEXT', 'SECRET-RULES-TEXT']) {
      assert.ok(!body.includes(secret), `${secret} was returned to the client`);
    }
  });
});
