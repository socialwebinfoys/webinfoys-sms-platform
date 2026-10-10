// Operational settings (singleton per platform account). Holds NON-secret
// configuration only — Twilio credentials live in environment variables, never
// here. Identified by a fixed `key` so there is a single settings document.
const mongoose = require('mongoose');

// Inbox auto-refresh choices, in seconds. 0 means off.
const INBOX_REFRESH_OPTIONS = [0, 5, 10, 15, 30, 60];

const settingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'twilio',
    },
    // Master switch for outbound SMS sending.
    smsEnabled: {
      type: Boolean,
      default: true,
    },
    // LEGACY (pre-Phase-7): the original boolean mobile-only switch.
    //
    // Phase 7 replaced it with `allowedLineTypes`, but the field is KEPT rather
    // than dropped so an existing settings document still reads correctly and a
    // rollback stays possible. It is now a compatibility input only:
    // resolveAllowedLineTypes() below derives the effective policy from
    // allowedLineTypes when that is set, and falls back to this boolean
    // otherwise. Nothing is rewritten in the database.
    mobileOnly: {
      type: Boolean,
      default: false,
    },
    // Phase 7: which Twilio Lookup line types may be messaged.
    //
    // Null/absent means "never configured" — the effective policy is then
    // derived from the legacy `mobileOnly` flag, so existing installations keep
    // behaving exactly as before until an admin saves this for the first time.
    // An EMPTY array is rejected by the API: it would silently block every send.
    allowedLineTypes: {
      type: [String],
      default: undefined,
    },
    // Phase 7: how long a cached Twilio Lookup result stays trustworthy. A
    // number can be ported between carriers/line types, so an old
    // classification is re-checked rather than trusted indefinitely.
    lookupMaxAgeDays: {
      type: Number,
      default: 30,
      min: [1, 'lookupMaxAgeDays must be at least 1'],
    },
    // Optional override for the "from" number (non-secret). If empty, the
    // TWILIO_PHONE_NUMBER environment value is used.
    defaultFrom: {
      type: String,
      trim: true,
      default: '',
    },
    // Sending window for the automation engine. Timezone is an IANA name.
    // Phase 2 defaults target US quiet-hour rules (TCPA allows 8am-9pm in the
    // recipient's local time); 9-20 America/New_York sits safely inside that.
    // NOTE: defaults only apply to NEW installations — an existing settings
    // document keeps whatever it was saved with.
    sendingWindow: {
      enabled: { type: Boolean, default: true },
      startHour: { type: Number, default: 9, min: 0, max: 23 },
      endHour: { type: Number, default: 20, min: 1, max: 24 },
      timezone: { type: String, default: 'America/New_York' },
    },
    // Phase 2: days of the week automation may send on, as JS day numbers
    // (0 = Sunday … 6 = Saturday), evaluated in the sending-window timezone.
    // Defaults to every day so existing behaviour is unchanged.
    sendDays: {
      type: [Number],
      default: [0, 1, 2, 3, 4, 5, 6],
    },
    // Phase 2: per-run send throttle. When set, this OVERRIDES the
    // AUTOMATION_MAX_SENDS_PER_RUN environment value; null means "use the env
    // value". Read with ?? (never ||) so a configured value is honoured exactly.
    maxSendsPerRun: {
      type: Number,
      default: null,
      min: [1, 'maxSendsPerRun must be at least 1'],
    },
    // Phase 3: how many TEMPORARY delivery failures in a row block a contact.
    // Permanent failure codes block on the first receipt regardless of this.
    deliveryFailureThreshold: {
      type: Number,
      default: 3,
      min: [1, 'deliveryFailureThreshold must be at least 1'],
    },
    // How often the Inbox checks for new messages, in seconds. 0 = auto-refresh
    // off (manual refresh only). A settings document saved before this field
    // existed simply reads the default.
    inboxRefreshSeconds: {
      type: Number,
      default: 10,
      validate: {
        validator: (v) => INBOX_REFRESH_OPTIONS.includes(v),
        message: 'inboxRefreshSeconds must be one of 0, 5, 10, 15, 30, 60',
      },
    },
    // Phase 8: AI reply configuration. Kept on this singleton rather than in a
    // new collection so there is one place an operator configures the platform.
    // Everything here is non-secret EXCEPT apiKeyEncrypted, which is ciphertext
    // and is additionally `select: false`.
    ai: {
      // THE MASTER SWITCH. False by default, and never flipped on implicitly —
      // configuring a provider does not enable AI.
      enabled: { type: Boolean, default: false },
      // What the system does with a generated reply:
      //   'draft' — store it for a human to review and send (default)
      //   'auto'  — may send automatically, if every guardrail passes
      defaultMode: { type: String, enum: ['draft', 'auto'], default: 'draft' },
      provider: { type: String, enum: ['gemini', 'groq', 'openai'], default: 'openai' },
      model: { type: String, default: '', trim: true },
      // AES-256-GCM ciphertext from utils/secretBox. `select: false` means it is
      // omitted from every query that does not ask for it by name, so it cannot
      // reach an API response by accident.
      apiKeyEncrypted: { type: String, default: '', select: false },
      // Who the assistant is and how it should behave.
      persona: { type: String, default: '', trim: true },
      businessRules: { type: String, default: '', trim: true },
      faq: { type: String, default: '', trim: true },
      // An inbound message containing any of these hands the thread to a human.
      // Matched case-insensitively as whole words.
      escalationKeywords: { type: [String], default: ['human', 'agent', 'complaint', 'lawyer'] },
      // Below this, a reply is never sent automatically; it is drafted instead.
      confidenceThreshold: { type: Number, default: 0.7, min: 0, max: 1 },
      // Hard stop on AI<->customer ping-pong, counted per conversation.
      maxRepliesPerConversation: { type: Number, default: 3, min: 0 },
      // How many recent messages are given to the model as context. Bounded so a
      // long thread cannot inflate a prompt without limit.
      contextMessageLimit: { type: Number, default: 10, min: 1, max: 50 },
      // Upper bound on generated reply length, in characters. A single SMS
      // segment is 160 GSM-7 characters; the default allows a couple of segments.
      maxReplyCharacters: { type: Number, default: 320, min: 20, max: 1600 },
      // Fix 2: when an operator answers a thread by hand, hand that thread to
      // them — the assistant stops working on it until they hand it back.
      //
      // Defaults to TRUE: a human having just replied is the clearest possible
      // signal that they are handling this conversation, and the failure it
      // prevents (the customer receiving two different answers) is worse than
      // the inconvenience it causes.
      //
      // NOTE this switch governs the TAKEOVER only. Queued and drafted AI work
      // for the thread is cancelled on a manual reply either way — that is not
      // configurable, because it is the double-reply bug itself.
      autoTakeoverOnManualReply: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

settingsSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

// Phase 7: every line type Twilio Lookup v2 can report, as the API spells them.
// `unknown` covers a number Lookup could not classify.
const LINE_TYPES = ['mobile', 'landline', 'fixedVoip', 'nonFixedVoip', 'tollFree', 'unknown'];

// The effective sending policy, resolved WITHOUT writing anything.
//
// This is the compatibility layer that lets Phase 7 ship without a migration:
//   * allowedLineTypes configured -> use it
//   * otherwise mobileOnly === true  -> ['mobile']   (the old meaning)
//   * otherwise                      -> every type   (the old "filter off")
//
// Returning a fresh array each call keeps callers from mutating settings state.
function resolveAllowedLineTypes(settings) {
  if (Array.isArray(settings.allowedLineTypes) && settings.allowedLineTypes.length > 0) {
    return [...settings.allowedLineTypes];
  }
  return settings.mobileOnly ? ['mobile'] : [...LINE_TYPES];
}

settingsSchema.statics.LINE_TYPES = LINE_TYPES;
settingsSchema.statics.resolveAllowedLineTypes = resolveAllowedLineTypes;
settingsSchema.statics.INBOX_REFRESH_OPTIONS = INBOX_REFRESH_OPTIONS;

// Fetch the singleton settings doc, creating it with defaults if absent.
settingsSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne({ key: 'twilio' });
  if (!doc) doc = await this.create({ key: 'twilio' });
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
