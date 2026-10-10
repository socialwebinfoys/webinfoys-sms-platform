// Graceful shutdown orchestration (utils/gracefulShutdown.js): the order things
// are stopped in, the exit code, the hard timeout, and that a second signal
// cannot start a second shutdown.
'use strict';

require('../_support/env');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createShutdownHandler, FORCE_EXIT_GRACE_MS } = require('../../utils/gracefulShutdown');

const quiet = { log: () => {}, error: () => {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(overrides = {}) {
  const events = [];
  const exits = [];
  const server = {
    close(cb) {
      events.push('server.close');
      setImmediate(() => {
        events.push('server.closed');
        cb();
      });
    },
  };
  const worker = (name, result = { drained: true, waitedFor: 0 }, delayMs = 0) => ({
    async shutdown(options) {
      events.push(`${name}.shutdown:${options.timeoutMs}`);
      if (delayMs) await sleep(delayMs);
      events.push(`${name}.done`);
      return result;
    },
  });
  const options = {
    server,
    workers: [worker('automation'), worker('ai')],
    disconnect: async () => { events.push('db.disconnect'); },
    timeoutMs: 500,
    exit: (code) => { exits.push(code); },
    log: quiet,
    ...overrides,
  };
  return { events, exits, worker, shutdown: createShutdownHandler(options) };
}

describe('graceful shutdown', () => {
  test('stops taking connections, drains the workers, closes the database, then exits 0', async () => {
    const h = harness();
    const result = await h.shutdown('SIGTERM');

    assert.deepEqual(result, { drained: true });
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.events[0], 'server.close', 'new connections are refused first');
    const at = (e) => h.events.indexOf(e);
    assert.ok(at('automation.shutdown:500') < at('db.disconnect'));
    assert.ok(at('automation.done') < at('db.disconnect'), 'the database stays open until the workers are done');
    assert.ok(at('ai.done') < at('db.disconnect'));
    assert.ok(at('server.closed') < at('db.disconnect'));
    assert.equal(h.events[h.events.length - 1], 'db.disconnect');
  });

  test('every worker is given the configured timeout', async () => {
    const h = harness({ timeoutMs: 1234 });
    await h.shutdown('SIGTERM');
    assert.ok(h.events.includes('automation.shutdown:1234'));
    assert.ok(h.events.includes('ai.shutdown:1234'));
  });

  test('it waits for a worker pass that is still running', async () => {
    const h = harness();
    const slow = harness().worker('automation', { drained: true, waitedFor: 1 }, 80);
    const events = [];
    const shutdown = createShutdownHandler({
      server: { close: (cb) => cb() },
      workers: [slow],
      disconnect: async () => { events.push('db.disconnect'); },
      timeoutMs: 500,
      exit: (code) => { events.push(`exit:${code}`); },
      log: quiet,
    });
    const started = Date.now();
    await shutdown('SIGTERM');
    assert.ok(Date.now() - started >= 70, 'the exit did not overtake the worker');
    assert.deepEqual(events, ['db.disconnect', 'exit:0']);
    assert.equal(h.exits.length, 0);
  });

  test('a worker that could not finish in time means a non-zero exit', async () => {
    const h = harness();
    const stuck = h.worker('automation', { drained: false, waitedFor: 1 });
    const exits = [];
    const shutdown = createShutdownHandler({
      server: { close: (cb) => cb() },
      workers: [stuck],
      timeoutMs: 100,
      exit: (code) => exits.push(code),
      log: quiet,
    });
    const result = await shutdown('SIGTERM');
    assert.deepEqual(result, { drained: false });
    assert.deepEqual(exits, [1], 'the host is told the stop was not clean');
  });

  test('a second signal does not start a second shutdown', async () => {
    const h = harness();
    const first = h.shutdown('SIGTERM');
    const second = await h.shutdown('SIGINT');
    await first;
    assert.equal(second, undefined);
    assert.deepEqual(h.exits, [0], 'exit is called once');
    assert.equal(h.events.filter((e) => e === 'server.close').length, 1);
    assert.equal(h.events.filter((e) => e.startsWith('automation.shutdown')).length, 1);
  });

  test('a connection that never closes cannot hang the process: the exit is forced', async () => {
    const exits = [];
    const errors = [];
    const shutdown = createShutdownHandler({
      server: { close: () => {} }, // never calls back
      workers: [],
      timeoutMs: 30,
      exit: (code) => exits.push(code),
      log: { log: () => {}, error: (...a) => errors.push(a.join(' ')) },
    });
    shutdown('SIGTERM');
    await sleep(30 + FORCE_EXIT_GRACE_MS + 300);
    assert.deepEqual(exits, [1]);
    assert.ok(errors.some((e) => /timed out/i.test(e)));
  });

  test('a worker whose shutdown throws, or a failed disconnect, still ends in an exit', async () => {
    const exits = [];
    const shutdown = createShutdownHandler({
      server: { close: (cb) => cb() },
      workers: [{ shutdown: async () => { throw new Error('boom'); } }],
      disconnect: async () => { throw new Error('already closed'); },
      timeoutMs: 100,
      exit: (code) => exits.push(code),
      log: quiet,
    });
    await shutdown('SIGTERM');
    assert.deepEqual(exits, [1]);
  });

  test('the entry point wires both workers and the database into it', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'index.js'), 'utf8');
    assert.match(src, /workers: \[automationWorker, aiWorker\]/);
    assert.match(src, /disconnect: disconnectDB/);
    assert.match(src, /timeoutMs: config\.shutdownTimeoutMs/);
    assert.match(src, /process\.on\('SIGTERM', \(\) => shutdown\('SIGTERM'\)\)/);
    assert.match(src, /process\.on\('SIGINT', \(\) => shutdown\('SIGINT'\)\)/);
  });
});

describe('the AI worker supports the same shutdown', () => {
  test('after shutdown no pass or tick starts', async () => {
    const aiWorker = require('../../jobs/aiWorker');
    try {
      assert.deepEqual(await aiWorker.shutdown(), { drained: true, waitedFor: 0 });
      const summary = await aiWorker.processDueJobs(new Date());
      assert.equal(summary.skipped, true);
      assert.match(summary.reason, /shutting down/);
      const tick = await aiWorker.runTick(new Date());
      assert.equal(tick.heldLease, false);
    } finally {
      aiWorker.resetShutdownForTests();
    }
  });
});
