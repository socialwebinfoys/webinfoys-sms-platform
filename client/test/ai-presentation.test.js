// Phase 9 — AI presentation logic.
//
// The decisions the frontend actually makes: which label and colour a job status
// gets, what an operator is told when a request fails, whether a typed reply is
// plausible before a round trip, and which chips describe a conversation. All
// pure, so all testable directly.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  JOB_STATUSES,
  jobStatusMeta,
  describeReason,
  describeApiError,
  validateDraftBody,
  effectiveMode,
  replyLimitReached,
  conversationAiChips,
  messageBadge,
  formatConfidence,
  previewText,
  jobContactLabel,
  jobConversationId,
} from '../src/utils/aiPresentation.js';

// The server's enum, as of Phase 8.1. If the backend adds a status this list
// should follow it — and jobStatusMeta must not break in the meantime.
const SERVER_STATUSES = [
  'pending',
  'processing',
  'drafted',
  'sent',
  'skipped',
  'escalated',
  'failed',
  'rejected',
];

// ===========================================================================
describe('job statuses', () => {
  test('the status list matches the backend enum exactly', () => {
    assert.deepEqual(JOB_STATUSES, SERVER_STATUSES);
  });

  test('every backend status has a label, a chip class and an explanation', () => {
    for (const status of SERVER_STATUSES) {
      const meta = jobStatusMeta(status);
      assert.equal(meta.known, true, `${status} is not described`);
      assert.ok(meta.label, `${status} has no label`);
      assert.match(meta.chipClass, /^chip/, `${status} has no chip class`);
      assert.ok(meta.description.length > 10, `${status} has no explanation`);
    }
  });

  test('ONLY drafted is actionable', () => {
    const actionable = SERVER_STATUSES.filter((s) => jobStatusMeta(s).actionable);
    assert.deepEqual(actionable, ['drafted']);
  });

  test('an unknown status degrades gracefully instead of rendering nothing', () => {
    const meta = jobStatusMeta('quantum_superposition');
    assert.equal(meta.known, false);
    assert.equal(meta.label, 'quantum_superposition');
    assert.equal(meta.chipClass, 'chip');
    assert.equal(meta.actionable, false, 'an unknown status must never be actionable');
  });

  test('a missing status still produces something renderable', () => {
    for (const value of [undefined, null, '', 0]) {
      const meta = jobStatusMeta(value);
      assert.equal(meta.label, 'unknown');
      assert.equal(meta.actionable, false);
    }
  });

  test('sent and rejected are both terminal and not actionable', () => {
    assert.equal(jobStatusMeta('sent').actionable, false);
    assert.equal(jobStatusMeta('rejected').actionable, false);
  });
});

// ===========================================================================
describe('guardrail reasons', () => {
  // Every token guardrails.REASONS can emit, plus the job reasons the service
  // stores. An operator must never see a raw snake_case token.
  const BACKEND_REASONS = [
    'ai_disabled', 'no_contact', 'no_conversation', 'opted_out', 'inactive',
    'delivery_blocked', 'sms_disabled', 'takeover', 'reply_limit',
    'escalation_keyword', 'already_escalated', 'line_type_blocked',
    'line_type_unknown', 'outside_window', 'low_confidence', 'model_escalated',
    'empty_reply', 'not_auto_mode', 'draft_mode', 'approved', 'approved_edited',
    'rejected', 'send_failed', 'empty_draft', 'max_retries',
  ];

  test('every backend reason has readable text', () => {
    for (const reason of BACKEND_REASONS) {
      const text = describeReason(reason);
      assert.ok(text.length > 5, `${reason} has no text`);
      assert.ok(!text.includes('_'), `${reason} leaked a raw token: ${text}`);
    }
  });

  test('an unknown reason is softened rather than shown raw', () => {
    assert.equal(describeReason('some_new_reason'), 'some new reason');
  });

  test('an empty reason produces nothing to render', () => {
    assert.equal(describeReason(''), '');
    assert.equal(describeReason(undefined), '');
  });
});

// ===========================================================================
describe('API error handling', () => {
  const err = (status, data) => ({ response: { status, data } });

  test('401 asks the operator to sign in again', () => {
    const d = describeApiError(err(401, {}));
    assert.equal(d.status, 401);
    assert.match(d.message, /sign in/i);
  });

  test("403 shows the server's own consent message", () => {
    const d = describeApiError(
      err(403, { message: 'This contact has opted out of SMS', reason: 'opted_out', approvable: false })
    );
    assert.equal(d.message, 'This contact has opted out of SMS');
    assert.equal(d.reason, 'opted_out');
    assert.equal(d.draftSurvives, false, 'an opted-out draft is retired by the server');
  });

  test('403 for a delivery block is surfaced with its reason', () => {
    const d = describeApiError(
      err(403, {
        message: 'Messages to this number keep failing to be delivered',
        reason: 'delivery_blocked',
        approvable: false,
      })
    );
    assert.match(d.message, /keep failing/);
    assert.equal(d.reason, 'delivery_blocked');
    assert.equal(d.draftSurvives, false);
  });

  test('409 reports the real job status so the UI can resync', () => {
    const d = describeApiError(
      err(409, { message: 'This draft is no longer awaiting approval (status: sent)', status: 'sent' })
    );
    assert.equal(d.status, 409);
    assert.equal(d.jobStatus, 'sent');
    assert.match(d.message, /no longer awaiting approval/);
  });

  test('422 line-type block keeps the draft', () => {
    const d = describeApiError(
      err(422, {
        message: "This number's line type is not allowed by the current policy",
        reason: 'line_type_blocked',
        approvable: true,
      })
    );
    assert.equal(d.draftSurvives, true);
    assert.equal(d.retryable, false, 'a policy block is not fixed by retrying');
  });

  test('429 is presented as a wait, and is retryable', () => {
    const d = describeApiError(err(429, { message: 'Too many AI test requests.' }));
    assert.equal(d.retryable, true);
    assert.match(d.message, /too many/i);
  });

  test('503 says nothing was sent and can be retried', () => {
    const d = describeApiError(
      err(503, { message: 'Outside the configured sending window for this recipient', reason: 'outside_window', approvable: true })
    );
    assert.equal(d.draftSurvives, true);
    assert.equal(d.retryable, true);
  });

  test('502 send failure is retryable and keeps the draft', () => {
    const d = describeApiError(err(502, { message: 'Twilio is unavailable', approvable: true }));
    assert.equal(d.draftSurvives, true);
    assert.equal(d.retryable, true);
  });

  test('500 NEVER shows the server body — it may carry internal detail', () => {
    const d = describeApiError(
      err(500, { message: 'TypeError: cannot read property _id of undefined at /srv/app/x.js:42' })
    );
    assert.ok(!d.message.includes('TypeError'), 'internal detail leaked');
    assert.ok(!d.message.includes('/srv/'), 'a server path leaked');
    assert.match(d.message, /unexpected error/i);
    assert.match(d.message, /nothing was sent/i);
  });

  test('404 means the draft is gone', () => {
    const d = describeApiError(err(404, { message: 'AI draft not found' }));
    assert.equal(d.draftSurvives, false);
  });

  test('a network failure is explained without blaming the operator', () => {
    const d = describeApiError({ request: {} });
    assert.equal(d.status, 0);
    assert.match(d.message, /could not reach the server/i);
    assert.equal(d.draftSurvives, true);
    assert.equal(d.retryable, true);
  });

  test('an unrecognised shape falls back to the supplied message', () => {
    const d = describeApiError({}, { fallback: 'Could not do the thing.' });
    assert.equal(d.message, 'Could not do the thing.');
  });

  test("the server's approvable flag always wins over the status guess", () => {
    const d = describeApiError(err(422, { message: 'nope', approvable: false }));
    assert.equal(d.draftSurvives, false);
  });
});

// ===========================================================================
describe('draft body validation', () => {
  test('a normal reply passes and reports what is left', () => {
    const v = validateDraftBody('We are open until 6pm.', 320);
    assert.equal(v.ok, true);
    assert.equal(v.body, 'We are open until 6pm.');
    assert.equal(v.remaining, 320 - 'We are open until 6pm.'.length);
  });

  test('empty and whitespace-only are refused', () => {
    for (const value of ['', '   ', '\n\t ', undefined, null]) {
      assert.equal(validateDraftBody(value, 320).ok, false);
    }
  });

  test('over the limit is refused, and says by how much', () => {
    const v = validateDraftBody('x'.repeat(330), 320);
    assert.equal(v.ok, false);
    assert.match(v.reason, /330 characters/);
    assert.match(v.reason, /10 over/);
  });

  test('the text is never truncated by validation', () => {
    const long = 'y'.repeat(400);
    const v = validateDraftBody(long, 320);
    assert.equal(v.ok, false);
    assert.equal(v.body.length, 400, 'validation must not shorten the text');
  });

  test('exactly at the limit is accepted', () => {
    assert.equal(validateDraftBody('z'.repeat(320), 320).ok, true);
  });

  test('the configured limit is what is used, not a constant', () => {
    assert.equal(validateDraftBody('a'.repeat(100), 80).ok, false);
    assert.equal(validateDraftBody('a'.repeat(100), 500).ok, true);
  });

  test('a missing limit falls back to the schema default of 320', () => {
    assert.equal(validateDraftBody('a'.repeat(321), undefined).ok, false);
    assert.equal(validateDraftBody('a'.repeat(320), undefined).ok, true);
  });

  test('leading and trailing whitespace does not count toward the limit', () => {
    assert.equal(validateDraftBody(`   ${'a'.repeat(320)}   `, 320).ok, true);
  });
});

// ===========================================================================
describe('effective mode (display only)', () => {
  const settings = { defaultMode: 'draft', maxRepliesPerConversation: 3 };

  test('with no override the platform default applies, marked inherited', () => {
    const r = effectiveMode(settings, { ai: { mode: '' } });
    assert.deepEqual(r, { mode: 'draft', inherited: true });
  });

  test('a per-conversation override wins and is marked as such', () => {
    assert.deepEqual(effectiveMode(settings, { ai: { mode: 'auto' } }), {
      mode: 'auto',
      inherited: false,
    });
  });

  test('an unrecognised override falls back to the default', () => {
    assert.deepEqual(effectiveMode(settings, { ai: { mode: 'banana' } }), {
      mode: 'draft',
      inherited: true,
    });
  });

  test('no settings at all still yields a mode rather than crashing', () => {
    assert.deepEqual(effectiveMode(null, null), { mode: 'draft', inherited: true });
  });
});

// ===========================================================================
describe('reply limit (Part G)', () => {
  test('at the limit counts as reached', () => {
    assert.equal(replyLimitReached({ maxRepliesPerConversation: 3 }, { ai: { replyCount: 3 } }), true);
  });

  test('over the limit counts as reached', () => {
    assert.equal(replyLimitReached({ maxRepliesPerConversation: 3 }, { ai: { replyCount: 9 } }), true);
  });

  test('under the limit does not', () => {
    assert.equal(replyLimitReached({ maxRepliesPerConversation: 3 }, { ai: { replyCount: 2 } }), false);
  });

  test('a limit of 0 means the assistant never replies', () => {
    assert.equal(replyLimitReached({ maxRepliesPerConversation: 0 }, { ai: { replyCount: 0 } }), true);
  });

  test('no configured limit is not treated as reached', () => {
    assert.equal(replyLimitReached({}, { ai: { replyCount: 50 } }), false);
  });
});

// ===========================================================================
describe('conversation chips', () => {
  const on = { enabled: true, defaultMode: 'draft', maxRepliesPerConversation: 3 };
  const keys = (chips) => chips.map((c) => c.key);

  test('a clean thread shows just its mode', () => {
    const chips = conversationAiChips(on, { ai: { replyCount: 0 } });
    assert.deepEqual(keys(chips), ['mode']);
    assert.equal(chips[0].label, 'Draft mode');
  });

  test('auto mode is visually distinct and explained', () => {
    const chips = conversationAiChips({ ...on, defaultMode: 'auto' }, { ai: { replyCount: 0 } });
    assert.equal(chips[0].label, 'Auto mode');
    assert.equal(chips[0].chipClass, 'chip chip-on');
    assert.match(chips[0].title, /may send/i);
  });

  test('takeover is reported first — it changes what the operator should do', () => {
    const chips = conversationAiChips(on, { ai: { takeover: true, replyCount: 0 } });
    assert.equal(keys(chips)[0], 'takeover');
    assert.match(chips[0].title, /will not reply/i);
  });

  test('escalation is surfaced with its reason in plain words', () => {
    const chips = conversationAiChips(on, {
      ai: { escalated: true, escalationReason: 'escalation_keyword', replyCount: 0 },
    });
    const chip = chips.find((c) => c.key === 'escalated');
    assert.ok(chip);
    assert.ok(!chip.title.includes('escalation_keyword'), 'a raw token leaked into the tooltip');
  });

  test('AI switched off is stated, and no mode chip is shown', () => {
    const chips = conversationAiChips({ enabled: false }, { ai: {} });
    assert.ok(keys(chips).includes('ai_off'));
    assert.ok(!keys(chips).includes('mode'), 'a mode chip would imply the AI is working');
  });

  test('missing settings are treated as AI off, never as enabled', () => {
    assert.ok(keys(conversationAiChips(null, { ai: {} })).includes('ai_off'));
  });

  test('the reply limit is called out so "AI active" is never misleading', () => {
    const chips = conversationAiChips(on, { ai: { replyCount: 3 } });
    const chip = chips.find((c) => c.key === 'reply_limit');
    assert.ok(chip, 'the reply limit must be visible');
    assert.match(chip.title, /does not reset/i, 'the UI must say a release does not reset it');
  });

  test('every chip carries a tooltip, so colour is never the only signal', () => {
    const chips = conversationAiChips(on, {
      ai: { takeover: true, escalated: true, replyCount: 5 },
    });
    for (const chip of chips) {
      assert.ok(chip.label, 'a chip with no text');
      assert.ok(chip.title && chip.title.length > 10, `chip ${chip.key} has no explanation`);
    }
  });
});

// ===========================================================================
describe('message badges', () => {
  test("a message with source 'ai' is badged", () => {
    const badge = messageBadge({ source: 'ai' });
    assert.equal(badge.label, 'AI');
    assert.match(badge.title, /assistant/i);
  });

  test('every other source is unbadged — no clutter on human messages', () => {
    for (const source of ['manual', 'reply', 'campaign', 'following', '', undefined]) {
      assert.equal(messageBadge({ source }), null, `${source} should not be badged`);
    }
  });

  test('a missing message does not crash', () => {
    assert.equal(messageBadge(undefined), null);
    assert.equal(messageBadge(null), null);
  });
});

// ===========================================================================
describe('small formatters', () => {
  test('confidence renders as a percentage', () => {
    assert.equal(formatConfidence(0.91), '91%');
    assert.equal(formatConfidence(1), '100%');
    assert.equal(formatConfidence(0), '0%');
  });

  test('an absent confidence renders as nothing', () => {
    assert.equal(formatConfidence(undefined), '');
    assert.equal(formatConfidence(null), '');
    assert.equal(formatConfidence('abc'), '');
  });

  test('preview text is bounded and collapses whitespace', () => {
    assert.equal(previewText('a\n\n  b'), 'a b');
    const long = previewText('x'.repeat(500), 50);
    assert.equal(long.length, 50);
    assert.ok(long.endsWith('…'));
  });

  test('preview text does not alter anything dangerous — only length', () => {
    // Escaping is React's job; this must not pretend to sanitise.
    const malicious = '<script>alert(1)</script>';
    assert.equal(previewText(malicious), malicious);
  });
});

// ===========================================================================
describe('job row labels without an extra request', () => {
  test('a populated contact supplies the name and phone', () => {
    const label = jobContactLabel({
      contact: { _id: 'c1', name: 'Ada Lovelace', phone: '+14155552671' },
    });
    assert.equal(label.display, 'Ada Lovelace');
    assert.equal(label.phone, '+14155552671');
  });

  test('a populated conversation is the fallback source', () => {
    const label = jobContactLabel({
      contact: 'bare-object-id',
      conversation: { _id: 'k1', contactName: 'Grace Hopper', contactPhone: '+15105550000' },
    });
    assert.equal(label.display, 'Grace Hopper');
    assert.equal(label.phone, '+15105550000');
  });

  test('a nameless contact falls back to the phone number', () => {
    const label = jobContactLabel({ contact: { _id: 'c1', name: '', phone: '+14155552671' } });
    assert.equal(label.display, '+14155552671');
  });

  test('bare ObjectIds degrade to a readable placeholder, never to "[object Object]"', () => {
    const label = jobContactLabel({ contact: '6a9a77ec9990e8f4bb000001', conversation: '6a9a77ec9990e8f4bb000002' });
    assert.equal(label.display, 'Unknown contact');
    assert.equal(label.name, '');
    assert.equal(label.phone, '');
  });

  test('a conversation id is read whether the field is populated or bare', () => {
    assert.equal(jobConversationId({ conversation: { _id: 'abc' } }), 'abc');
    assert.equal(jobConversationId({ conversation: 'abc' }), 'abc');
    assert.equal(jobConversationId({}), '');
  });
});

// ===========================================================================
// Fix 2 — reasons for a reply that was correct but is no longer current.
describe('Fix 2 reason labels', () => {
  const FIX2_REASONS = ['already_answered', 'superseded', 'human_replied', 'inbound_missing'];

  test('every Fix 2 reason has readable text', () => {
    for (const reason of FIX2_REASONS) {
      const text = describeReason(reason);
      assert.ok(text.length > 5, `${reason} has no text`);
      assert.ok(!text.includes('_'), `${reason} leaked a raw token: ${text}`);
    }
  });

  test('the labels say what actually happened', () => {
    assert.match(describeReason('already_answered'), /already answered/i);
    assert.match(describeReason('superseded'), /newer message/i);
    assert.match(describeReason('human_replied'), /person replied/i);
    assert.match(describeReason('inbound_missing'), /no longer available/i);
  });

  test('a Fix 2 skip is not described as a failure', () => {
    // Nothing was wrong with the reply — it simply must not be sent.
    for (const reason of FIX2_REASONS) {
      const text = describeReason(reason).toLowerCase();
      assert.ok(!text.includes('error'), `${reason} reads as an error`);
      assert.ok(!text.includes('failed'), `${reason} reads as a failure`);
    }
  });
});
