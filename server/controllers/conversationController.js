// Conversation / shared-inbox logic. Reuses the Phase 4 Twilio service for all
// outbound sending (no second Twilio implementation here).
const Conversation = require('../models/Conversation');
const Contact = require('../models/Contact');
const User = require('../models/User');
const SMSMessage = require('../models/SMSMessage');
const Settings = require('../models/Settings');
const Template = require('../models/Template');
const twilioService = require('../services/twilioService');
const { checkCanSend, checkMobileOnly } = require('../services/sendPolicy');
const { renderForContact } = require('../utils/mergeFields');
const { classifyInboundKeyword, handleCarrierOptOut } = require('../utils/optOut');
const { logEvent } = require('../services/logService');
// Fix 2: a manual reply stands the assistant down for that thread. The AI logic
// lives in the AI service; this controller only says when it happened.
const aiService = require('../services/ai/aiService');

const MAX_LIMIT = 100;
const PREVIEW_LEN = 140;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Soft-deleted threads and messages are invisible to every normal query.
// { deletedAt: null } also matches documents written before the field existed,
// so nothing historical is hidden by accident.
const NOT_DELETED = { deletedAt: null };

// Twilio's two terminal failure states — the same set the status callback
// treats as failures (webhookController FAILURE_STATUSES). Terminal states never
// overwrite one another, so a message that was delivered can never also carry
// one of these.
const UNDELIVERED_STATUSES = ['undelivered', 'failed'];

// Contacts that have at least one visible outbound message that failed. One
// distinct() over the { status, contact } index — failed messages are a small
// slice of the log — rather than a per-conversation lookup.
async function contactsWithUndelivered() {
  return SMSMessage.distinct('contact', {
    direction: 'outbound',
    status: { $in: UNDELIVERED_STATUSES },
    ...NOT_DELETED,
  });
}

// Contacts whose consent is currently withdrawn — the authoritative
// Contact.optedOut flag (keyword STOP, operator toggle or carrier 21610), never
// a guess from message text. A contact who later sent START is opted back in
// and is not listed; their STOP message stays in the thread history regardless.
async function contactsOptedOut() {
  return Contact.distinct('_id', { optedOut: true });
}

// Build the conversation list filter from the query string (Phase 4).
async function buildConversationFilter(req) {
  const filter = { ...NOT_DELETED };

  if (req.query.status === 'open' || req.query.status === 'closed') {
    filter.status = req.query.status;
  }
  // Threads with at least one unread inbound message.
  if (req.query.unread === 'true') {
    filter.unreadCount = { $gt: 0 };
  }
  // "Needs reply" = the last thing that happened was them messaging us.
  if (req.query.needsReply === 'true') {
    filter.lastMessageDirection = 'inbound';
  }
  // assigned=me | none | <userId>
  if (req.query.assigned) {
    const a = String(req.query.assigned);
    if (a === 'me') filter.assignedTo = req.user ? req.user._id : null;
    else if (a === 'none') filter.assignedTo = null;
    else filter.assignedTo = a;
  }
  // delivery=undelivered | optedOut=true narrow by contact. Both may be given;
  // the thread must then satisfy both.
  const contactSets = [];
  if (req.query.delivery === 'undelivered') contactSets.push(await contactsWithUndelivered());
  if (req.query.optedOut === 'true') contactSets.push(await contactsOptedOut());
  if (contactSets.length) {
    let ids = contactSets[0];
    for (const other of contactSets.slice(1)) {
      const keep = new Set(other.map(String));
      ids = ids.filter((id) => keep.has(String(id)));
    }
    filter.contact = { $in: ids };
  }
  // Search the denormalized contact name/phone. Regex (not $text) so partial
  // phone numbers match; the input is escaped so it cannot inject a pattern.
  if (req.query.search && String(req.query.search).trim()) {
    const re = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
    filter.$or = [{ contactName: re }, { contactPhone: re }];
  }

  return filter;
}

// GET /api/conversations
// Filters: status, unread, needsReply, assigned, delivery, optedOut, search;
// paginated.
async function listConversations(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;

    const filter = await buildConversationFilter(req);

    const [items, total] = await Promise.all([
      Conversation.find(filter)
        // Most recent activity first. _id breaks ties, so threads sharing a
        // lastMessageAt (bulk sends) have one fixed order and paging can never
        // show one twice or skip one.
        .sort({ lastMessageAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate('contact', 'name phone optedOut deliveryBlocked')
        .populate('assignedTo', 'name email'),
      Conversation.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 0 },
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/conversations/unread-count
// Number of CONVERSATIONS with unread inbound messages — the nav badge counts
// threads, not individual messages.
async function getUnreadCount(req, res, next) {
  try {
    const count = await Conversation.countDocuments({ ...NOT_DELETED, unreadCount: { $gt: 0 } });
    return res.json({ success: true, count });
  } catch (err) {
    return next(err);
  }
}

// GET /api/conversations/changes?since=<ISO date>
// Cheap polling: just the threads touched since `since`, served from the
// updatedAt index. Never returns message bodies.
async function getChanges(req, res, next) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_LIMIT);
    const since = req.query.since ? new Date(req.query.since) : null;
    if (req.query.since && Number.isNaN(since.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid "since" timestamp' });
    }

    const filter = { ...NOT_DELETED };
    if (since) filter.updatedAt = { $gt: since };

    // Taken BEFORE the query. A thread updated while the query runs then has
    // updatedAt > now and is picked up by the next poll; taking it afterwards
    // let such an update fall between two polls and never be reported.
    const now = new Date();

    const items = await Conversation.find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .populate('contact', 'name phone optedOut deliveryBlocked')
      .populate('assignedTo', 'name email');

    const unreadConversations = await Conversation.countDocuments({
      ...NOT_DELETED,
      unreadCount: { $gt: 0 },
    });

    // Threads deleted since `since` are not in `data` (they are hidden), but an
    // open Inbox still has to drop them — so say how many there were. Bounded by
    // the same updatedAt index; deleting a thread bumps its updatedAt.
    const removed = since
      ? await Conversation.countDocuments({ updatedAt: { $gt: since }, deletedAt: { $ne: null } })
      : 0;

    return res.json({
      success: true,
      data: items,
      removed,
      unreadConversations,
      // Echoed back so the client can use the server's clock for the next poll.
      now,
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/conversations/:id
async function getConversation(req, res, next) {
  try {
    const convo = await Conversation.findOne({ _id: req.params.id, ...NOT_DELETED })
      // Opt-out (Phase 1), delivery-block (Phase 3), line type and tags are
      // included so the inbox side panel can show the contact's real state.
      .populate(
        'contact',
        'name phone email tags optedOut optedOutAt optOutSource deliveryBlocked deliveryBlockedAt deliveryFailureCount lastDeliveryStatus lastDeliveryErrorCode lookup timezone'
      )
      .populate('assignedTo', 'name email');
    if (!convo) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }
    return res.json({ success: true, data: convo });
  } catch (err) {
    return next(err);
  }
}

// GET /api/conversations/:id/messages?limit=&before=<ISO date>
// Returns the NEWEST page of a thread (Phase 4) — a long history must open at
// the bottom, not at a message from last year. The page is fetched newest-first
// and then reversed, so the caller receives it in chronological order.
// "Load older" passes `before` = the createdAt of the oldest message it holds.
//
// History is contact-based so it includes every SMS for the contact (inbound,
// inbox replies, manual sends, and automation sends). Soft-deleted messages are
// excluded; legacy records without the field are not.
async function getMessages(req, res, next) {
  try {
    const convo = await Conversation.findOne({ _id: req.params.id, ...NOT_DELETED });
    if (!convo) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_LIMIT);

    const filter = { contact: convo.contact, ...NOT_DELETED };
    if (req.query.before) {
      const before = new Date(req.query.before);
      if (Number.isNaN(before.getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid "before" timestamp' });
      }
      if (req.query.beforeId !== undefined) {
        // Cursor = (createdAt, _id) of the oldest message held. Messages that
        // share the boundary's timestamp (one bulk send) are split by _id, so
        // none is skipped and none is returned twice.
        if (!OBJECT_ID_RE.test(String(req.query.beforeId))) {
          return res.status(400).json({ success: false, message: 'Invalid "beforeId"' });
        }
        filter.$or = [
          { createdAt: { $lt: before } },
          { createdAt: before, _id: { $lt: String(req.query.beforeId) } },
        ];
      } else {
        // Legacy timestamp-only cursor: strictly older.
        filter.createdAt = { $lt: before };
      }
    }

    // Fetch one extra row to tell the client whether more history exists.
    // Same (createdAt, _id) order as the cursor.
    const [found, total] = await Promise.all([
      SMSMessage.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1),
      SMSMessage.countDocuments({ contact: convo.contact, ...NOT_DELETED }),
    ]);

    const hasMore = found.length > limit;
    const page = hasMore ? found.slice(0, limit) : found;
    // Reverse so the page reads oldest -> newest for display.
    page.reverse();

    return res.json({
      success: true,
      data: page,
      // hasMore means "older messages exist before this page".
      hasMore,
      oldest: page.length ? page[0].createdAt : null,
      // Send both back as before/beforeId to load the next older page.
      oldestId: page.length ? page[0]._id : null,
      newest: page.length ? page[page.length - 1].createdAt : null,
      pagination: { limit, total, returned: page.length },
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/conversations/:id/reply   { body?, templateId? }
// Sends an operator reply through the existing Twilio service.
//
// Phase 4: when `templateId` is supplied the body is taken from the template
// and its merge fields are rendered HERE, against the real contact. Whatever
// the client previewed is never trusted — the server decides what is sent.
async function reply(req, res, next) {
  try {
    const { body, templateId } = req.body || {};
    const hasTemplate = templateId !== undefined && templateId !== null && String(templateId).trim() !== '';
    if (!hasTemplate && (!body || String(body).trim() === '')) {
      return res
        .status(400)
        .json({ success: false, message: 'Provide a message body or a templateId' });
    }

    const convo = await Conversation.findOne({ _id: req.params.id, ...NOT_DELETED });
    if (!convo) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    const contact = await Contact.findById(convo.contact);
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact for this conversation not found' });
    }
    if (!contact.phone) {
      return res.status(400).json({ success: false, message: 'Contact has no phone number' });
    }

    // Resolve the text to send. A template always wins over a client-supplied
    // body, and merge fields are rendered server-side with the real contact.
    let finalBody = String(body || '').trim();
    let templateRef;
    if (hasTemplate) {
      let template;
      try {
        template = await Template.findById(templateId);
      } catch (e) {
        return res.status(400).json({ success: false, message: 'Selected template not found' });
      }
      if (!template) {
        return res.status(400).json({ success: false, message: 'Selected template not found' });
      }
      const { rendered } = renderForContact(template.body, contact);
      finalBody = String(rendered || '').trim();
      templateRef = template._id;
      if (!finalBody) {
        return res
          .status(400)
          .json({ success: false, message: 'The template rendered an empty message' });
      }
    } else {
      // A typed reply goes through the same resolver, so a merge field typed by
      // hand is filled in for this contact rather than sent as literal text.
      // A reply with no merge fields is sent exactly as typed.
      finalBody = String(renderForContact(finalBody, contact).rendered || '').trim();
      if (!finalBody) {
        return res.status(400).json({
          success: false,
          message: 'The message is empty once its merge fields are filled in',
        });
      }
    }

    const settings = await Settings.getSingleton();
    if (!settings.smsEnabled) {
      return res.status(400).json({ success: false, message: 'SMS sending is disabled in settings' });
    }

    // Phase 1: an operator reply is still a send — opted-out and inactive
    // contacts are blocked here exactly as they are everywhere else.
    const eligibility = await checkCanSend({ contact, phone: contact.phone });
    if (!eligibility.allowed) {
      await logEvent({
        eventType: 'sms.blocked_optout',
        severity: 'warning',
        message: eligibility.reason,
        status: 'blocked',
        contact: contact._id,
        conversation: convo._id,
        meta: { to: contact.phone, code: eligibility.code, path: 'reply' },
      });
      return res.status(403).json({ success: false, message: eligibility.reason });
    }

    // Phase 10: the admin's line-type policy applies to an operator reply too —
    // it is still an outbound message, and every other send path enforces it.
    //
    // ONE exception: a contact who has messaged us (lastInboundAt) has
    // demonstrably received SMS on that number, so a Lookup classification must
    // never stop an operator answering them — and checking it would also spend a
    // billable Lookup call to learn something the inbound message already proved.
    // Consent is checked above and is never bypassed by this exemption.
    if (!contact.lastInboundAt) {
      const policy = await checkMobileOnly({ contact, phone: contact.phone });
      if (!policy.allowed) {
        await logEvent({
          eventType: 'sms.blocked',
          severity: policy.temporary ? 'error' : 'warning',
          message: policy.reason,
          status: 'blocked',
          contact: contact._id,
          conversation: convo._id,
          meta: {
            to: contact.phone,
            temporary: !!policy.temporary,
            type: policy.type || '',
            path: 'reply',
          },
        });
        return res
          .status(policy.temporary ? 503 : 422)
          .json({ success: false, message: policy.reason });
      }
    }

    const from = settings.defaultFrom || undefined;

    try {
      const result = await twilioService.sendSms({ to: contact.phone, body: finalBody, from });

      const record = await SMSMessage.create({
        direction: 'outbound',
        to: contact.phone,
        from: result.from || '',
        body: finalBody,
        twilioSid: result.sid,
        status: result.status,
        contact: contact._id,
        conversation: convo._id,
        source: 'reply',
      });

      // Update thread activity (outbound does not create unread state).
      convo.lastMessageAt = new Date();
      convo.lastMessagePreview = finalBody.slice(0, PREVIEW_LEN);
      convo.lastMessageDirection = 'outbound';
      await convo.save();

      // Fix 2: a human has answered this thread, so the assistant stands down —
      // queued and drafted AI replies for it are cancelled, and (unless the
      // setting is off) the thread is handed to this operator.
      //
      // Deliberately AFTER the send and the save: a reply that failed must not
      // cancel the assistant's work or take a thread over. The helper swallows
      // its own errors, so it cannot turn a delivered message into a 5xx.
      await aiService.standDownForManualReply({
        conversation: convo,
        contact,
        user: req.user,
        settings,
      });

      await logEvent({
        eventType: 'reply.sent',
        severity: 'info',
        message: `Inbox reply ${result.simulated ? '(simulated) ' : ''}to ${contact.phone}`,
        status: result.status,
        contact: contact._id,
        conversation: convo._id,
        twilioSid: result.sid,
        meta: {
          simulated: !!result.simulated,
          templateId: templateRef ? String(templateRef) : undefined,
        },
      });

      return res.status(201).json({ success: true, message: record, result });
    } catch (sendErr) {
      await SMSMessage.create({
        direction: 'outbound',
        to: contact.phone,
        from: from || '',
        body: finalBody,
        status: 'failed',
        contact: contact._id,
        conversation: convo._id,
        source: 'reply',
        error: sendErr.message || 'send failed',
      });
      await logEvent({
        eventType: 'reply.failed',
        severity: 'error',
        message: `Inbox reply to ${contact.phone} failed`,
        status: 'failed',
        contact: contact._id,
        conversation: convo._id,
        error: sendErr.message || 'send failed',
      });
      // Twilio 21610: the carrier reports this recipient unsubscribed. Record
      // the opt-out so an operator reply cannot leave withdrawn consent
      // unrecorded (the automation worker has always done this).
      await handleCarrierOptOut(contact, sendErr, { path: 'reply', conversation: convo._id });
      return res
        .status(sendErr.statusCode || 502)
        .json({ success: false, message: sendErr.message || 'Failed to send SMS' });
    }
  } catch (err) {
    return next(err);
  }
}

// PATCH /api/conversations/:id   { status?, assignedTo? }
async function updateConversation(req, res, next) {
  try {
    const convo = await Conversation.findOne({ _id: req.params.id, ...NOT_DELETED });
    if (!convo) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    const { status, assignedTo } = req.body || {};

    if (status !== undefined) {
      if (!['open', 'closed'].includes(status)) {
        return res.status(400).json({ success: false, message: 'status must be open or closed' });
      }
      convo.status = status;
    }

    if (assignedTo !== undefined) {
      if (assignedTo === null || assignedTo === '') {
        convo.assignedTo = null;
      } else {
        const user = await User.findById(assignedTo);
        if (!user) {
          return res.status(400).json({ success: false, message: 'Assigned user not found' });
        }
        convo.assignedTo = user._id;
      }
    }

    await convo.save();
    const populated = await convo.populate([
      { path: 'contact', select: 'name phone' },
      { path: 'assignedTo', select: 'name email' },
    ]);
    return res.json({ success: true, data: populated });
  } catch (err) {
    return next(err);
  }
}

// POST /api/conversations/:id/read  — mark the thread read (clear unread count).
async function markRead(req, res, next) {
  try {
    const convo = await Conversation.findOneAndUpdate(
      { _id: req.params.id, ...NOT_DELETED },
      { $set: { unreadCount: 0 } },
      { new: true }
    );
    if (!convo) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }
    return res.json({ success: true, data: convo });
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/conversations/messages/:messageId   (admin)
// Soft delete: the document stays in the database, it is simply hidden.
//
// Compliance guard: an INBOUND STOP/START message is the record proving when a
// contact withdrew or restored consent. It can never be deleted — this is the
// FDGSMS bug ("message delete removed STOP records") that must not be repeated.
async function deleteMessage(req, res, next) {
  try {
    const message = await SMSMessage.findById(req.params.messageId);
    if (!message) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }
    if (message.deletedAt) {
      return res.status(400).json({ success: false, message: 'Message is already deleted' });
    }

    if (message.direction === 'inbound') {
      const keyword = classifyInboundKeyword(message.body);
      if (keyword === 'stop' || keyword === 'start') {
        return res.status(403).json({
          success: false,
          message:
            'This message records an opt-out or opt-in and must be kept as a compliance record. It cannot be deleted.',
        });
      }
    }

    message.deletedAt = new Date();
    message.deletedBy = req.user ? req.user._id : undefined;
    await message.save();

    // If this was the thread's most recent message, its text is still sitting
    // in the inbox preview — recompute from the newest surviving message so a
    // deleted message really does disappear from the UI.
    if (message.contact) {
      const convo = await Conversation.findOne({ contact: message.contact });
      if (convo && convo.lastMessagePreview === String(message.body || '').slice(0, PREVIEW_LEN)) {
        const latest = await SMSMessage.findOne({ contact: message.contact, ...NOT_DELETED })
          .sort({ createdAt: -1 })
          .select('body direction createdAt');
        convo.lastMessagePreview = latest ? String(latest.body || '').slice(0, PREVIEW_LEN) : '';
        convo.lastMessageDirection = latest ? latest.direction : '';
        await convo.save();
      }
    }

    const operator = req.user ? req.user.name || req.user.email : 'unknown operator';
    await logEvent({
      eventType: 'message.deleted',
      severity: 'warning',
      message: `${operator} deleted a ${message.direction} message`,
      status: 'deleted',
      contact: message.contact,
      conversation: message.conversation,
      twilioSid: message.twilioSid,
      meta: { by: operator, byUserId: req.user ? String(req.user._id) : undefined, messageId: String(message._id) },
    });

    return res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/conversations/:id   (admin)
// Soft-deletes the THREAD only. Every SMSMessage — including the STOP/START
// compliance trail — is deliberately left untouched, so nothing auditable is
// lost and restoring the thread would restore the full history.
async function deleteConversation(req, res, next) {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (!convo) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }
    if (convo.deletedAt) {
      return res.status(400).json({ success: false, message: 'Conversation is already deleted' });
    }

    convo.deletedAt = new Date();
    convo.deletedBy = req.user ? req.user._id : undefined;
    await convo.save();

    const operator = req.user ? req.user.name || req.user.email : 'unknown operator';
    await logEvent({
      eventType: 'conversation.deleted',
      severity: 'warning',
      message: `${operator} deleted the conversation with ${convo.contactPhone || 'a contact'}`,
      status: 'deleted',
      contact: convo.contact,
      conversation: convo._id,
      meta: {
        by: operator,
        byUserId: req.user ? String(req.user._id) : undefined,
        messagesPreserved: true,
      },
    });

    return res.json({
      success: true,
      message: 'Conversation deleted. Its message history was preserved.',
    });
  } catch (err) {
    return next(err);
  }
}

// --- bulk delete ------------------------------------------------------------
// Both bulk actions use EXACTLY the single delete's semantics above: the thread
// is soft-deleted (deletedAt/deletedBy) and disappears from the inbox, while
// every SMSMessage — including the STOP/START compliance trail — is left in
// place. Contacts, campaigns, enrollments and follow-ups are never touched.

const BULK_DELETE_MAX = 500;

function deletedBy(req) {
  return req.user ? req.user._id : undefined;
}

// POST /api/conversations/bulk-delete   (admin)   body: { ids: [...] }
// Idempotent: an id that is already deleted or does not exist is reported as
// skipped, not as an error, so a repeated request is harmless.
async function bulkDeleteConversations(req, res, next) {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: 'ids must be a non-empty array of conversation ids' });
    }
    if (ids.length > BULK_DELETE_MAX) {
      return res.status(400).json({
        success: false,
        message: `At most ${BULK_DELETE_MAX} conversations can be deleted at once. Use Delete All for everything.`,
      });
    }
    // Validate everything BEFORE writing anything: a bad id fails the whole
    // request rather than half-applying it.
    if (ids.some((id) => typeof id !== 'string' || !OBJECT_ID_RE.test(id))) {
      return res
        .status(400)
        .json({ success: false, message: 'Every id must be a valid conversation id' });
    }
    const unique = [...new Set(ids)];

    const operator = req.user ? req.user.name || req.user.email : 'unknown operator';
    const now = new Date();
    const deletedIds = [];
    for (const id of unique) {
      // Conditional per thread: of two simultaneous requests for the same id
      // exactly one matches, so each thread is deleted — and logged — once.
      const convo = await Conversation.findOneAndUpdate(
        { _id: id, ...NOT_DELETED },
        { $set: { deletedAt: now, deletedBy: deletedBy(req) } },
        { new: true }
      );
      if (!convo) continue;
      deletedIds.push(String(convo._id));
      // The same audit event the single delete writes, marked as bulk.
      await logEvent({
        eventType: 'conversation.deleted',
        severity: 'warning',
        message: `${operator} deleted the conversation with ${convo.contactPhone || 'a contact'}`,
        status: 'deleted',
        contact: convo.contact,
        conversation: convo._id,
        meta: {
          by: operator,
          byUserId: req.user ? String(req.user._id) : undefined,
          messagesPreserved: true,
          bulk: true,
        },
      });
    }

    const unreadConversations = await Conversation.countDocuments({
      ...NOT_DELETED,
      unreadCount: { $gt: 0 },
    });
    return res.json({
      success: true,
      deleted: deletedIds.length,
      skipped: unique.length - deletedIds.length,
      deletedIds,
      unreadConversations,
      message: `${deletedIds.length} conversation${deletedIds.length === 1 ? '' : 's'} deleted.`,
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/conversations/delete-all   (admin)   body: { confirm: 'DELETE_ALL' }
// One server-side update — the client never has to fetch every id. The explicit
// confirm token means a stray or replayed request cannot empty the inbox.
async function deleteAllConversations(req, res, next) {
  try {
    if (!req.body || req.body.confirm !== 'DELETE_ALL') {
      return res.status(400).json({
        success: false,
        message: 'Deleting every conversation requires { "confirm": "DELETE_ALL" }',
      });
    }

    const result = await Conversation.updateMany(
      { ...NOT_DELETED },
      { $set: { deletedAt: new Date(), deletedBy: deletedBy(req) } }
    );
    const deleted = (result && (result.modifiedCount ?? result.nModified)) || 0;

    // One summary event rather than one per thread: Delete All can cover
    // thousands of threads, and the event records exactly how many and by whom.
    const operator = req.user ? req.user.name || req.user.email : 'unknown operator';
    await logEvent({
      eventType: 'conversation.deleted_all',
      severity: 'warning',
      message: `${operator} deleted all ${deleted} inbox conversation${deleted === 1 ? '' : 's'}`,
      status: 'deleted',
      meta: {
        by: operator,
        byUserId: req.user ? String(req.user._id) : undefined,
        count: deleted,
        messagesPreserved: true,
      },
    });

    return res.json({
      success: true,
      deleted,
      // Nothing visible remains, so nothing visible is unread.
      unreadConversations: 0,
      message: `${deleted} conversation${deleted === 1 ? '' : 's'} deleted.`,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  bulkDeleteConversations,
  deleteAllConversations,
  listConversations,
  getConversation,
  getMessages,
  reply,
  updateConversation,
  markRead,
  getUnreadCount,
  getChanges,
  deleteMessage,
  deleteConversation,
};
