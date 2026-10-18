// Flat log of individual SMS messages (outbound sends and inbound webhooks).
//
// This is intentionally a simple audit record — NOT conversation threading or an
// inbox (those are a later phase). It exists so the outbound service can record
// what it sent and the inbound webhook has somewhere to store received replies.
const mongoose = require('mongoose');

const smsMessageSchema = new mongoose.Schema(
  {
    direction: {
      type: String,
      enum: ['outbound', 'inbound'],
      required: true,
    },
    to: {
      type: String,
      required: true,
      trim: true,
    },
    from: {
      type: String,
      trim: true,
      default: '',
    },
    body: {
      type: String,
      default: '',
    },
    // Twilio message SID, when available.
    twilioSid: {
      type: String,
      trim: true,
      default: '',
    },
    // e.g. queued/sent/simulated (outbound) or received (inbound) or failed.
    status: {
      type: String,
      trim: true,
      default: '',
    },
    // Populated when the counterpart phone matches a known contact (convenience
    // only — no threading logic).
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
    },
    // Phase 6: links the message to its conversation thread when one applies
    // (inbound webhooks and inbox replies). Optional/back-compatible.
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
    },
    // Error detail for failed outbound sends (never contains secrets).
    error: {
      type: String,
      default: '',
    },
    // Phase 2: what produced this message. Optional + back-compatible — messages
    // written before this existed simply have no source/links. These let later
    // phases attribute sends to a campaign without a second write path.
    // 'ai' marks a reply produced by the Phase 8 AI reply system and sent in auto
    // mode. (It was briefly removed in Phase 10 as a dead value, when the plan of
    // the day had no AI in it; Phase 8 of the v2 plan reinstated the feature, so
    // the value is now genuinely written — see services/ai/aiService.js.)
    source: {
      type: String,
      enum: ['manual', 'reply', 'campaign', 'following', 'ai', ''],
      default: '',
    },
    // Fix 3: the AI job that produced this message, when one did.
    //
    // THIS IS THE DUPLICATE-SEND GUARD. A crash can happen between Twilio
    // accepting a message and the AI job being marked sent, which leaves the job
    // looking unfinished when the work is actually done. Recovery asks this field
    // "was a message already sent for this job?" and that answer has to be exact:
    // a body comparison, a timestamp window or a conversation lookup would all
    // guess, and guessing wrong here sends a customer the same reply twice.
    //
    // Optional and unindexed on old rows by design — messages written before this
    // existed simply have no value, and recovery treats "no linked message" as
    // "nothing was sent", which is the safe reading for them.
    aiJob: { type: mongoose.Schema.Types.ObjectId, ref: 'AIReplyJob', index: true },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },
    enrollment: { type: mongoose.Schema.Types.ObjectId, ref: 'Enrollment' },
    following: { type: mongoose.Schema.Types.ObjectId, ref: 'Following' },
    // Which campaign step this was, when it came from one.
    stepIndex: { type: Number },
    // Phase 3: delivery receipts from Twilio's status callback. Historical
    // messages simply have none of these and keep whatever status they were
    // written with.
    // Twilio error code for an undelivered/failed message (e.g. 30005).
    errorCode: { type: Number },
    // When a 'delivered' receipt arrived.
    deliveredAt: { type: Date },
    // When any delivery receipt last changed this record.
    statusUpdatedAt: { type: Date },
    // Phase 4: admin soft delete. The document is never removed — it is simply
    // hidden from the inbox. Queries filter on { deletedAt: null }, which in
    // MongoDB also matches documents that predate the field, so historical
    // messages stay visible. Inbound STOP/START messages can never be deleted.
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

smsMessageSchema.index({ createdAt: -1 });
// Thread history for one contact, newest first (inbox + conversation views).
smsMessageSchema.index({ contact: 1, createdAt: -1 });
// Lookup by Twilio SID (delivery receipts in a later phase). Not unique:
// simulated sends and pre-existing rows can share an empty SID.
smsMessageSchema.index({ twilioSid: 1 });
// Bug #2: inbound idempotency. Twilio retries a webhook whenever it does not get
// a timely 2xx, so the same MessageSid can arrive more than once. This partial
// unique index is what makes "one inbound row per MessageSid" true even when two
// identical requests race — the upsert in webhookController relies on it.
//
// Scoped deliberately:
//   * direction 'inbound' only — OUTBOUND rows legitimately share SIDs with
//     nothing, and simulated sends reuse the empty string.
//   * twilioSid greater than '' — excludes the empty-SID rows that simulated and
//     pre-Phase-3 messages carry, which would otherwise all collide.
// Verified against the existing collection before it was added: no inbound
// MessageSid is duplicated, so it builds cleanly on current data.
smsMessageSchema.index(
  { twilioSid: 1 },
  {
    unique: true,
    partialFilterExpression: { direction: 'inbound', twilioSid: { $gt: '' } },
    name: 'inbound_twilioSid_unique',
  }
);
// Phase 5: per-campaign sent/delivered counts for GET /api/campaigns/stats.
// Leading with `campaign` is what makes the stats aggregation an index scan
// rather than a full collection scan.
smsMessageSchema.index({ campaign: 1, createdAt: -1 });
// Fix 2: "has anything been sent or received on this thread since <time>?" is
// asked twice per AI job and once per draft approval, so it is a hot path. The
// existing { contact, createdAt } index cannot serve it — the question is about
// the CONVERSATION, and a contact's messages are not all in one thread. Additive
// and backward-compatible; no existing index covers this key.
smsMessageSchema.index({ conversation: 1, createdAt: -1 });
// Inbox "Undelivered" filter: the contacts with a failed/undelivered message,
// via distinct('contact') over a status range — an index scan of just the
// failed rows instead of the whole message log. Additive and non-unique.
smsMessageSchema.index({ status: 1, contact: 1 });

smsMessageSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('SMSMessage', smsMessageSchema);
