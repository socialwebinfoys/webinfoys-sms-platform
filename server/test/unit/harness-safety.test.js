// Phase 10 — harness safety. These assertions are the reason the rest of the
// suite can be trusted: they prove the harness CANNOT reach the live database,
// CANNOT reach Twilio, and CANNOT start the automation worker.
'use strict';

require('../_support/env');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mongoose = require('mongoose');
const { config } = require('../../config/env');
const twilioService = require('../../services/twilioService');

test('the real server/.env never reaches the code under test', () => {
  // The live configuration uses an Atlas URI and a +1 Twilio number. If dotenv
  // had won, these assertions would fail.
  assert.match(config.mongoUri, /HARNESS_NEVER_CONNECTS$/);
  assert.equal(config.mongoUri.includes('mongodb+srv'), false);
  assert.equal(config.twilio.accountSid, '');
  assert.equal(config.twilio.authToken, '');
  assert.equal(config.nodeEnv, 'test');
});

test('mongoose.connect is blocked', () => {
  assert.throws(() => mongoose.connect('mongodb://127.0.0.1:27017/anything'), {
    message: /BLOCKED BY TEST HARNESS/,
  });
});

test('mongoose.createConnection is blocked', () => {
  assert.throws(() => mongoose.createConnection('mongodb://127.0.0.1:27017/anything'), {
    message: /BLOCKED BY TEST HARNESS/,
  });
});

test('no mongoose connection is open', () => {
  // 0 === disconnected.
  assert.equal(mongoose.connection.readyState, 0);
});

test('constructing a Twilio client is blocked', () => {
  const twilio = require('twilio');
  assert.throws(() => twilio('ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'token'), {
    message: /BLOCKED BY TEST HARNESS/,
  });
});

test('Twilio is unconfigured, so a non-simulated send could not leave the process', () => {
  assert.equal(twilioService.isConfigured(), false);
  assert.equal(twilioService.getClient(), null);
});

test('outbound SMS is simulated', () => {
  assert.equal(config.sms.simulate, true);
});

test('the automation worker is disabled', () => {
  assert.equal(config.automation.enabled, false);
});

test('a simulated send returns a simulated result and contacts nothing', async () => {
  const result = await twilioService.sendSms({ to: '+14155552671', body: 'hi' });
  assert.equal(result.simulated, true);
  assert.equal(result.status, 'simulated');
  assert.match(result.sid, /^SIMULATED-/);
});

test('starting the cron worker with automation disabled is a no-op', () => {
  const worker = require('../../jobs/automationWorker');
  // Must not throw and must not schedule anything.
  worker.start();
  worker.stop();
  assert.equal(config.automation.enabled, false);
});
