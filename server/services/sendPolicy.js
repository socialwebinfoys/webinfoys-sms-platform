// Send policy: the line-type sending filter.
//
// Settings.allowedLineTypes names the Twilio Lookup classifications that may be
// messaged (with the legacy `mobileOnly` boolean as a fallback — see
// Settings.resolveAllowedLineTypes). The filter FAILS CLOSED: a number whose type
// is not on the list is blocked, and if the type cannot be determined at all
// (Lookup unavailable / not configured) the send is blocked too — but that is
// marked `temporary` so callers can retry later.
//
// WHERE IT IS APPLIED (all five send paths, verified by test/api/send-paths and
// test/worker/*):
//   * manual send and retry      — always
//   * campaign and follow-up automation — always
//   * inbox reply                — unless the contact has `lastInboundAt`, i.e.
//     they have messaged us, which proves the number receives SMS. See the
//     comment in conversationController.reply.
// The consent gate (checkCanSend) applies to every path with no exceptions.
//
// A number Lookup has DEFINITIVELY reported invalid is refused by that gate, not
// by the line-type filter: the filter returns early when every line type is
// allowed (the default) and is skipped for some inbox replies, so a block that
// lived there would not hold on every path.
//
// It reuses the existing lookupService (single Twilio client) and the existing
// Contact.lookup cache — a number is looked up at most once, then reused.
const Settings = require('../models/Settings');
const Contact = require('../models/Contact');
const lookupService = require('./lookupService');

// Has Twilio Lookup DEFINITIVELY reported this contact's number invalid?
//
// True for one stored value only: lookup.status === 'invalid'. A number that was
// never checked, one Lookup could not classify, and one whose lookup attempt
// failed (status is left untouched, see contactLookup.lookupOne) are all NOT
// invalid. This is the single definition used by the send gate below and by the
// enrollment and follow-up eligibility rules.
function isLookupInvalid(contact) {
  return !!(contact && contact.lookup && contact.lookup.status === 'invalid');
}

// Phase 1 (compliance): the eligibility gate that runs BEFORE the mobile-only
// filter on every send path (manual send, inbox reply, campaign automation,
// follow-up automation). It answers one question: are we allowed to message
// this person at all?
//
// Blocks are always definitive (temporary:false) — opting out or deactivating a
// contact is a decision, not a transient error, so callers must never retry.
//
// Returns { allowed: true } or { allowed:false, temporary:false, reason, code }.
async function checkCanSend({ contact, phone }) {
  // A raw `to` number still has to be checked: if it belongs to a contact who
  // opted out, sending to the number directly would bypass the opt-out.
  let target = contact || null;
  if (!target && phone) {
    target = await Contact.findOne({ phone });
  }
  // Unknown number with no contact record: nothing to block on here (the
  // mobile-only filter still applies downstream).
  if (!target) return { allowed: true };

  if (target.optedOut) {
    return {
      allowed: false,
      temporary: false,
      code: 'opted_out',
      reason: 'Blocked: this contact has opted out of SMS',
    };
  }
  if (target.isActive === false) {
    return {
      allowed: false,
      temporary: false,
      code: 'inactive',
      reason: 'Blocked: this contact is marked inactive',
    };
  }
  // Phase 3: Twilio has told us this number cannot receive messages. Only an
  // admin can clear it, so this is a definitive block like the two above.
  if (target.deliveryBlocked) {
    return {
      allowed: false,
      temporary: false,
      code: 'delivery_blocked',
      reason: 'Blocked: messages to this number keep failing to be delivered',
    };
  }
  // A number Lookup reported invalid can never receive a message, whatever the
  // line-type filter is set to and however long ago the contact was enrolled or
  // added to a follow-up. This reads the cached result only — nothing is looked
  // up here — and it stays blocked until a new Lookup of the contact says
  // otherwise (or its phone number is changed, which resets the cache).
  if (isLookupInvalid(target)) {
    return {
      allowed: false,
      temporary: false,
      code: 'invalid_number',
      reason: 'Blocked: Twilio Lookup reports this number as invalid',
    };
  }

  return { allowed: true };
}

// Phase 7: Twilio Lookup v2 reports voip numbers as `fixedVoip` /
// `nonFixedVoip` and toll-free as `tollFree`. A number it cannot classify, or
// one classified before those distinctions were stored, is normalised to a
// known bucket here so the allow-list only ever deals in the six canonical
// values. A legacy cached value of plain 'voip' maps to nonFixedVoip, the
// stricter of the two readings.
function canonicalLineType(type) {
  const t = String(type || '').trim();
  if (!t) return 'unknown';
  const map = {
    mobile: 'mobile',
    landline: 'landline',
    fixedvoip: 'fixedVoip',
    nonfixedvoip: 'nonFixedVoip',
    voip: 'nonFixedVoip',
    tollfree: 'tollFree',
    'toll-free': 'tollFree',
    unknown: 'unknown',
  };
  return map[t.toLowerCase()] || 'unknown';
}

// Is a cached Lookup result still trustworthy? A number can be ported to a
// different carrier and line type, so an old classification is re-checked.
function isLookupFresh(lookup, maxAgeDays) {
  if (!lookup || !lookup.lookedUpAt) return false;
  const ageMs = Date.now() - new Date(lookup.lookedUpAt).getTime();
  return ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}

// The line-type filter (Phase 7, replacing the Phase 7-era mobile-only
// boolean — see Settings.resolveAllowedLineTypes for the compatibility rules).
//
// Still FAILS CLOSED: a number whose type cannot be established is blocked, not
// sent to. The one concession is that when Lookup is DOWN and we hold a stale
// cached classification, that stale value is honoured only if it names a type
// the admin has allowed — a stale 'landline' under a mobile-only policy stays
// blocked, and a stale value is never used to permit a type that is not on the
// list.
//
// Returns:
//   { allowed: true, filterApplied }                          → send
//   { allowed: false, temporary: false, reason, type, status } → definitive block
//   { allowed: false, temporary: true, reason }                → cannot classify (retryable)
async function checkMobileOnly({ contact, phone }) {
  const settings = await Settings.getSingleton();
  const allowedTypes = Settings.resolveAllowedLineTypes(settings);

  // Every type permitted = the filter is off. Short-circuit before spending a
  // Lookup call (Lookup is billable).
  if (allowedTypes.length >= Settings.LINE_TYPES.length) {
    return { allowed: true, filterApplied: false };
  }

  const number = phone || (contact && contact.phone);
  const maxAgeDays = settings.lookupMaxAgeDays || 30;
  const cached = contact && contact.lookup ? contact.lookup : null;
  const hasClassification = !!(cached && cached.status && cached.status !== 'unknown');
  const fresh = hasClassification && isLookupFresh(cached, maxAgeDays);

  let status = hasClassification ? cached.status : 'unknown';
  let type = hasClassification ? cached.type : '';

  // Look up when never classified, or when the cached classification has aged
  // past the configured limit.
  if (!fresh) {
    let result;
    try {
      result = await lookupService.lookupNumber(number);
    } catch (e) {
      // Lookup is unavailable. With a stale cached type we may still proceed —
      // but only when that type is explicitly allowed.
      if (hasClassification) {
        const staleType = canonicalLineType(type);
        if (status !== 'invalid' && allowedTypes.includes(staleType)) {
          return {
            allowed: true,
            filterApplied: true,
            stale: true,
            type: staleType,
            status,
            reason: `Lookup unavailable; using cached ${staleType} classification (allowed)`,
          };
        }
        return {
          allowed: false,
          temporary: false,
          stale: true,
          type: staleType,
          status,
          reason: `Lookup unavailable and the cached classification (${staleType}) is not an allowed line type`,
        };
      }
      // No classification at all → fail closed, and retryable.
      return {
        allowed: false,
        temporary: true,
        reason: 'Cannot verify number type (Lookup unavailable); blocked by the line-type filter',
      };
    }

    status = result.valid ? 'valid' : 'invalid';
    type = result.type || '';
    // Cache on the contact (only sets `lookup`; never overwrites other fields,
    // never creates a duplicate contact).
    if (contact) {
      contact.lookup = {
        status,
        type,
        carrier: result.carrier || '',
        canonicalPhone: result.phone || '',
        lookedUpAt: result.lookedUpAt || new Date(),
      };
      await contact.save();
    }
  }

  if (status === 'invalid') {
    return {
      allowed: false,
      temporary: false,
      reason: 'Blocked by the line-type filter: Twilio reports this number as invalid',
      type: canonicalLineType(type),
      status,
    };
  }

  const canonical = canonicalLineType(type);
  const allowed = allowedTypes.includes(canonical);
  return {
    allowed,
    filterApplied: true,
    temporary: false,
    type: canonical,
    status,
    reason: allowed
      ? canonical
      : `Blocked by the line-type filter: ${canonical} is not an allowed line type (allowed: ${allowedTypes.join(', ')})`,
  };
}

module.exports = { checkCanSend, checkMobileOnly, canonicalLineType, isLookupFresh, isLookupInvalid };
