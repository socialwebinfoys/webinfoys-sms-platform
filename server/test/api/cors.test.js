// Cross-origin access from the production frontend.
//
//   frontend  https://sms.webinfoys.com
//   API       https://sms-api.webinfoys.com
//
// The real Express app is built for several environments — including the one
// production was actually running with (NODE_ENV=development,
// CORS_ORIGIN=http://localhost:5173), which refused the real frontend — and
// driven over real HTTP with the headers a browser sends.
'use strict';

require('../_support/env');

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { stubModule, fakeModel, query, resolveAppModule } = require('../_support/stubs');

stubModule('services/logService', { logEvent: async () => {} });
// No account exists, so every login is a clean 401 "Invalid credentials".
stubModule('models/User', fakeModel('User', { findOne: () => query(null), findById: () => query(null) }));

const FRONTEND = 'https://sms.webinfoys.com';
const API = 'https://sms-api.webinfoys.com';

// What the host was running with when the browser reported "CORS error".
const AS_DEPLOYED = { NODE_ENV: 'development', CORS_ORIGIN: 'http://localhost:5173' };
const PRODUCTION = {
  NODE_ENV: 'production',
  CORS_ORIGIN: FRONTEND,
  PUBLIC_API_URL: API,
  TWILIO_WEBHOOK_BASE_URL: API,
  TWILIO_VALIDATE_WEBHOOK: 'true',
};

// The modules that capture configuration when they are first loaded.
const RELOADED = ['config/env', 'app', 'middleware/rateLimiter', 'routes/authRoutes', 'routes/aiRoutes', 'middleware/errorHandler'];

let server;
let restoreEnv = () => {};
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  server = null;
  restoreEnv();
  restoreEnv = () => {};
});

function loadWith(env) {
  const saved = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  Object.assign(process.env, env);
  for (const m of RELOADED) delete require.cache[resolveAppModule(m)];
  restoreEnv = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const m of RELOADED) delete require.cache[resolveAppModule(m)];
  };
  const env_ = require('../../config/env');
  return { createApp: require('../../app'), config: env_.config, validateConfig: env_.validateConfig };
}

async function serve(env, appOptions) {
  const loaded = loadWith(env);
  server = http.createServer(loaded.createApp(appOptions));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const call = (method, route, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1', port, path: route, method, agent: false,
          headers: {
            ...(payload !== null && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}),
            ...(payload !== null ? { 'content-length': Buffer.byteLength(payload) } : {}),
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        }
      );
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  return { call, ...loaded };
}

// The preflight Chrome sends before a JSON POST or an authenticated request.
const preflight = (api, route, { origin = FRONTEND, method = 'POST', headers = 'content-type' } = {}) =>
  api.call('OPTIONS', route, {
    headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': headers },
  });
const list = (value) => String(value || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
const login = (api, origin = FRONTEND) =>
  api.call('POST', '/api/auth/login', { headers: { origin }, body: { email: 'nobody@test.invalid', password: 'wrong-password-123' } });

// ===========================================================================
for (const [label, env] of Object.entries({
  'as production was deployed (development mode, CORS_ORIGIN=http://localhost:5173)': AS_DEPLOYED,
  'correctly configured production (CORS_ORIGIN=https://sms.webinfoys.com)': PRODUCTION,
})) {
  describe(`the production frontend is allowed — ${label}`, () => {
    test('the login preflight is answered 204 with the exact origin, method and headers', async () => {
      const api = await serve(env);
      const res = await preflight(api, '/api/auth/login');

      assert.equal(res.status, 204);
      assert.equal(res.headers['access-control-allow-origin'], FRONTEND, 'the exact origin, not "*"');
      assert.ok(list(res.headers['access-control-allow-methods']).includes('post'));
      assert.ok(list(res.headers['access-control-allow-headers']).includes('content-type'));
      assert.ok(list(res.headers['access-control-allow-headers']).includes('authorization'));
      assert.ok(list(res.headers.vary).includes('origin'), 'responses differ by origin, so caches must too');
      assert.equal(res.headers['access-control-max-age'], '600');
      assert.equal(res.text, '', 'a preflight has no body');
    });

    test('the login request itself then carries the CORS header (so the browser can read the answer)', async () => {
      const api = await serve(env);
      const res = await login(api);
      assert.equal(res.status, 401, 'the real route ran: wrong credentials');
      assert.equal(JSON.parse(res.text).message, 'Invalid credentials');
      assert.equal(res.headers['access-control-allow-origin'], FRONTEND);
    });

    test('preflights for the other API routes and methods are answered the same way', async () => {
      const api = await serve(env);
      const cases = [
        ['GET', '/api/auth/me'],
        ['GET', '/api/conversations/unread-count'],
        ['POST', '/api/sms/send'],
        ['POST', '/api/contacts/import/preview'],
        ['PUT', '/api/contacts/6a9a77ec9990e8f4bb000001'],
        ['PATCH', '/api/enrollments/6a9a77ec9990e8f4bb000001'],
        ['DELETE', '/api/conversations/6a9a77ec9990e8f4bb000001'],
      ];
      for (const [method, route] of cases) {
        const res = await preflight(api, route, { method, headers: 'authorization,content-type' });
        assert.equal(res.status, 204, `${method} ${route}`);
        assert.equal(res.headers['access-control-allow-origin'], FRONTEND, `${method} ${route}`);
        assert.ok(list(res.headers['access-control-allow-methods']).includes(method.toLowerCase()), `${method} ${route}`);
      }
    });

    test('every kind of answer is readable by the frontend: 200, 401, 404 and 400', async () => {
      const api = await serve(env);
      const origin = { origin: FRONTEND };
      const answers = {
        200: await api.call('GET', '/api/health', { headers: origin }),
        401: await api.call('GET', '/api/contacts', { headers: origin }),
        404: await api.call('GET', '/api/no-such-route', { headers: origin }),
        400: await api.call('POST', '/api/auth/login', { headers: origin, body: {} }),
      };
      for (const [status, res] of Object.entries(answers)) {
        assert.equal(res.status, Number(status));
        assert.equal(res.headers['access-control-allow-origin'], FRONTEND, `status ${status}`);
      }
    });

    test('a URL missing the /api prefix now shows as a plain 404, not as a "CORS error"', async () => {
      const api = await serve(env);
      // What the deployed frontend was calling.
      const pre = await preflight(api, '/auth/login');
      assert.equal(pre.status, 204);
      assert.equal(pre.headers['access-control-allow-origin'], FRONTEND);
      const res = await api.call('POST', '/auth/login', { headers: { origin: FRONTEND }, body: { email: 'a@b.c', password: 'x' } });
      assert.equal(res.status, 404);
      assert.equal(res.headers['access-control-allow-origin'], FRONTEND);
      assert.match(JSON.parse(res.text).message, /Route not found: \/auth\/login/);
    });

    test('credentials mode is never enabled, so it can never be combined with a wildcard', async () => {
      const api = await serve(env);
      for (const res of [await preflight(api, '/api/auth/login'), await login(api), await api.call('GET', '/api/health', { headers: { origin: FRONTEND } })]) {
        assert.equal(res.headers['access-control-allow-credentials'], undefined);
        assert.notEqual(res.headers['access-control-allow-origin'], '*');
      }
    });
  });
}

// ===========================================================================
describe('preflights run before authentication and rate limiting', () => {
  test('a preflight needs no token, even for a protected route', async () => {
    const api = await serve(PRODUCTION);
    const res = await preflight(api, '/api/contacts', { method: 'GET', headers: 'authorization' });
    assert.equal(res.status, 204);
    // …while the request itself is still refused without one.
    assert.equal((await api.call('GET', '/api/contacts', { headers: { origin: FRONTEND } })).status, 401);
  });

  test('preflights are not counted as login attempts', async () => {
    const api = await serve(PRODUCTION);
    for (let i = 0; i < 25; i += 1) assert.equal((await preflight(api, '/api/auth/login')).status, 204);
    assert.equal((await login(api)).status, 401, 'the login limiter has not been touched');
  });

  test('the login rate limit still applies to real attempts, and its 429 is readable too', async () => {
    const api = await serve(PRODUCTION);
    let last;
    for (let i = 0; i < 11; i += 1) last = await login(api);
    assert.equal(last.status, 429);
    assert.equal(last.headers['access-control-allow-origin'], FRONTEND);
    assert.match(JSON.parse(last.text).message, /Too many login attempts/);
  });

  test('a preflight is answered at once even while the server is still starting', async () => {
    const api = await serve(PRODUCTION, { ready: new Promise(() => {}) });
    const res = await preflight(api, '/api/auth/login');
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], FRONTEND);
  });

  test('the cors middleware is registered before the startup gate and every route', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
    const at = (needle) => {
      const i = source.indexOf(needle);
      assert.ok(i >= 0, `expected to find ${needle}`);
      return i;
    };
    const cors = at('app.use(cors(buildCorsOptions()));');
    assert.ok(cors < at('app.use(express.json('), 'before body parsing');
    assert.ok(cors < at("app.get('/api/health'"), 'before the health route');
    assert.ok(cors < at('if (ready && typeof ready.then'), 'before the startup gate');
    assert.ok(cors < at("app.use('/api/auth', authRoutes);"), 'before the auth routes (and their rate limiter)');
    assert.ok(cors < at("app.use('/api/webhooks', webhookRoutes);"));
    assert.ok(cors < at('app.use(notFound);'), 'before the 404 and error handlers');
  });
});

// ===========================================================================
describe('other origins are still refused', () => {
  const STRANGERS = [
    'https://evil.example.com',
    'http://sms.webinfoys.com', // http, not https
    'https://sms.webinfoys.com.evil.example.com',
    'https://webinfoys.com',
    'https://www.sms.webinfoys.com',
    'https://sms-api.webinfoys.com',
    'null',
  ];

  for (const origin of STRANGERS) {
    test(`${origin} gets no CORS headers`, async () => {
      const api = await serve(PRODUCTION);
      const pre = await preflight(api, '/api/auth/login', { origin });
      assert.equal(pre.headers['access-control-allow-origin'], undefined);
      assert.equal(pre.headers['access-control-allow-methods'], undefined);
      const res = await login(api, origin);
      assert.equal(res.headers['access-control-allow-origin'], undefined, 'the browser will not expose the response');
    });
  }

  test('in production the development origin is NOT allowed unless it is configured', async () => {
    const api = await serve(PRODUCTION);
    const res = await preflight(api, '/api/auth/login', { origin: 'http://localhost:5173' });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  test('a refused origin is written to the server log once, with the allowed list', async () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const api = await serve(PRODUCTION);
      for (let i = 0; i < 3; i += 1) await preflight(api, '/api/auth/login', { origin: 'https://evil.example.com' });
      const cors = warnings.filter((w) => w.startsWith('CORS: refused'));
      assert.equal(cors.length, 1, 'once per origin, not once per request');
      assert.match(cors[0], /"https:\/\/evil\.example\.com"/);
      assert.match(cors[0], /Allowed origins: https:\/\/sms\.webinfoys\.com/);
    } finally {
      console.warn = original;
    }
  });
});

// ===========================================================================
describe('requests that are not from a browser are unaffected', () => {
  test('no Origin header (Twilio, curl, server-to-server) is served, with no CORS headers needed', async () => {
    const api = await serve(PRODUCTION);
    const res = await api.call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  test('a Twilio webhook still has to pass signature validation', async () => {
    const api = await serve(PRODUCTION);
    const form = 'From=%2B15122345678&Body=hello&MessageSid=SMcors1';
    const fromTwilio = await api.call('POST', '/api/webhooks/twilio/inbound', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    assert.ok([403, 503].includes(fromTwilio.status), `unsigned request refused (${fromTwilio.status})`);
    // Being an allowed ORIGIN does not get a request past the signature check.
    const fromBrowser = await api.call('POST', '/api/webhooks/twilio/inbound', {
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: FRONTEND },
      body: form,
    });
    assert.ok([403, 503].includes(fromBrowser.status));
  });

  test('helmet’s security headers are still sent', async () => {
    const api = await serve(PRODUCTION);
    const res = await api.call('GET', '/api/health', { headers: { origin: FRONTEND } });
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['strict-transport-security']);
    assert.equal(res.headers['x-powered-by'], undefined);
  });
});

// ===========================================================================
describe('the allow-list', () => {
  test('the production frontend is always on it, alongside whatever CORS_ORIGIN lists', () => {
    assert.deepEqual(loadWith(AS_DEPLOYED).config.corsAllowedOrigins, ['http://localhost:5173', FRONTEND]);
    restoreEnv();
    assert.deepEqual(loadWith(PRODUCTION).config.corsAllowedOrigins, [FRONTEND], 'not listed twice');
    restoreEnv();
    const several = loadWith({ ...PRODUCTION, CORS_ORIGIN: 'https://staging.webinfoys.com, https://sms.webinfoys.com' });
    assert.deepEqual(several.config.corsAllowedOrigins, ['https://staging.webinfoys.com', FRONTEND]);
    assert.deepEqual(several.config.corsOrigins, ['https://staging.webinfoys.com', FRONTEND], 'the configured list itself is unchanged');
  });

  test('an origin written with a trailing slash or capitals is matched as the browser sends it', async () => {
    const api = await serve({ ...PRODUCTION, CORS_ORIGIN: 'https://Staging.Webinfoys.com/' });
    assert.deepEqual(api.config.corsOrigins, ['https://staging.webinfoys.com']);
    assert.doesNotThrow(() => api.validateConfig());
    const res = await preflight(api, '/api/auth/login', { origin: 'https://staging.webinfoys.com' });
    assert.equal(res.headers['access-control-allow-origin'], 'https://staging.webinfoys.com');
  });

  test('production still refuses to start with a wildcard, or with an entry that is not an origin', () => {
    assert.throws(() => loadWith({ ...PRODUCTION, CORS_ORIGIN: '*' }).validateConfig(), /must not be "\*" in production/);
    restoreEnv();
    assert.throws(() => loadWith({ ...PRODUCTION, CORS_ORIGIN: 'https://sms.webinfoys.com/login' }).validateConfig(), /not a bare origin/);
    restoreEnv();
    assert.doesNotThrow(() => loadWith(PRODUCTION).validateConfig());
  });

  test('the development wildcard answers "*" and never with credentials', async () => {
    const api = await serve({ NODE_ENV: 'development', CORS_ORIGIN: '*' });
    assert.equal(api.config.corsAllowAll, true);
    const pre = await preflight(api, '/api/auth/login', { origin: 'http://localhost:5173' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], '*');
    assert.equal(pre.headers['access-control-allow-credentials'], undefined);
    const res = await login(api, 'http://localhost:5173');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  });

  test('no CORS option in the app turns credentials on', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /credentials\s*:/);
  });
});
