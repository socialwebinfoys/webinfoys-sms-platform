// Contact model. A contact is a person the platform can message, identified by
// a normalized E.164 phone number.
const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      default: '',
    },
    // Stored in E.164 form (e.g. +14155552671). Unique across the platform so
    // the same person is never stored twice.
    phone: {
      type: String,
      required: [true, 'Phone is required'],
      unique: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      match: [/^$|^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    // Arbitrary per-contact data captured from imports or manual entry.
    customFields: {
      type: Map,
      of: String,
      default: {},
    },
    tags: {
      type: [String],
      default: [],
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Phase 1 (compliance): opt-out state. A contact who has opted out is never
    // messaged again by ANY send path until they opt back in. Legacy contacts
    // have no `optedOut` field at all, so queries use { $ne: true } rather than
    // { optedOut: false } to include them.
    optedOut: {
      type: Boolean,
      default: false,
      index: true,
    },
    optedOutAt: { type: Date },
    optedInAt: { type: Date },
    // Phase 6: where the consent on record came from (e.g. "web form",
    // "in-store"). Free text, mirroring optOutSource's role for the opposite
    // transition, and populated from an optional `opt_in_source` import column.
    // Evidence only — it is never consulted by any send guard, so a value here
    // can never override an opt-out.
    optInSource: { type: String, default: '', trim: true },
    // How the opt-out was recorded: an inbound STOP keyword, an operator
    // toggle, or a carrier-level unsubscribe reported by Twilio (error 21610).
    optOutSource: {
      type: String,
      enum: ['keyword', 'manual', 'carrier', ''],
      default: '',
    },
    // When this contact last messaged us. Used to stop drip automation as soon
    // as someone replies.
    lastInboundAt: { type: Date },
    // Phase 2: optional IANA timezone for this contact, so automation can send
    // inside their local hours. The worker resolves enrollment tz -> contact tz
    // -> the global sending-window tz. Empty means "use the global window".
    timezone: { type: String, default: '', trim: true },
    // Phase 3: delivery health, driven by Twilio status callbacks. A blocked
    // contact is refused by checkCanSend on every send path until an admin
    // clears it. Separate from `optedOut`: that is consent, this is
    // deliverability, and neither overrides the other.
    deliveryBlocked: { type: Boolean, default: false, index: true },
    deliveryBlockedAt: { type: Date },
    // Consecutive delivery failures. Reset to 0 by a successful delivery, so
    // this always means "failures in a row", never a lifetime total.
    deliveryFailureCount: { type: Number, default: 0 },
    lastDeliveryStatus: { type: String, default: '' },
    lastDeliveryErrorCode: { type: Number },
    // Phase 7: Twilio Lookup enrichment. Additive/optional — the canonical
    // number is stored here as enrichment and does NOT replace `phone`.
    lookup: {
      // 'unknown' (never looked up), 'valid', or 'invalid'.
      status: { type: String, enum: ['unknown', 'valid', 'invalid'], default: 'unknown' },
      // Line type: 'mobile' | 'landline' | 'voip' | other Twilio value | ''.
      type: { type: String, default: '' },
      carrier: { type: String, default: '' },
      // Canonical E.164 returned by Lookup (enrichment only).
      canonicalPhone: { type: String, default: '' },
      lookedUpAt: { type: Date },
      // Set only when a lookup ATTEMPT failed (Twilio unavailable, rate limit,
      // unparseable number). `status` is deliberately left as it was, so a
      // failure is reported as "unknown" and can never mark a number invalid.
      lastError: { type: String, default: '' },
      lastAttemptAt: { type: Date },
    },
    // The CSV/XLSX import batch that CREATED this contact (back-reference to
    // Import). Lets a Campaign scope its enrollable contacts to one import.
    // Absent for contacts created manually or before import tracking existed.
    import: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Import',
      index: true,
    },
    // The allocation batch (Import.allocation.batches[]._id) that took this
    // contact from its import's queue. Null = still in the remaining pool. Set
    // once, conditionally, so a contact is never allocated twice.
    importBatch: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    // Which operator created/imported this contact (audit only; contacts are
    // shared across the team).
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// Support recency-ordered listing.
contactSchema.index({ createdAt: -1 });
// Batch allocation: "the next N unallocated contacts of this import, in order".
contactSchema.index({ import: 1, importBatch: 1, _id: 1 });

contactSchema.methods.toJSON = function toJSON() {
  // flattenMaps converts the customFields Map into a plain object; without it a
  // Map serializes to {} in JSON responses.
  const obj = this.toObject({ flattenMaps: true });
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Contact', contactSchema);
