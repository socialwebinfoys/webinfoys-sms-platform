// Delivery policy (Phase 3): what a Twilio delivery receipt means for a
// contact's future deliverability.
//
// The rule, deliberately conservative:
//   * PERMANENT failure codes block the contact on the first receipt — the
//     number will never work, so retrying only burns messages.
//   * Every other failure is TEMPORARY and merely increments a consecutive
//     failure counter; the contact is blocked once that counter reaches the
//     configured threshold (Settings.deliveryFailureThreshold, default 3).
//     This is why a single 30003 never blocks anyone.
//   * A successful delivery resets the counter to zero, so "3 failures" always
//     means three in a row, never three spread over a year.
//   * 21610 is not a deliverability problem at all — the recipient unsubscribed
//     at carrier level, so it is routed to the Phase 1 opt-out path instead.
//
// All codes live in the tables below so the policy can be tuned in one place.
const Settings = require('../models/Settings');

// Twilio code meaning "the recipient has unsubscribed". Handled as consent
// (Phase 1 opt-out), never as a delivery block.
const OPT_OUT_CODE = 21610;

// Failures that can never succeed on a retry: block immediately.
const PERMANENT_CODES = new Set([
  30005, // Unknown destination handset — the number does not exist
  30006, // Landline or unreachable carrier — cannot receive SMS
]);

// Plain-English meanings for the delivery report. Presentation only: being
// listed here does NOT classify a code as permanent.
const CODE_MEANINGS = {
  30001: 'Queue overflow — the message waited too long and expired',
  30002: 'Account suspended',
  30003: 'Unreachable destination handset (off, out of coverage, or blocked)',
  30004: 'Message blocked by the recipient or their carrier',
  30005: 'Unknown destination handset — the number does not exist',
  30006: 'Landline or carrier that cannot receive SMS',
  30007: 'Carrier filtered the message (often flagged as spam)',
  30008: 'Unknown error reported by the carrier',
  30009: 'Missing segment — part of a multi-part message was lost',
  30010: 'Message price exceeds the configured maximum',
  21610: 'Recipient has unsubscribed (STOP)',
  21211: 'Invalid phone number',
  21614: 'Number is not capable of receiving SMS',
  21408: 'Sending to this region is not enabled on the Twilio account',
};

function describeCode(code) {
  if (code === undefined || code === null || code === '') return '';
  return CODE_MEANINGS[Number(code)] || `Twilio error ${code}`;
}

function isPermanentCode(code) {
  return PERMANENT_CODES.has(Number(code));
}

function isOptOutCode(code) {
  return Number(code) === OPT_OUT_CODE;
}

// Decide what a failed delivery means for this contact, and apply it.
//
// `contact` is a Mongoose document (mutated and saved here). `status` is the
// Twilio MessageStatus ('undelivered' | 'failed'), `errorCode` the numeric code
// or undefined. Returns a description of what was decided, for logging:
//   { blocked, reason, permanent, failureCount, threshold }
async function recordFailure(contact, status, errorCode) {
  const settings = await Settings.getSingleton();
  // ?? not ||, so a configured threshold is used exactly as stored.
  const threshold = settings.deliveryFailureThreshold ?? 3;

  const permanent = isPermanentCode(errorCode);
  // Legacy contacts have no counter; treat a missing value as zero.
  const nextCount = (contact.deliveryFailureCount || 0) + 1;

  contact.deliveryFailureCount = nextCount;
  contact.lastDeliveryStatus = status;
  if (errorCode !== undefined && errorCode !== null && errorCode !== '') {
    contact.lastDeliveryErrorCode = Number(errorCode);
  }

  let blocked = false;
  let reason = '';
  if (permanent) {
    blocked = true;
    reason = `Permanent delivery failure (${errorCode}): ${describeCode(errorCode)}`;
  } else if (nextCount >= threshold) {
    blocked = true;
    reason = `${nextCount} consecutive delivery failures (threshold ${threshold})`;
  }

  // Only ever set the block; clearing it is an explicit admin action.
  if (blocked && !contact.deliveryBlocked) {
    contact.deliveryBlocked = true;
    contact.deliveryBlockedAt = new Date();
  }

  await contact.save();
  return { blocked, reason, permanent, failureCount: nextCount, threshold };
}

// A delivered receipt: the number works, so the consecutive-failure streak is
// over. Deliberately does NOT clear an existing block — unblocking stays an
// explicit admin decision (and a blocked contact cannot be sent to anyway).
async function recordSuccess(contact, status = 'delivered') {
  contact.deliveryFailureCount = 0;
  contact.lastDeliveryStatus = status;
  contact.lastDeliveryErrorCode = undefined;
  await contact.save();
  return { reset: true };
}

module.exports = {
  OPT_OUT_CODE,
  PERMANENT_CODES,
  CODE_MEANINGS,
  describeCode,
  isPermanentCode,
  isOptOutCode,
  recordFailure,
  recordSuccess,
};
