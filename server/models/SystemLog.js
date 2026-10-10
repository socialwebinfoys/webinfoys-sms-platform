// System event log (Phase 8). A flat, append-only record of meaningful platform
// events (sends, failures, automation runs, blocks, inbound webhooks). Stores
// non-secret metadata only — never credentials, passwords, or full message
// bodies.
const mongoose = require('mongoose');

const systemLogSchema = new mongoose.Schema(
  {
    // Dotted event name, e.g. 'sms.sent', 'sms.failed', 'sms.blocked',
    // 'automation.run', 'automation.sent', 'automation.failed',
    // 'automation.blocked', 'reply.sent', 'reply.failed', 'webhook.inbound'.
    eventType: { type: String, required: true, index: true },
    severity: { type: String, enum: ['info', 'warning', 'error'], default: 'info', index: true },
    // Human-readable summary of what happened.
    message: { type: String, default: '' },
    // Optional outcome tag (e.g. sent/failed/blocked/retry/received).
    status: { type: String, default: '' },
    // Related entities (ids only — no PII/bodies).
    contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },
    enrollment: { type: mongoose.Schema.Types.ObjectId, ref: 'Enrollment' },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
    twilioSid: { type: String, default: '' },
    // Safe error text (already sanitized upstream — no secrets).
    error: { type: String, default: '' },
    // Small, non-secret extra data (counts, flags). Never store credentials.
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Logs are read newest-first and filtered by type/severity.
systemLogSchema.index({ createdAt: -1 });
// Phase 10: AI analytics and the AI activity table both ask the same question —
// "events of this family, within this date range, newest first". The single-field
// eventType index above can select the family but then has to sort the matches;
// this compound index answers both halves, and serves the ^-anchored eventPrefix
// regex as a range scan. One index, because one query shape needs it.
systemLogSchema.index({ eventType: 1, createdAt: -1 });

systemLogSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('SystemLog', systemLogSchema);
