// Following model. A "Following" is an automated follow-up: a single message
// sent to a selected set of contacts (from one CSV/import) after a configurable
// delay measured from the moment the automation is activated.
//
// It deliberately mirrors the pieces of the existing campaign/enrollment design
// instead of inventing a new scheduler: the shared cron worker advances it, the
// shared Twilio service sends it, and the shared merge-field engine renders it.
// Contacts are stored as REFERENCES only (never copied), and per-recipient send
// state lives in `recipients` for idempotency + retries (the same idea as an
// enrollment's `sentSteps`).
const mongoose = require('mongoose');

// Per-recipient send tracking (idempotency + retry state). References a Contact;
// never a copy of the contact's data.
const recipientSchema = new mongoose.Schema(
  {
    contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
    // 'skipped' (Phase 1): deliberately not sent — the contact opted out or
    // replied before this follow-up went out. Distinct from 'failed', which
    // means a send was attempted and did not succeed.
    status: { type: String, enum: ['pending', 'sent', 'failed', 'skipped'], default: 'pending' },
    twilioSid: { type: String, default: '' },
    sentAt: { type: Date },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    // The worker's expiring claim on this ONE recipient, taken before it sends
    // and released (set to the epoch) in the same write that saves the result.
    // A value in the future means a pass is working on the recipient right now;
    // a past value that is not the epoch means a pass was interrupted on it.
    // Absent on recipients created before this field existed — they are simply
    // unclaimed.
    lockedUntil: { type: Date },
  },
  { _id: false }
);

const followingSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Following name is required'],
      trim: true,
    },
    // The CSV/import whose contacts this follow-up targets. Required, and
    // validated to exist by the controller.
    import: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Import',
      required: true,
    },
    // Selected contacts (references only). Configuration/source-of-truth for the
    // selection; the runtime send list is `recipients`, built at activation.
    contactIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }],
    // Follow-up delay, measured from activation. Minutes or hours only.
    delayValue: { type: Number, default: 0, min: [0, 'Delay cannot be negative'] },
    delayUnit: { type: String, enum: ['minutes', 'hours'], default: 'hours' },
    // Message: a snapshot body (rendered with merge fields at send time) plus an
    // optional reference to the Template it came from (for display/editing). If
    // no template was used, `template` is unset and `body` is the custom message.
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'Template' },
    body: { type: String, default: '' },
    // Lifecycle. Draft records never send; the worker only processes 'active'.
    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'completed'],
      default: 'draft',
    },
    // Phase 2: when true (the default), a recipient who replies after this
    // follow-up was activated is skipped instead of messaged.
    stopOnReply: { type: Boolean, default: true },
    activatedAt: { type: Date },
    // When the follow-up becomes due (activatedAt + delay).
    nextRunAt: { type: Date },
    // Per-recipient send state (built at activation from contactIds).
    recipients: { type: [recipientSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Fast lookup of due work for the worker.
followingSchema.index({ status: 1, nextRunAt: 1 });
followingSchema.index({ createdAt: -1 });

followingSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Following', followingSchema);
