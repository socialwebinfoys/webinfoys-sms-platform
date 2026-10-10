// The login session: ONE access token, valid for exactly seven days.
//
// There is no refresh token, no refresh endpoint and no silent renewal. A token
// is issued by a successful login and by nothing else; it works for seven days
// from that moment and then stops, after which the user logs in again.
//
// Real Express app, real `protect` middleware, real utils/token and real
// jsonwebtoken. The clock is moved with node:test's mock timers (Date only), so
// "six days and 23 hours later" is the actual verification code path, not a
// token forged with a shorter lifetime.
'use strict';

require('../_support/env');
// The harness default is 1h; this file is about the production lifetime.
process.env.JWT_EXPIRES_IN = '7d';

const { test, before, after, afterEach, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { stubModule, fakeModel, query } = require('../_support/stubs');
const f = require('../_support/factories');

const logged = [];
stubModule('services/logService', { logEvent: async (event) => void logged.push(event) });

const PASSWORD = 'correct-horse-battery-staple';
const withAuth = (user) => ({
  ...user,
  password: bcrypt.hashSync(PASSWORD, 4), // low cost: tests only
  comparePassword(candidate) {
    return bcrypt.compare(candidate, this.password);
  },
  toJSON() {
    const { password, comparePassword, toJSON, ...rest } = this;
    return rest;
  },
});
const operator = withAuth(f.user({ email: 'operator@test.invalid' }));
const administrator = withAuth(f.admin({ email: 'admin@test.invalid' }));
const users = [operator, administrator];
stubModule(
  'models/User',
  fakeModel('User', {
    findOne: (filter) => query(users.find((u) => u.email === (filter && filter.email)) || null),
    findById: (id) => query(users.find((u) => String(u._id) === String(id)) || null),
    find: () => query(users),
  })
);

const { config } = require('../../config/env');
const { signToken, verifyToken } = require('../../utils/token');
const { startApp } = require('../_support/http');

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60; // 604800

let api;
before(async () => {
  api = await startApp();
});
after(async () => {
  await api.close();
});
afterEach(() => {
  mock.timers.reset();
  operator.isActive = true;
  operator.role = 'user';
});

const login = (user = operator, password = PASSWORD) =>
  api.post('/api/auth/login', { body: { email: user.email, password } });
const me = (token) => api.get('/api/auth/me', { token });
// Freeze "now" at a whole second, then move it.
function freezeAt(ms) {
  mock.timers.enable({ apis: ['Date'], now: ms });
}
const T0 = Date.UTC(2026, 9, 12, 9, 0, 0); // a Monday morning

// ===========================================================================
describe('the token lifetime is seven days', () => {
  test('the configured lifetime is 7d, from the existing JWT_EXPIRES_IN setting', () => {
    assert.equal(config.jwt.expiresIn, '7d');
  });

  test('with JWT_EXPIRES_IN unset the default is also 7d', () => {
    const envId = require.resolve('../../config/env');
    const saved = process.env.JWT_EXPIRES_IN;
    delete process.env.JWT_EXPIRES_IN;
    delete require.cache[envId];
    try {
      assert.equal(require('../../config/env').config.jwt.expiresIn, '7d');
    } finally {
      process.env.JWT_EXPIRES_IN = saved;
      delete require.cache[envId];
      require('../../config/env');
    }
  });

  test('a token issued at login expires exactly 604,800 seconds after it was issued', async () => {
    const res = await login();
    assert.equal(res.status, 200);
    const { iat, exp } = jwt.decode(res.body.token);
    assert.equal(exp - iat, SEVEN_DAYS_SECONDS);
  });

  test('the token carries the user id, the role and its expiry — and nothing else', async () => {
    const payload = jwt.decode((await login()).body.token);
    assert.deepEqual(Object.keys(payload).sort(), ['exp', 'iat', 'id', 'role']);
    assert.equal(payload.id, String(operator._id));
  });

  test('it is signed with HS256 and the configured secret', async () => {
    const { token } = (await login()).body;
    assert.equal(jwt.decode(token, { complete: true }).header.alg, 'HS256');
    assert.doesNotThrow(() => jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }));
  });
});

// ===========================================================================
describe('a valid token keeps working for the whole seven days', () => {
  const CHECKPOINTS = {
    'one minute': 60 * SECOND,
    'one day': DAY,
    'three and a half days': 3.5 * DAY,
    'six days': 6 * DAY,
    'six days, 23 hours and 59 minutes': 7 * DAY - 60 * SECOND,
    'one second before the seven days are up': 7 * DAY - SECOND,
  };

  for (const [label, elapsed] of Object.entries(CHECKPOINTS)) {
    test(`still accepted after ${label}`, async () => {
      freezeAt(T0);
      const { token } = (await login()).body;
      mock.timers.setTime(T0 + elapsed);

      assert.doesNotThrow(() => verifyToken(token));
      const res = await me(token);
      assert.equal(res.status, 200, 'the user is NOT asked to log in again');
      assert.equal(res.body.user.email, operator.email);
    });
  }

  test('the same token is accepted on an ordinary protected route all week, with no new login', async () => {
    freezeAt(T0);
    const { token } = (await login()).body;
    const loginsBefore = logged.filter((e) => e.eventType === 'auth.login').length;
    for (let day = 0; day < 7; day += 1) {
      mock.timers.setTime(T0 + day * DAY + 5 * 60 * SECOND);
      assert.equal((await api.get('/api/users', { token })).status, 200, `day ${day + 1}`);
    }
    assert.equal(logged.filter((e) => e.eventType === 'auth.login').length, loginsBefore);
  });
});

// ===========================================================================
describe('after seven days the token stops working', () => {
  for (const [label, elapsed] of Object.entries({
    'at exactly seven days': 7 * DAY,
    'one second after': 7 * DAY + SECOND,
    'a day after': 8 * DAY,
    'a year after': 372 * DAY,
  })) {
    test(`rejected ${label}`, async () => {
      freezeAt(T0);
      const { token } = (await login()).body;
      mock.timers.setTime(T0 + elapsed);

      assert.throws(() => verifyToken(token), { name: 'TokenExpiredError' });
      const res = await me(token);
      assert.equal(res.status, 401);
      assert.equal(res.body.success, false);
      assert.equal(res.body.token, undefined, 'no replacement token is handed out');
    });
  }

  test('an expired token is refused on every kind of route, reads and writes alike', async () => {
    freezeAt(T0);
    const { token } = (await login(administrator)).body;
    mock.timers.setTime(T0 + 7 * DAY + SECOND);
    const attempts = [
      api.get('/api/auth/me', { token }),
      api.get('/api/users', { token }),
      api.post('/api/auth/register', { token, body: { name: 'X', email: 'x@test.invalid', password: 'a-long-enough-password' } }),
      api.patch(`/api/users/${operator._id}`, { token, body: { isActive: false } }),
    ];
    for (const res of await Promise.all(attempts)) assert.equal(res.status, 401);
    assert.equal(operator.isActive, true, 'nothing was changed with the expired token');
  });

  test('the user can simply log in again and gets a fresh seven days', async () => {
    freezeAt(T0);
    const first = (await login()).body.token;
    mock.timers.setTime(T0 + 9 * DAY);
    assert.equal((await me(first)).status, 401);

    const again = await login();
    assert.equal(again.status, 200);
    const { iat, exp } = jwt.decode(again.body.token);
    assert.equal(iat, Math.floor((T0 + 9 * DAY) / 1000));
    assert.equal(exp - iat, SEVEN_DAYS_SECONDS);
    assert.equal((await me(again.body.token)).status, 200);
    assert.equal((await me(first)).status, 401, 'the old token stays dead');
  });
});

// ===========================================================================
describe('no refresh, no renewal, no extension', () => {
  test('using a token never extends it: the expiry is fixed at login', async () => {
    freezeAt(T0);
    const { token } = (await login()).body;
    const { exp } = jwt.decode(token);
    // Heavy use right up to the end of day six…
    for (let day = 0; day < 7; day += 1) {
      mock.timers.setTime(T0 + day * DAY + 23 * 60 * 60 * SECOND);
      const res = await me(token);
      assert.equal(res.status, 200);
      assert.equal(res.body.token, undefined, 'a request never returns a new token');
      assert.equal(res.headers.authorization, undefined);
      assert.equal(res.headers['set-cookie'], undefined);
    }
    // …does not buy a single extra second.
    assert.equal(jwt.decode(token).exp, exp);
    mock.timers.setTime(exp * 1000);
    assert.equal((await me(token)).status, 401);
  });

  test('there is no refresh endpoint of any name', async () => {
    const { token } = (await login()).body;
    for (const route of ['/api/auth/refresh', '/api/auth/refresh-token', '/api/auth/token', '/api/auth/renew', '/api/auth/logout']) {
      for (const method of ['get', 'post']) {
        const res = await api[method](route, method === 'post' ? { token, body: {} } : { token });
        assert.equal(res.status, 404, `${method.toUpperCase()} ${route}`);
      }
    }
  });

  test('login is the only place a token is issued', () => {
    const root = path.join(__dirname, '..', '..');
    const issuers = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'test') continue;
        const file = path.join(dir, entry);
        if (fs.statSync(file).isDirectory()) walk(file);
        else if (entry.endsWith('.js') && /signToken\(|jwt\.sign\(/.test(fs.readFileSync(file, 'utf8'))) {
          issuers.push(path.relative(root, file).replace(/\\/g, '/'));
        }
      }
    })(root);
    assert.deepEqual(issuers.sort(), ['controllers/authController.js', 'utils/token.js']);
    const routes = fs.readFileSync(path.join(root, 'routes', 'authRoutes.js'), 'utf8');
    assert.deepEqual(routes.match(/router\.(get|post|put|patch|delete)\('[^']+'/g), [
      "router.post('/login'",
      "router.get('/me'",
      "router.post('/register'",
    ]);
  });

  test('an already-expired token cannot be exchanged for anything at login', async () => {
    freezeAt(T0);
    const { token } = (await login()).body;
    mock.timers.setTime(T0 + 8 * DAY);
    // Presenting the dead token to the login route without a password gets nothing.
    const res = await api.post('/api/auth/login', { token, body: { email: operator.email } });
    assert.equal(res.status, 400);
    assert.equal(res.body.token, undefined);
  });
});

// ===========================================================================
describe('the existing protections are unchanged inside the seven days', () => {
  test('a deactivated user is locked out at once, even with a fresh token', async () => {
    const { token } = (await login()).body;
    assert.equal((await me(token)).status, 200);
    operator.isActive = false;
    assert.equal((await me(token)).status, 401);
    assert.equal((await login()).status, 403, 'and cannot log in');
  });

  test('the role is read from the account on every request, not trusted from the token', async () => {
    const { token } = (await login()).body;
    const adminOnly = () => api.post('/api/auth/register', { token, body: { name: 'N', email: 'n@test.invalid', password: 'a-long-enough-password' } });
    assert.equal((await adminOnly()).status, 403, 'an operator token cannot use an admin route');
    // A token whose payload CLAIMS admin does not help either.
    const forged = jwt.sign({ id: String(operator._id), role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    assert.equal((await api.post('/api/auth/register', { token: forged, body: { name: 'N', email: 'n2@test.invalid', password: 'a-long-enough-password' } })).status, 403);
  });

  test('a token signed with another key, or with no signature, is refused', async () => {
    const wrongKey = jwt.sign({ id: String(operator._id), role: 'user' }, 'some-other-signing-key-of-sufficient-length', { expiresIn: '7d' });
    assert.equal((await me(wrongKey)).status, 401);
    const unsigned = jwt.sign({ id: String(operator._id), role: 'user' }, '', { algorithm: 'none' });
    assert.equal((await me(unsigned)).status, 401);
    assert.equal((await me('not-a-token')).status, 401);
    assert.equal((await api.get('/api/auth/me')).status, 401);
  });

  test('a wrong password is still refused, and the password is stored only as a bcrypt hash', async () => {
    assert.equal((await login(operator, 'the-wrong-password')).status, 401);
    assert.match(operator.password, /^\$2[aby]\$/);
    const model = fs.readFileSync(path.join(__dirname, '..', '..', 'models', 'User.js'), 'utf8');
    assert.match(model, /bcrypt\.hash\(this\.password, salt\)/);
  });

  test('login is still rate-limited', () => {
    const routes = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'authRoutes.js'), 'utf8');
    assert.match(routes, /router\.post\('\/login', loginLimiter, login\)/);
  });

  test('neither the token nor the password is ever written to the log', async () => {
    logged.length = 0;
    const { token } = (await login()).body;
    await login(operator, 'the-wrong-password');
    await me(token);
    const everything = JSON.stringify(logged);
    assert.ok(logged.some((e) => e.eventType === 'auth.login'));
    assert.equal(everything.includes(token), false);
    assert.equal(everything.includes(token.split('.')[2]), false, 'not even the signature');
    assert.equal(everything.includes(PASSWORD), false);
    assert.equal(everything.includes('the-wrong-password'), false);
    assert.equal(everything.includes(process.env.JWT_SECRET), false);
  });
});
