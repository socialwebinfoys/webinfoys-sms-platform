// AI presentation logic (Phase 9).
//
// Pure functions: given server data, decide what to SHOW. No network, no React,
// no clock-dependent branching beyond what is passed in — which is what makes
// this the part of the AI frontend that can be tested directly.
//
// IT DECIDES NOTHING OPERATIONAL. Whether a reply may be sent, whether a draft
// may be approved, whether a contact may be messaged — all of that belongs to the
// backend and is never recomputed here. Where a rule appears to be mirrored
// (effectiveMode, replyLimitReached) it is for a LABEL only, and is marked as
// such, following the precedent already set in the inbox by `keywordOf` and in
// Settings by `windowStatus`.
import { contactIdentity } from './contactIdentity';

// --- job statuses -----------------------------------------------------------
// Mirrors AIReplyJob.STATUSES (server/models/AIReplyJob.js). Kept in the
// server's order so filter dropdowns and the server's validation agree. An
// unrecognised status must still render — see jobStatusMeta.
export const JOB_STATUSES = [
  'pending',
  'processing',
  'drafted',
  'sent',
  'skipped',
  'escalated',
  'failed',
  'rejected',
];

// Statuses an operator can act on. Only `drafted` is approvable or rejectable —
// the backend's approval claim matches exactly that and nothing else.
export const ACTIONABLE_STATUSES = ['drafted'];

const STATUS_META = {
  pending: {
    label: 'Queued',
    chipClass: 'chip',
    description: 'Waiting for the AI worker to generate a reply.',
    actionable: false,
  },
  processing: {
    label: 'Working',
    chipClass: 'chip',
    description: 'Being generated or sent right now.',
    actionable: false,
  },
  drafted: {
    label: 'Awaiting review',
    chipClass: 'chip chip-warn',
    description: 'A reply is ready for a human to approve, edit or discard.',
    actionable: true,
  },
  sent: {
    label: 'Sent',
    chipClass: 'chip chip-on',
    description: 'This reply was sent to the contact.',
    actionable: false,
  },
  skipped: {
    label: 'Skipped',
    chipClass: 'chip',
    description: 'A safety rule stopped this reply. Nothing was sent.',
    actionable: false,
  },
  escalated: {
    label: 'Escalated',
    chipClass: 'chip chip-warn',
    description: 'Handed to a human. Nothing was sent automatically.',
    actionable: false,
  },
  failed: {
    label: 'Failed',
    chipClass: 'chip chip-invalid',
    description: 'Generation or sending failed after the allowed retries.',
    actionable: false,
  },
  rejected: {
    label: 'Discarded',
    chipClass: 'chip',
    description: 'A human discarded this draft. Nothing was sent.',
    actionable: false,
  },
};

// Never throws, and never renders an empty chip: an unknown status (a backend
// newer than this build) degrades to its own raw name rather than disappearing.
export function jobStatusMeta(status) {
  const key = String(status || '').trim();
  if (STATUS_META[key]) return { status: key, known: true, ...STATUS_META[key] };
  return {
    status: key || 'unknown',
    known: false,
    label: key || 'unknown',
    chipClass: 'chip',
    description: 'This status is not recognised by this version of the interface.',
    actionable: false,
  };
}

// --- reasons ----------------------------------------------------------------
// The stable tokens guardrails.REASONS emits, in operator language. Used for both
// a refused approval and a job whose stored `reason` explains a non-send.
const REASON_TEXT = {
  ai_disabled: 'The AI assistant is switched off.',
  no_contact: 'The contact record no longer exists.',
  no_conversation: 'The conversation no longer exists.',
  opted_out: 'This contact has opted out of SMS.',
  inactive: 'This contact is marked inactive.',
  delivery_blocked: 'Messages to this number keep failing to be delivered.',
  invalid_number: 'Twilio Lookup reports this number as invalid.',
  sms_disabled: 'SMS sending is turned off in Settings.',
  takeover: 'A human has taken over this conversation.',
  reply_limit: 'The AI reply limit for this conversation was reached.',
  escalation_keyword: 'The contact used a word that hands the thread to a human.',
  already_escalated: 'This conversation was already escalated to a human.',
  line_type_blocked: "This number's line type is not allowed by the current policy.",
  line_type_unknown: "This number's line type could not be verified.",
  outside_window: 'Outside the sending window for this recipient.',
  low_confidence: 'The model was not confident enough to send without review.',
  model_escalated: 'The model asked for a human.',
  empty_reply: 'The model produced nothing usable.',
  not_auto_mode: 'This conversation is in draft mode, so nothing is sent automatically.',
  draft_mode: 'Draft mode — saved for a human to review.',
  approved: 'Approved and sent by a human.',
  approved_edited: 'Edited and sent by a human.',
  rejected: 'Discarded by a human.',
  send_failed: 'The last attempt to send this failed.',
  empty_draft: 'The draft has no text to send.',
  max_retries: 'Retried the allowed number of times without success.',
  // Fix 2: the thread moved on before this reply could be sent.
  already_answered: 'Already answered — something else was sent on this chat first.',
  superseded: 'Superseded by a newer message from the contact.',
  human_replied: 'A person replied, so the assistant stood down.',
  inbound_missing: 'The message this was answering is no longer available.',
};

export function describeReason(reason) {
  const key = String(reason || '').trim();
  if (!key) return '';
  return REASON_TEXT[key] || key.replace(/_/g, ' ');
}

// --- errors -----------------------------------------------------------------
// One place that turns an Axios failure into something an operator can act on.
//
// `draftSurvives` is the question that actually matters after a failed approval:
// is the draft still there to try again, or is it gone for good? The backend
// answers it explicitly with `approvable`; where it does not, the HTTP status is
// enough to infer it safely (a 4xx about the request leaves the draft alone).
export function describeApiError(err, { fallback = 'Something went wrong.' } = {}) {
  // No response at all: the request never reached the API.
  if (err && err.request && !err.response) {
    return {
      status: 0,
      message: 'Could not reach the server. Check your connection and try again.',
      reason: 'network',
      draftSurvives: true,
      retryable: true,
    };
  }

  const res = (err && err.response) || {};
  const data = res.data || {};
  const status = res.status || 0;
  // The server's own message is safe to show: every AI endpoint returns a short
  // written sentence, never a stack trace. A 500 is the exception — it may carry
  // internal detail, so it is replaced wholesale.
  const serverMessage = typeof data.message === 'string' ? data.message.trim() : '';

  const byStatus = {
    401: 'Your session has expired. Sign in again.',
    403: 'You are not allowed to do that.',
    404: 'That is no longer there — it may have been handled already.',
    409: 'This was already handled. Refreshing to show the current state.',
    422: 'That cannot be sent as it is.',
    429: 'Too many requests. Wait a moment and try again.',
    500: 'The server hit an unexpected error. Nothing was sent.',
    502: 'The message could not be sent. Nothing left the system.',
    503: 'Temporarily unavailable. Nothing was sent — try again shortly.',
  };

  const message =
    status === 500 ? byStatus[500] : serverMessage || byStatus[status] || fallback;

  // Explicit from the server wins; otherwise infer. Only a 404 (the job is gone)
  // and a definitive 403/409 consent block end a draft's life, and in those cases
  // the server sets `approvable: false` itself.
  const draftSurvives =
    typeof data.approvable === 'boolean' ? data.approvable : status !== 404;

  return {
    status,
    message,
    reason: data.reason || '',
    // Present when a 409 reports the job's real status.
    jobStatus: data.status || '',
    draftSurvives,
    retryable: [0, 429, 500, 502, 503].includes(status),
  };
}

// --- draft body validation --------------------------------------------------
// Client-side validation exists to catch a mistake before a round trip, NOT to
// be the rule. The backend re-validates and stays authoritative, so the limits
// used here come from the server's own settings rather than from a constant.
export function validateDraftBody(text, maxChars) {
  const body = String(text === undefined || text === null ? '' : text).trim();
  const ceiling = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Number(maxChars) : 320;

  if (!body) return { ok: false, reason: 'Enter a reply before approving it.', body: '' };
  if (body.length > ceiling) {
    return {
      ok: false,
      // Says how far over, because "too long" alone makes someone count.
      reason: `This reply is ${body.length} characters — ${body.length - ceiling} over the ${ceiling}-character limit.`,
      body,
    };
  }
  return { ok: true, body, remaining: ceiling - body.length };
}

// --- conversation AI state --------------------------------------------------
// DISPLAY ONLY. Mirrors guardrails.resolveMode so a label can say which mode is
// in force; it decides nothing. The backend resolves the real mode per job.
export function effectiveMode(aiSettings, conversation) {
  const override = conversation && conversation.ai && conversation.ai.mode;
  if (override === 'draft' || override === 'auto') return { mode: override, inherited: false };
  const fallback = (aiSettings && aiSettings.defaultMode) || 'draft';
  return { mode: fallback, inherited: true };
}

// DISPLAY ONLY, and deliberately conservative: the limit counts replies the
// assistant produced, and releasing a takeover does NOT reset it, so a thread at
// its limit stays at its limit. Saying so plainly is the whole point — otherwise
// the UI shows "AI active" for a thread the backend will never let AI answer.
export function replyLimitReached(aiSettings, conversation) {
  const limit = aiSettings && Number(aiSettings.maxRepliesPerConversation);
  if (!Number.isFinite(limit)) return false;
  const used = (conversation && conversation.ai && Number(conversation.ai.replyCount)) || 0;
  return used >= limit;
}

// The chips shown for one conversation, in priority order: the thing that most
// changes what an operator should do comes first.
//
// Returns [{ key, label, chipClass, title }]. `title` is the tooltip/explanation
// so colour is never the only carrier of meaning.
export function conversationAiChips(aiSettings, conversation) {
  const chips = [];
  const ai = (conversation && conversation.ai) || {};

  if (ai.takeover) {
    chips.push({
      key: 'takeover',
      label: 'Human takeover',
      chipClass: 'chip chip-warn',
      title: 'You are handling this conversation. The assistant will not reply to it.',
    });
  }

  if (ai.escalated) {
    chips.push({
      key: 'escalated',
      label: 'Escalated',
      chipClass: 'chip chip-invalid',
      title: ai.escalationReason
        ? `Handed to a human: ${describeReason(ai.escalationReason)}`
        : 'Handed to a human.',
    });
  }

  if (!aiSettings || !aiSettings.enabled) {
    chips.push({
      key: 'ai_off',
      label: 'AI off',
      chipClass: 'chip',
      title: 'The assistant is switched off platform-wide, so it will not produce new replies.',
    });
    return chips;
  }

  if (replyLimitReached(aiSettings, conversation)) {
    chips.push({
      key: 'reply_limit',
      label: 'Reply limit reached',
      chipClass: 'chip chip-warn',
      title:
        `The assistant has used its ${aiSettings.maxRepliesPerConversation} replies for this ` +
        'conversation and will not send more. Releasing a takeover does not reset this.',
    });
  }

  const { mode, inherited } = effectiveMode(aiSettings, conversation);
  chips.push({
    key: 'mode',
    label: mode === 'auto' ? 'Auto mode' : 'Draft mode',
    chipClass: mode === 'auto' ? 'chip chip-on' : 'chip',
    title:
      (mode === 'auto'
        ? 'The assistant may send replies itself, if every safety check passes.'
        : 'The assistant prepares replies for a human to review.') +
      (inherited ? ' Inherited from the platform default.' : ' Set for this conversation.'),
  });

  return chips;
}

// --- message badges ---------------------------------------------------------
// Uses the message's existing `source`, which the API already returns. No new
// message type, and nothing invented client-side.
export function messageBadge(message) {
  const source = String((message && message.source) || '');
  if (source === 'ai') {
    return { label: 'AI', chipClass: 'chip chip-on', title: 'Sent by the AI assistant' };
  }
  return null;
}

// --- misc -------------------------------------------------------------------
// An ABSENT confidence must render as nothing, not as 0%. Number(null) is 0 and
// Number('') is 0, so the empty cases are rejected before the numeric check —
// otherwise a job the provider gave no confidence for would be displayed as
// "Confidence 0%", which reads as an alarming value rather than a missing one.
export function formatConfidence(confidence) {
  if (confidence === undefined || confidence === null || confidence === '') return '';
  const n = Number(confidence);
  if (!Number.isFinite(n)) return '';
  return `${Math.round(n * 100)}%`;
}

// A short, safe preview of untrusted text for a list row. Returns a plain string
// — React escapes it on render; this only bounds the length.
export function previewText(text, max = 120) {
  const str = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

// Resolve a display name for a job row without a per-row request. Takes whatever
// the populated job already carries and falls back through the denormalised
// fields the conversation list provides.
export function jobContactLabel(job) {
  const { name, phone, title } = contactIdentity(job && job.contact, job && job.conversation);
  return { name, phone, display: title || 'Unknown contact' };
}

// ---------------------------------------------------------------------------
// Analytics presentation (Phase 10)
//
// Formatting and labelling only. Every number shown comes from the server's
// aggregation; nothing here derives a metric, and nothing invents a denominator.
// ---------------------------------------------------------------------------

// The ranges the existing analytics API accepts. Same keys and labels the
// dashboard already uses, so the two screens agree.
export const ANALYTICS_RANGES = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
];

export function rangeLabel(key) {
  const found = ANALYTICS_RANGES.find((r) => r.key === key);
  return found ? found.label : 'All time';
}

// A percentage, or an em dash when there is no denominator to divide by. Never
// NaN, never Infinity, never a made-up 0% — the same rule the dashboard uses.
export function formatPercent(value, denominator) {
  if (denominator === undefined || denominator === null || denominator <= 0) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

// Thousands separators for token counts. 0 is a real value and shows as 0.
export function formatCount(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

// What to show for a measurement that may not exist. Distinguishes "zero" from
// "not measured" — the distinction Part G of the brief turns on, and the one
// Phase 9 already fixed for a single job's confidence.
export function formatAverageConfidence(confidence) {
  if (!confidence || !confidence.measured || confidence.average === null || confidence.average === undefined) {
    return { value: '—', measured: 0, hasData: false };
  }
  return {
    value: `${Math.round(confidence.average * 100)}%`,
    measured: confidence.measured,
    hasData: true,
  };
}

// Human labels for the AI event types the backend emits. An unrecognised type
// degrades to a readable form of its own name rather than disappearing.
const EVENT_LABELS = {
  'ai.run': 'Worker run',
  'ai.reply.sent': 'Reply sent automatically',
  'ai.reply.drafted': 'Reply drafted',
  'ai.reply.skipped': 'Reply skipped',
  'ai.reply.escalated': 'Escalated to a human',
  'ai.provider.error': 'Provider error',
  'ai.settings.updated': 'Settings changed',
  'ai.takeover.enabled': 'Human took over',
  'ai.takeover.released': 'Handed back to AI',
  'ai.draft.approved': 'Draft approved',
  'ai.draft.rejected': 'Draft discarded',
  'ai.draft.blocked': 'Approval blocked',
  'ai.draft.send_failed': 'Approved send failed',
  'ai.mode.changed': 'Conversation mode changed',
};

export function eventTypeLabel(eventType) {
  const key = String(eventType || '').trim();
  if (!key) return 'Unknown event';
  if (EVENT_LABELS[key]) return EVENT_LABELS[key];
  // ai.some.new_thing -> "Some new thing"
  const words = key.replace(/^ai\./, '').replace(/[._]/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function severityChipClass(severity) {
  if (severity === 'error') return 'chip chip-invalid';
  if (severity === 'warning') return 'chip chip-warn';
  return 'chip';
}

// The outcome breakdown.
//
// NOT a funnel, deliberately. A job holds exactly one terminal status, so
// `drafted` and `sent` are mutually exclusive buckets, not consecutive stages —
// drawing them as a funnel would imply that drafts flow into sends within the
// same period, which the data does not establish. A proportional breakdown says
// what is true: each attempt ended exactly one way.
export function outcomeBreakdown(jobs) {
  if (!jobs || !jobs.byStatus) return [];
  const order = ['sent', 'drafted', 'skipped', 'escalated', 'failed', 'rejected', 'pending', 'processing'];
  const seen = new Set(order);
  const extra = Object.keys(jobs.byStatus).filter((k) => !seen.has(k));
  return [...order, ...extra]
    .map((status) => ({
      status,
      label: jobStatusMeta(status).label,
      chipClass: jobStatusMeta(status).chipClass,
      value: jobs.byStatus[status] || 0,
      share: jobs.total > 0 ? (jobs.byStatus[status] || 0) / jobs.total : 0,
    }))
    .filter((row) => row.value > 0);
}

// Is there anything at all to show? Used to choose between the metrics and an
// honest empty state, rather than rendering a page of zeroes and fake charts.
export function hasAiActivity(analytics) {
  if (!analytics) return false;
  const jobs = (analytics.jobs && analytics.jobs.total) || 0;
  const events = (analytics.activity && analytics.activity.byEventType) || [];
  return jobs > 0 || events.length > 0;
}

// Confidence bands as the server returned them, labelled for display. The band
// edges are the server's; this only formats them.
export function confidenceBands(confidence) {
  if (!confidence || !Array.isArray(confidence.distribution)) return [];
  return confidence.distribution.map((band) => ({
    label: `${Math.round(band.from * 100)}–${Math.round(band.to * 100)}%`,
    value: band.n,
    from: band.from,
    to: band.to,
  }));
}

// The conversation id for a job, whether the field is populated or a bare id.
export function jobConversationId(job) {
  const conversation = job && job.conversation;
  if (!conversation) return '';
  if (typeof conversation === 'object') return String(conversation._id || '');
  return String(conversation);
}
