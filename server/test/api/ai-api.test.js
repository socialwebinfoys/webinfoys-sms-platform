// Phase 8 — the AI API.
//
// The headline guarantee under test: a provider API key goes in and is never
// seen again. Every read path returns { configured, masked } and nothing else.
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

let conversations;
stubModule(
  'models/Conversation',
  fakeModel('Conversation', {
    findOne: (filter) => query(conversations.get(String(filter._id)) || null),
    findById: (id) => query(conversations.get(String(id)) || null),
    updateOne: async () => ({ modifiedCount: 1 }),
  })
);

let aiJobs;
stubModule(
  'models/AIReplyJob',
  Object.assign(
    fakeModel('AIReplyJob', {
      find: () => {
        const chain = {
          sort: () => chain,
          skip: () => chain,
          limit: () => chain,
          select: () => chain,
          // Phase 9: listAiJobs populates contact and conversation so the draft
          // queue can name the recipient without a request per row.
          populate: () => chain,
          then: (res, rej) => Promise.resolve(aiJobs).then(res, rej),
        };
        return chain;
      },
      countDocuments: async () => aiJobs.length,
    }),
    { STATUSES: ['pending', 'processing', 'drafted', 'sent', 'skipped', 'escalated', 'failed'] }
  )
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
  'models/SystemLog',
]) {
  stubModule(m, fakeModel(m));
}

const secretBox = require('../../utils/secretBox');
const providers = require('../../services/ai/providers');
const { startApp, tokenFor } = require('../_support/http');

const REAL_LOOKING_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789wxyz';

let api;
let adminToken;
let operatorToken;

before(async () => {
  api = await startApp();
  adminToken = tokenFor(administrator);
  operatorToken = tokenFor(operator);
});
after(async () => {
  await api.close();
});

function makeSettings(aiOverrides = {}) {
  return fakeDoc(
    f.settings({
      ai: {
        enabled: false,
        defaultMode: 'draft',
        provider: 'openai',
        model: '',
        apiKeyEncrypted: '',
        persona: '',
        businessRules: '',
        faq: '',
        escalationKeywords: ['human'],
        confidenceThreshold: 0.7,
        maxRepliesPerConversation: 3,
        contextMessageLimit: 10,
        maxReplyCharacters: 320,
        ...aiOverrides,
      },
    })
  );
}

beforeEach(() => {
  logged.length = 0;
  settingsDoc = makeSettings();
  conversations = new Map();
  aiJobs = [];
  providers.__reset();
});

// ---------------------------------------------------------------------------
describe('GET /api/ai/settings', () => {
  test('requires authentication', async () => {
    assert.equal((await api.get('/api/ai/settings')).status, 401);
  });

  test('an ordinary operator may read the configuration', async () => {
    const res = await api.get('/api/ai/settings', { token: operatorToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.enabled, false);
  });

  test('AI is OFF by default', async () => {
    const res = await api.get('/api/ai/settings', { token: adminToken });
    assert.equal(res.body.settings.enabled, false, 'AI must never default to on');
    assert.equal(res.body.settings.defaultMode, 'draft', 'and the safe mode must be the default');
  });

  test('the available providers are advertised', async () => {
    const res = await api.get('/api/ai/settings', { token: adminToken });
    assert.deepEqual([...res.body.settings.availableProviders].sort(), ['gemini', 'groq', 'openai']);
  });

  test('with no key stored, apiKey reports not configured', async () => {
    const res = await api.get('/api/ai/settings', { token: adminToken });
    assert.deepEqual(res.body.settings.apiKey, { configured: false, masked: '' });
  });

  test('with a key stored, ONLY a masked form is returned', async () => {
    settingsDoc = makeSettings({ apiKeyEncrypted: secretBox.encrypt(REAL_LOOKING_KEY) });
    const res = await api.get('/api/ai/settings', { token: adminToken });

    assert.equal(res.body.settings.apiKey.configured, true);
    assert.equal(res.body.settings.apiKey.masked, '••••••••wxyz');
    assert.equal(res.text.includes(REAL_LOOKING_KEY), false, 'the plaintext key must never appear');
    assert.equal(res.text.includes('sk-proj'), false);
    assert.equal(res.text.includes(settingsDoc.ai.apiKeyEncrypted), false, 'nor the ciphertext');
    assert.equal(res.text.includes('apiKeyEncrypted'), false);
  });

  test('the encryption key itself never appears in a response', async () => {
    settingsDoc = makeSettings({ apiKeyEncrypted: secretBox.encrypt(REAL_LOOKING_KEY) });
    const res = await api.get('/api/ai/settings', { token: adminToken });
    assert.equal(res.text.includes(process.env.AI_ENCRYPTION_KEY), false);
  });
});

describe('PUT /api/ai/settings', () => {
  test('is admin-only', async () => {
    assert.equal((await api.put('/api/ai/settings', { body: { enabled: true } })).status, 401);
    const res = await api.put('/api/ai/settings', {
      token: operatorToken,
      body: { enabled: true },
    });
    assert.equal(res.status, 403);
  });

  test('an admin can enable AI explicitly', async () => {
    const res = await api.put('/api/ai/settings', { token: adminToken, body: { enabled: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.enabled, true);
    assert.equal(settingsDoc.ai.enabled, true);
  });

  test('configuring a provider does NOT implicitly enable AI', async () => {
    const res = await api.put('/api/ai/settings', {
      token: adminToken,
      body: { provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: REAL_LOOKING_KEY },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.enabled, false, 'setting up a provider must not turn AI on');
  });

  test('a stored key is encrypted, never written in plaintext', async () => {
    await api.put('/api/ai/settings', { token: adminToken, body: { apiKey: REAL_LOOKING_KEY } });
    const stored = settingsDoc.ai.apiKeyEncrypted;
    assert.ok(stored.startsWith('v1.'));
    assert.equal(stored.includes(REAL_LOOKING_KEY), false);
    assert.equal(secretBox.decrypt(stored), REAL_LOOKING_KEY, 'and it decrypts back internally');
  });

  test('the response after storing a key is still masked only', async () => {
    const res = await api.put('/api/ai/settings', {
      token: adminToken,
      body: { apiKey: REAL_LOOKING_KEY },
    });
    assert.equal(res.body.settings.apiKey.configured, true);
    assert.equal(res.text.includes(REAL_LOOKING_KEY), false);
  });

  test('the api key never reaches the audit log', async () => {
    await api.put('/api/ai/settings', { token: adminToken, body: { apiKey: REAL_LOOKING_KEY } });
    const serialised = JSON.stringify(logged);
    assert.equal(serialised.includes(REAL_LOOKING_KEY), false);
    assert.equal(serialised.includes(settingsDoc.ai.apiKeyEncrypted), false);
    const event = logged.find((e) => e.eventType === 'ai.settings.updated');
    assert.ok(event, 'the change itself is still recorded');
    assert.ok(event.meta.changes.includes('apiKey set'), 'as a description, not a value');
  });

  test('sending an empty apiKey clears it', async () => {
    settingsDoc = makeSettings({ apiKeyEncrypted: secretBox.encrypt(REAL_LOOKING_KEY) });
    const res = await api.put('/api/ai/settings', { token: adminToken, body: { apiKey: '' } });
    assert.equal(res.body.settings.apiKey.configured, false);
    assert.equal(settingsDoc.ai.apiKeyEncrypted, '');
  });

  test('omitting apiKey leaves the stored key untouched', async () => {
    settingsDoc = makeSettings({ apiKeyEncrypted: secretBox.encrypt(REAL_LOOKING_KEY) });
    const before = settingsDoc.ai.apiKeyEncrypted;
    await api.put('/api/ai/settings', { token: adminToken, body: { persona: 'new persona' } });
    assert.equal(settingsDoc.ai.apiKeyEncrypted, before);
  });

  test('storing a key is refused when the server has no encryption key', async () => {
    const original = process.env.AI_ENCRYPTION_KEY;
    try {
      process.env.AI_ENCRYPTION_KEY = '';
      const res = await api.put('/api/ai/settings', {
        token: adminToken,
        body: { apiKey: REAL_LOOKING_KEY },
      });
      assert.equal(res.status, 503);
      assert.match(res.body.message, /AI_ENCRYPTION_KEY/);
      assert.equal(settingsDoc.ai.apiKeyEncrypted, '', 'nothing may be stored unencrypted');
    } finally {
      process.env.AI_ENCRYPTION_KEY = original;
    }
  });

  const invalid = [
    [{ provider: 'claude' }, /provider must be one of/],
    [{ provider: '' }, /provider must be one of/],
    [{ defaultMode: 'turbo' }, /defaultMode/],
    [{ confidenceThreshold: 1.5 }, /confidenceThreshold/],
    [{ confidenceThreshold: -0.1 }, /confidenceThreshold/],
    [{ maxRepliesPerConversation: -1 }, /maxRepliesPerConversation/],
    [{ maxRepliesPerConversation: 2.5 }, /whole number/],
    [{ contextMessageLimit: 0 }, /contextMessageLimit/],
    [{ contextMessageLimit: 500 }, /contextMessageLimit/],
    [{ maxReplyCharacters: 5 }, /maxReplyCharacters/],
    [{ maxReplyCharacters: 99999 }, /maxReplyCharacters/],
    [{ escalationKeywords: 'human' }, /must be an array/],
  ];
  for (const [body, pattern] of invalid) {
    test(`${JSON.stringify(body)} is refused`, async () => {
      const res = await api.put('/api/ai/settings', { token: adminToken, body });
      assert.equal(res.status, 400, res.text);
      assert.match(res.body.message, pattern);
    });
  }

  test('escalation keywords are normalised and de-duplicated', async () => {
    const res = await api.put('/api/ai/settings', {
      token: adminToken,
      body: { escalationKeywords: [' Human ', 'HUMAN', 'agent', ''] },
    });
    assert.deepEqual(res.body.settings.escalationKeywords, ['human', 'agent']);
  });

  test('an empty body is refused rather than silently doing nothing', async () => {
    const res = await api.put('/api/ai/settings', { token: adminToken, body: {} });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Nothing to update/);
  });

  test('a partial update does not blank the other fields', async () => {
    settingsDoc = makeSettings({ persona: 'keep me', faq: 'keep me too' });
    await api.put('/api/ai/settings', { token: adminToken, body: { enabled: true } });
    assert.equal(settingsDoc.ai.persona, 'keep me');
    assert.equal(settingsDoc.ai.faq, 'keep me too');
  });
});

describe('POST /api/ai/test — generate without sending', () => {
  function installFake(behaviour) {
    providers.__setAdapter('openai', {
      name: 'openai',
      defaultModel: 'fake-model',
      generate: behaviour,
    });
  }

  test('is admin-only', async () => {
    assert.equal((await api.post('/api/ai/test', { body: { message: 'hi' } })).status, 401);
    const res = await api.post('/api/ai/test', { token: operatorToken, body: { message: 'hi' } });
    assert.equal(res.status, 403);
  });

  test('a message is required', async () => {
    const res = await api.post('/api/ai/test', { token: adminToken, body: {} });
    assert.equal(res.status, 400);
  });

  test('it returns the generated reply and states that nothing was sent', async () => {
    settingsDoc = makeSettings({ apiKeyEncrypted: secretBox.encrypt(REAL_LOOKING_KEY) });
    installFake(async () => ({
      provider: 'openai',
      model: 'fake-model',
      text: '{"reply":"We are open 9-5.","confidence":0.9,"escalate":false}',
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    }));

    const res = await api.post('/api/ai/test', {
      token: adminToken,
      body: { message: 'what are your hours?' },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.sent, false, 'the test endpoint must never send');
    assert.equal(res.body.reply, 'We are open 9-5.');
    assert.equal(res.body.confidence, 0.9);
    assert.equal(res.body.provider, 'openai');
  });

  test('it works while AI is globally DISABLED (that is the point of a test)', async () => {
    settingsDoc = makeSettings({ enabled: false, apiKeyEncrypted: secretBox.encrypt(REAL_LOOKING_KEY) });
    installFake(async () => ({ provider: 'openai', model: 'm', text: '{"reply":"hi","confidence":1}' }));
    const res = await api.post('/api/ai/test', { token: adminToken, body: { message: 'hi' } });
    assert.equal(res.status, 200);
  });

  test('unusable model output is a 422, not a reply', async () => {
    settingsDoc = makeSettings({ apiKeyEncrypted: secretBox.encrypt(REAL_LOOKING_KEY) });
    installFake(async () => ({ provider: 'openai', model: 'm', text: 'not json' }));
    const res = await api.post('/api/ai/test', { token: adminToken, body: { message: 'hi' } });
    assert.equal(res.status, 422);
    assert.equal(res.body.reason, 'provider_malformed_json');
  });

  test('a provider failure is a 502 and never leaks the key', async () => {
    settingsDoc = makeSettings({ apiKeyEncrypted: secretBox.encrypt(REAL_LOOKING_KEY) });
    const { ProviderError } = require('../../services/ai/providers/errors');
    installFake(async () => {
      throw new ProviderError('upstream exploded', { kind: 'temporary', provider: 'openai' });
    });
    const res = await api.post('/api/ai/test', { token: adminToken, body: { message: 'hi' } });
    assert.equal(res.status, 502);
    assert.equal(res.text.includes(REAL_LOOKING_KEY), false);
  });

  test('with no key configured it fails as an auth problem, without sending', async () => {
    settingsDoc = makeSettings({ apiKeyEncrypted: '' });
    const res = await api.post('/api/ai/test', { token: adminToken, body: { message: 'hi' } });
    assert.equal(res.status, 502);
    assert.equal(res.body.kind, 'auth');
  });
});

describe('human takeover', () => {
  function seedConversation(ai = {}) {
    const convo = fakeDoc(
      f.conversation({
        _id: f.oid(),
        ai: { takeover: false, replyCount: 0, escalated: false, ...ai },
      })
    );
    conversations.set(String(convo._id), convo);
    return convo;
  }

  test('requires authentication', async () => {
    const convo = seedConversation();
    assert.equal((await api.post(`/api/ai/conversations/${convo._id}/takeover`)).status, 401);
  });

  test('an ordinary operator CAN take over — it is an inbox action', async () => {
    const convo = seedConversation();
    const res = await api.post(`/api/ai/conversations/${convo._id}/takeover`, {
      token: operatorToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.takeover, true);
    assert.equal(convo.ai.takeover, true);
    assert.ok(convo.ai.takeoverAt instanceof Date);
  });

  test('releasing takeover restores AI eligibility and clears an escalation', async () => {
    const convo = seedConversation({ takeover: true, escalated: true, escalationReason: 'keyword' });
    const res = await api.delete(`/api/ai/conversations/${convo._id}/takeover`, {
      token: operatorToken,
    });
    assert.equal(res.status, 200);
    assert.equal(convo.ai.takeover, false);
    assert.equal(convo.ai.escalated, false);
    assert.equal(convo.ai.escalationReason, '');
  });

  test('releasing does NOT reset the reply counter', async () => {
    const convo = seedConversation({ takeover: true, replyCount: 3 });
    await api.delete(`/api/ai/conversations/${convo._id}/takeover`, { token: operatorToken });
    assert.equal(convo.ai.replyCount, 3, 'resetting it would make the limit bypassable');
  });

  test('both transitions are logged', async () => {
    const convo = seedConversation();
    await api.post(`/api/ai/conversations/${convo._id}/takeover`, { token: operatorToken });
    await api.delete(`/api/ai/conversations/${convo._id}/takeover`, { token: operatorToken });
    assert.ok(logged.some((e) => e.eventType === 'ai.takeover.enabled'));
    assert.ok(logged.some((e) => e.eventType === 'ai.takeover.released'));
  });

  test('an unknown conversation is 404', async () => {
    const res = await api.post(`/api/ai/conversations/${f.oid(9999)}/takeover`, {
      token: operatorToken,
    });
    assert.equal(res.status, 404);
  });
});

describe('GET /api/ai/conversations/:id', () => {
  test('returns the AI state and recent jobs', async () => {
    const convo = fakeDoc(
      f.conversation({
        _id: f.oid(),
        ai: { takeover: true, replyCount: 2, escalated: true, escalationReason: 'reply_limit' },
      })
    );
    conversations.set(String(convo._id), convo);
    aiJobs = [fakeDoc({ _id: f.oid(), status: 'drafted', mode: 'draft', draftReply: 'hello' })];

    const res = await api.get(`/api/ai/conversations/${convo._id}`, { token: operatorToken });

    assert.equal(res.status, 200);
    assert.equal(res.body.state.takeover, true);
    assert.equal(res.body.state.replyCount, 2);
    assert.equal(res.body.state.escalated, true);
    assert.equal(res.body.state.escalationReason, 'reply_limit');
    assert.equal(res.body.jobs.length, 1);
  });

  test('requires authentication', async () => {
    assert.equal((await api.get(`/api/ai/conversations/${f.oid(1)}`)).status, 401);
  });
});

describe('GET /api/ai/jobs', () => {
  test('requires authentication', async () => {
    assert.equal((await api.get('/api/ai/jobs')).status, 401);
  });

  test('lists jobs with pagination', async () => {
    aiJobs = [fakeDoc({ _id: f.oid(), status: 'sent' })];
    const res = await api.get('/api/ai/jobs', { token: operatorToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
    assert.ok(res.body.pagination);
  });

  test('an unknown status filter is refused', async () => {
    const res = await api.get('/api/ai/jobs?status=bogus', { token: operatorToken });
    assert.equal(res.status, 400);
  });

  test('a malformed conversation id is refused', async () => {
    const res = await api.get('/api/ai/jobs?conversation=not-an-id', { token: operatorToken });
    assert.equal(res.status, 400);
  });

  test('an operator-injection attempt is neutralised', async () => {
    const res = await api.get('/api/ai/jobs?status[$ne]=sent', { token: operatorToken });
    assert.equal(res.status, 200, 'the object collapses to empty and the filter is simply not applied');
  });
});

describe('no AI endpoint ever exposes a secret', () => {
  test('across every GET, no key material appears', async () => {
    settingsDoc = makeSettings({ apiKeyEncrypted: secretBox.encrypt(REAL_LOOKING_KEY) });
    const convo = fakeDoc(f.conversation({ _id: f.oid(), ai: {} }));
    conversations.set(String(convo._id), convo);

    const responses = [
      await api.get('/api/ai/settings', { token: adminToken }),
      await api.get('/api/ai/jobs', { token: adminToken }),
      await api.get(`/api/ai/conversations/${convo._id}`, { token: adminToken }),
    ];

    for (const res of responses) {
      for (const secret of [
        REAL_LOOKING_KEY,
        process.env.AI_ENCRYPTION_KEY,
        process.env.JWT_SECRET,
        settingsDoc.ai.apiKeyEncrypted,
      ]) {
        assert.equal(res.text.includes(secret), false, 'a secret leaked into a response');
      }
    }
  });
});
