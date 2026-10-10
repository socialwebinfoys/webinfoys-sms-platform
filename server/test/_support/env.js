// Phase 10 test harness — SAFETY PRELUDE.
//
// Every test file requires this FIRST, before any application module. It does
// three things, in this order:
//
//   1. Sets a complete, self-contained test environment. Because dotenv never
//      overrides an existing process.env value, setting these here means the
//      real server/.env can NEVER reach the code under test — not the Atlas
//      URI, not the Twilio credentials, not the production JWT secret.
//
//   2. HARD-BLOCKS every MongoDB connection path. mongoose.connect and
//      mongoose.createConnection are replaced with functions that throw. This
//      is what makes "the tests did not touch the live database" a structural
//      guarantee rather than a promise: a test that tried would fail loudly.
//      Persistence is supplied by stubs instead (see _support/stubs.js).
//
//   3. HARD-BLOCKS the Twilio SDK. Constructing a client throws, so no test can
//      reach the Twilio API even if a send guard were bypassed. Outbound sends
//      are additionally simulated (SMS_SIMULATE=true) and unconfigured (no
//      credentials), giving three independent layers.
//
// Nothing here is conditional and nothing can be opted out of from a test file.
'use strict';

// --- 1. environment --------------------------------------------------------
// A deliberately inert Mongo URI: no test connects, and connecting is blocked
// below in any case. The database name says so out loud.
const INERT_MONGO_URI = 'mongodb://127.0.0.1:27017/webinfoys_sms_HARNESS_NEVER_CONNECTS';

const TEST_ENV = {
  NODE_ENV: 'test',
  PORT: '0',
  MONGO_URI: INERT_MONGO_URI,
  // 48 random-looking characters; satisfies the 32-char minimum. Test-only.
  JWT_SECRET: 'phase10-test-signing-key-not-a-real-secret-0001',
  JWT_EXPIRES_IN: '1h',
  CORS_ORIGIN: 'http://localhost:5173',
  DEFAULT_COUNTRY_CODE: '+1',
  // Outbound sends are simulated and Twilio is unconfigured.
  SMS_SIMULATE: 'true',
  LOOKUP_SIMULATE: 'true',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_PHONE_NUMBER: '',
  TWILIO_WEBHOOK_BASE_URL: '',
  TWILIO_VALIDATE_WEBHOOK: 'true',
  PUBLIC_API_URL: '',
  // The cron worker must never start during a test run.
  AUTOMATION_ENABLED: 'false',
  // Phase 8. A test-only encryption key — long enough to satisfy the 32-char
  // floor, and obviously not a real secret. The AI worker is off, so no AI cron
  // task is scheduled; AI tests drive the worker functions directly.
  AI_ENCRYPTION_KEY: 'phase8-test-encryption-key-not-a-real-secret-0001',
  AI_WORKER_ENABLED: 'false',
  AI_REQUEST_TIMEOUT_MS: '5000',
  AI_MAX_RETRIES: '3',
  AI_RETRY_BACKOFF_MINUTES: '2',
  AUTOMATION_MAX_SENDS_PER_RUN: '20',
  AUTOMATION_MAX_RETRIES: '3',
  AUTOMATION_RETRY_BACKOFF_MINUTES: '5',
  ADMIN_NAME: 'Test Admin',
  ADMIN_EMAIL: 'admin@test.invalid',
  ADMIN_PASSWORD: 'test-admin-password-12345',
};

// Overwrite unconditionally: a value inherited from the developer's shell must
// not be able to point the harness at a real service.
//
// This assignment IS the isolation mechanism. config/env.js calls
// `require('dotenv').config()`, and dotenv never overwrites a variable that is
// already set — so once these are in place, nothing in server/.env can reach the
// code under test. harness-safety.test.js asserts that outcome directly rather
// than trusting the reasoning.
for (const [key, value] of Object.entries(TEST_ENV)) {
  process.env[key] = value;
}

// --- 2. block every database connection ------------------------------------
const mongoose = require('mongoose');

function blockedConnection(what) {
  return function blocked() {
    throw new Error(
      `BLOCKED BY TEST HARNESS: ${what} was called. Phase 10 tests must not ` +
        'connect to any MongoDB. Use the model stubs in test/_support/stubs.js.'
    );
  };
}
mongoose.connect = blockedConnection('mongoose.connect');
mongoose.createConnection = blockedConnection('mongoose.createConnection');

// Model methods would otherwise buffer for 10s waiting for a connection that
// never comes, turning a missing stub into a timeout. Fail fast and clearly.
mongoose.set('bufferCommands', false);

// --- 3. block the Twilio SDK ----------------------------------------------
// twilioService only constructs a client when credentials exist (they do not
// here), so this is a third layer rather than the only one.
const twilioModuleId = require.resolve('twilio');
require('twilio'); // populate the cache entry so we can replace its exports
const realTwilio = require.cache[twilioModuleId].exports;
function blockedTwilio() {
  throw new Error(
    'BLOCKED BY TEST HARNESS: a Twilio client was constructed. Phase 10 tests ' +
      'must not contact Twilio.'
  );
}
// validateRequest is pure HMAC over strings (no network), so the real one is
// kept — the webhook signature tests need it to produce genuine signatures.
blockedTwilio.validateRequest = realTwilio.validateRequest;
blockedTwilio.webhook = realTwilio.webhook;
require.cache[twilioModuleId].exports = blockedTwilio;

// --- quieten per-request logging -------------------------------------------
// requestLogger prints a line per request and errorHandler prints 5xx details.
// Both are expected during negative-path tests and would bury real output.
// console.error is deliberately left alone.
if (process.env.TEST_VERBOSE !== 'true') {
  console.log = () => {};
  console.warn = () => {};
}

module.exports = { TEST_ENV, INERT_MONGO_URI };
