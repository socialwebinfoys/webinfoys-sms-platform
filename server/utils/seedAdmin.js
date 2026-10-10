// Admin bootstrap. Provides one idempotent admin-creation implementation that is
// reused in two places:
//   * the CLI script `npm run seed:admin` (manual, connects + disconnects), and
//   * automatic startup initialization in index.js (uses the already-open
//     connection) when a new/different MONGO_URI is detected.
//
// It never overwrites an existing admin's password and never deletes or modifies
// any other data.
const { config, validateConfig } = require('../config/env');
const { connectDB, disconnectDB } = require('../config/db');
const User = require('../models/User');

// Phase 0: matches the User schema's `minlength` and the API's register check.
const MIN_ADMIN_PASSWORD_LENGTH = 12;

// Ensure the configured admin exists on the CURRENT Mongoose connection.
// Assumes a connection is already open (does not connect, disconnect, or exit),
// so it is safe to call from the server startup path. Idempotent:
//   * admin missing -> creates it (password hashed by the User model pre-save hook)
//   * admin present -> returns without changing anything
// Returns { created: boolean, email }. Throws if ADMIN_EMAIL/ADMIN_PASSWORD are
// not configured (the caller decides how to fail).
async function ensureAdmin() {
  const { name, email, password } = config.seedAdmin;
  if (!email || !password) {
    const err = new Error(
      'Cannot initialize admin: ADMIN_EMAIL and ADMIN_PASSWORD must be set in the environment.'
    );
    err.code = 'ADMIN_CONFIG_MISSING';
    throw err;
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    return { created: false, email: existing.email };
  }

  // Phase 0: a new admin must meet the 12-character minimum. Checked here so the
  // failure names the environment variable instead of surfacing as an opaque
  // Mongoose validation error. The LENGTH is reported, never the value.
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    const err = new Error(
      `Cannot initialize admin: ADMIN_PASSWORD is too short (${password.length} characters). ` +
        `Use at least ${MIN_ADMIN_PASSWORD_LENGTH}.`
    );
    err.code = 'ADMIN_PASSWORD_TOO_SHORT';
    throw err;
  }

  const admin = await User.create({ name, email, password, role: 'admin' });
  return { created: true, email: admin.email };
}

// CLI entry point for `npm run seed:admin`: validate config, open its own
// connection, ensure the admin, then disconnect and exit. Kept fully backwards
// compatible and idempotent.
async function runCli() {
  try {
    validateConfig();
    await connectDB();

    const result = await ensureAdmin();
    if (result.created) {
      console.log(`Admin created: ${result.email}`);
    } else {
      console.log(`Admin already exists: ${result.email} (no changes made).`);
    }

    await disconnectDB();
    process.exit(0);
  } catch (err) {
    console.error('Seeding admin failed:', err.message);
    process.exit(1);
  }
}

// Only auto-run the CLI when this file is executed directly (node utils/seedAdmin.js).
// When required by the app (index.js), nothing runs on import.
if (require.main === module) {
  runCli();
}

module.exports = { ensureAdmin };
