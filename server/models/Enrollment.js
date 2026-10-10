// Enrollment model. Tracks one contact's progress through one campaign's steps.
// The automation worker advances enrollments; this schema stores the state it
// needs (which step is next, when it's due, retry attempts, and an audit of
// which steps have already been sent — the key guard against duplicate sends).
const mongoose = require('mongoose');

// Audit record of a step that has actually been sent (used for idempotency).
//
// Phase 5: `stepId` is the real identity. `stepIndex` is kept because rows
// written before Phase 5 have only that, and because it is useful in the UI —
// but it is a POSITION, and positions move when a campaign is edited. Any
// "have we already sent this?" check must prefer stepId and fall back to
// stepIndex only for legacy rows that carry no stepId.
const sentStepSchema = new mongoose.Schema(
  {
    stepId: { type: mongoose.Schema.Types.ObjectId },
    stepIndex: { type: Number, required: true },
    twilioSid: { type: String, default: '' },
    status: { type: String, default: '' },
    sentAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const enrollmentSchema = new mongoose.Schema(
  {
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      required: true,
    },
    campaign: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      required: true,
    },
    // 'replied' (Phase 1) means the contact answered, so the remaining steps are
    // deliberately never sent. It is a terminal state, like completed/failed.
    status: {
      type: String,
      enum: ['active', 'paused', 'completed', 'failed', 'cancelled', 'replied'],
      default: 'active',
    },
    // Set when the contact's reply stopped this enrollment.
    repliedAt: { type: Date },
    // Why automation stopped early, e.g. 'replied' or 'opted_out'.
    stopReason: { type: String, default: '' },
    // Phase 5: the STABLE id of the next step to send. This is the authoritative
    // pointer. Campaign steps carry their own _id, so an enrollment keeps
    // waiting on the same message even if the campaign's steps are reordered or
    // another step is deleted around it.
    //
    // Null/absent means "legacy enrollment" (created before Phase 5) — the
    // worker then falls back to currentStepIndex, so existing rows keep running
    // exactly as they did. No migration is required.
    currentStepId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    // Index of the NEXT step to send (0-based). Advances only after a step is
    // successfully sent.
    //
    // Phase 5: kept for backwards compatibility and for display ("Step 2 of 4").
    // It is NOT the source of truth any more — currentStepId is. An index can
    // silently come to mean a different message after a campaign edit, which is
    // exactly the bug stable ids exist to prevent.
    currentStepIndex: {
      type: Number,
      default: 0,
    },
    // When the current step becomes due.
    nextRunAt: {
      type: Date,
      default: Date.now,
    },
    lastStepSentAt: { type: Date },
    // Retry attempts for the CURRENT step; reset to 0 after a successful send.
    attempts: {
      type: Number,
      default: 0,
    },
    lastError: { type: String, default: '' },
    // Steps already sent — prevents re-sending the same step on a retry/rerun.
    sentSteps: {
      type: [sentStepSchema],
      default: [],
    },
    // Optional per-enrollment IANA timezone override for the sending window.
    timezone: { type: String, default: '' },
    // Phase 2: short-lived processing lease. The worker claims a row by moving
    // this into the future, so two instances (or a tick overlapping a manual
    // run) can never process the same enrollment. Defaults to the epoch, i.e.
    // "not locked". Legacy rows have no value at all, so claim queries must
    // match a MISSING field too — see claimEnrollment() in the worker.
    lockedUntil: { type: Date, default: new Date(0) },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// Fast lookup of due work for the worker.
enrollmentSchema.index({ status: 1, nextRunAt: 1 });
// Phase 5: per-campaign status breakdown for GET /api/campaigns/stats.
// The existing { contact, campaign } index cannot serve this — it leads with
// `contact`, and its partial filter covers only active rows.
enrollmentSchema.index({ campaign: 1, status: 1 });
// Prevent a second ACTIVE enrollment of the same contact in the same campaign
// (a duplicate-send guard). Re-enrollment after completion/cancellation is
// still allowed because the partial filter only covers active rows.
enrollmentSchema.index(
  { contact: 1, campaign: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);

enrollmentSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Enrollment', enrollmentSchema);
