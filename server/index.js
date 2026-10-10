// Application entry point: validate config, connect to MongoDB, initialize the
// admin user if the database configuration is new/changed, then start the server.
const { config, validateConfig } = require('./config/env');
const { connectDB, disconnectDB } = require('./config/db');
const createApp = require('./app');
const automationWorker = require('./jobs/automationWorker');
const aiWorker = require('./jobs/aiWorker');
const { ensureAdmin } = require('./utils/seedAdmin');
const { computeFingerprint, readState, writeState } = require('./utils/dbState');
const { createShutdownHandler } = require('./utils/gracefulShutdown');

async function start() {
  try {
    validateConfig();

    // Determine the current MONGO_URI fingerprint and compare it to the last
    // recorded one BEFORE connecting, so the decision is deterministic. Only a
    // one-way hash is used/stored — never the raw URI (see utils/dbState.js).
    const fingerprint = computeFingerprint(config.mongoUri);
    const previous = readState();
    const isNewConfig = !previous || previous.mongoFingerprint !== fingerprint;

    await connectDB();

    // Auto-initialize the admin ONLY when the database configuration is new,
    // changed, or has never been recorded (first-time setup). When the URI is
    // unchanged we skip this entirely — the users collection is not queried for
    // admin initialization on ordinary restarts. This must complete before the
    // server accepts traffic; a failure aborts startup (see catch below) and the
    // fingerprint is intentionally NOT recorded, so the next start retries.
    if (isNewConfig) {
      console.log(
        previous
          ? 'MongoDB configuration change detected; verifying admin user...'
          : 'No previous MongoDB configuration recorded; verifying admin user...'
      );
      const result = await ensureAdmin();
      console.log(
        result.created
          ? `Admin user initialized: ${result.email}`
          : `Admin user already present: ${result.email} (no changes made).`
      );
      try {
        writeState(fingerprint);
      } catch (e) {
        // Non-fatal: without a persisted fingerprint the (idempotent, non-
        // destructive) admin check simply re-runs on the next start.
        console.warn(
          'Could not persist DB state file; admin verification will re-run on next start.',
          `Reason: ${e.message}`
        );
      }
    }

    // Start the automation worker (no-op if AUTOMATION_ENABLED=false).
    automationWorker.start();
    // Start the AI reply worker (no-op unless AI_WORKER_ENABLED=true). Gated
    // separately so AI and campaign automation can be operated independently.
    aiWorker.start();

    const app = createApp();
    const server = app.listen(config.port, () => {
      console.log(
        `Server running in ${config.nodeEnv} mode on port ${config.port} ` +
          `(health: http://localhost:${config.port}/api/health)`
      );
    });

    // Graceful shutdown on termination signals: stop taking connections, let
    // the workers finish the item they are on, then close the database and
    // exit. See utils/gracefulShutdown.js for the order and the limits.
    const shutdown = createShutdownHandler({
      server,
      workers: [automationWorker, aiWorker],
      disconnect: disconnectDB,
      timeoutMs: config.shutdownTimeoutMs,
    });
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();
