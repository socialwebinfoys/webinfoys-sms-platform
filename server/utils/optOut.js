// Compliance helpers (Phase 1): inbound keyword classification (STOP / START /
// HELP) and the state transitions that follow from an opt-out, an opt-in, or an
// ordinary reply.
//
// Design notes:
//   * A keyword only counts when it is the WHOLE message. "Stop by later" is a
//     normal reply, not an opt-out.
//   * "YES" is deliberately NOT a START keyword. Treating a plain "Yes" answer
//     as an opt-in (and therefore letting the campaign continue) is the FDGSMS
//     bug this platform must not repeat.
//   * This module sends nothing. The legally required STOP/START confirmation
//     replies are sent by Twilio's Advanced Opt-Out at carrier level.
const Contact = require('../models/Contact');
const Enrollment = require('../models/Enrollment');
const Following = require('../models/Following');
const { logEvent } = require('../services/logService');

const STOP_KEYWORDS = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'optout',
  'revoke',
]);
// NOT 'yes' — see the note above.
const START_KEYWORDS = new Set(['start', 'unstop', 'optin']);
// Twilio answers these at carrier level; the app only classifies them.
const HELP_KEYWORDS = new Set(['help', 'info']);

// Classify an inbound body as 'stop' | 'start' | 'help' | 'none'.
// Trims, lowercases and strips trailing punctuation before matching, so
// "Stop." and "STOP" both count while "stop by later" does not.
function classifyInboundKeyword(body) {
  const k = String(body === undefined || body === null ? '' : body)
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/, '')
    .trim();
  if (STOP_KEYWORDS.has(k)) return 'stop';
  if (START_KEYWORDS.has(k)) return 'start';
  if (HELP_KEYWORDS.has(k)) return 'help';
  return 'none';
}

// Mark the contact's pending Following recipients so the worker never sends to
// them. Uses a positional array filter so only this contact's pending rows are
// touched — other recipients and their history are left exactly as they are.
//
// `onlyStopOnReply` (Phase 2) restricts this to follow-ups configured to stop
// when a contact replies. Opt-outs ignore that switch and always skip, because
// consent overrides per-campaign configuration.
//
// `onlyActive` (Bug #1) restricts this to follow-ups that are actually RUNNING.
// Marking a recipient 'skipped' is irreversible — `reconcileRecipients` keeps
// any row that is not 'pending', so nothing can put it back. For an ACTIVE
// follow-up that is harmless: it just pre-empts the decision the worker is about
// to make anyway. For a DRAFT or PAUSED one it destroys choices the operator
// still has, because the worker re-reads `stopOnReply` and `activatedAt` at send
// time. Pausing a follow-up, letting a contact reply, then setting
// stopOnReply=false and resuming should send to that contact — and used to not,
// because the recipient had already been burned.
//
// Opt-out deliberately does NOT pass this: withdrawn consent must reach every
// follow-up in every state, and must never be undone by a later config change.
async function skipPendingFollowingRecipients(
  contactId,
  reason,
  { onlyStopOnReply = false, onlyActive = false } = {}
) {
  const filter = { recipients: { $elemMatch: { contact: contactId, status: 'pending' } } };
  // Legacy follow-ups have no stopOnReply field, and the default is true, so
  // only an explicit false opts out of reply-stopping.
  if (onlyStopOnReply) filter.stopOnReply = { $ne: false };
  if (onlyActive) filter.status = 'active';
  const result = await Following.updateMany(
    filter,
    {
      $set: {
        'recipients.$[r].status': 'skipped',
        'recipients.$[r].lastError': reason,
      },
    },
    { arrayFilters: [{ 'r.contact': contactId, 'r.status': 'pending' }] }
  );
  return result.modifiedCount || 0;
}

// Record an opt-out and stop every automation already queued for this contact.
// `source` is 'keyword' (inbound STOP), 'manual' (operator toggle) or 'carrier'
// (Twilio 21610). Idempotent: opting out an already-opted-out contact is safe.
// Returns { cancelledEnrollments, skippedFollowings }.
async function applyOptOut(contact, source) {
  contact.optedOut = true;
  contact.optedOutAt = new Date();
  contact.optOutSource = source;
  await contact.save();

  // Active AND paused enrollments are cancelled: a paused enrollment would
  // otherwise resume and message someone who has opted out.
  const enr = await Enrollment.updateMany(
    { contact: contact._id, status: { $in: ['active', 'paused'] } },
    { $set: { status: 'cancelled', lastError: 'opted_out', stopReason: 'opted_out' } }
  );
  const skipped = await skipPendingFollowingRecipients(contact._id, 'opted_out');

  return { cancelledEnrollments: enr.modifiedCount || 0, skippedFollowings: skipped };
}

// Record an opt-in. Clears the flag only — it deliberately does NOT re-enroll
// the contact into anything they were cancelled out of; that stays a human
// decision. `optOutSource` is kept as history of how they last opted out.
async function applyOptIn(contact) {
  contact.optedOut = false;
  contact.optedInAt = new Date();
  await contact.save();
  return { optedIn: true };
}

// An ordinary (non-keyword) reply stops drip automation for this contact:
// active enrollments become 'replied' and pending follow-up recipients are
// skipped. Completed/failed/cancelled enrollments are untouched.
// Returns { enrollments, followings }.
async function stopAutomationOnReply(contactId, now = new Date()) {
  const enr = await Enrollment.updateMany(
    { contact: contactId, status: 'active' },
    { $set: { status: 'replied', repliedAt: now, stopReason: 'replied' } }
  );
  // Only follow-ups that are ACTIVE and set to stop on a reply. A draft or
  // paused follow-up stays untouched and fully eligible for later activation —
  // the worker applies the same stopOnReply / activatedAt rule when it finally
  // runs, so nothing is sent that should not be (Bug #1).
  const skipped = await skipPendingFollowingRecipients(contactId, 'replied', {
    onlyStopOnReply: true,
    onlyActive: true,
  });
  return { enrollments: enr.modifiedCount || 0, followings: skipped };
}

// Twilio error 21610 means the carrier is reporting that this recipient has
// unsubscribed. It is a consent signal, not a delivery problem: whatever path
// hit it must stop messaging the contact, exactly as an inbound STOP would.
const CARRIER_OPT_OUT_CODE = 21610;

// Apply a carrier opt-out if (and only if) the error is a 21610.
//
// The automation worker has handled this since Phase 1. This helper exists so
// the MANUAL send, retry and inbox-reply paths behave identically — previously
// they recorded the failure and left the contact contactable, so the very next
// send would be attempted again against someone the carrier had already told us
// had opted out.
//
// Returns { applied, cancelledEnrollments, skippedFollowings } — `applied` is
// false for any other error, so callers can simply always call it.
async function handleCarrierOptOut(contact, err, { path, conversation } = {}) {
  if (!contact || !err || err.twilioCode !== CARRIER_OPT_OUT_CODE) {
    return { applied: false };
  }
  // Re-read nothing and write once: applyOptOut is idempotent, so a contact
  // already opted out simply has their timestamp refreshed.
  const result = await applyOptOut(contact, 'carrier');
  await logEvent({
    eventType: 'optout.received',
    severity: 'warning',
    message: `Twilio reported ${contact.phone} as unsubscribed (21610); contact opted out`,
    status: 'opted_out',
    contact: contact._id,
    conversation,
    meta: {
      source: 'carrier',
      twilioCode: CARRIER_OPT_OUT_CODE,
      path: path || 'send',
      cancelledEnrollments: result.cancelledEnrollments,
      skippedFollowings: result.skippedFollowings,
    },
  });
  return { applied: true, ...result };
}

// Record the moment of the latest inbound message without touching any other
// field on the contact (avoids clobbering concurrent writes).
async function touchLastInboundAt(contactId, now = new Date()) {
  await Contact.updateOne({ _id: contactId }, { $set: { lastInboundAt: now } });
}

module.exports = {
  STOP_KEYWORDS,
  START_KEYWORDS,
  HELP_KEYWORDS,
  classifyInboundKeyword,
  applyOptOut,
  applyOptIn,
  stopAutomationOnReply,
  touchLastInboundAt,
  handleCarrierOptOut,
  CARRIER_OPT_OUT_CODE,
};
