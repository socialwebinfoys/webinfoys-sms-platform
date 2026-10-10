// Twilio Lookup (v2) integration — phone number validation + line-type
// classification (mobile / landline / voip). Kept separate from twilioService
// (which handles SMS sending) but reuses its Twilio client, so there is only one
// Twilio client in the app. Credentials come from config (env), never hardcoded.
const twilioService = require('./twilioService');
const { config } = require('../config/env');
const { normalizePhone } = require('../utils/phoneFormatter');

// Normalize the various shapes Twilio's line_type_intelligence can take into a
// simple { type, carrier } pair. Defensive about camelCase vs snake_case.
function parseLineType(res) {
  const lti = res.lineTypeIntelligence || res.line_type_intelligence || {};
  const type = lti.type || '';
  const carrier = lti.carrier_name || lti.carrierName || '';
  return { type, carrier };
}

// Deterministic simulated result so tests can exercise each classification
// without real credentials. Numbers ending 0-3 => mobile, 4-6 => landline,
// 7-9 => voip; numbers ending in "0000" simulate an invalid number.
function simulate(e164) {
  if (e164.endsWith('0000')) {
    return { valid: false, phone: e164, type: '', carrier: '', simulated: true };
  }
  const last = e164.charCodeAt(e164.length - 1) - 48;
  let type = 'mobile';
  if (last >= 7) type = 'voip';
  else if (last >= 4) type = 'landline';
  return { valid: true, phone: e164, type, carrier: 'Simulated Carrier', simulated: true };
}

// Look up a phone number. Resolves to a normalized result object; throws an
// Error with `statusCode` on validation/config/API failure (safe messages only).
async function lookupNumber(rawPhone) {
  const norm = normalizePhone(rawPhone);
  if (!norm.valid) {
    const err = new Error(norm.error || 'Invalid phone number');
    err.statusCode = 400;
    throw err;
  }
  const e164 = norm.e164;

  // Simulation mode — no real Twilio call.
  if (config.lookup.simulate) {
    return { ...simulate(e164), lookedUpAt: new Date() };
  }

  const client = twilioService.getClient();
  if (!client) {
    const err = new Error('Twilio is not configured');
    err.statusCode = 503;
    throw err;
  }

  try {
    const res = await client.lookups.v2
      .phoneNumbers(e164)
      .fetch({ fields: 'line_type_intelligence' });
    const { type, carrier } = parseLineType(res);
    return {
      valid: res.valid !== undefined ? !!res.valid : true,
      phone: res.phoneNumber || res.phone_number || e164,
      type,
      carrier,
      simulated: false,
      lookedUpAt: new Date(),
    };
  } catch (e) {
    // Twilio returns 404 for a number it cannot find — treat as "invalid",
    // not a server error.
    if (e && (e.status === 404 || e.code === 20404)) {
      return { valid: false, phone: e164, type: '', carrier: '', simulated: false, lookedUpAt: new Date() };
    }
    const err = new Error(`Lookup failed: ${e.message || 'Twilio Lookup API error'}`);
    err.statusCode = 502;
    err.twilioCode = e.code;
    throw err;
  }
}

module.exports = { lookupNumber, parseLineType };
