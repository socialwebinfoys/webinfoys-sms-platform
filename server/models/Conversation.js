// Conversation model (Phase 6). Represents the SMS thread between the platform
// and a single contact. There is exactly one conversation per contact (reused
// across open/closed), which keeps inbound messages threaded and prevents
// duplicate threads. Message bodies live in SMSMessage; this model holds the
// thread state the shared inbox needs.
const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      required: true,
      unique: true, // one thread per contact (also the concurrency guard)
    },
    status: {
      type: String,
      enum: ['open', 'closed'],
      default: 'open',
    },
    // Assignment/ownership for display only — NOT an access boundary. The inbox
    // is shared across the whole team.
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Denormalized "latest activity" fields so the inbox list can render and
    // sort without loading every message.
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, default: '' },
    lastMessageDirection: { type: String, enum: ['inbound', 'outbound', ''], default: '' },
    // Count of inbound messages not yet read by an operator.
    unreadCount: { type: Number, default: 0 },
    // Phase 4: denormalized contact identity so the inbox can search and render
    // without a per-row lookup. Kept in sync when the contact is created or
    // edited. Conversations created before this existed simply have empty
    // values — they still list and open normally, they just will not match a
    // search until backfilled (scripts/backfillConversationContacts.js).
    contactName: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    // Phase 4: admin soft delete. The thread is hidden from the inbox, but
    // nothing is removed — every SMSMessage, including the STOP/START
    // compliance trail, stays exactly where it was.
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // --- Phase 8: AI reply state -------------------------------------------
    // Kept here rather than in a parallel collection because it is thread state,
    // exactly like unreadCount and assignedTo, and because every AI decision
    // needs it alongside the thread it is about.
    ai: {
      // HUMAN TAKEOVER. While true, AI generates nothing for this thread.
      // Inbound messages are still stored and the inbox works normally — this
      // only stands the assistant down.
      takeover: { type: Boolean, default: false },
      takeoverAt: { type: Date },
      takeoverBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      // Per-thread override of Settings.ai.defaultMode. '' means "inherit".
      mode: { type: String, enum: ['draft', 'auto', ''], default: '' },
      // Counts replies the AI actually produced for this thread, which is what
      // Settings.ai.maxRepliesPerConversation limits. Incremented when a reply
      // is sent or drafted, never when one is skipped or fails.
      replyCount: { type: Number, default: 0 },
      lastReplyAt: { type: Date },
      // Set when a thread is handed to a human by a rule rather than by a
      // person: a keyword hit, low confidence, or the reply limit.
      escalated: { type: Boolean, default: false },
      escalatedAt: { type: Date },
      escalationReason: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

// `contact` unique index is declared above (fast lookup by contact + dup guard).
// Inbox is sorted by most recent activity:
conversationSchema.index({ lastMessageAt: -1 });
// The list sorts { lastMessageAt: -1, _id: -1 } so ties have a fixed order for
// paging; this index serves that sort directly. Additive — nothing is dropped.
conversationSchema.index({ lastMessageAt: -1, _id: -1 });
// Filtered inbox (e.g. only open) still sorted by activity:
conversationSchema.index({ status: 1, lastMessageAt: -1 });
// Phase 4: cheap "what changed since X?" polling, served from an index rather
// than a collection scan.
conversationSchema.index({ updatedAt: -1 });
// Phase 4: text index over the denormalized contact fields, as specified by the
// plan. NOTE: the controller searches with an escaped regex instead, because
// operators type partial phone numbers ("415") and a text index only matches
// whole words. The index is kept for spec compliance and word-based search.
conversationSchema.index({ contactName: 'text', contactPhone: 'text' });

conversationSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

// Atomic find-or-create keyed on contact. Concurrent inbound webhooks for the
// same contact resolve to a single conversation (upsert + unique index).
// `contact` may be an id or a loaded Contact document; passing the document
// lets the denormalized name/phone be filled in at creation time (Phase 4).
conversationSchema.statics.findOrCreateForContact = async function findOrCreateForContact(
  contact
) {
  const contactId = contact && contact._id ? contact._id : contact;
  const onInsert = { contact: contactId, status: 'open' };
  if (contact && contact._id) {
    onInsert.contactName = contact.name || '';
    onInsert.contactPhone = contact.phone || '';
  }
  try {
    return await this.findOneAndUpdate(
      { contact: contactId },
      { $setOnInsert: onInsert },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    // Two concurrent upserts can race to insert; the unique index makes the
    // loser throw E11000. Re-read to return the single winning conversation.
    if (err && err.code === 11000) {
      return this.findOne({ contact: contactId });
    }
    throw err;
  }
};

module.exports = mongoose.model('Conversation', conversationSchema);
