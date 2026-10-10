// Graceful shutdown for SIGTERM / SIGINT (a deploy, a restart, Ctrl+C).
//
// Kept out of index.js so it can be tested without starting a server.
//
// ORDER
//   1. Stop accepting new HTTP connections (requests already in flight finish).
//   2. Ask every worker to stop: no new ticks, no new passes, and a pass that is
//      running takes no more work after the item it is on. Wait for them, up to
//      `timeoutMs`.
//   3. Wait for the HTTP server to finish closing, close the database
//      connection, and exit.
//
// THE TIMEOUT IS A HARD LIMIT. Whatever is still running when it passes is cut
// off: the process exits with code 1 so the host records an unclean stop. That
// is safe for the workers by design — each enrollment and each follow-up
// recipient is claimed with an expiring lease and its result is saved as soon as
// it is known, so at most the single item in flight is affected.
//
// `timeoutMs` must be shorter than the host's own kill delay (Render sends
// SIGTERM, then SIGKILL after 30 seconds unless that is raised), otherwise the
// host ends the process before this can finish cleanly.
'use strict';

// Extra time allowed, after the worker timeout, for the server and database to
// close before the exit is forced.
const FORCE_EXIT_GRACE_MS = 3000;

function createShutdownHandler({
  server,
  workers = [],
  disconnect = async () => {},
  timeoutMs = 20000,
  exit = (code) => process.exit(code),
  log = console,
}) {
  let started = false;

  return async function shutdown(signal) {
    // A second signal (or SIGINT after SIGTERM) must not start a second
    // shutdown racing the first.
    if (started) return undefined;
    started = true;
    log.log(`\n${signal} received. Shutting down gracefully (up to ${Math.round(timeoutMs / 1000)}s)...`);

    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      exit(code);
    };

    // Last resort: never hang forever on a connection or a worker that will not
    // let go.
    const force = setTimeout(() => {
      log.error('Shutdown timed out; exiting now. Any work in flight is released when its claim expires.');
      finish(1);
    }, timeoutMs + FORCE_EXIT_GRACE_MS);
    if (typeof force.unref === 'function') force.unref();

    // 1. No new connections.
    const httpClosed = new Promise((resolve) => {
      if (!server || typeof server.close !== 'function') return resolve();
      return server.close(() => resolve());
    });

    // 2. Workers: stop scheduling, refuse new passes, wait for a running one.
    const results = await Promise.all(
      workers.map(async (worker) => {
        try {
          return await worker.shutdown({ timeoutMs });
        } catch (err) {
          log.error('Worker shutdown failed:', err.message);
          return { drained: false, waitedFor: 0 };
        }
      })
    );
    const drained = results.every((r) => r && r.drained);
    if (!drained) {
      log.error(
        'A worker pass was still running at the shutdown timeout and will be interrupted. ' +
          'At most the one item it was on is affected; its claim expires by itself.'
      );
    }

    // 3. Requests in flight, then the database.
    await httpClosed;
    log.log('HTTP server closed.');
    try {
      await disconnect();
    } catch (err) {
      log.error('Database disconnect failed:', err.message);
    }

    clearTimeout(force);
    finish(drained ? 0 : 1);
    return { drained };
  };
}

module.exports = { createShutdownHandler, FORCE_EXIT_GRACE_MS };
