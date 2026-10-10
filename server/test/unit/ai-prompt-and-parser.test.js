// Phase 8 — prompt construction and the strict output parser.
'use strict';

require('../_support/env');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const promptBuilder = require('../../services/ai/promptBuilder');
const { parseProviderResponse, normalizeConfidence, stripCodeFence } =
  require('../../services/ai/responseParser');

const AI_SETTINGS = {
  persona: 'You are Sam from Webinfoys, friendly and brief.',
  businessRules: 'Opening hours are 9-5 Monday to Friday. Never quote a price.',
  faq: 'Delivery takes 3-5 working days. Returns are accepted within 30 days.',
  contextMessageLimit: 3,
  maxReplyCharacters: 320,
};

const HISTORY = [
  { direction: 'inbound', body: 'newest customer line' },
  { direction: 'outbound', body: 'business line' },
  { direction: 'inbound', body: 'older customer line' },
  { direction: 'outbound', body: 'oldest, beyond the limit' },
];

describe('prompt builder is deterministic', () => {
  test('the same inputs produce byte-identical output', () => {
    const a = promptBuilder.buildPrompt({ inboundBody: 'hi', messages: HISTORY, aiSettings: AI_SETTINGS });
    const b = promptBuilder.buildPrompt({ inboundBody: 'hi', messages: HISTORY, aiSettings: AI_SETTINGS });
    assert.deepEqual(a, b);
  });

  test('it returns a system half and a user half', () => {
    const { system, user } = promptBuilder.buildPrompt({
      inboundBody: 'hi',
      messages: [],
      aiSettings: AI_SETTINGS,
    });
    assert.equal(typeof system, 'string');
    assert.equal(typeof user, 'string');
    assert.ok(system.length > 0 && user.length > 0);
  });
});

describe('configured context is included', () => {
  const { system } = promptBuilder.buildPrompt({ inboundBody: 'hi', aiSettings: AI_SETTINGS });

  test('the persona is included', () => {
    assert.ok(system.includes('Sam from Webinfoys'));
  });
  test('the business rules are included', () => {
    assert.ok(system.includes('Never quote a price'));
  });
  test('the FAQ is included', () => {
    assert.ok(system.includes('3-5 working days'));
  });
  test('the reply-length limit is stated to the model', () => {
    assert.ok(system.includes('320'));
  });
  test('the JSON response contract is stated', () => {
    assert.ok(system.includes('"reply"'));
    assert.ok(system.includes('"confidence"'));
    assert.ok(system.includes('"escalate"'));
  });
  test('safety instructions are present', () => {
    assert.match(system, /never invent/i);
    assert.match(system, /payment details, passwords/i);
  });

  test('empty configuration simply omits those sections', () => {
    const bare = promptBuilder.buildSystemPrompt({});
    assert.equal(bare.includes('Who you are:'), false);
    assert.equal(bare.includes('Business rules:'), false);
    assert.equal(bare.includes('Reference information:'), false);
    assert.ok(bare.includes('"reply"'), 'the response contract is always present');
  });
});

describe('conversation context is bounded and ordered', () => {
  test('only contextMessageLimit messages are included', () => {
    const { user } = promptBuilder.buildUserPrompt
      ? { user: promptBuilder.buildUserPrompt({ inboundBody: 'hi', messages: HISTORY, aiSettings: AI_SETTINGS }) }
      : {};
    assert.ok(user.includes('newest customer line'));
    assert.ok(user.includes('older customer line'));
    assert.equal(
      user.includes('oldest, beyond the limit'),
      false,
      'the 4th message is outside a limit of 3'
    );
  });

  test('messages are rendered oldest-first for the model', () => {
    const user = promptBuilder.buildUserPrompt({
      inboundBody: 'hi',
      messages: HISTORY,
      aiSettings: AI_SETTINGS,
    });
    assert.ok(user.indexOf('older customer line') < user.indexOf('newest customer line'));
  });

  test('speakers are labelled', () => {
    const user = promptBuilder.buildUserPrompt({
      inboundBody: 'hi',
      messages: HISTORY,
      aiSettings: AI_SETTINGS,
    });
    assert.ok(user.includes('Customer: newest customer line'));
    assert.ok(user.includes('Business: business line'));
  });

  test('the new inbound message is always included', () => {
    const user = promptBuilder.buildUserPrompt({
      inboundBody: 'what are your hours?',
      messages: HISTORY,
      aiSettings: AI_SETTINGS,
    });
    assert.ok(user.includes('what are your hours?'));
  });

  test('no history still produces a valid prompt', () => {
    const user = promptBuilder.buildUserPrompt({ inboundBody: 'hello', messages: [], aiSettings: {} });
    assert.ok(user.includes('hello'));
    assert.equal(user.includes('Conversation so far'), false);
  });

  test('empty and whitespace-only messages are dropped', () => {
    const user = promptBuilder.buildUserPrompt({
      inboundBody: 'hi',
      messages: [{ direction: 'inbound', body: '   ' }, { direction: 'inbound', body: 'real' }],
      aiSettings: {},
    });
    assert.equal((user.match(/Customer:/g) || []).length, 1);
  });

  test('an over-long section is truncated, not sent whole', () => {
    const system = promptBuilder.buildSystemPrompt({ persona: 'x'.repeat(10000) });
    assert.ok(system.length < 10000);
    assert.ok(system.includes('…'));
  });

  test('an over-long inbound message is truncated', () => {
    const user = promptBuilder.buildUserPrompt({ inboundBody: 'y'.repeat(5000), aiSettings: {} });
    assert.ok(user.length < 5000);
  });
});

describe('secrets can never reach a prompt', () => {
  // The builder is a pure function of its arguments, so the way to prove this is
  // to show that real configuration values do not appear in its output.
  const { config } = require('../../config/env');

  test('no environment secret appears in either half', () => {
    const { system, user } = promptBuilder.buildPrompt({
      inboundBody: 'hi',
      messages: HISTORY,
      aiSettings: AI_SETTINGS,
    });
    const combined = `${system}\n${user}`;
    const secrets = [
      config.jwt.secret,
      config.mongoUri,
      process.env.AI_ENCRYPTION_KEY,
      process.env.ADMIN_PASSWORD,
    ].filter(Boolean);
    for (const secret of secrets) {
      assert.equal(combined.includes(secret), false, 'a secret reached the prompt');
    }
    for (const name of ['mongodb://', 'JWT_SECRET', 'authToken', 'apiKey', 'apiKeyEncrypted']) {
      assert.equal(combined.includes(name), false, `${name} reached the prompt`);
    }
  });

  test('an encrypted key sitting in the settings object is not emitted', () => {
    const { system, user } = promptBuilder.buildPrompt({
      inboundBody: 'hi',
      aiSettings: { ...AI_SETTINGS, apiKeyEncrypted: 'v1.AAA.BBB.CCC', provider: 'openai' },
    });
    assert.equal(`${system}${user}`.includes('v1.AAA.BBB.CCC'), false);
  });

  test('whole documents are never serialised into the prompt', () => {
    const { user } = promptBuilder.buildPrompt({
      inboundBody: 'hi',
      messages: [
        {
          direction: 'inbound',
          body: 'hello',
          _id: 'secret-id',
          contact: 'contact-id',
          twilioSid: 'SMxxxx',
        },
      ],
      aiSettings: AI_SETTINGS,
    });
    for (const leak of ['secret-id', 'contact-id', 'SMxxxx']) {
      assert.equal(user.includes(leak), false, `${leak} reached the prompt`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('parser accepts well-formed output', () => {
  const raw = (text) => ({ text, provider: 'openai', model: 'gpt-4o-mini', usage: {} });

  test('a clean JSON object', () => {
    const result = parseProviderResponse(raw('{"reply":"We are open 9-5.","confidence":0.9,"escalate":false}'));
    assert.equal(result.ok, true);
    assert.equal(result.reply, 'We are open 9-5.');
    assert.equal(result.confidence, 0.9);
    assert.equal(result.shouldEscalate, false);
  });

  test('a ```json fenced object', () => {
    const result = parseProviderResponse(raw('```json\n{"reply":"hi","confidence":0.8}\n```'));
    assert.equal(result.ok, true);
    assert.equal(result.reply, 'hi');
  });

  test('an object preceded by prose', () => {
    const result = parseProviderResponse(raw('Sure! {"reply":"hi","confidence":0.8}'));
    assert.equal(result.ok, true);
    assert.equal(result.reply, 'hi');
  });

  test('multi-line replies are collapsed to one SMS body', () => {
    const result = parseProviderResponse(raw('{"reply":"line one\\nline two","confidence":0.9}'));
    assert.equal(result.reply, 'line one line two');
  });

  test('usage is normalised when present', () => {
    const result = parseProviderResponse({
      text: '{"reply":"hi","confidence":1}',
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
    assert.deepEqual(result.usage, { promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  test('absent usage is undefined rather than a bag of nulls', () => {
    assert.equal(parseProviderResponse(raw('{"reply":"hi","confidence":1}')).usage, undefined);
  });
});

describe('parser refuses anything it cannot trust', () => {
  const cases = [
    [undefined, 'provider_no_text'],
    [{}, 'provider_no_text'],
    // '' is still a string, so it reaches the emptiness check rather than the
    // missing-field check. Both refuse; the reasons just distinguish the cause.
    [{ text: '' }, 'provider_empty_output'],
    [{ text: '   ' }, 'provider_empty_output'],
    [{ text: 'just prose, no object' }, 'provider_malformed_json'],
    [{ text: '{broken json' }, 'provider_malformed_json'],
    [{ text: '[1,2,3]' }, 'provider_malformed_json'],
    [{ text: '"a string"' }, 'provider_malformed_json'],
    [{ text: '{"confidence":0.9}' }, 'provider_missing_reply'],
    [{ text: '{"reply":123}' }, 'provider_missing_reply'],
    [{ text: '{"reply":null}' }, 'provider_missing_reply'],
    [{ text: '{"reply":"   "}' }, 'provider_empty_reply'],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      const result = parseProviderResponse(input);
      assert.equal(result.ok, false);
      assert.equal(result.reason, expected);
    });
  }

  test('an over-long reply is REFUSED, never truncated mid-sentence', () => {
    const result = parseProviderResponse(
      { text: JSON.stringify({ reply: 'x'.repeat(500), confidence: 1 }) },
      { maxReplyCharacters: 320 }
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'provider_reply_too_long');
  });

  test('an absolute ceiling applies however high the configured limit', () => {
    const result = parseProviderResponse(
      { text: JSON.stringify({ reply: 'x'.repeat(5000), confidence: 1 }) },
      { maxReplyCharacters: 99999 }
    );
    assert.equal(result.ok, false);
  });

  test('an empty reply IS allowed when the model is explicitly escalating', () => {
    const result = parseProviderResponse({
      text: '{"reply":"","escalate":true,"reason":"needs a human"}',
    });
    assert.equal(result.ok, true);
    assert.equal(result.shouldEscalate, true);
    assert.equal(result.reply, '');
    assert.equal(result.reason, 'needs a human');
  });

  test('parsing never throws, whatever it is handed', () => {
    for (const input of [null, undefined, 0, 'x', [], { text: null }, { text: {} }]) {
      assert.doesNotThrow(() => parseProviderResponse(input));
    }
  });
});

describe('field normalisation', () => {
  test('confidence accepts number, numeric string and percentage', () => {
    assert.equal(normalizeConfidence(0.85), 0.85);
    assert.equal(normalizeConfidence('0.85'), 0.85);
    assert.equal(normalizeConfidence(85), 0.85);
    assert.equal(normalizeConfidence('85'), 0.85);
  });

  test('confidence is clamped to [0,1]', () => {
    assert.equal(normalizeConfidence(-5), 0);
    assert.equal(normalizeConfidence(500), 1);
  });

  test('an uninterpretable confidence is undefined, not zero', () => {
    for (const value of [undefined, null, '', 'high', NaN, {}]) {
      assert.equal(normalizeConfidence(value), undefined);
    }
  });

  test('escalate accepts booleans and the usual string spellings', () => {
    const esc = (v) => parseProviderResponse({ text: JSON.stringify({ reply: 'hi', escalate: v }) }).shouldEscalate;
    assert.equal(esc(true), true);
    assert.equal(esc('true'), true);
    assert.equal(esc('yes'), true);
    assert.equal(esc(false), false);
    assert.equal(esc('no'), false);
    assert.equal(esc(undefined), false);
    assert.equal(esc('maybe'), false, 'anything unrecognised must NOT read as escalation');
  });

  test('shouldEscalate is also accepted as an alias', () => {
    const result = parseProviderResponse({ text: '{"reply":"hi","shouldEscalate":true}' });
    assert.equal(result.shouldEscalate, true);
  });

  test('stripCodeFence handles both fenced and plain input', () => {
    assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}');
    assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
  });
});
