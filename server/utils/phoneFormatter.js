// Phone number normalization to E.164 (e.g. +14155552671).
//
// E.164 = a leading "+" followed by 8-15 digits (country code + national number).
// This is a lightweight, dependency-free normalizer. It intentionally does not
// validate national number plans per country (that would need a library such as
// libphonenumber-js); it focuses on producing a consistent, storable E.164 form.
const { config } = require('../config/env');

// The North American Numbering Plan country code. It is the only E.164 country
// code that starts with '1', which is what makes the checks below unambiguous.
const NANP_COUNTRY_CODE = '1';

// Normalize a raw phone value into E.164.
// Returns { valid: true, e164 } or { valid: false, error }.
function normalizePhone(input, defaultCountryCode = config.defaultCountryCode) {
  if (input === undefined || input === null) {
    return { valid: false, error: 'Phone is empty' };
  }

  let cleaned = String(input).trim();
  if (!cleaned) return { valid: false, error: 'Phone is empty' };

  // Drop common formatting characters: spaces, dashes, parentheses, dots.
  cleaned = cleaned.replace(/[\s\-().]/g, '');

  // International prefix "00" is equivalent to "+".
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }

  if (!cleaned.startsWith('+')) {
    if (!/^\d+$/.test(cleaned)) {
      return { valid: false, error: 'Phone contains invalid characters' };
    }
    if (!defaultCountryCode) {
      return {
        valid: false,
        error:
          'Phone has no country code. Provide E.164 format (+countrycode...) or set DEFAULT_COUNTRY_CODE.',
      };
    }
    const cc = defaultCountryCode.replace(/[^\d]/g, '');

    if (cc === NANP_COUNTRY_CODE) {
      // Phase 0 bug fix (US/Canada). A bare 11-digit number starting with 1
      // ALREADY carries the country code — "14155552671" means +1 415 555 2671.
      // The previous code prepended another 1 and stored "+114155552671", an
      // unroutable number. Handle both accepted shapes explicitly:
      //   11 digits starting with 1 -> '+' + digits   (country code present)
      //   10 digits                 -> '+1' + digits  (national number only)
      // Anything else is a malformed NANP number and is rejected rather than
      // guessed at. Note there is deliberately no leading-zero stripping here:
      // NANP has no '0' trunk prefix, so a leading 0 means the input is wrong.
      if (/^1\d{10}$/.test(cleaned)) {
        cleaned = '+' + cleaned;
      } else if (/^\d{10}$/.test(cleaned)) {
        cleaned = '+' + NANP_COUNTRY_CODE + cleaned;
      } else {
        return {
          valid: false,
          error:
            'US/Canada numbers must have 10 digits (optionally prefixed with 1), ' +
            'e.g. 4155552671 or 14155552671.',
        };
      }
    } else {
      // Other countries: drop any national trunk prefix (leading zeros) before
      // prepending the country code.
      const national = cleaned.replace(/^0+/, '');
      cleaned = '+' + cc + national;
    }
  }

  const digits = cleaned.slice(1);
  if (!/^\d+$/.test(digits)) {
    return { valid: false, error: 'Phone contains invalid characters' };
  }
  if (digits.length < 8 || digits.length > 15) {
    return { valid: false, error: 'Phone must have between 8 and 15 digits' };
  }

  // Phase 10: no E.164 country code begins with 0. Without this, the "00" ->
  // "+" international-prefix rule above silently accepted a plainly local
  // string: "0000000000" became "+00000000", and "+0123456789" was kept as-is.
  // Both are unroutable and Twilio rejects them with error 21211.
  if (digits.startsWith('0')) {
    return {
      valid: false,
      error: 'Phone has an invalid country code (no country code starts with 0).',
    };
  }

  // Phase 0: +1 is the ONLY country code beginning with 1, so a leading 1 here
  // always means NANP — which has exactly 10 national digits. This also rejects
  // values corrupted by the old bug (e.g. +114155552671), so they surface as a
  // clear validation error instead of being silently kept. Existing rows are
  // repaired by scripts/fixUsPhones.js.
  if (digits.startsWith(NANP_COUNTRY_CODE)) {
    if (digits.length !== 11) {
      return {
        valid: false,
        error: `+1 numbers must have exactly 10 digits after the country code (got ${
          digits.length - 1
        }).`,
      };
    }

    // Phase 10: enforce the NANP structure the comment above already promised.
    // A North American number is NPA-NXX-XXXX where the area code (NPA) and the
    // central-office code (NXX) both begin with 2-9. Previously a 10-digit input
    // was accepted whatever its leading digits, so "0415552671" was stored as
    // "+10415552671" — an unroutable number with a nonexistent area code, the
    // same class of corruption the Phase 0 fix above exists to prevent.
    //
    // DELIBERATELY STRUCTURAL ONLY. This check does not reject N11 service codes
    // such as 911 or 411 in the area-code position, nor any other unassigned NPA.
    // Doing so would mean tracking the live NANP assignment tables, which is the
    // full numbering-plan validation this module states up front it does not
    // attempt (use libphonenumber-js if that is ever needed). The rule here is
    // the invariant part of the format, which is enough to stop a number being
    // stored in a shape that can never route.
    const national = digits.slice(1);
    if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) {
      return {
        valid: false,
        error:
          'Not a valid US/Canada number: the area code and the exchange code must ' +
          'each start with a digit from 2 to 9 (e.g. 4155552671).',
      };
    }
  }

  return { valid: true, e164: '+' + digits };
}

module.exports = { normalizePhone, NANP_COUNTRY_CODE };
