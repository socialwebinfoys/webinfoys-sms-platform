// Phase 10 test harness — HTTP driver.
//
// Starts the REAL Express app (app.js, with helmet, cors, the body limits, the
// request logger, every router and the central error handler) on an ephemeral
// port and drives it with global fetch. No supertest dependency is needed.
//
// Call startApp() only AFTER the required module stubs are in place, because
// app.js pulls in every router and controller at require time.
'use strict';

require('./env');

const jwt = require('jsonwebtoken');

async function startApp() {
  // Required lazily so stubs registered by the test file win.
  const createApp = require('../../app');
  const app = createApp();

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function request(method, routePath, { body, token, headers = {}, raw } = {}) {
    const init = { method, headers: { ...headers } };

    if (raw !== undefined) {
      // Pre-encoded body, used for malformed-JSON and oversized-payload tests.
      init.body = raw;
      if (!init.headers['content-type'] && !init.headers['Content-Type']) {
        init.headers['content-type'] = 'application/json';
      }
    } else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (token) init.headers.authorization = `Bearer ${token}`;

    const res = await fetch(base + routePath, init);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, body: json, text };
  }

  return {
    base,
    server,
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),
    put: (p, o) => request('PUT', p, o),
    patch: (p, o) => request('PATCH', p, o),
    delete: (p, o) => request('DELETE', p, o),
    request,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Mint a token the real `protect` middleware will accept, using the same
// payload shape as utils/token.js.
function tokenFor(user, overrides = {}) {
  return jwt.sign(
    { id: String(user._id), role: user.role, ...overrides },
    process.env.JWT_SECRET,
    { expiresIn: overrides.expiresIn || '1h' }
  );
}

// A token signed with the wrong key — must never be accepted.
function tokenSignedWith(user, secret) {
  return jwt.sign({ id: String(user._id), role: user.role }, secret, { expiresIn: '1h' });
}

// An already-expired token, for the expiry path.
function expiredTokenFor(user) {
  return jwt.sign({ id: String(user._id), role: user.role }, process.env.JWT_SECRET, {
    expiresIn: '-1s',
  });
}

module.exports = { startApp, tokenFor, tokenSignedWith, expiredTokenFor };
