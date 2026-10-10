// Global worker lease (Phase 2). A single short-lived document per worker key
// ensures only ONE instance runs a scheduled tick, even when the host briefly
// runs two instances (e.g. a zero-downtime deploy).
//
// This is a second line of defence only: each enrollment is also claimed
// atomically before it is processed, so duplicate sends are already impossible
// without this. The lease simply stops two instances doing redundant work.
//
// Expiry-based, never "released and forgotten": if the holder crashes, the
// lease lapses at `expiresAt` and the next tick can take it.
const mongoose = require('mongoose');

const workerLockSchema = new mongoose.Schema(
  {
    // Logical worker name, e.g. 'automation'.
    key: { type: String, required: true, unique: true },
    // Who holds it (pid@host) — diagnostics only, never used for control flow.
    owner: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Try to take (or renew) the lease for `key`. Returns true when this process
// holds it. The upsert is atomic: of two instances racing, exactly one wins —
// the loser gets a duplicate-key error and simply skips its tick.
workerLockSchema.statics.acquire = async function acquire(key, owner, ttlMs) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  try {
    const res = await this.findOneAndUpdate(
      // Free when no lease exists, it has expired, or we already own it.
      { key, $or: [{ expiresAt: { $lte: now } }, { owner }] },
      { $set: { key, owner, expiresAt } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return !!res;
  } catch (err) {
    // E11000: another instance inserted the lease first, so it is held.
    if (err && err.code === 11000) return false;
    throw err;
  }
};

// Let the lease go as soon as the tick finishes, so the next tick (possibly on
// another instance) need not wait for it to expire.
workerLockSchema.statics.release = async function release(key, owner) {
  await this.updateOne({ key, owner }, { $set: { expiresAt: new Date(0) } });
};

module.exports = mongoose.model('WorkerLock', workerLockSchema);
