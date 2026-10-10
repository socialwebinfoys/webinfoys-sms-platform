// Contact-import record. Represents one CSV/XLSX import batch so a Campaign can
// reference the contact list it was built from. This stores only import
// metadata + counts — the contacts themselves are NOT duplicated here; each
// created Contact carries an `import` back-reference instead (normalized).
const mongoose = require('mongoose');

// One allocated batch. `from`/`to` are 1-based positions in the list's
// allocation order (e.g. 301-800); the contacts themselves carry the batch id.
const allocationBatchSchema = new mongoose.Schema({
  mode: { type: String, enum: ['all', 'custom'], required: true },
  requested: { type: Number, required: true },
  size: { type: Number, default: 0 },
  from: { type: Number, default: 0 },
  to: { type: Number, default: 0 },
  // 'allocating' only while contacts are being marked; an interrupted run is
  // finished by the next allocation. 'deleted': an operator removed the batch
  // once its work was done. A deleted batch disappears from every batch
  // selector, but its record — and its contacts' membership markers — are kept,
  // so its contacts never return to the pool and history never breaks.
  status: { type: String, enum: ['allocating', 'complete', 'deleted'], default: 'allocating' },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
  enrollment: {
    enrolled: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    notEligible: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
  },
  allocatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  allocatedAt: { type: Date, default: Date.now },
});

const importSchema = new mongoose.Schema(
  {
    // Original uploaded filename (e.g. "client-leads.csv").
    filename: { type: String, default: '', trim: true },
    // Row/outcome counts captured at import time (for display only).
    totalRows: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    duplicates: { type: Number, default: 0 },
    invalid: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Batch allocation: the imported list as a persistent queue. Contacts are
    // handed out in batches ("next 300", "all remaining") without re-uploading.
    // Which contacts a batch took is recorded on each Contact (`importBatch`);
    // these counters and the history live here. See services/importAllocation.js.
    allocation: {
      // Null until first read; legacy imports are initialised from their
      // contacts at that point, so no migration is needed.
      initializedAt: { type: Date, default: null },
      total: { type: Number, default: 0 },
      allocated: { type: Number, default: 0 },
      remaining: { type: Number, default: 0 },
      // Unallocated contacts left out of the pool because Twilio Lookup reported
      // their number invalid. total = allocated + remaining + excluded.
      excluded: { type: Number, default: 0 },
      // Short lease so allocations for one list run one at a time.
      lockedUntil: { type: Date, default: null },
      lockOwner: { type: String, default: null },
      batches: { type: [allocationBatchSchema], default: [] },
    },
  },
  { timestamps: true }
);

// Imports are listed newest-first in the campaign "contact list" picker.
importSchema.index({ createdAt: -1 });

importSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Import', importSchema);
