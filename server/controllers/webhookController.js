// Inbound Twilio webhook: receives incoming SMS/replies, records them, and
// threads them into the shared-inbox conversation for the sender.
// Signature is validated by upstream middleware (unchanged from Phase 4).
const Contact = require('../models/Contact');
const SMSMessage = require('../models/SMSMessage');
const Conversation = require('../models/Conversation');
const Enrollment = require('../models/Enrollment');
const Following = require('../models/Following');
const { logEvent } = require('../services/logService');
const deliveryPolicy = require('../services/deliveryPolicy');
const aiService = require('../services/ai/aiService');
const { normalizePhone } = require('../utils/phoneFormatter');
const {
  classifyInboundKeyword,
  applyOptOut,
  applyOptIn,
  stopAutomationOnReply,
  touchLastInboundAt,
} = require('../utils/optOut');

const PREVIEW_LEN = 140;

// POST /api/webhooks/twilio/inbound
// Twilio posts application/x-www-form-urlencoded fields: From, To, Body,
// MessageSid, etc.
async function inboundSms(req, res, next) {
  try {
    const { From, To, Body, MessageSid, SmsStatus } = req.body || {};

    // A conversation needs a contact. Reuse an existing contact for this number,
    // otherwise create a minimal one so the message still lands in the inbox.
    // Atomic upsert (with a duplicate-key fallback) so simultaneous inbound
    // messages from a brand-new number can't race to create duplicate contacts
    // or lose messages.
    //
    // The sender is matched on the NORMALIZED number — the form every contact is
    // stored in — so a reply always lands on the existing contact (and its one
    // conversation), whether or not that contact has a name. Only the phone is
    // ever written here, and only on insert: an existing contact's name and
    // other fields are never touched.
    let contact = null;
    const normalizedFrom = From ? normalizePhone(From) : null;
    const senderPhone = normalizedFrom && normalizedFrom.valid ? normalizedFrom.e164 : From;
    if (senderPhone) {
      try {
        contact = await Contact.findOneAndUpdate(
          { phone: senderPhone },
          { $setOnInsert: { phone: senderPhone } },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );
      } catch (err) {
        if (err && err.code === 11000) {
          contact = await Contact.findOne({ phone: senderPhone });
        } else {
          throw err;
        }
      }
    }

    let conversation = null;
    if (contact) {
      // Atomic find-or-create keyed on contact (concurrency-safe).
      // Pass the whole contact so the thread stores its name/phone for inbox
      // search (Phase 4) at the moment it is created.
      conversation = await Conversation.findOrCreateForContact(contact);
    }

    // Bug #2: idempotency. Twilio retries a webhook whenever it does not receive
    // a timely 2xx, so the same MessageSid can arrive twice — or twice at once.
    // Everything below this point is a BUSINESS EFFECT (unread counts, thread
    // state, opt-out transitions, log events) and must happen exactly once per
    // inbound message.
    //
    // The insert is the thing that decides. An upsert keyed on the SID either
    // inserts (first delivery) or matches (replay); the partial unique index on
    // SMSMessage makes that decision atomic, so of two simultaneous requests
    // exactly one can insert and the loser sees E11000.
    //
    // `timestamps: false` plus explicit dates keeps a replay a true no-op — it
    // must not even bump updatedAt on the existing row.
    const sid = String(MessageSid || '').trim();
    const now = new Date();
    const messageFields = {
      direction: 'inbound',
      to: To || '',
      from: From || '',
      body: Body || '',
      twilioSid: sid,
      status: SmsStatus || 'received',
      contact: contact ? contact._id : undefined,
      conversation: conversation ? conversation._id : undefined,
      createdAt: now,
      updatedAt: now,
    };

    let isDuplicate = false;
    if (sid) {
      try {
        const result = await SMSMessage.updateOne(
          { direction: 'inbound', twilioSid: sid },
          { $setOnInsert: messageFields },
          { upsert: true, timestamps: false }
        );
        // Inserted -> upsertedCount 1. Matched an existing row -> 0, i.e. replay.
        isDuplicate = !result.upsertedCount;
      } catch (err) {
        // Lost the insert race against a simultaneous identical request. The
        // winner is doing the work; this one is a replay.
        if (err && err.code === 11000) {
          isDuplicate = true;
        } else {
          throw err;
        }
      }
    } else {
      // No MessageSid to key on (not something Twilio does, but the endpoint
      // must not lose a message over it). Record it as before; it simply cannot
      // be de-duplicated.
      await SMSMessage.create(messageFields);
    }

    if (isDuplicate) {
      // Acknowledge so Twilio stops retrying, and record that it happened —
      // without repeating a single business effect.
      await logEvent({
        eventType: 'webhook.duplicate',
        severity: 'info',
        message: `Duplicate inbound webhook ignored for ${From || 'unknown'}`,
        status: 'duplicate',
        contact: contact ? contact._id : undefined,
        conversation: conversation ? conversation._id : undefined,
        twilioSid: sid,
      });
      return sendEmptyTwiml(res);
    }

    // Update the thread: bump activity, preview, unread count; reopen if closed.
    // Done as a single atomic update ($inc, not read-modify-save) so two
    // simultaneous inbound messages can never lose an unread increment.
    if (conversation) {
      conversation = await Conversation.findByIdAndUpdate(
        conversation._id,
        {
          $inc: { unreadCount: 1 },
          $set: {
            lastMessageAt: new Date(),
            lastMessagePreview: (Body || '').slice(0, PREVIEW_LEN),
            lastMessageDirection: 'inbound',
            // An inbound message always reopens a closed thread, and also
            // restores one an admin had soft-deleted (Phase 4) — otherwise a
            // new reply would land in a hidden thread and never be seen.
            status: 'open',
            deletedAt: null,
          },
        },
        { new: true }
      );
    }

    // Compliance (Phase 1). STOP/START are handled and nothing else happens for
    // them; EVERY other inbound message — including HELP — stops automation for
    // this contact. Failures here must never break the webhook, so each action
    // is guarded and the 200 below is always returned.
    let inboundKeyword = 'none';
    if (contact) {
      const keyword = classifyInboundKeyword(Body);
      inboundKeyword = keyword;
      try {
        if (keyword === 'stop') {
          const r = await applyOptOut(contact, 'keyword');
          await logEvent({
            eventType: 'optout.received',
            severity: 'warning',
            message: `Contact ${contact.phone} opted out by SMS keyword`,
            status: 'opted_out',
            contact: contact._id,
            conversation: conversation ? conversation._id : undefined,
            meta: {
              source: 'keyword',
              cancelledEnrollments: r.cancelledEnrollments,
              skippedFollowings: r.skippedFollowings,
            },
          });
        } else if (keyword === 'start') {
          await applyOptIn(contact);
          await logEvent({
            eventType: 'optin.received',
            severity: 'info',
            message: `Contact ${contact.phone} opted back in by SMS keyword`,
            status: 'opted_in',
            contact: contact._id,
            conversation: conversation ? conversation._id : undefined,
            meta: { source: 'keyword' },
          });
        } else {
          // Ordinary reply (or HELP): stop drip automation for this contact.
          const now = new Date();
          const stopped = await stopAutomationOnReply(contact._id, now);
          await touchLastInboundAt(contact._id, now);
          if (stopped.enrollments > 0 || stopped.followings > 0) {
            await logEvent({
              eventType: 'automation.stopped_on_reply',
              severity: 'info',
              message: `Reply from ${contact.phone} stopped ${stopped.enrollments} enrollment(s) and ${stopped.followings} pending follow-up recipient(s)`,
              status: 'stopped',
              contact: contact._id,
              conversation: conversation ? conversation._id : undefined,
              meta: { enrollments: stopped.enrollments, followings: stopped.followings },
            });
          }
        }
      } catch (complianceErr) {
        // Never fail the webhook: Twilio would retry and duplicate the message.
        await logEvent({
          eventType: 'webhook.inbound',
          severity: 'error',
          message: `Inbound compliance handling failed for ${contact.phone}`,
          status: 'error',
          contact: contact._id,
          error: complianceErr.message || 'compliance handling failed',
        });
      }
    }

    // Phase 8: hand the message to the AI reply system.
    //
    // This runs AFTER the message is safely persisted and compliance has been
    // applied, and it only ever ENQUEUES — the provider call happens in
    // jobs/aiWorker.js. Twilio must get its 200 in milliseconds and must never
    // wait on a third-party model.
    //
    // STOP/START are excluded: those are consent instructions, not conversation,
    // and the correct response to them is the carrier's, not a generated one.
    // enqueueForInboundMessage swallows its own errors and returns null, so
    // nothing here can prevent acknowledgement.
    if (contact && conversation && inboundKeyword !== 'stop' && inboundKeyword !== 'start') {
      try {
        const storedInbound = sid
          ? await SMSMessage.findOne({ direction: 'inbound', twilioSid: sid })
          : null;
        if (storedInbound) {
          await aiService.enqueueForInboundMessage({
            contact,
            conversation,
            inboundMessage: storedInbound,
          });
        }
      } catch (aiErr) {
        // Belt and braces — enqueue already guards itself.
        await logEvent({
          eventType: 'ai.provider.error',
          severity: 'error',
          message: 'Could not hand the inbound message to the AI reply system',
          status: 'enqueue_failed',
          contact: contact._id,
          conversation: conversation._id,
          error: String(aiErr.message || 'enqueue failed').slice(0, 200),
        });
      }
    }

    await logEvent({
      eventType: 'webhook.inbound',
      severity: 'info',
      message: `Inbound SMS received from ${From || 'unknown'}`,
      status: SmsStatus || 'received',
      contact: contact ? contact._id : undefined,
      conversation: conversation ? conversation._id : undefined,
      twilioSid: MessageSid || '',
    });

    // Acknowledge with empty TwiML so Twilio does not treat it as an error and
    // no auto-reply is sent (auto-replies are a later phase).
    res.set('Content-Type', 'text/xml');
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) {
    return next(err);
  }
}

// --- Phase 3: delivery status callbacks ------------------------------------

// Lifecycle rank. A receipt only ever moves a message FORWARD: callbacks can
// arrive out of order, so a late 'sent' must never overwrite 'delivered'.
// All three terminal states share the top rank, and an update is applied only
// when it is STRICTLY higher — which also makes duplicate callbacks no-ops, so
// the delivery failure counter can never be incremented twice for one receipt.
const STATUS_RANK = {
  queued: 1,
  accepted: 1,
  scheduled: 1,
  sending: 2,
  sent: 3,
  simulated: 3,
  receiving: 3,
  delivered: 4,
  undelivered: 4,
  failed: 4,
  canceled: 4,
};
const FAILURE_STATUSES = new Set(['undelivered', 'failed']);

function rankOf(status) {
  return STATUS_RANK[String(status || '').toLowerCase()] || 0;
}

// POST /api/webhooks/twilio/status
// Twilio posts MessageSid, MessageStatus and (on failure) ErrorCode. The
// signature is validated by the same middleware as the inbound webhook.
//
// Always answers 200 with empty TwiML: a non-2xx makes Twilio retry, which
// would replay the same receipt. Nothing here ever sends a message.
async function statusCallback(req, res, next) {
  try {
    const { MessageSid, MessageStatus, ErrorCode } = req.body || {};
    const sid = String(MessageSid || '').trim();
    const status = String(MessageStatus || '').trim().toLowerCase();

    if (!sid || !status) {
      // Malformed callback: acknowledge so Twilio stops retrying, but record it.
      await logEvent({
        eventType: 'delivery.ignored',
        severity: 'warning',
        message: 'Status callback missing MessageSid or MessageStatus',
        status: 'ignored',
      });
      return sendEmptyTwiml(res);
    }

    const message = await SMSMessage.findOne({ twilioSid: sid });
    if (!message) {
      // A receipt for something we never recorded (e.g. sent from the Twilio
      // console). Nothing to update — acknowledge quietly.
      await logEvent({
        eventType: 'delivery.ignored',
        severity: 'info',
        message: `Status callback for an unknown message (${status})`,
        status: 'unknown_message',
        twilioSid: sid,
      });
      return sendEmptyTwiml(res);
    }

    const newRank = rankOf(status);
    const errorCode =
      ErrorCode === undefined || ErrorCode === null || ErrorCode === ''
        ? undefined
        : Number(ErrorCode);
    const now = new Date();

    // Move the message forward ATOMICALLY. The condition repeats the rank check
    // inside the update, so of two callbacks racing for the same SID (Twilio
    // retries can overlap) exactly one matches and the loser updates nothing.
    // Everything after this point therefore runs at most once per receipt —
    // which is what keeps the delivery failure counter honest.
    const set = { status, statusUpdatedAt: now };
    if (errorCode !== undefined && !Number.isNaN(errorCode)) set.errorCode = errorCode;
    if (status === 'delivered') set.deliveredAt = now;

    const lowerStatuses = Object.keys(STATUS_RANK).filter((s) => STATUS_RANK[s] < newRank);
    const knownStatuses = Object.keys(STATUS_RANK);
    const updated =
      newRank === 0
        ? null
        : await SMSMessage.findOneAndUpdate(
            {
              _id: message._id,
              // Current status ranks lower, or is an unrecognised/empty value
              // (rank 0) such as a legacy record.
              $or: [{ status: { $in: lowerStatuses } }, { status: { $nin: knownStatuses } }],
            },
            { $set: set },
            { new: true }
          );

    if (!updated) {
      await logEvent({
        eventType: 'delivery.ignored',
        severity: 'info',
        message: `Out-of-order or duplicate receipt ignored: '${status}' after '${message.status}'`,
        status: 'out_of_order',
        contact: message.contact,
        twilioSid: sid,
        meta: { from: message.status, to: status },
      });
      return sendEmptyTwiml(res);
    }
    message.status = updated.status;

    // Mirror the outcome onto whatever produced the message, so campaign and
    // follow-up views reflect real delivery rather than "accepted by Twilio".
    await propagateToAutomation(message, status);

    // Update the contact's delivery health.
    const contact = message.contact
      ? await Contact.findById(message.contact)
      : await Contact.findOne({ phone: message.to });

    if (contact) {
      if (FAILURE_STATUSES.has(status)) {
        // A carrier-level unsubscribe is consent, not deliverability: route it
        // through the Phase 1 opt-out path and do not count it as a failure.
        if (deliveryPolicy.isOptOutCode(errorCode)) {
          const r = await applyOptOut(contact, 'carrier');
          await logEvent({
            eventType: 'optout.received',
            severity: 'warning',
            message: `Twilio reported ${contact.phone} as unsubscribed (21610); contact opted out`,
            status: 'opted_out',
            contact: contact._id,
            twilioSid: sid,
            meta: { source: 'carrier', twilioCode: 21610, via: 'status_callback', ...r },
          });
        } else {
          const outcome = await deliveryPolicy.recordFailure(contact, status, errorCode);
          await logEvent({
            eventType: outcome.blocked ? 'delivery.blocked' : 'delivery.failed',
            severity: outcome.blocked ? 'error' : 'warning',
            message: outcome.blocked
              ? `${contact.phone} blocked for delivery: ${outcome.reason}`
              : `Delivery ${status} to ${contact.phone}${errorCode ? ` (${errorCode}: ${deliveryPolicy.describeCode(errorCode)})` : ''}`,
            status,
            contact: contact._id,
            twilioSid: sid,
            error: errorCode ? deliveryPolicy.describeCode(errorCode) : '',
            meta: {
              errorCode,
              permanent: outcome.permanent,
              failureCount: outcome.failureCount,
              threshold: outcome.threshold,
            },
          });
        }
      } else if (status === 'delivered') {
        await deliveryPolicy.recordSuccess(contact, status);
        await logEvent({
          eventType: 'delivery.delivered',
          severity: 'info',
          message: `Delivered to ${contact.phone}`,
          status,
          contact: contact._id,
          twilioSid: sid,
        });
      }
    }

    return sendEmptyTwiml(res);
  } catch (err) {
    return next(err);
  }
}

function sendEmptyTwiml(res) {
  res.set('Content-Type', 'text/xml');
  return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

// Reflect a delivery outcome on the enrollment step or follow-up recipient that
// produced this message. Best-effort: a failure here must not fail the webhook.
async function propagateToAutomation(message, status) {
  try {
    const sid = message.twilioSid;
    if (!sid) return;

    // Enrollment step: `status` there is free-form, so it carries the Twilio
    // value verbatim.
    await Enrollment.updateOne(
      { 'sentSteps.twilioSid': sid },
      { $set: { 'sentSteps.$[s].status': status } },
      { arrayFilters: [{ 's.twilioSid': sid }] }
    );

    // Follow-up recipient: its status is a workflow enum
    // (pending|sent|failed|skipped) with no 'delivered' member, so only a
    // failure changes it. A delivered receipt correctly leaves it as 'sent'.
    if (FAILURE_STATUSES.has(status)) {
      await Following.updateOne(
        { 'recipients.twilioSid': sid },
        {
          $set: {
            'recipients.$[r].status': 'failed',
            'recipients.$[r].lastError': `delivery ${status}`,
          },
        },
        { arrayFilters: [{ 'r.twilioSid': sid }] }
      );
    }
  } catch (e) {
    await logEvent({
      eventType: 'delivery.failed',
      severity: 'warning',
      message: 'Could not propagate a delivery receipt to its automation record',
      status: 'propagation_error',
      error: e.message,
      twilioSid: message.twilioSid,
    });
  }
}

module.exports = { inboundSms, statusCallback, rankOf, STATUS_RANK };
