// Wraps the Twilio SDK for outbound SMS. Credentials come from the environment
// (via config). Designed to be testable: a mock client can be injected, and a
// "simulate" mode lets sends succeed without contacting Twilio.
const twilio = require('twilio');
const { config } = require('../config/env');

let cachedClient; // real client, lazily created
let injectedClient = null; // test override

// Twilio errors that will never succeed on a retry (Phase 1). Retrying these
// wastes sends and, in the case of 21610, keeps messaging someone who has
// unsubscribed. Callers fail immediately instead of backing off.
//   21610 - recipient has unsubscribed (carrier-level STOP)
//   21211 - invalid 'to' number
//   21614 - 'to' number is not mobile-capable
//   21408 - permission to send to this region is disabled
const PERMANENT_CODES = new Set([21610, 21211, 21614, 21408]);

// Returns a Twilio client, or null if credentials are absent.
function getClient() {
  if (injectedClient) return injectedClient;
  if (!config.twilio.accountSid || !config.twilio.authToken) return null;
  if (!cachedClient) {
    cachedClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return cachedClient;
}

// True when SID, auth token, and a from-number are all present.
function isConfigured() {
  return !!(config.twilio.accountSid && config.twilio.authToken && config.twilio.from);
}

// Non-secret status for the settings screen. Never exposes the auth token, and
// masks the account SID.
function status() {
  const sid = config.twilio.accountSid;
  return {
    configured: isConfigured(),
    simulate: config.sms.simulate,
    accountSid: sid ? `${sid.slice(0, 2)}****${sid.slice(-4)}` : '',
    from: config.twilio.from || '',
  };
}

// Send a single SMS. Resolves to { sid, status, simulated, to, from }.
// Throws an Error with a `statusCode` on failure (safe message, no secrets).
async function sendSms({ to, body, from }) {
  const fromNumber = from || config.twilio.from;

  if (!to || !body) {
    const err = new Error('Both "to" and "body" are required');
    err.statusCode = 400;
    throw err;
  }

  // Simulation mode: don't touch Twilio, return a fake success.
  if (config.sms.simulate) {
    return {
      sid: `SIMULATED-${Date.now()}`,
      status: 'simulated',
      simulated: true,
      to,
      from: fromNumber,
    };
  }

  const client = getClient();
  if (!client || !isConfigured()) {
    const err = new Error('Twilio is not configured');
    err.statusCode = 503;
    throw err;
  }

  try {
    const params = { to, from: fromNumber, body };
    // Phase 3: ask Twilio to post delivery receipts back. Only when a public
    // base URL is configured — an unreachable callback URL would just make
    // Twilio retry against nothing.
    if (config.publicApiUrl) {
      params.statusCallback = `${config.publicApiUrl.replace(/\/$/, '')}/api/webhooks/twilio/status`;
    }
    const message = await client.messages.create(params);
    return {
      sid: message.sid,
      status: message.status,
      simulated: false,
      to,
      from: fromNumber,
    };
  } catch (e) {
    // Map Twilio SDK errors to a clean upstream-failure error.
    const err = new Error(`Failed to send SMS: ${e.message || 'Twilio API error'}`);
    err.statusCode = 502;
    err.twilioCode = e.code;
    // Lets callers distinguish "try again later" from "never going to work".
    err.permanent = PERMANENT_CODES.has(e.code);
    throw err;
  }
}

// --- test helpers (not used in production paths) ---
function __setClient(client) {
  injectedClient = client;
}
function __reset() {
  injectedClient = null;
  cachedClient = undefined;
}

module.exports = {
  getClient,
  isConfigured,
  status,
  sendSms,
  PERMANENT_CODES,
  __setClient,
  __reset,
};
