// One unit of AI work: "an inbound message arrived; decide what to say back"
// (Phase 8).
//
// WHY THIS IS A SEPARATE COLLECTION
// The brief asks for no unnecessary collections, so this one has to earn its
// place. It carries four things that have nowhere else to live:
//
//   1. ASYNCHRONY. The Twilio webhook must acknowledge in milliseconds and must
//      never wait on a third-party model. So the webhook records the intent and
//      returns; something else does the work. That record is this.
//   2. RETRY STATE. attempts / nextAttemptAt / lastError, so a provider outage
//      backs off instead of hammering, exactly as Enrollment does for sends.
//   3. A CLAIM. `lockedUntil` lets one worker take a job atomically, which is
//      what stops two processes generating two replies to one message.
//   4. THE DRAFT. In draft mode the generated candidate has to be stored
//      somewhere for a human to review. It is not an SMSMessage — nothing was
//      sent, and a draft that is never approved must not appear in the thread.
//
// Conversation holds the per-thread AI state (takeover, counters) and
// SMSMessage holds anything actually sent; neither can hold the above.
//
// STATUS TRANSITIONS
//   pending ──claim──> processing ──┬─> drafted    (awaiting a human)
//                                   ├─> sent       (auto mode, all guards passed)
//                                   ├─> skipped    (a guard said no; terminal)
//                                   ├─> escalated  (needs a human; terminal)
//                                   └─> failed     (retries exhausted; terminal)
//   processing ──retryable error──> pending (with backoff)
// Only `pending` is ever picked up by the worker, so every terminal state is
// final as far as generation is concerned.
//
// PHASE 8.1 — the human review transitions. A `drafted` job is the only thing an
// operator may act on, and both actions are an ATOMIC status change, which is
// what makes them idempotent and race-safe:
//
//   drafted ──approve claim──> processing ──┬─> sent     (approved and sent)
//                                           ├─> drafted  (blocked / send failed;
//                                           │             still approvable)
//                                           └─> skipped  (consent withdrawn or
//                                                         the contact is gone;
//                                                         never approvable again)
//   drafted ──reject──> rejected  (terminal; no SMS, no provider call)
//
// `rejected` is terminal, so a rejected draft can never later be approved: the
// approval claim matches `status: 'drafted'` and nothing else.
const mongoose = require('mongoose');

const STATUSES = [
  'pending',
  'processing',
  'drafted',
  'sent',
  'skipped',
  'escalated',
  'failed',
  // Phase 8.1: a human read the draft and declined to send it. The job is kept
  // for audit — a discarded draft is evidence of a decision, so it is never
  // physically deleted.
  'rejected',
];
const TERMINAL_STATUSES = ['drafted', 'sent', 'skipped', 'escalated', 'failed', 'rejected'];

const aiReplyJobSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      required: true,
      index: true,
    },
    // The inbound message this job is answering. Unique, which is the
    // idempotency guarantee: a replayed webhook, a restart mid-flight or two
    // racing enqueues can only ever produce ONE job for a given message.
    inboundMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SMSMessage',
      required: true,
      unique: true,
    },
    status: { type: String, enum: STATUSES, default: 'pending', index: true },
    // What this job was allowed to do, resolved at enqueue time from the
    // thread override and then the global default.
    mode: { type: String, enum: ['draft', 'auto'], required: true },

    // --- generation result -------------------------------------------------
    // The candidate reply. In draft mode this is what a human reviews; in auto
    // mode it is what was sent. Never populated for a skipped or failed job.
    draftReply: { type: String, default: '' },
    confidence: { type: Number, min: 0, max: 1 },
    provider: { type: String, default: '' },
    model: { type: String, default: '' },
    // Token counts when the provider reports them. Numbers only — no content.
    usage: {
      promptTokens: { type: Number },
      completionTokens: { type: Number },
      totalTokens: { type: Number },
    },

    // --- outcome -----------------------------------------------------------
    // Machine-readable reason for a non-send, e.g. 'opted_out', 'takeover',
    // 'low_confidence', 'reply_limit', 'escalation_keyword', 'outside_window'.
    // Drives both the UI and the logs, so it is a short stable token.
    reason: { type: String, default: '' },
    escalated: { type: Boolean, default: false },
    // The SMSMessage created when an auto-mode reply was actually sent.
    sentMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'SMSMessage' },
    // Who approved a draft, when a human sends one later.
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    // Phase 8.1: the text a human actually approved, stored separately so
    // `draftReply` always remains the UNEDITED model output. Overwriting the
    // draft with the edit would destroy the only record of what the AI proposed,
    // which is exactly what an audit of an AI system needs to show. Empty when
    // the draft was approved unchanged.
    approvedBody: { type: String, default: '' },
    // True when approvedBody differs from the generated draft. Derivable, but
    // stored because the UI and the logs both read it and a stored flag cannot
    // drift from the comparison rule.
    edited: { type: Boolean, default: false },
    // Phase 8.1: who discarded a draft, and when. The counterpart of
    // approvedBy/approvedAt — a rejection is a decision worth attributing.
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: { type: Date },

    // --- scheduling / retry ------------------------------------------------
    attempts: { type: Number, default: 0 },
    // Safe, already-sanitised error text. Never a provider key, never a body.
    lastError: { type: String, default: '' },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    // Short processing lease. A worker claims a job by pushing this into the
    // future; the epoch default means "not claimed". Legacy-safe: the claim
    // query matches a MISSING value too (see claimJob in jobs/aiWorker.js).
    lockedUntil: { type: Date, default: new Date(0) },
    processedAt: { type: Date },
  },
  { timestamps: true }
);

// The worker's due-work query: pending jobs whose backoff has elapsed.
aiReplyJobSchema.index({ status: 1, nextAttemptAt: 1 });
// Newest-first listing for a conversation's AI history.
aiReplyJobSchema.index({ conversation: 1, createdAt: -1 });
// Phase 10: every AI analytics aggregation starts by selecting the jobs created
// within the chosen range. Without this that match is a collection scan, which
// grows with history; with it, it is a bounded range scan. The draft queue's
// newest-first listing uses it too.
aiReplyJobSchema.index({ createdAt: -1 });

aiReplyJobSchema.statics.STATUSES = STATUSES;
aiReplyJobSchema.statics.TERMINAL_STATUSES = TERMINAL_STATUSES;

aiReplyJobSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('AIReplyJob', aiReplyJobSchema);
