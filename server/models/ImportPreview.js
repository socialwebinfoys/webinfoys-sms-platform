// Temporary holding record for a previewed-but-not-yet-committed contact import
// (Phase 6).
//
// WHY THE ORIGINAL FILE IS STORED, NOT THE PARSED ROWS
// The confirm step must import exactly what the operator previewed, and it must
// not trust anything the browser sends back. Keeping the uploaded bytes means
// confirmImport re-runs the SAME parser and the SAME validation over the SAME
// input, so the result is reproducible by construction rather than by keeping
// two code paths in agreement. The computed summary is stored alongside purely
// so the preview can be re-read without re-parsing.
//
// WHY NOT THE FILESYSTEM
// The API runs on Render, where the filesystem is ephemeral and a second
// request may be served by a different instance. A local temp file would work
// in development and fail in production. The database is the only storage both
// requests are guaranteed to share.
//
// SIZE
// Uploads are already capped at 5 MB by multer (see routes/contactRoutes.js),
// comfortably inside MongoDB's 16 MB document limit. The cap below is a second,
// explicit guard so this collection can never hold an unbounded payload.
//
// LIFETIME
// A TTL index removes the document an hour after creation, so abandoned
// previews clean themselves up — nothing accumulates and no cron is needed.
const crypto = require('crypto');
const mongoose = require('mongoose');

// Keep in step with the multer limit in routes/contactRoutes.js.
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const PREVIEW_TTL_MS = 60 * 60 * 1000; // 1 hour

const importPreviewSchema = new mongoose.Schema(
  {
    // Opaque, unguessable handle given to the client. The client never sees the
    // document id, and a token alone is not enough to confirm — ownership is
    // checked too (see confirmImport).
    token: { type: String, required: true, unique: true },
    filename: { type: String, default: '' },
    // The uploaded bytes, re-parsed verbatim at confirm time.
    fileBuffer: { type: Buffer, required: true },
    fileSize: { type: Number, default: 0 },
    // The summary computed at preview time, for display only. The authoritative
    // numbers at confirm time are recomputed from fileBuffer.
    summary: { type: mongoose.Schema.Types.Mixed },
    // Who uploaded it. Only this user may confirm it.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Set once the preview has been committed, so a token cannot be replayed to
    // import the same file twice.
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL: MongoDB deletes the document once `expiresAt` passes. expireAfterSeconds
// of 0 means "expire exactly at the stored time" rather than N seconds after it.
importPreviewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Never ship the uploaded bytes back to a client.
importPreviewSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.fileBuffer;
  delete obj.__v;
  return obj;
};

importPreviewSchema.statics.newToken = function newToken() {
  return crypto.randomBytes(24).toString('base64url');
};

importPreviewSchema.statics.MAX_PREVIEW_BYTES = MAX_PREVIEW_BYTES;
importPreviewSchema.statics.PREVIEW_TTL_MS = PREVIEW_TTL_MS;

module.exports = mongoose.model('ImportPreview', importPreviewSchema);
