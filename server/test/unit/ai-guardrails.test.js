// Phase 8 — guardrails.
//
// Exercises the REAL sendPolicy and the REAL automation-worker window helpers;
// only Settings.getSingleton, Contact.findOne and the Lookup call are
// substituted. That is deliberate: the point of these tests is that AI reuses
// the platform's single compliance path, so stubbing that path would prove
// nothing.
'use strict';

require('../_support/env');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const Settings = require('../../models/Settings');
const Contact = require('../../models/Contact');
const lookupService = require('../../services/lookupService');
const guardrails = require('../../services/ai/guardrails');
const f = require('../_support/factories');
const { fakeDoc } = require('../_support/stubs');

const { REASONS } = guardrails;
const DAY = 24 * 60 * 60 * 1000;

let lookupResult;
// checkMobileOnly reads the singleton itself (it needs allowedLineTypes and
// lookupMaxAgeDays), so the stub has to return whatever the test is using.
let currentSettings;
Contact.findOne = async () => null;
Settings.getSingleton = async () => currentSettings;
lookupService.lookupNumber = async (phone) => lookupResult(phone);

function aiSettings(overrides = {}) {
  return {
    enabled: true,
    defaultMode: 'draft',
    provider: 'openai',
    model: '',
    persona: '',
    businessRules: '',
    faq: '',
    escalationKeywords: ['human', 'agent', 'lawyer'],
    confidenceThreshold: 0.7,
    maxRepliesPerConversation: 3,
    contextMessageLimit: 10,
    maxReplyCharacters: 320,
    ...overrides,
  };
}

// Also records the result as the singleton, so the policy helpers that read
// Settings themselves see exactly the configuration under test.
function settingsWith(aiOverrides = {}, base = {}) {
  currentSettings = f.settings({
    // Window off unless a test is about it.
    sendingWindow: { enabled: false },
    sendDays: [0, 1, 2, 3, 4, 5, 6],
    ...base,
    ai: aiSettings(aiOverrides),
  });
  return currentSettings;
}

// A contact with a fresh MOBILE classification, so the line-type filter has a
// definite answer without spending a Lookup call.
function mobileContact(overrides = {}) {
  return fakeDoc(
    f.contact({
      _id: f.oid(),
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

function conversationWith(ai = {}) {
  return fakeDoc(f.conversation({ _id: f.oid(), ai: { takeover: false, replyCount: 0, escalated: false, ...ai } }));
}

beforeEach(() => {
  lookupResult = async () => ({ valid: true, type: 'mobile', phone: '+14155552671', lookedUpAt: new Date() });
  Contact.findOne = async () => null;
});

// ---------------------------------------------------------------------------
describe('gate 1 — may we generate at all?', () => {
  const generate = (over = {}, convOver = {}, body = 'what are your hours?', contactOver = {}) =>
    guardrails.checkCanGenerate({
      settings: settingsWith(over),
      contact: mobileContact(contactOver),
      conversation: conversationWith(convOver),
      inboundBody: body,
    });

  test('a normal message is allowed', async () => {
    assert.equal((await generate()).allowed, true);
  });

  test('AI disabled blocks everything', async () => {
    const result = await generate({ enabled: false });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.AI_DISABLED);
  });

  test('smsEnabled=false blocks generation', async () => {
    const result = await guardrails.checkCanGenerate({
      settings: settingsWith({}, { smsEnabled: false }),
      contact: mobileContact(),
      conversation: conversationWith(),
      inboundBody: 'hi',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.SMS_DISABLED);
  });

  test('an OPTED-OUT contact is blocked — AI cannot override consent', async () => {
    const result = await generate({}, {}, 'hi', { optedOut: true });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'opted_out');
    assert.equal(result.escalate, false, 'an opt-out is not an escalation, it is a stop');
  });

  test('an INACTIVE contact is blocked', async () => {
    const result = await generate({}, {}, 'hi', { isActive: false });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'inactive');
  });

  test('a DELIVERY-BLOCKED contact is blocked', async () => {
    const result = await generate({}, {}, 'hi', { deliveryBlocked: true });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'delivery_blocked');
  });

  test('a missing contact is blocked', async () => {
    const result = await guardrails.checkCanGenerate({
      settings: settingsWith(),
      contact: null,
      conversation: conversationWith(),
      inboundBody: 'hi',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.NO_CONTACT);
  });

  test('HUMAN TAKEOVER blocks generation', async () => {
    const result = await generate({}, { takeover: true });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.TAKEOVER);
  });

  test('an already-escalated thread blocks generation', async () => {
    const result = await generate({}, { escalated: true });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.ALREADY_ESCALATED);
  });

  test('the REPLY LIMIT blocks and escalates', async () => {
    const result = await generate({ maxRepliesPerConversation: 3 }, { replyCount: 3 });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.REPLY_LIMIT);
    assert.equal(result.escalate, true, 'a customer still talking after the limit needs a human');
  });

  test('below the reply limit is allowed', async () => {
    assert.equal((await generate({ maxRepliesPerConversation: 3 }, { replyCount: 2 })).allowed, true);
  });

  test('a limit of 0 blocks immediately', async () => {
    const result = await generate({ maxRepliesPerConversation: 0 }, { replyCount: 0 });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.REPLY_LIMIT);
  });

  test('an ESCALATION KEYWORD blocks and escalates', async () => {
    const result = await generate({}, {}, 'can I speak to a human please');
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.ESCALATION_KEYWORD);
    assert.equal(result.escalate, true);
    assert.equal(result.detail, 'human');
  });

  test('keyword matching is case-insensitive', async () => {
    assert.equal((await generate({}, {}, 'GET ME A HUMAN')).allowed, false);
  });

  test('keyword matching is WHOLE WORD — "humane" does not trip "human"', async () => {
    assert.equal(
      (await generate({}, {}, 'that is a humane policy')).allowed,
      true,
      'substring matching would make this a false escalation'
    );
  });

  test('a multi-word keyword is matched as a phrase', async () => {
    const result = await generate({ escalationKeywords: ['speak to someone'] }, {}, 'I want to speak to someone now');
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.ESCALATION_KEYWORD);
  });

  test('an empty keyword list escalates nothing', async () => {
    assert.equal((await generate({ escalationKeywords: [] }, {}, 'human agent lawyer')).allowed, true);
  });

  test('consent is checked BEFORE the reply limit and keywords', async () => {
    // All three conditions true at once: opt-out must win, because it is the
    // one that must never be overridden.
    const result = await guardrails.checkCanGenerate({
      settings: settingsWith({ maxRepliesPerConversation: 0 }),
      contact: mobileContact({ optedOut: true }),
      conversation: conversationWith({ replyCount: 99 }),
      inboundBody: 'get me a human',
    });
    assert.equal(result.reason, 'opted_out');
  });
});

// ---------------------------------------------------------------------------
describe('gate 2 — may this reply be sent?', () => {
  const good = { ok: true, reply: 'We are open 9-5.', confidence: 0.9, shouldEscalate: false };

  const send = (over = {}, parsed = good, mode = 'auto', contactOver = {}, now = new Date()) =>
    guardrails.checkCanSendReply({
      settings: settingsWith(over),
      contact: mobileContact(contactOver),
      conversation: conversationWith(),
      parsed,
      mode,
      now,
    });

  test('a confident, non-escalating reply is allowed in auto mode', async () => {
    assert.equal((await send()).allowed, true);
  });

  test('DRAFT mode never passes this gate', async () => {
    const result = await send({}, good, 'draft');
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.NOT_AUTO_MODE);
  });

  test('an unparsed or empty reply is refused', async () => {
    assert.equal((await send({}, { ok: false })).reason, REASONS.EMPTY_REPLY);
    assert.equal((await send({}, { ok: true, reply: '  ' })).reason, REASONS.EMPTY_REPLY);
  });

  test('the model asking to escalate is honoured', async () => {
    const result = await send({}, { ...good, shouldEscalate: true, reason: 'unsure' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.MODEL_ESCALATED);
    assert.equal(result.escalate, true);
  });

  test('confidence BELOW the threshold blocks and escalates', async () => {
    const result = await send({ confidenceThreshold: 0.8 }, { ...good, confidence: 0.5 });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.LOW_CONFIDENCE);
    assert.equal(result.escalate, true);
  });

  test('confidence exactly AT the threshold passes', async () => {
    assert.equal((await send({ confidenceThreshold: 0.8 }, { ...good, confidence: 0.8 })).allowed, true);
  });

  test('UNSTATED confidence is treated as failing the threshold', async () => {
    const result = await send({}, { ok: true, reply: 'hi', shouldEscalate: false });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.LOW_CONFIDENCE, '"do not know" must read as "do not send"');
  });

  test('consent is RE-CHECKED after generation (a STOP can arrive mid-call)', async () => {
    const result = await send({}, good, 'auto', { optedOut: true });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'opted_out');
  });

  test('a BLOCKED LINE TYPE refuses the send', async () => {
    const result = await guardrails.checkCanSendReply({
      settings: settingsWith({}, { allowedLineTypes: ['mobile'] }),
      contact: mobileContact({
        lookup: { status: 'valid', type: 'landline', lookedUpAt: new Date(Date.now() - DAY) },
      }),
      conversation: conversationWith(),
      parsed: good,
      mode: 'auto',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.LINE_TYPE_BLOCKED);
  });

  test('an unverifiable line type is TEMPORARY, so it can be retried', async () => {
    lookupResult = async () => {
      throw new Error('Lookup unavailable');
    };
    const result = await guardrails.checkCanSendReply({
      settings: settingsWith({}, { allowedLineTypes: ['mobile'] }),
      contact: fakeDoc(f.contact({ _id: f.oid() })),
      conversation: conversationWith(),
      parsed: good,
      mode: 'auto',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.LINE_TYPE_UNKNOWN);
    assert.equal(result.temporary, true);
  });

  test('OUTSIDE THE SENDING WINDOW is temporary, not a refusal of the reply', async () => {
    const result = await guardrails.checkCanSendReply({
      settings: settingsWith(
        {},
        { sendingWindow: { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' } }
      ),
      contact: mobileContact(),
      conversation: conversationWith(),
      parsed: good,
      mode: 'auto',
      now: new Date('2026-07-01T03:00:00Z'),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.OUTSIDE_WINDOW);
    assert.equal(result.temporary, true);
  });

  test('inside the sending window is allowed', async () => {
    const result = await guardrails.checkCanSendReply({
      settings: settingsWith(
        {},
        { sendingWindow: { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' } }
      ),
      contact: mobileContact(),
      conversation: conversationWith(),
      parsed: good,
      mode: 'auto',
      now: new Date('2026-07-01T12:00:00Z'),
    });
    assert.equal(result.allowed, true);
  });

  test("a DISALLOWED SEND DAY blocks", async () => {
    const result = await guardrails.checkCanSendReply({
      settings: settingsWith(
        {},
        {
          sendingWindow: { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' },
          sendDays: [1, 2, 3, 4, 5],
        }
      ),
      contact: mobileContact(),
      conversation: conversationWith(),
      parsed: good,
      mode: 'auto',
      now: new Date('2026-07-05T12:00:00Z'), // a Sunday
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.OUTSIDE_WINDOW);
  });

  test("the recipient's own timezone governs quiet hours", async () => {
    // 12:00 UTC is inside a 9-18 UTC window but 21:00 in Tokyo.
    const result = await guardrails.checkCanSendReply({
      settings: settingsWith(
        {},
        { sendingWindow: { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' } }
      ),
      contact: mobileContact({ timezone: 'Asia/Tokyo' }),
      conversation: conversationWith(),
      parsed: good,
      mode: 'auto',
      now: new Date('2026-07-01T12:00:00Z'),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.OUTSIDE_WINDOW);
  });
});

// ---------------------------------------------------------------------------
describe('mode resolution', () => {
  test('the global default applies when the thread has no override', () => {
    assert.equal(guardrails.resolveMode(settingsWith({ defaultMode: 'auto' }), conversationWith()), 'auto');
    assert.equal(guardrails.resolveMode(settingsWith({ defaultMode: 'draft' }), conversationWith()), 'draft');
  });

  test('a per-thread override wins', () => {
    const settings = settingsWith({ defaultMode: 'draft' });
    assert.equal(guardrails.resolveMode(settings, conversationWith({ mode: 'auto' })), 'auto');
  });

  test("an empty override means 'inherit'", () => {
    const settings = settingsWith({ defaultMode: 'auto' });
    assert.equal(guardrails.resolveMode(settings, conversationWith({ mode: '' })), 'auto');
  });

  test('it defaults to draft — the safe mode — when nothing is configured', () => {
    assert.equal(guardrails.resolveMode({}, null), 'draft');
  });
});

describe('keyword matcher', () => {
  const match = guardrails.matchesEscalationKeyword;

  test('matches a whole word anywhere in the message', () => {
    assert.equal(match('I need a human now', ['human']), 'human');
    assert.equal(match('HUMAN', ['human']), 'human');
    assert.equal(match('human.', ['human']), 'human');
  });

  test('does not match a substring of a longer word', () => {
    assert.equal(match('humane', ['human']), null);
    assert.equal(match('agency', ['agent']), null);
  });

  test('returns null for empty input', () => {
    assert.equal(match('', ['human']), null);
    assert.equal(match('hello', []), null);
    assert.equal(match(null, ['human']), null);
    assert.equal(match('hello', [null, '', '  ']), null);
  });
});

// ---------------------------------------------------------------------------
// The AI reaches a handset through the same shared gate as every other path, so
// a number Twilio Lookup reported invalid is never drafted for or sent to — with
// the line-type filter off (the default) as well as on.
describe('a definitively invalid number — the AI path', () => {
  const invalid = { lookup: { status: 'invalid', type: '', lookedUpAt: new Date() } };
  const good = { ok: true, reply: 'We are open 9-5.', confidence: 0.9, shouldEscalate: false };

  for (const [label, base] of Object.entries({
    'mobileOnly=false': { mobileOnly: false },
    'every line type allowed': { allowedLineTypes: ['mobile', 'landline', 'fixedVoip', 'nonFixedVoip', 'tollFree', 'unknown'] },
    'mobile only': { allowedLineTypes: ['mobile'] },
  })) {
    test(`gate 1 refuses to generate (${label})`, async () => {
      const result = await guardrails.checkCanGenerate({
        settings: settingsWith({}, base),
        contact: mobileContact(invalid),
        conversation: conversationWith(),
        inboundBody: 'what are your hours?',
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, REASONS.INVALID_NUMBER);
      assert.equal(result.escalate, false);
    });

    test(`gate 2 refuses to send (${label})`, async () => {
      const result = await guardrails.checkCanSendReply({
        settings: settingsWith({}, base),
        contact: mobileContact(invalid),
        conversation: conversationWith(),
        parsed: good,
        mode: 'auto',
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'invalid_number');
      assert.equal(result.temporary, false, 'definitive: the worker must not retry it');
    });
  }

  test('an unchecked number, and one whose lookup failed, are NOT refused as invalid', async () => {
    for (const lookup of [
      { status: 'unknown', type: '' },
      { status: 'unknown', type: '', lastError: 'Lookup failed: timeout', lastAttemptAt: new Date() },
      { status: 'valid', type: '', lookedUpAt: new Date() },
    ]) {
      const result = await guardrails.checkCanSendReply({
        settings: settingsWith(),
        contact: mobileContact({ lookup }),
        conversation: conversationWith(),
        parsed: good,
        mode: 'auto',
      });
      assert.equal(result.allowed, true, JSON.stringify(lookup));
    }
  });
});
