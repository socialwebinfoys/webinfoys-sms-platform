// Server startup order (index.js) and the startup gate (app.js).
//
// A managed Node.js host loads the entry file and expects listen() within a few
// seconds. Connecting to the database first made that impossible, so the server
// now listens immediately and holds API requests until startup has finished.
//
//   * index.js is loaded here with require() — NOT run as the main module — and
//     every dependency replaced by a recording double, so the ORDER of calls is
//     what is asserted, and nothing connects anywhere.
//   * The gate is exercised through the real Express app over real HTTP.
'use strict';

require('../_support/env');

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { stubModule, resolveAppModule } = require('../_support/stubs');

const INDEX = resolveAppModule('index.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 10; i += 1) await tick();
}

// ---------------------------------------------------------------------------
// index.js with recording doubles for everything it wires together.
function loadEntry({ connect, previousState = null, admin = { created: false, email: 'admin@test.invalid' } } = {}) {
  const events = [];
  const captured = { ready: null, listenPort: undefined, shutdownOptions: null };
  const realModules = ['app', 'config/db', 'jobs/automationWorker', 'jobs/aiWorker', 'utils/seedAdmin', 'utils/dbState', 'utils/gracefulShutdown'];
  const saved = new Map(realModules.map((m) => [resolveAppModule(m), require.cache[resolveAppModule(m)]]));

  stubModule('app', ({ ready } = {}) => {
    captured.ready = ready;
    events.push('createApp');
    return {
      listen(port, cb) {
        captured.listenPort = port;
        events.push('listen');
        if (cb) setImmediate(cb);
        return { close: (done) => done && done() };
      },
    };
  });
  stubModule('config/db', {
    connectDB: () => {
      events.push('connectDB:start');
      return connect().then(() => {
        events.push('connectDB:done');
      });
    },
    disconnectDB: async () => {},
  });
  stubModule('jobs/automationWorker', { start: () => events.push('automation.start'), shutdown: async () => ({ drained: true }) });
  stubModule('jobs/aiWorker', { start: () => events.push('ai.start'), shutdown: async () => ({ drained: true }) });
  stubModule('utils/seedAdmin', {
    ensureAdmin: async () => {
      events.push('ensureAdmin');
      return admin;
    },
  });
  stubModule('utils/dbState', {
    computeFingerprint: () => 'fingerprint',
    readState: () => previousState,
    writeState: () => events.push('writeState'),
  });
  stubModule('utils/gracefulShutdown', {
    createShutdownHandler: (options) => {
      captured.shutdownOptions = options;
      events.push('shutdownHandler');
      return async () => {};
    },
  });

  // Keep the test process itself untouched: no real exit, no leaked handlers.
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const exits = [];
  const lines = [];
  process.exit = (code) => { exits.push(code); };
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  const signalsBefore = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };

  delete require.cache[INDEX];
  require(INDEX); // loaded by require(), exactly as a host's loader does it
  const eventsAtLoad = [...events];

  const restore = () => {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      for (const listener of process.listeners(signal)) {
        if (!signalsBefore[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    delete require.cache[INDEX];
    for (const [id, mod] of saved) {
      if (mod) require.cache[id] = mod;
      else delete require.cache[id];
    }
  };
  return { events, eventsAtLoad, captured, exits, lines, restore };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('index.js — listen() is called before any asynchronous startup work', () => {
  let entry;
  afterEach(() => {
    if (entry) entry.restore();
    entry = null;
  });

  test('listen() has already been called by the time the entry file finishes loading', () => {
    const db = deferred();
    entry = loadEntry({ connect: () => db.promise });

    assert.ok(entry.eventsAtLoad.includes('listen'), 'listen() must be called synchronously on load');
    assert.ok(
      entry.eventsAtLoad.indexOf('listen') < entry.eventsAtLoad.indexOf('connectDB:start'),
      'and before the database connection is even started'
    );
    assert.equal(entry.eventsAtLoad.includes('connectDB:done'), false, 'the database is NOT connected yet');
    db.resolve();
  });

  test('it starts when loaded with require() — it does not depend on require.main === module', () => {
    entry = loadEntry({ connect: async () => {} });
    assert.notEqual(require.main && require.main.filename, INDEX, 'this test did not run it as the main module');
    assert.ok(entry.eventsAtLoad.includes('listen'));
    const source = fs.readFileSync(INDEX, 'utf8');
    assert.equal(/require\.main\s*===\s*module/.test(source.replace(/^\s*\/\/.*$/gm, '')), false);
    assert.match(source, /^start\(\);$/m, 'start() is called unconditionally');
  });

  test('it listens on the configured port', () => {
    entry = loadEntry({ connect: async () => {} });
    assert.equal(entry.captured.listenPort, require('../../config/env').config.port);
  });

  test('a slow database connection does not delay listen(), and nothing else starts until it connects', async () => {
    const db = deferred();
    entry = loadEntry({ connect: () => db.promise });
    await settle();

    assert.deepEqual(entry.events, ['createApp', 'listen', 'shutdownHandler', 'connectDB:start']);
    let ready = false;
    entry.captured.ready.then(() => { ready = true; });
    await settle();
    assert.equal(ready, false, 'requests stay held while the database is connecting');

    db.resolve();
    await settle();
    assert.deepEqual(entry.events, [
      'createApp', 'listen', 'shutdownHandler',
      'connectDB:start', 'connectDB:done',
      'ensureAdmin', 'writeState',
      'automation.start', 'ai.start',
    ]);
    assert.equal(ready, true, 'the gate opens only after the database, the admin check and the workers');
    assert.ok(entry.lines.some((l) => /Startup complete/.test(l)));
  });

  test('the admin check still runs before any request is released, and only for a new database configuration', async () => {
    entry = loadEntry({ connect: async () => {} });
    await settle();
    assert.ok(entry.events.includes('ensureAdmin'));
    entry.restore();

    entry = loadEntry({ connect: async () => {}, previousState: { mongoFingerprint: 'fingerprint' } });
    await settle();
    assert.equal(entry.events.includes('ensureAdmin'), false, 'unchanged configuration: no admin query, as before');
    assert.ok(entry.events.includes('automation.start'));
  });

  test('a database that cannot be reached still ends the process — and never opens the gate', async () => {
    entry = loadEntry({ connect: () => Promise.reject(new Error('server selection timed out')) });
    let ready = false;
    entry.captured.ready.then(() => { ready = true; });
    await settle();

    assert.deepEqual(entry.exits, [1]);
    assert.equal(ready, false);
    assert.equal(entry.events.includes('automation.start'), false, 'no worker starts without a database');
    assert.ok(entry.lines.some((l) => /Failed to start server: server selection timed out/.test(l)));
  });

  test('graceful shutdown is wired to the listening server from the start', () => {
    entry = loadEntry({ connect: async () => {} });
    assert.equal(typeof entry.captured.shutdownOptions.server.close, 'function');
    assert.equal(entry.captured.shutdownOptions.workers.length, 2);
    assert.ok(process.listeners('SIGTERM').length >= 1);
  });

  test('package.json starts the same file a host is pointed at', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    assert.equal(pkg.main, 'index.js');
    assert.equal(pkg.scripts.start, 'node index.js');
  });
});

// ---------------------------------------------------------------------------
describe('app.js — the startup gate holds requests instead of failing them', () => {
  const createApp = require('../../app');
  let server;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    server = null;
  });

  // One connection per request (no keep-alive pool), so nothing outlives a test.
  async function serve(options) {
    server = http.createServer(createApp(options));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return (route, init = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: route, method: init.method || 'GET', headers: init.headers || {}, agent: false },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                headers: { get: (name) => res.headers[name.toLowerCase()] },
                json: async () => JSON.parse(text),
              })
            );
          }
        );
        req.on('error', reject);
        if (init.body) req.write(init.body);
        req.end();
      });
  }
  const within = (promise, ms) =>
    Promise.race([promise.then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('waiting'), ms))]);

  test('the health check answers at once, before startup has finished', async () => {
    const get = await serve({ ready: new Promise(() => {}) });
    const res = await get('/api/health');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  });

  test('an API request is held while starting and handled normally once startup completes', async () => {
    const ready = deferred();
    const get = await serve({ ready: ready.promise });

    const pending = get('/api/contacts');
    assert.equal(await within(pending, 200), 'waiting', 'held, not answered and not refused');

    ready.resolve();
    const res = await pending;
    assert.equal(res.status, 401, 'then it reaches the real route, with authentication intact');
    assert.equal((await res.json()).message, 'Not authorized: no token provided');
  });

  test('several requests held together are all released', async () => {
    const ready = deferred();
    const get = await serve({ ready: ready.promise });
    const pending = ['/api/contacts', '/api/campaigns', '/api/auth/me', '/api/does-not-exist'].map((r) => get(r));
    assert.equal(await within(Promise.all(pending), 150), 'waiting');
    ready.resolve();
    const statuses = (await Promise.all(pending)).map((r) => r.status);
    assert.deepEqual(statuses, [401, 401, 401, 404]);
  });

  test('a webhook that arrives mid-start is held, then still has its signature checked', async () => {
    const ready = deferred();
    const post = await serve({ ready: ready.promise });
    const pending = post('/api/webhooks/twilio/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'From=%2B15122345678&Body=hello&MessageSid=SMstartup',
    });
    assert.equal(await within(pending, 150), 'waiting');
    ready.resolve();
    const res = await pending;
    // Validation is on and no auth token is configured in the test environment,
    // so the unsigned request is refused by the signature middleware.
    assert.ok([403, 503].includes(res.status), `refused by signature validation (${res.status})`);
    assert.notEqual(res.status, 200);
  });

  test('once started, requests pass straight through', async () => {
    const get = await serve({ ready: Promise.resolve() });
    await tick();
    const started = Date.now();
    const res = await get('/api/contacts');
    assert.equal(res.status, 401);
    assert.ok(Date.now() - started < 1000);
  });

  test('if startup fails, a request that was waiting gets a clean 503 with no internals', async () => {
    const ready = deferred();
    const get = await serve({ ready: ready.promise });
    const pending = get('/api/contacts');
    await within(pending, 100);
    ready.reject(new Error('mongodb+srv://user:secret@cluster/ unreachable'));
    const res = await pending;
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { success: false, message: 'The server is starting up. Please try again shortly.' });
    assert.equal(JSON.stringify(body).includes('secret'), false);
  });

  test('without a readiness promise the app is exactly as before (no gate)', async () => {
    const get = await serve();
    assert.equal((await get('/api/contacts')).status, 401);
    assert.equal((await get('/api/health')).status, 200);
  });

  test('security headers and CORS are applied to a held request exactly as to any other', async () => {
    const ready = deferred();
    const get = await serve({ ready: ready.promise });
    const pending = get('/api/contacts', { headers: { origin: 'http://localhost:5173' } });
    ready.resolve();
    const res = await pending;
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });
});
