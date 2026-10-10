// Phase 10 — Stage 2A: login rate limiting.
//
// In its own file so the limiter's in-memory store starts empty (each test file
// is a separate process under `node --test`).
'use strict';

require('../_support/env');

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { stubModule, fakeModel, query } = require('../_support/stubs');
const f = require('../_support/factories');

stubModule('services/logService', { logEvent: async () => {} });

const PASSWORD = 'correct-horse-battery-staple';
const account = {
  ...f.user({ email: 'operator@test.invalid' }),
  password: bcrypt.hashSync(PASSWORD, 4),
  comparePassword(candidate) {
    return bcrypt.compare(candidate, this.password);
  },
  toJSON() {
    const { password, comparePassword, toJSON, ...rest } = this;
    return rest;
  },
};

stubModule(
  'models/User',
  fakeModel('User', {
    findOne: (filter) => query(filter && filter.email === account.email ? account : null),
    findById: () => query(account),
  })
);

const { startApp } = require('../_support/http');

let api;
before(async () => {
  api = await startApp();
});
after(async () => {
  await api.close();
});

const failedLogin = () =>
  api.post('/api/auth/login', { body: { email: account.email, password: 'wrong-password' } });
const goodLogin = () =>
  api.post('/api/auth/login', { body: { email: account.email, password: PASSWORD } });

describe('POST /api/auth/login is rate limited by failed attempt', () => {
  test('the first 10 failures are ordinary 401s', async () => {
    for (let i = 1; i <= 10; i += 1) {
      const res = await failedLogin();
      assert.equal(res.status, 401, `attempt ${i} should still be a 401, got ${res.status}`);
    }
  });

  test('the 11th failure is throttled with 429 and a clean JSON body', async () => {
    const res = await failedLogin();
    assert.equal(res.status, 429);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /Too many login attempts/);
    assert.equal('stack' in res.body, false);
  });

  test('the throttle response advertises standard RateLimit headers', async () => {
    const res = await failedLogin();
    assert.equal(res.status, 429);
    assert.ok(
      res.headers.get('ratelimit') || res.headers.get('ratelimit-remaining'),
      'expected draft-7 RateLimit headers'
    );
    assert.equal(res.headers.get('x-ratelimit-limit'), null, 'legacy headers are disabled');
  });

  test('once throttled, even CORRECT credentials are refused — the limiter runs first', async () => {
    const res = await goodLogin();
    assert.equal(res.status, 429);
    assert.equal(res.body.token, undefined);
  });

  test('the limiter does NOT apply to other routes', async () => {
    // Still inside the throttled window; an unrelated endpoint must be unaffected.
    const res = await api.get('/api/health');
    assert.equal(res.status, 200);
  });

  test('the limiter does not apply to the Twilio webhook (inbound SMS must not be dropped)', async () => {
    const res = await api.post('/api/webhooks/twilio/inbound', {
      raw: 'From=%2B14155552671&Body=hello',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    // 403 (bad signature) or 503 (no token) — the point is that it is NOT 429.
    assert.notEqual(res.status, 429);
  });
});
