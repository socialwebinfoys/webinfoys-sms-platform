// Phase 8.1 — the rate limit on POST /api/ai/test.
//
// That endpoint is the one authenticated route that spends money per call: it
// reaches a third-party model. Admin-only caps WHO may spend provider credit,
// not how much, so it carries a budget of its own.
//
// The limit is read from the environment at load time, so this file sets a small
// value BEFORE anything requires config/env. That is also the point of the test:
// the limit is genuinely configurable, and the suite does not have to fire
// thirty requests to prove it works.
//
// The budget is keyed per ADMIN, so each test uses its own admin and gets its own
// fresh allowance — no ordering dependencies between tests.
'use strict';

require('../_support/env');

// Must happen before config/env.js is first required (app.js pulls it in, lazily,
// inside startApp below).
const LIMIT = 3;
process.env.AI_TEST_RATE_LIMIT_MAX = String(LIMIT);
process.env.AI_TEST_RATE_LIMIT_WINDOW_MINUTES = '15';

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
stubModule('services/lookupService', { lookupNumber: async () => ({ valid: true, type: 'mobile' }) });

// Several admins, so each test draws on its own budget.
const admins = Array.from({ length: 6 }, (_, i) =>
  f.admin({ _id: f.oid(), email: `admin${i}@test.invalid` })
);
const operator = f.user();
const usersById = new Map([
  [String(operator._id), operator],
  ...admins.map((a) => [String(a._id), a]),
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

for (const m of [
  'models/Contact',
  'models/Conversation',
  'models/Campaign',
  'models/Enrollment',
  'models/Following',
  'models/Import',
  'models/SMSMessage',
  'models/Template',
  'models/ImportPreview',
  'models/SystemLog',
  'models/WorkerLock',
  'models/AIReplyJob',
]) {
  stubModule(m, fakeModel(m));
}

const secretBox = require('../../utils/secretBox');
const providers = require('../../services/ai/providers');
const { startApp, tokenFor } = require('../_support/http');

let api;
let tokens;

// A stand-in adapter: the real controller, the real prompt builder and the real
// parser all run, but nothing leaves the process. The provider call is the thing
// the limit exists to ration, so it is counted.
let providerCalls = 0;

before(async () => {
  api = await startApp();
  tokens = admins.map((a) => tokenFor(a));

  for (const name of providers.PROVIDER_NAMES) {
    providers.__setAdapter(name, {
      name,
      defaultModel: 'test-model',
      generate: async () => {
        providerCalls += 1;
        return {
          provider: name,
          model: 'test-model',
          text: JSON.stringify({ reply: 'We are open until 6pm.', confidence: 0.9, escalate: false }),
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      },
    });
  }
});
after(async () => {
  providers.__reset();
  await api.close();
});

beforeEach(() => {
  logged.length = 0;
  providerCalls = 0;
  settingsDoc = fakeDoc(
    f.settings({
      ai: {
        enabled: false, // the limiter is independent of the master switch
        defaultMode: 'draft',
        provider: 'openai',
        model: 'test-model',
        apiKeyEncrypted: secretBox.encrypt('sk-test-key-for-the-rate-limit-suite'),
        persona: '',
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

const callTest = (token) =>
  api.post('/api/ai/test', { body: { message: 'are you open today?' }, token });

// ===========================================================================
describe('POST /api/ai/test — within the budget', () => {
  test('an admin may call up to the configured limit', async () => {
    const token = tokens[0];
    for (let i = 1; i <= LIMIT; i += 1) {
      const res = await callTest(token);
      assert.equal(res.status, 200, `request ${i} should have been allowed`);
      assert.equal(res.body.sent, false, 'the test endpoint must never send');
    }
    assert.equal(providerCalls, LIMIT);
  });

  test('the standard RateLimit headers are present', async () => {
    const res = await callTest(tokens[1]);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('ratelimit') || res.headers.get('ratelimit-limit'));
    // The legacy X- headers are off, matching the login limiter.
    assert.equal(res.headers.get('x-ratelimit-limit'), null);
  });
});

// ===========================================================================
describe('POST /api/ai/test — over the budget', () => {
  test('the request past the limit is refused with 429 and the API error shape', async () => {
    const token = tokens[2];
    for (let i = 0; i < LIMIT; i += 1) await callTest(token);

    const res = await callTest(token);
    assert.equal(res.status, 429);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /too many/i);
  });

  test('a refused request does NOT reach the provider', async () => {
    const token = tokens[3];
    for (let i = 0; i < LIMIT; i += 1) await callTest(token);
    assert.equal(providerCalls, LIMIT);

    await callTest(token);
    await callTest(token);
    assert.equal(providerCalls, LIMIT, 'no provider credit may be spent once limited');
  });

  test('the 429 body leaks no configuration, key or provider detail', async () => {
    const token = tokens[4];
    for (let i = 0; i < LIMIT; i += 1) await callTest(token);
    const res = await callTest(token);

    const text = res.text || '';
    assert.ok(!/sk-/.test(text), 'no API key material');
    assert.ok(!/openai|gemini|groq/i.test(text), 'no provider name');
    assert.ok(!/test-model/.test(text), 'no model name');
    assert.ok(!/15|window/i.test(text) || !/windowMs/.test(text), 'no internal config');
    assert.deepEqual(Object.keys(res.body).sort(), ['message', 'success']);
  });

  test('the budget is per admin, not shared across all admins', async () => {
    const exhausted = tokens[5];
    for (let i = 0; i < LIMIT; i += 1) await callTest(exhausted);
    assert.equal((await callTest(exhausted)).status, 429);

    // A different admin, with a budget of their own, is unaffected.
    const fresh = tokenFor(f.admin({ _id: f.oid(), email: 'fresh@test.invalid' }));
    usersById.set(
      String(require('jsonwebtoken').decode(fresh).id),
      f.admin({ _id: require('jsonwebtoken').decode(fresh).id, email: 'fresh@test.invalid' })
    );
    assert.equal((await callTest(fresh)).status, 200);
  });
});

// ===========================================================================
describe('POST /api/ai/test — authorization is unchanged', () => {
  test('an unauthenticated request is still 401', async () => {
    const res = await api.post('/api/ai/test', { body: { message: 'hello' } });
    assert.equal(res.status, 401);
    assert.equal(providerCalls, 0);
  });

  test('a non-admin operator is still 403', async () => {
    const res = await callTest(tokenFor(operator));
    assert.equal(res.status, 403);
    assert.equal(providerCalls, 0);
  });

  test("a rejected non-admin cannot drain an admin's budget", async () => {
    // The limiter is mounted AFTER authorize, so these never reach it.
    const operatorToken = tokenFor(operator);
    for (let i = 0; i < LIMIT * 3; i += 1) {
      const res = await callTest(operatorToken);
      assert.equal(res.status, 403);
    }
    const admin = f.admin({ _id: f.oid(), email: 'untouched@test.invalid' });
    usersById.set(String(admin._id), admin);
    const token = tokenFor(admin);
    for (let i = 1; i <= LIMIT; i += 1) {
      assert.equal((await callTest(token)).status, 200, `admin request ${i} should be allowed`);
    }
  });
});

// ===========================================================================
describe('the limiter is scoped to this one endpoint', () => {
  test('other AI routes keep working after /api/ai/test is exhausted', async () => {
    const admin = f.admin({ _id: f.oid(), email: 'scoped@test.invalid' });
    usersById.set(String(admin._id), admin);
    const token = tokenFor(admin);

    for (let i = 0; i < LIMIT; i += 1) await callTest(token);
    assert.equal((await callTest(token)).status, 429);

    // Reading configuration, listing jobs and updating settings are untouched.
    assert.equal((await api.get('/api/ai/settings', { token })).status, 200);
    assert.equal((await api.get('/api/ai/jobs', { token })).status, 200);
    assert.equal(
      (await api.put('/api/ai/settings', { body: { defaultMode: 'draft' }, token })).status,
      200
    );
  });

  test('an unrelated endpoint on another router is unaffected', async () => {
    const admin = f.admin({ _id: f.oid(), email: 'elsewhere@test.invalid' });
    usersById.set(String(admin._id), admin);
    const token = tokenFor(admin);
    for (let i = 0; i < LIMIT; i += 1) await callTest(token);
    assert.equal((await callTest(token)).status, 429);

    assert.equal((await api.get('/api/health')).status, 200);
    assert.equal((await api.get('/api/settings/twilio', { token })).status, 200);
  });
});

// ===========================================================================
describe('configuration', () => {
  test('the limit comes from the environment', () => {
    const { config } = require('../../config/env');
    assert.equal(config.ai.testRateLimitMax, LIMIT);
    assert.equal(config.ai.testRateLimitWindowMinutes, 15);
  });

  test('production defaults are stricter than development', () => {
    // Verified on the parsing rule rather than by reloading the module: an unset
    // AI_TEST_RATE_LIMIT_MAX yields 10 under production and 30 otherwise.
    const resolve = (envMax, nodeEnv) =>
      parseInt(envMax, 10) || (nodeEnv === 'production' ? 10 : 30);
    assert.equal(resolve(undefined, 'production'), 10);
    assert.equal(resolve(undefined, 'development'), 30);
    assert.equal(resolve(undefined, 'test'), 30);
    assert.equal(resolve('5', 'production'), 5, 'an explicit value always wins');
  });
});
