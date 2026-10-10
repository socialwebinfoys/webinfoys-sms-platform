// AI guardrails (Phase 8).
//
// Every reason an AI reply must not be sent, in one place and in one order.
//
// This module deliberately owns NO compliance logic of its own. Opt-out,
// inactive and delivery-blocked come from sendPolicy.checkCanSend; line type
// comes from sendPolicy.checkMobileOnly; the sending window, send days and
// timezone resolution come from the automation worker's existing helpers. There
// is exactly one opt-out system on this platform and AI uses it — it cannot
// override it, and a contact who has opted out can never be messaged by the AI
// however it is configured.
//
// Split into two gates because they answer different questions at different
// costs:
//
//   checkCanGenerate — "should we spend a provider call at all?" Runs BEFORE
//       generation. Cheap, and avoids paying to generate a reply that could
//       never be sent.
//   checkCanSend    — "may this specific generated reply go out?" Runs AFTER
//       generation, because confidence and the model's own escalation signal
//       are not known until then.
//
// Draft mode still runs the first gate (there is no point drafting a reply for
// someone who has opted out) but never the second, because nothing is sent.
'use strict';

const Settings = require('../../models/Settings');
const sendPolicy = require('../sendPolicy');
const automationWorker = require('../../jobs/automationWorker');

// Stable machine-readable tokens. These reach SystemLog, the job record and the
// eventual UI, so they are part of the contract rather than prose.
const REASONS = {
  AI_DISABLED: 'ai_disabled',
  NO_CONTACT: 'no_contact',
  // Phase 8.1: the thread a draft belongs to is gone or has been soft-deleted,
  // so there is nowhere legitimate to send it.
  NO_CONVERSATION: 'no_conversation',
  OPTED_OUT: 'opted_out',
  INACTIVE: 'inactive',
  DELIVERY_BLOCKED: 'delivery_blocked',
  // Twilio Lookup has definitively reported the number invalid. Emitted by the
  // shared sendPolicy.checkCanSend, like the three above.
  INVALID_NUMBER: 'invalid_number',
  SMS_DISABLED: 'sms_disabled',
  TAKEOVER: 'takeover',
  REPLY_LIMIT: 'reply_limit',
  ESCALATION_KEYWORD: 'escalation_keyword',
  ALREADY_ESCALATED: 'already_escalated',
  LINE_TYPE_BLOCKED: 'line_type_blocked',
  LINE_TYPE_UNKNOWN: 'line_type_unknown',
  OUTSIDE_WINDOW: 'outside_window',
  LOW_CONFIDENCE: 'low_confidence',
  MODEL_ESCALATED: 'model_escalated',
  EMPTY_REPLY: 'empty_reply',
  NOT_AUTO_MODE: 'not_auto_mode',

  // --- Fix 2: at most one answer per customer message ---------------------
  // These three describe a job that was valid when it was created and has since
  // been overtaken by events. They are not policy refusals — nothing was wrong
  // with the reply, it simply must not be sent any more.
  //
  // Something already went out on this thread after the message being answered.
  // Sending now would be a second answer to one question.
  ALREADY_ANSWERED: 'already_answered',
  // The customer sent another message after the one this job is answering, so
  // this answer is stale: the newer message is the one that deserves a reply.
  SUPERSEDED: 'superseded',
  // A human operator answered from the inbox, which stands the assistant down
  // for the messages that were already queued.
  HUMAN_REPLIED: 'human_replied',
  // The inbound message this job was created for can no longer be read, so there
  // is nothing to answer and no way to tell whether answering would be safe.
  INBOUND_MISSING: 'inbound_missing',
};

const allow = () => ({ allowed: true });
const block = (reason, { escalate = false, temporary = false, detail = '' } = {}) => ({
  allowed: false,
  reason,
  escalate,
  temporary,
  detail,
});

// Whole-word, case-insensitive keyword match. Substring matching would make
// "humane" trip "human", so the comparison is tokenised instead.
function matchesEscalationKeyword(body, keywords = []) {
  const words = new Set(
    String(body || '')
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter(Boolean)
  );
  for (const keyword of keywords) {
    const needle = String(keyword || '').trim().toLowerCase();
    if (!needle) continue;
    // A multi-word keyword is checked as a phrase against the raw text.
    if (needle.includes(' ')) {
      if (String(body || '').toLowerCase().includes(needle)) return needle;
    } else if (words.has(needle)) {
      return needle;
    }
  }
  return null;
}

// Which mode applies: the per-thread override wins over the global default.
function resolveMode(settings, conversation) {
  const override = conversation && conversation.ai && conversation.ai.mode;
  if (override === 'draft' || override === 'auto') return override;
  return (settings.ai && settings.ai.defaultMode) || 'draft';
}

// Gate 1 — may we generate at all?
async function checkCanGenerate({ settings, contact, conversation, inboundBody }) {
  const ai = (settings && settings.ai) || {};

  if (!ai.enabled) return block(REASONS.AI_DISABLED);
  if (!settings.smsEnabled) return block(REASONS.SMS_DISABLED);
  if (!contact) return block(REASONS.NO_CONTACT);

  // The platform's single compliance gate. Opt-out, inactive and
  // delivery-blocked all surface here; AI never re-implements them.
  const eligibility = await sendPolicy.checkCanSend({ contact, phone: contact.phone });
  if (!eligibility.allowed) {
    return block(eligibility.code || REASONS.OPTED_OUT, { detail: eligibility.reason });
  }

  if (conversation && conversation.ai) {
    if (conversation.ai.takeover) return block(REASONS.TAKEOVER);
    if (conversation.ai.escalated) return block(REASONS.ALREADY_ESCALATED);

    const limit = ai.maxRepliesPerConversation;
    if (Number.isFinite(limit) && (conversation.ai.replyCount || 0) >= limit) {
      // Escalating here is the point: the assistant has had its turns and the
      // customer is still talking, which is precisely when a human should look.
      return block(REASONS.REPLY_LIMIT, { escalate: true });
    }
  }

  const keyword = matchesEscalationKeyword(inboundBody, ai.escalationKeywords);
  if (keyword) {
    return block(REASONS.ESCALATION_KEYWORD, { escalate: true, detail: keyword });
  }

  return allow();
}

// Gate 2 — may THIS generated reply be sent?
//
// `parsed` is a normalised responseParser result. Called only in auto mode.
async function checkCanSendReply({ settings, contact, conversation, parsed, mode, now = new Date() }) {
  const ai = (settings && settings.ai) || {};

  if (mode !== 'auto') return block(REASONS.NOT_AUTO_MODE);
  if (!parsed || !parsed.ok) return block(REASONS.EMPTY_REPLY);

  // The model asked for a human. Checked BEFORE the empty-reply test, because
  // an empty reply plus escalate:true is exactly how the model says "I have
  // nothing useful to say, hand this over" — treating that as an empty reply
  // would file a deliberate escalation as a malfunction.
  if (parsed.shouldEscalate) {
    return block(REASONS.MODEL_ESCALATED, { escalate: true, detail: parsed.reason || '' });
  }

  if (!parsed.reply || !parsed.reply.trim()) return block(REASONS.EMPTY_REPLY);

  // A reply with no stated confidence is treated as failing the threshold: the
  // safe reading of "don't know" is "don't send".
  const threshold = Number.isFinite(ai.confidenceThreshold) ? ai.confidenceThreshold : 0.7;
  if (!Number.isFinite(parsed.confidence) || parsed.confidence < threshold) {
    return block(REASONS.LOW_CONFIDENCE, {
      escalate: true,
      detail: `confidence ${parsed.confidence ?? 'unstated'} < ${threshold}`,
    });
  }

  // Re-check consent immediately before sending. Generation involves a network
  // round trip, and a STOP can arrive during it.
  const eligibility = await sendPolicy.checkCanSend({ contact, phone: contact.phone });
  if (!eligibility.allowed) {
    return block(eligibility.code || REASONS.OPTED_OUT, { detail: eligibility.reason });
  }

  // The admin's line-type policy applies to an AI reply exactly as it does to
  // every other outbound message.
  const linePolicy = await sendPolicy.checkMobileOnly({ contact, phone: contact.phone });
  if (!linePolicy.allowed) {
    return block(
      linePolicy.temporary ? REASONS.LINE_TYPE_UNKNOWN : REASONS.LINE_TYPE_BLOCKED,
      { temporary: !!linePolicy.temporary, detail: linePolicy.reason }
    );
  }

  // Quiet hours, in the recipient's own timezone where they have one — the same
  // rule and the same helpers campaign steps and follow-ups use.
  const window = settings.sendingWindow;
  const zone = automationWorker.resolveTimezone(null, contact, window);
  if (!automationWorker.isSendableAt(now, window, settings.sendDays, zone)) {
    // Temporary: the reply is fine, the hour is not. The worker reschedules.
    return block(REASONS.OUTSIDE_WINDOW, { temporary: true, detail: zone });
  }

  return allow();
}

// Gate 3 (Phase 8.1) — may a HUMAN-APPROVED draft be sent?
//
// A third gate rather than a flag on gate 2, because the two answer different
// questions and share no decision.
//
// WHAT IS CHECKED, and it is every compliance rule the platform has: smsEnabled,
// consent (opt-out / inactive / delivery-blocked), human takeover, the admin's
// line-type policy, and quiet hours plus send days in the recipient's own
// timezone. Consent is re-read here, not inherited from draft time, because a
// draft can sit for hours and a STOP can arrive in the gap.
//
// WHAT IS DELIBERATELY NOT CHECKED, and why:
//   * confidenceThreshold and the model's escalate signal — both exist to decide
//     whether a MACHINE may send unsupervised. A human has now read the text and
//     chosen to send it, which is the review those checks were asking for.
//   * maxRepliesPerConversation — that limit caps AI<->customer ping-pong. An
//     operator deciding to answer is not the AI taking another turn, and the
//     count was already incremented when the draft was recorded.
//   * conversation.ai.escalated — escalation asks for a human. One has arrived.
//   * Settings.ai.enabled — the master switch governs whether the AI GENERATES.
//     This text already exists and is being sent by a person, so turning AI off
//     does not strand drafts an operator still needs to deal with. The decision
//     is deliberate; the guards that protect the RECIPIENT all still apply.
//
// `temporary: true` means "right text, wrong moment" — the caller keeps the draft
// approvable. A definitive consent block means it never becomes sendable.
async function checkCanSendApproved({ settings, contact, conversation, now = new Date() }) {
  if (!settings || !settings.smsEnabled) return block(REASONS.SMS_DISABLED);
  if (!contact) return block(REASONS.NO_CONTACT);

  // The platform's single consent gate, re-read at the moment of sending.
  const eligibility = await sendPolicy.checkCanSend({ contact, phone: contact.phone });
  if (!eligibility.allowed) {
    return block(eligibility.code || REASONS.OPTED_OUT, { detail: eligibility.reason });
  }

  // A human already owns this thread; the AI's draft is not theirs to send.
  if (conversation && conversation.ai && conversation.ai.takeover) {
    return block(REASONS.TAKEOVER);
  }

  // The line-type policy is applied UNCONDITIONALLY here. The inbox reply path
  // exempts a contact with `lastInboundAt` (their inbound message proves the
  // number receives SMS, and re-checking spends a billable Lookup) — that
  // exemption is not copied, because this message is attributed to the AI and
  // the AI's auto path has always enforced the filter in full. Stricter, and
  // consistent with the rest of the AI subsystem.
  const linePolicy = await sendPolicy.checkMobileOnly({ contact, phone: contact.phone });
  if (!linePolicy.allowed) {
    return block(
      linePolicy.temporary ? REASONS.LINE_TYPE_UNKNOWN : REASONS.LINE_TYPE_BLOCKED,
      { temporary: !!linePolicy.temporary, detail: linePolicy.reason }
    );
  }

  // Quiet hours, same helpers and same rule as campaign steps and follow-ups.
  const window = settings.sendingWindow;
  const zone = automationWorker.resolveTimezone(null, contact, window);
  if (!automationWorker.isSendableAt(now, window, settings.sendDays, zone)) {
    return block(REASONS.OUTSIDE_WINDOW, { temporary: true, detail: zone });
  }

  return allow();
}

module.exports = {
  REASONS,
  checkCanGenerate,
  checkCanSendReply,
  checkCanSendApproved,
  resolveMode,
  matchesEscalationKeyword,
};
