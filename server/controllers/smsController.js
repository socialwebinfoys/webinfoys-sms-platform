// Outbound SMS sending. Sends a single message via the Twilio service and
// records it in the flat message log. (Bulk/automated sending is a later phase.)
const Contact = require('../models/Contact');
const Settings = require('../models/Settings');
const SMSMessage = require('../models/SMSMessage');
const twilioService = require('../services/twilioService');
const { normalizePhone } = require('../utils/phoneFormatter');
const { checkCanSend, checkMobileOnly } = require('../services/sendPolicy');
const { logEvent } = require('../services/logService');
const { handleCarrierOptOut } = require('../utils/optOut');
const { renderForContact } = require('../utils/mergeFields');

// POST /api/sms/send
// Body: { to?, contactId?, body }.  Provide either a phone number or a contactId.
async function sendSms(req, res, next) {
  try {
    const { to, contactId, body: rawBody } = req.body || {};

    if (!rawBody) {
      return res.status(400).json({ success: false, message: 'Message body is required' });
    }

    // Resolve the destination number.
    let destination;
    let contactRef;
    let contactObj = null;
    if (contactId) {
      const contact = await Contact.findById(contactId);
      if (!contact) {
        return res.status(404).json({ success: false, message: 'Contact not found' });
      }
      destination = contact.phone;
      contactRef = contact._id;
      contactObj = contact;
    } else if (to) {
      const normalized = normalizePhone(to);
      if (!normalized.valid) {
        return res.status(400).json({ success: false, message: normalized.error });
      }
      destination = normalized.e164;
      const match = await Contact.findOne({ phone: destination });
      if (match) {
        contactRef = match._id;
        contactObj = match;
      }
    } else {
      return res
        .status(400)
        .json({ success: false, message: 'Provide a "to" number or a "contactId"' });
    }

    // Merge fields are resolved by the shared resolver, against THIS contact
    // only (or nothing, for a number that is not a contact) — a literal
    // "{{first_name}}" is never sent. Text without merge fields is unchanged.
    const { rendered: body } = renderForContact(rawBody, contactObj);
    if (!String(body).trim()) {
      return res.status(400).json({
        success: false,
        message: 'The message is empty once its merge fields are filled in',
      });
    }

    // Respect the master send switch.
    const settings = await Settings.getSingleton();
    if (!settings.smsEnabled) {
      return res.status(400).json({ success: false, message: 'SMS sending is disabled in settings' });
    }

    // Phase 1: compliance gate — runs BEFORE the mobile-only filter. Opted-out
    // and inactive contacts are never messaged, including via a raw `to` number
    // that belongs to one.
    const eligibility = await checkCanSend({ contact: contactObj, phone: destination });
    if (!eligibility.allowed) {
      await logEvent({
        eventType: 'sms.blocked_optout',
        severity: 'warning',
        message: eligibility.reason,
        status: 'blocked',
        contact: contactRef,
        meta: { to: destination, code: eligibility.code },
      });
      return res.status(403).json({ success: false, message: eligibility.reason });
    }

    // Phase 7: mobile-only sending filter (fails closed). Nothing is sent to a
    // non-mobile / unverifiable number when the filter is enabled.
    const policy = await checkMobileOnly({ contact: contactObj, phone: destination });
    if (!policy.allowed) {
      await logEvent({
        eventType: 'sms.blocked',
        severity: policy.temporary ? 'error' : 'warning',
        message: policy.reason,
        status: 'blocked',
        contact: contactRef,
        meta: { to: destination, temporary: !!policy.temporary, type: policy.type || '' },
      });
      return res
        .status(policy.temporary ? 503 : 422)
        .json({ success: false, message: policy.reason });
    }

    const from = settings.defaultFrom || undefined;

    try {
      const result = await twilioService.sendSms({ to: destination, body, from });

      const record = await SMSMessage.create({
        direction: 'outbound',
        to: destination,
        from: result.from || '',
        body,
        twilioSid: result.sid,
        status: result.status,
        contact: contactRef,
        source: 'manual',
      });

      await logEvent({
        eventType: 'sms.sent',
        severity: 'info',
        message: `Outbound SMS ${result.simulated ? '(simulated) ' : ''}to ${destination}`,
        status: result.status,
        contact: contactRef,
        twilioSid: result.sid,
        meta: { simulated: !!result.simulated },
      });

      return res.status(201).json({ success: true, message: record, result });
    } catch (sendErr) {
      // Record the failed attempt (without leaking secrets), then surface a
      // clean error.
      await SMSMessage.create({
        direction: 'outbound',
        to: destination,
        from: from || '',
        body,
        status: 'failed',
        contact: contactRef,
        source: 'manual',
        error: sendErr.message || 'send failed',
      });
      await logEvent({
        eventType: 'sms.failed',
        severity: 'error',
        message: `Outbound SMS to ${destination} failed`,
        status: 'failed',
        contact: contactRef,
        error: sendErr.message || 'send failed',
      });
      // Twilio 21610: the carrier says this recipient unsubscribed. Treat it as
      // an opt-out here exactly as the automation worker does, so a manual send
      // cannot leave a withdrawn consent unrecorded.
      await handleCarrierOptOut(contactObj, sendErr, { path: 'manual' });
      return res
        .status(sendErr.statusCode || 502)
        .json({ success: false, message: sendErr.message || 'Failed to send SMS' });
    }
  } catch (err) {
    return next(err);
  }
}

// POST /api/sms/:id/retry
// Re-sends an outbound message that failed to go out or to be delivered.
//
// It is a RETRY, not a new message: the same SMSMessage record is updated in
// place, so the thread shows one bubble that moves from failed to sent.
//
// Every guard the original send had is re-run here — nothing about "this
// already exists" is allowed to shortcut consent or deliverability:
//   * smsEnabled master switch
//   * checkCanSend  (Phase 1 opt-out / inactive, Phase 3 delivery block)
//   * checkMobileOnly (Phase 7 line-type policy, fails closed)
const RETRYABLE_STATUSES = new Set(['failed', 'undelivered']);

async function retryMessage(req, res, next) {
  try {
    const message = await SMSMessage.findById(req.params.id);
    if (!message) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }
    if (message.deletedAt) {
      return res.status(400).json({ success: false, message: 'This message was deleted' });
    }
    if (message.direction !== 'outbound') {
      return res
        .status(400)
        .json({ success: false, message: 'Only outbound messages can be retried' });
    }
    if (!RETRYABLE_STATUSES.has(String(message.status || '').toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: `Only failed messages can be retried (this one is "${message.status || 'unknown'}")`,
      });
    }
    if (!message.body || !String(message.body).trim()) {
      return res.status(400).json({ success: false, message: 'This message has no body to resend' });
    }

    // Prefer the linked contact; fall back to the destination number.
    let contactObj = null;
    if (message.contact) {
      contactObj = await Contact.findById(message.contact);
      if (!contactObj) {
        return res
          .status(404)
          .json({ success: false, message: 'The contact for this message no longer exists' });
      }
    }
    const destination = contactObj ? contactObj.phone : message.to;
    if (!destination) {
      return res.status(400).json({ success: false, message: 'This message has no destination' });
    }

    const settings = await Settings.getSingleton();
    if (!settings.smsEnabled) {
      return res.status(400).json({ success: false, message: 'SMS sending is disabled in settings' });
    }

    // Phase 1 + Phase 3 compliance gate.
    const eligibility = await checkCanSend({ contact: contactObj, phone: destination });
    if (!eligibility.allowed) {
      await logEvent({
        eventType: 'sms.blocked_optout',
        severity: 'warning',
        message: eligibility.reason,
        status: 'blocked',
        contact: message.contact,
        meta: { to: destination, code: eligibility.code, path: 'retry' },
      });
      return res.status(403).json({ success: false, message: eligibility.reason });
    }

    // Phase 7 mobile-only policy (fails closed).
    const policy = await checkMobileOnly({ contact: contactObj, phone: destination });
    if (!policy.allowed) {
      await logEvent({
        eventType: 'sms.blocked',
        severity: policy.temporary ? 'error' : 'warning',
        message: policy.reason,
        status: 'blocked',
        contact: message.contact,
        meta: { to: destination, temporary: !!policy.temporary, type: policy.type || '', path: 'retry' },
      });
      return res
        .status(policy.temporary ? 503 : 422)
        .json({ success: false, message: policy.reason });
    }

    const from = settings.defaultFrom || undefined;
    try {
      const result = await twilioService.sendSms({ to: destination, body: message.body, from });

      // Update the SAME record rather than creating a second one.
      message.status = result.status;
      message.twilioSid = result.sid;
      message.from = result.from || message.from || '';
      message.error = '';
      message.errorCode = undefined;
      message.deliveredAt = undefined;
      message.statusUpdatedAt = new Date();
      await message.save();

      await logEvent({
        eventType: 'sms.retried',
        severity: 'info',
        message: `Retried SMS ${result.simulated ? '(simulated) ' : ''}to ${destination}`,
        status: result.status,
        contact: message.contact,
        conversation: message.conversation,
        twilioSid: result.sid,
        meta: { simulated: !!result.simulated, messageId: String(message._id) },
      });

      return res.json({ success: true, message, result });
    } catch (sendErr) {
      message.status = 'failed';
      message.error = sendErr.message || 'send failed';
      message.statusUpdatedAt = new Date();
      await message.save();

      await logEvent({
        eventType: 'sms.failed',
        severity: 'error',
        message: `Retry of SMS to ${destination} failed`,
        status: 'failed',
        contact: message.contact,
        conversation: message.conversation,
        error: sendErr.message || 'send failed',
        meta: { path: 'retry', messageId: String(message._id) },
      });
      await handleCarrierOptOut(contactObj, sendErr, { path: 'retry', conversation: message.conversation });

      return res
        .status(sendErr.statusCode || 502)
        .json({ success: false, message: sendErr.message || 'Failed to resend SMS' });
    }
  } catch (err) {
    return next(err);
  }
}

module.exports = { sendSms, retryMessage };
