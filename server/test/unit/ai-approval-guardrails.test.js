// Phase 8.1 — the human-approval guard (guardrails.checkCanSendApproved).
//
// Same approach as test/unit/ai-guardrails.test.js: the REAL sendPolicy and the
// REAL automation-worker window helpers run, and only Settings.getSingleton,
// Contact.findOne and the billable Lookup call are substituted. Stubbing the
// compliance path would defeat the purpose — the claim under test is precisely
// that approving a draft goes through the platform's single set of send rules.
//
// Two halves to the specification:
//   * every recipient-protecting rule still applies (consent, line type, quiet
//     hours, takeover, the SMS master switch);
//   * the machine-supervision rules do NOT (confidence, the model's escalate
//     signal, the reply limit, prior escalation, Settings.ai.enabled), because a
//     human has read the text and chosen to send it.
'use strict';

require('../_support/env');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const Settings = require('../../models/Settings');
const Contact = require('../../models/Contact');
const lookupService = require('../../services/lookupService');
const guardrails = require('../../services/ai/guardrails');
const f = require('../_support/factories');
const { fakeDoc } = require('../_support/stubs');

const { REASONS } = guardrails;
const DAY = 24 * 60 * 60 * 1000;

let lookupResult = () => ({ valid: true, type: 'mobile', carrier: 'Test' });
let currentSettings;
Contact.findOne = async () => null;
Settings.getSingleton = async () => currentSettings;
lookupService.lookupNumber = async (phone) => lookupResult(phone);

function aiSettings(overrides = {}) {
  return {
    enabled: true,
    defaultMode: 'draft',
    provider: 'openai',
    confidenceThreshold: 0.7,
    maxRepliesPerConversation: 3,
    contextMessageLimit: 10,
    maxReplyCharacters: 320,
    escalationKeywords: ['human'],
    ...overrides,
  };
}

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

// A contact with a fresh MOBILE classification, so the line-type filter can
// answer without spending a Lookup call.
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
  return fakeDoc(
    f.conversation({
      ai: { takeover: false, mode: '', replyCount: 0, escalated: false, ...ai },
    })
  );
}

// ---------------------------------------------------------------------------
describe('checkCanSendApproved — the happy path', () => {
  test('a clean contact on an untouched thread is allowed', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(),
      contact: mobileContact(),
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, true);
  });
});

// ---------------------------------------------------------------------------
describe('checkCanSendApproved — consent is re-checked at approval time', () => {
  test('an OPTED-OUT contact is blocked definitively', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(),
      contact: mobileContact({ optedOut: true, optedOutAt: new Date() }),
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.OPTED_OUT);
    assert.equal(result.temporary, false);
  });

  test('an INACTIVE contact is blocked', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(),
      contact: mobileContact({ isActive: false }),
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.INACTIVE);
  });

  test('a DELIVERY-BLOCKED contact is blocked', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(),
      contact: mobileContact({ deliveryBlocked: true }),
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.DELIVERY_BLOCKED);
  });

  test('smsEnabled=false blocks before anything else is considered', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith({}, { smsEnabled: false }),
      contact: mobileContact(),
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.SMS_DISABLED);
  });

  test('a missing contact is blocked', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(),
      contact: null,
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.NO_CONTACT);
  });
});

// ---------------------------------------------------------------------------
describe('checkCanSendApproved — human takeover', () => {
  test('a thread under human takeover blocks the draft', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(),
      contact: mobileContact(),
      conversation: conversationWith({ takeover: true, takeoverAt: new Date() }),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.TAKEOVER);
  });
});

// ---------------------------------------------------------------------------
describe('checkCanSendApproved — the line-type policy', () => {
  test('a disallowed line type is a definitive block', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith({}, { allowedLineTypes: ['mobile'] }),
      contact: mobileContact({
        lookup: {
          status: 'valid',
          type: 'landline',
          carrier: 'Test',
          lookedUpAt: new Date(Date.now() - DAY),
        },
      }),
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.LINE_TYPE_BLOCKED);
    assert.equal(result.temporary, false);
  });

  test('an unverifiable line type is TEMPORARY, so the draft survives', async () => {
    lookupResult = () => {
      throw new Error('Lookup unavailable');
    };
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith({}, { allowedLineTypes: ['mobile'] }),
      // No cached classification at all → fails closed, retryable.
      contact: mobileContact({ lookup: { status: 'unknown', type: '' } }),
      conversation: conversationWith(),
    });
    lookupResult = () => ({ valid: true, type: 'mobile', carrier: 'Test' });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.LINE_TYPE_UNKNOWN);
    assert.equal(result.temporary, true);
  });

  test('the line-type filter is NOT exempted by lastInboundAt (unlike an inbox reply)', async () => {
    // The inbox reply path skips the filter for a contact who has messaged us.
    // An approved AI draft deliberately does not inherit that exemption.
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith({}, { allowedLineTypes: ['mobile'] }),
      contact: mobileContact({
        lastInboundAt: new Date(),
        lookup: {
          status: 'valid',
          type: 'landline',
          carrier: 'Test',
          lookedUpAt: new Date(Date.now() - DAY),
        },
      }),
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.LINE_TYPE_BLOCKED);
  });
});

// ---------------------------------------------------------------------------
describe('checkCanSendApproved — quiet hours and send days', () => {
  test('outside the sending window is a TEMPORARY block', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(
        {},
        { sendingWindow: { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' } }
      ),
      contact: mobileContact(),
      conversation: conversationWith(),
      now: new Date('2026-07-01T03:00:00Z'),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.OUTSIDE_WINDOW);
    assert.equal(result.temporary, true);
  });

  test('inside the sending window is allowed', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(
        {},
        { sendingWindow: { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' } }
      ),
      contact: mobileContact(),
      conversation: conversationWith(),
      now: new Date('2026-07-01T12:00:00Z'),
    });
    assert.equal(result.allowed, true);
  });

  test('a disallowed send day blocks', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(
        {},
        {
          sendingWindow: { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' },
          sendDays: [1, 2, 3, 4, 5],
        }
      ),
      contact: mobileContact(),
      conversation: conversationWith(),
      now: new Date('2026-07-05T12:00:00Z'), // a Sunday
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.OUTSIDE_WINDOW);
  });

  test("the recipient's own timezone governs quiet hours", async () => {
    // 12:00 UTC is inside a 9-18 UTC window but 21:00 in Tokyo.
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(
        {},
        { sendingWindow: { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' } }
      ),
      contact: mobileContact({ timezone: 'Asia/Tokyo' }),
      conversation: conversationWith(),
      now: new Date('2026-07-01T12:00:00Z'),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.OUTSIDE_WINDOW);
  });
});

// ---------------------------------------------------------------------------
// The other half of the contract: the checks that exist to supervise a MACHINE
// are not applied to a message a person has approved.
describe('checkCanSendApproved — machine-supervision checks do NOT apply', () => {
  test('Settings.ai.enabled=false does not block a human-approved draft', async () => {
    // The master switch governs GENERATION. The text already exists and a person
    // is sending it, so disabling AI must not strand drafts an operator still
    // has to deal with. Every recipient-protecting guard above still runs.
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith({ enabled: false }),
      contact: mobileContact(),
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, true);
  });

  test('a thread already at its reply limit can still be approved', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith({ maxRepliesPerConversation: 1 }),
      contact: mobileContact(),
      conversation: conversationWith({ replyCount: 99 }),
    });
    assert.equal(result.allowed, true);
  });

  test('a previously escalated thread can still be approved', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(),
      contact: mobileContact(),
      conversation: conversationWith({ escalated: true, escalationReason: 'low_confidence' }),
    });
    assert.equal(result.allowed, true);
  });

  test('no confidence value is required — the gate takes no `parsed` argument', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith({ confidenceThreshold: 0.99 }),
      contact: mobileContact(),
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, true);
  });

  test('a missing conversation does not crash the gate', async () => {
    // The caller retires the job for a missing thread before reaching here; the
    // gate still must not throw on an absent conversation.
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(),
      contact: mobileContact(),
      conversation: null,
    });
    assert.equal(result.allowed, true);
  });
});

// ---------------------------------------------------------------------------
describe('checkCanSendApproved — ordering', () => {
  test('consent is reported ahead of the line-type policy', async () => {
    // A contact who is both opted out AND on a disallowed line type must be
    // reported as opted out: that is the reason that can never be configured away.
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith({}, { allowedLineTypes: ['mobile'] }),
      contact: mobileContact({
        optedOut: true,
        lookup: { status: 'valid', type: 'landline', lookedUpAt: new Date() },
      }),
      conversation: conversationWith(),
    });
    assert.equal(result.reason, REASONS.OPTED_OUT);
  });

  test('takeover is reported ahead of quiet hours', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(
        {},
        { sendingWindow: { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' } }
      ),
      contact: mobileContact(),
      conversation: conversationWith({ takeover: true }),
      now: new Date('2026-07-01T03:00:00Z'),
    });
    assert.equal(result.reason, REASONS.TAKEOVER);
  });
});

// ---------------------------------------------------------------------------
describe('checkCanSendApproved — a definitively invalid number', () => {
  const invalid = { lookup: { status: 'invalid', type: '', lookedUpAt: new Date() } };

  test('a human-approved draft is not sent to it, with the line-type filter off', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith({}, { mobileOnly: false }),
      contact: mobileContact(invalid),
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REASONS.INVALID_NUMBER);
    assert.equal(result.temporary, false, 'the draft never becomes sendable to this number');
  });

  test('nor with every line type allowed, nor for a contact who has messaged us', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith({}, { allowedLineTypes: ['mobile', 'landline', 'fixedVoip', 'nonFixedVoip', 'tollFree', 'unknown'] }),
      contact: mobileContact({ ...invalid, lastInboundAt: new Date() }),
      conversation: conversationWith(),
    });
    assert.equal(result.reason, 'invalid_number');
  });

  test('a lookup that merely FAILED does not block an approved draft', async () => {
    const result = await guardrails.checkCanSendApproved({
      settings: settingsWith(),
      contact: mobileContact({ lookup: { status: 'unknown', type: '', lastError: 'Lookup failed: timeout' } }),
      conversation: conversationWith(),
    });
    assert.equal(result.allowed, true);
  });
});
