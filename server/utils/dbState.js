// Server-side DB configuration state, used only to detect when the configured
// MONGO_URI changes across restarts so a new/different database can be
// auto-initialized (see index.js).
//
// Security/design notes:
//   * We NEVER store the raw MONGO_URI (which contains the database password).
//     Only a one-way SHA-256 fingerprint is persisted.
//   * The fingerprint is NOT stored in MongoDB on purpose: when MONGO_URI points
//     at a brand-new database there would be no previous state there to compare
//     against. It is kept in a small local state file on the server filesystem.
//   * The file location can be overridden with the optional DB_STATE_FILE env var
//     (useful when the default working directory is ephemeral, e.g. some PaaS
//     deployments). If the file cannot be persisted, change detection degrades
//     gracefully: the admin check simply re-runs on the next start (it is
//     idempotent and never destructive).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.DB_STATE_FILE
  ? path.resolve(process.env.DB_STATE_FILE)
  : path.join(__dirname, '..', '.db-state.json');

// One-way fingerprint of the connection string. Same URI -> same hash; any
// change (host, database name, credentials) -> different hash.
function computeFingerprint(uri) {
  return crypto.createHash('sha256').update(String(uri || '')).digest('hex');
}

// Read the persisted state, or null if it is missing/unreadable/corrupt (all of
// which are treated as "no previous configuration" = first-time initialization).
function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

// Persist the current fingerprint. Throws on I/O failure so the caller can log a
// warning and continue (change detection then re-runs next start).
function writeState(fingerprint) {
  const payload = JSON.stringify(
    { mongoFingerprint: fingerprint, updatedAt: new Date().toISOString() },
    null,
    2
  );
  // mode 0o600: readable/writable by the owner only (defence in depth, even
  // though the file contains no secret — only a hash).
  fs.writeFileSync(STATE_FILE, payload, { encoding: 'utf8', mode: 0o600 });
}

module.exports = { computeFingerprint, readState, writeState, STATE_FILE };
