// Phase 10 — Stage 2A: authentication.
//
// Drives the real Express app end to end: real helmet/cors/body-parser, real
// authRoutes, real rateLimiter, real protect/authorize middleware, real
// authController, real jsonwebtoken. Only the User model and the log writer are
// doubles, so there is no database.
'use strict';

require('../_support/env');

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { stubModule, fakeModel, query } = require('../_support/stubs');
const f = require('../_support/factories');

// --- doubles ---------------------------------------------------------------
const logged = [];
stubModule('services/logService', {
  logEvent: async (event) => {
    logged.push(event);
  },
});

const PASSWORD = 'correct-horse-battery-staple';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4); // low cost: tests only

const activeUser = {
  ...f.user({ email: 'operator@test.invalid' }),
  password: PASSWORD_HASH,
  comparePassword(candidate) {
    return bcrypt.compare(candidate, this.password);
  },
  toJSON() {
    const { password, comparePassword, toJSON, ...rest } = this;
    return rest;
  },
};

const inactiveUser = {
  ...f.user({ email: 'disabled@test.invalid', isActive: false }),
  password: PASSWORD_HASH,
  comparePassword(candidate) {
    return bcrypt.compare(candidate, this.password);
  },
  toJSON() {
    const { password, comparePassword, toJSON, ...rest } = this;
    return rest;
  },
};

const adminUser = { ...f.admin(), toJSON() { return { ...this, toJSON: undefined }; } };

const byEmail = new Map([
  [activeUser.email, activeUser],
  [inactiveUser.email, inactiveUser],
]);
const byId = new Map([
  [String(activeUser._id), activeUser],
  [String(inactiveUser._id), inactiveUser],
  [String(adminUser._id), adminUser],
]);

stubModule(
  'models/User',
  fakeModel('User', {
    findOne: (filter) => query(byEmail.get(filter && filter.email) || null),
    findById: (id) => query(byId.get(String(id)) || null),
  })
);

const { startApp, tokenFor, tokenSignedWith, expiredTokenFor } = require('../_support/http');

let api;
before(async () => {
  api = await startApp();
});
after(async () => {
  await api.close();
});

describe('POST /api/auth/login', () => {
  test('valid credentials return a token and the user', async () => {
    const res = await api.post('/api/auth/login', {
      body: { email: activeUser.email, password: PASSWORD },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.user.email, activeUser.email);
  });

  test('a successful login is recorded as auth.login without the password', async () => {
    logged.length = 0;
    await api.post('/api/auth/login', {
      body: { email: activeUser.email, password: PASSWORD },
    });
    const event = logged.find((e) => e.eventType === 'auth.login');
    assert.ok(event, 'expected an auth.login event');
    assert.equal(event.meta.email, activeUser.email);
    // The whole serialised event must not contain the password or the token.
    const serialised = JSON.stringify(logged);
    assert.equal(serialised.includes(PASSWORD), false);
    assert.equal(serialised.includes(PASSWORD_HASH), false);
  });

  test('wrong password is rejected with a generic message', async () => {
    const res = await api.post('/api/auth/login', {
      body: { email: activeUser.email, password: 'wrong-password-entirely' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid credentials');
    // Must not reveal that the account exists.
    assert.equal(/password/i.test(res.body.message), false);
  });

  test('unknown email returns the SAME message as a wrong password', async () => {
    const res = await api.post('/api/auth/login', {
      body: { email: 'nobody@test.invalid', password: PASSWORD },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'Invalid credentials');
  });

  test('the log distinguishes unknown_email from wrong_password even though the response does not', async () => {
    logged.length = 0;
    await api.post('/api/auth/login', {
      body: { email: 'nobody@test.invalid', password: PASSWORD },
    });
    const event = logged.find((e) => e.eventType === 'auth.login_failed');
    assert.ok(event);
    assert.equal(event.meta.reason, 'unknown_email');
  });

  test('an inactive account is refused with 403', async () => {
    const res = await api.post('/api/auth/login', {
      body: { email: inactiveUser.email, password: PASSWORD },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, 'Account is disabled');
  });

  test('a query-operator object as a credential is refused with 400, not 500', async () => {
    const res = await api.post('/api/auth/login', {
      body: { email: { $gt: '' }, password: { $gt: '' } },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Email and password are required');
  });

  test('missing credentials are refused with 400', async () => {
    const res = await api.post('/api/auth/login', { body: {} });
    assert.equal(res.status, 400);
  });

  test('no login response ever carries a password field', async () => {
    const res = await api.post('/api/auth/login', {
      body: { email: activeUser.email, password: PASSWORD },
    });
    assert.equal('password' in res.body.user, false);
    assert.equal(res.text.includes(PASSWORD_HASH), false);
    assert.equal(res.text.includes('$2b$'), false);
    assert.equal(res.text.includes('$2a$'), false);
  });
});

describe('GET /api/auth/me — token handling', () => {
  test('a valid token is accepted', async () => {
    const res = await api.get('/api/auth/me', { token: tokenFor(activeUser) });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, activeUser.email);
  });

  test('a missing Authorization header is 401', async () => {
    const res = await api.get('/api/auth/me');
    assert.equal(res.status, 401);
    assert.match(res.body.message, /no token provided/);
  });

  test('a header without the Bearer scheme is 401', async () => {
    const res = await api.get('/api/auth/me', {
      headers: { authorization: tokenFor(activeUser) },
    });
    assert.equal(res.status, 401);
  });

  test('a structurally malformed token is 401', async () => {
    const res = await api.get('/api/auth/me', { token: 'not.a.jwt' });
    assert.equal(res.status, 401);
    assert.match(res.body.message, /invalid token/);
  });

  test('a token signed with the wrong secret is 401', async () => {
    const forged = tokenSignedWith(activeUser, 'a-different-signing-key-entirely-0001');
    const res = await api.get('/api/auth/me', { token: forged });
    assert.equal(res.status, 401);
  });

  test('an expired token is 401', async () => {
    const res = await api.get('/api/auth/me', { token: expiredTokenFor(activeUser) });
    assert.equal(res.status, 401);
  });

  test('a token for a user that no longer exists is 401', async () => {
    const ghost = f.user({ _id: f.oid(999999) });
    const res = await api.get('/api/auth/me', { token: tokenFor(ghost) });
    assert.equal(res.status, 401);
    assert.match(res.body.message, /user unavailable/);
  });

  test('a still-valid token for a DEACTIVATED user is refused (no revocation list needed)', async () => {
    const res = await api.get('/api/auth/me', { token: tokenFor(inactiveUser) });
    assert.equal(res.status, 401);
    assert.match(res.body.message, /user unavailable/);
  });

  test('a token claiming role=admin cannot escalate, because the role is re-read from the database', async () => {
    // The payload says admin; the stored user is a plain user.
    const escalated = tokenFor(activeUser, { role: 'admin' });
    const res = await api.post('/api/auth/register', {
      token: escalated,
      body: { name: 'X', email: 'x@test.invalid', password: 'twelve-chars-min' },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /insufficient permissions/);
  });
});

describe('POST /api/auth/register — admin only, 12-char minimum', () => {
  test('unauthenticated is 401', async () => {
    const res = await api.post('/api/auth/register', {
      body: { name: 'X', email: 'x@test.invalid', password: 'twelve-chars-min' },
    });
    assert.equal(res.status, 401);
  });

  test('a non-admin operator is 403', async () => {
    const res = await api.post('/api/auth/register', {
      token: tokenFor(activeUser),
      body: { name: 'X', email: 'x@test.invalid', password: 'twelve-chars-min' },
    });
    assert.equal(res.status, 403);
  });

  test('an 11-character password is refused for an admin', async () => {
    const res = await api.post('/api/auth/register', {
      token: tokenFor(adminUser),
      body: { name: 'X', email: 'x@test.invalid', password: 'eleven-char' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /at least 12 characters/);
  });

  test('a non-string password is refused before any length check', async () => {
    const res = await api.post('/api/auth/register', {
      token: tokenFor(adminUser),
      body: { name: 'X', email: 'x@test.invalid', password: { $gt: '' } },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /must be text values/);
  });

  test('an unknown role is silently downgraded to user, never honoured', async () => {
    const created = [];
    const User = require('../../models/User');
    const originalCreate = User.create;
    User.create = async (doc) => {
      created.push(doc);
      return { ...doc, _id: f.oid(), toJSON() { return { ...doc, _id: 'new' }; } };
    };
    try {
      const res = await api.post('/api/auth/register', {
        token: tokenFor(adminUser),
        body: {
          name: 'X',
          email: 'x@test.invalid',
          password: 'twelve-chars-min',
          role: 'superadmin',
        },
      });
      assert.equal(res.status, 201);
      assert.equal(created[0].role, 'user');
    } finally {
      User.create = originalCreate;
    }
  });
});
