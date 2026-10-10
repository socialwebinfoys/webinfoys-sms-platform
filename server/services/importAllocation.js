// Batch allocation from an imported contact list.
//
// An Import is treated as a persistent queue: "Custom 300" takes the next 300
// contacts that no batch has taken yet, "All Remaining" takes the rest. The CSV
// is never re-uploaded and nothing is deleted.
//
// HOW MEMBERSHIP IS RECORDED. Each Contact created by an import already points
// back at it (`Contact.import`). A contact taken by a batch also carries that
// batch's id (`Contact.importBatch`); null means "still in the remaining pool".
// The Import holds the counters and the batch history.
//
// DETERMINISTIC ORDER. Batches take contacts in ascending _id order. An import
// creates its contacts in file order, and ObjectIds increase, so batch 2 of a
// list starts at row 301 when batch 1 took 300.
//
// CONCURRENCY. Two layers:
//   1. A short per-import lease on the Import document (atomic
//      findOneAndUpdate), so allocations for ONE list run one at a time — the
//      counters can never be double-spent and never go negative. A second
//      request waits briefly for the lease rather than failing at once.
//   2. Each contact is marked with a conditional update
//      { importBatch: null } -> { importBatch: <batch> }, so even a lease holder
//      that outlived its lease can never give a contact to two batches.
'use strict';

const mongoose = require('mongoose');
const Import = require('../models/Import');
const Contact = require('../models/Contact');

const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 100;
// Contacts are marked in chunks so a 10,000-contact batch is a handful of
// writes rather than one enormous $in.
const MARK_CHUNK = 1000;

class AllocationError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// THE POOL: contacts of this list never allocated AND not definitively invalid
// (Twilio Lookup said so). An invalid number is excluded from every future
// batch — it is counted as "excluded", never handed to a campaign. A number
// that was merely never looked up, or whose lookup failed, stays in the pool.
const poolFilter = (importId) => ({
  import: importId,
  importBatch: null,
  'lookup.status': { $ne: 'invalid' },
});
const excludedFilter = (importId) => ({
  import: importId,
  importBatch: null,
  'lookup.status': 'invalid',
});
const modified = (r) => (r && (r.modifiedCount ?? r.nModified)) || 0;

// Strict request validation. `count` must be a real JSON number: a string, a
// fraction, zero or a negative is refused rather than coerced.
function parseRequest({ mode, count } = {}) {
  if (mode !== 'all' && mode !== 'custom') {
    throw new AllocationError(400, 'mode must be "all" (All Remaining) or "custom"', 'invalid_mode');
  }
  if (mode === 'all') return { mode };
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new AllocationError(400, 'Enter the number of contacts to use as a whole number', 'invalid_count');
  }
  if (!Number.isInteger(count)) {
    throw new AllocationError(400, 'The number of contacts must be a whole number (no decimals)', 'invalid_count');
  }
  if (count <= 0) {
    throw new AllocationError(400, 'The number of contacts must be greater than 0', 'invalid_count');
  }
  return { mode, count };
}

// The public view of an import's allocation state. Lease fields stay private.
function present(imp) {
  const a = (imp && imp.allocation) || {};
  const batches = (a.batches || []).map((b, i) => ({
    _id: b._id,
    // 1-based, in allocation order: "Batch 2". The latest batch is the last.
    number: i + 1,
    mode: b.mode,
    requested: b.requested,
    size: b.size,
    from: b.from,
    to: b.to,
    status: b.status,
    campaign: b.campaign || null,
    enrollment: b.enrollment || null,
    allocatedBy: b.allocatedBy || null,
    allocatedAt: b.allocatedAt,
    deletedAt: b.deletedAt || null,
  }));
  return {
    importId: imp._id,
    filename: imp.filename || '',
    total: a.total || 0,
    allocated: a.allocated || 0,
    remaining: a.remaining || 0,
    // Unallocated contacts left out of the pool because their number is
    // invalid. total = allocated + remaining + excluded.
    excluded: a.excluded || 0,
    batches,
    // The latest completed batch — what "Current batch" shows.
    currentBatch: (() => {
      const done = batches.filter((b) => b.status === 'complete');
      const last = done[done.length - 1];
      return last ? { _id: last._id, number: last.number, size: last.size } : null;
    })(),
  };
}

async function loadImport(importId) {
  const imp = await Import.findById(importId);
  if (!imp) throw new AllocationError(404, 'Import not found', 'not_found');
  return imp;
}

// Persist the counters the first time an import is looked at. Imports created
// before this feature (and new ones) start from their live contacts. The
// conditional filter makes two simultaneous first reads write it once.
async function ensureInitialized(importId) {
  const imp = await loadImport(importId);
  if (imp.allocation && imp.allocation.initializedAt) return imp;

  const [allocated, remaining, excluded] = await Promise.all([
    Contact.countDocuments({ import: imp._id, importBatch: { $ne: null } }),
    Contact.countDocuments(poolFilter(imp._id)),
    Contact.countDocuments(excludedFilter(imp._id)),
  ]);
  const updated = await Import.findOneAndUpdate(
    { _id: imp._id, 'allocation.initializedAt': null },
    {
      $set: {
        'allocation.initializedAt': new Date(),
        'allocation.total': allocated + remaining + excluded,
        'allocation.allocated': allocated,
        'allocation.remaining': remaining,
        'allocation.excluded': excluded,
      },
    },
    { new: true }
  );
  return updated || loadImport(importId);
}

async function getAllocation(importId) {
  const data = present(await ensureInitialized(importId));
  // `size` is what the batch was allocated; `contacts` is how many of its
  // members still exist (deleting invalid contacts lowers it). Selectors show
  // the live number; the history keeps the original.
  const live = await Promise.all(data.batches.map((b) => Contact.countDocuments({ importBatch: b._id })));
  data.batches = data.batches.map((b, i) => ({ ...b, contacts: live[i] }));
  // How many of the list's contacts exist now. `total` is the allocation
  // accounting (allocated + remaining + excluded, allocated being history), so
  // after deletions it can be higher than this.
  data.contacts = await Contact.countDocuments({ import: data.importId });
  if (data.currentBatch) {
    const cur = data.batches.find((b) => String(b._id) === String(data.currentBatch._id));
    data.currentBatch = { ...data.currentBatch, contacts: cur ? cur.contacts : 0 };
  }
  return data;
}

async function acquireLease(importId, owner, waitMs = LOCK_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const now = new Date();
    const imp = await Import.findOneAndUpdate(
      {
        _id: importId,
        $or: [{ 'allocation.lockedUntil': null }, { 'allocation.lockedUntil': { $lt: now } }],
      },
      {
        $set: {
          'allocation.lockedUntil': new Date(now.getTime() + LOCK_TTL_MS),
          'allocation.lockOwner': owner,
        },
      },
      { new: true }
    );
    if (imp) return imp;
    if (Date.now() >= deadline) {
      throw new AllocationError(
        409,
        'Another batch is being allocated from this list right now. Try again in a moment.',
        'busy'
      );
    }
    await sleep(LOCK_POLL_MS);
  }
}

async function releaseLease(importId, owner) {
  await Import.updateOne(
    { _id: importId, 'allocation.lockOwner': owner },
    { $set: { 'allocation.lockedUntil': null, 'allocation.lockOwner': null } }
  );
}

// Give up to `want` of the import's unallocated contacts, lowest _id first, to
// `batchId`. Returns how many were actually marked.
async function markContacts(importId, batchId, want) {
  let marked = 0;
  while (marked < want) {
    const next = await Contact.find(poolFilter(importId))
      .sort({ _id: 1 })
      .limit(Math.min(want - marked, MARK_CHUNK))
      .select('_id')
      .lean();
    if (!next.length) break;
    const result = await Contact.updateMany(
      { _id: { $in: next.map((c) => c._id) }, importBatch: null, 'lookup.status': { $ne: 'invalid' } },
      { $set: { importBatch: batchId } }
    );
    marked += modified(result);
  }
  return marked;
}

// A run that died after reserving its batch but before marking every contact
// left the batch 'allocating'. Finish it now — safe because we hold the lease,
// so nothing else is marking for this import.
async function finishInterruptedBatches(imp) {
  for (const b of (imp.allocation && imp.allocation.batches) || []) {
    if (b.status !== 'allocating') continue;
    const already = await Contact.countDocuments({ importBatch: b._id });
    const more = await markContacts(imp._id, b._id, Math.max(b.requested - already, 0));
    const size = already + more;
    await Import.updateOne(
      { _id: imp._id, 'allocation.batches._id': b._id },
      {
        $set: {
          'allocation.batches.$.size': size,
          'allocation.batches.$.to': size ? b.from + size - 1 : b.from - 1,
          'allocation.batches.$.status': 'complete',
        },
        $inc: { 'allocation.allocated': size - b.requested },
      }
    );
  }
}

// Allocate one batch. Returns { allocation, batch, contactIds }.
async function allocateBatch({
  importId,
  mode,
  count,
  campaignId = null,
  userId,
  lockWaitMs = LOCK_WAIT_MS,
}) {
  const request = parseRequest({ mode, count });
  await ensureInitialized(importId);

  const owner = new mongoose.Types.ObjectId().toString();
  let imp = await acquireLease(importId, owner, lockWaitMs);
  let batchId;
  try {
    await finishInterruptedBatches(imp);

    // Reconcile with the contacts that actually exist: a contact deleted, or
    // found invalid, since the last allocation is no longer in the pool.
    const fresh = await loadImport(importId);
    const allocated = fresh.allocation.allocated || 0;
    const [remaining, excluded] = await Promise.all([
      Contact.countDocuments(poolFilter(fresh._id)),
      Contact.countDocuments(excludedFilter(fresh._id)),
    ]);

    if (remaining === 0) {
      await Import.updateOne(
        { _id: fresh._id, 'allocation.lockOwner': owner },
        {
          $set: {
            'allocation.remaining': 0,
            'allocation.excluded': excluded,
            'allocation.total': allocated + excluded,
          },
        }
      );
      throw new AllocationError(
        409,
        excluded
          ? `Every valid contact in this list has already been allocated (${excluded.toLocaleString('en-US')} invalid number${excluded === 1 ? ' is' : 's are'} excluded).`
          : 'Every contact in this list has already been allocated.',
        'exhausted'
      );
    }
    const size = request.mode === 'all' ? remaining : request.count;
    if (size > remaining) {
      throw new AllocationError(
        400,
        `Only ${remaining.toLocaleString('en-US')} contact${remaining === 1 ? '' : 's'} remain in this list — cannot use ${size.toLocaleString('en-US')}.`,
        'exceeds_remaining'
      );
    }

    // Record the batch BEFORE marking, so an interrupted run is visible and is
    // finished by the next allocation instead of leaving contacts unaccounted.
    batchId = new mongoose.Types.ObjectId();
    const from = allocated + 1;
    const reserved = await Import.updateOne(
      { _id: fresh._id, 'allocation.lockOwner': owner },
      {
        $set: {
          'allocation.allocated': allocated + size,
          'allocation.remaining': remaining - size,
          'allocation.excluded': excluded,
          'allocation.total': allocated + remaining + excluded,
        },
        $push: {
          'allocation.batches': {
            _id: batchId,
            mode: request.mode,
            requested: size,
            from,
            status: 'allocating',
            campaign: campaignId || null,
            allocatedBy: userId,
            allocatedAt: new Date(),
          },
        },
      }
    );
    if (!modified(reserved)) {
      throw new AllocationError(409, 'The allocation lease was lost. Try again.', 'busy');
    }

    const marked = await markContacts(fresh._id, batchId, size);
    // Fewer than reserved only if contacts were deleted mid-allocation.
    const shortfall = size - marked;
    await Import.updateOne(
      { _id: fresh._id, 'allocation.batches._id': batchId },
      {
        $set: {
          'allocation.batches.$.size': marked,
          'allocation.batches.$.to': from + marked - 1,
          'allocation.batches.$.status': 'complete',
        },
        $inc: { 'allocation.allocated': -shortfall, 'allocation.total': -shortfall },
      }
    );
  } finally {
    await releaseLease(importId, owner);
  }

  const contacts = await Contact.find({ importBatch: batchId }).sort({ _id: 1 }).select('_id').lean();
  imp = await loadImport(importId);
  const allocation = present(imp);
  const batch = allocation.batches.find((b) => String(b._id) === String(batchId));
  return { allocation, batch, contactIds: contacts.map((c) => String(c._id)) };
}

// Recount a list's pool from its actual contacts — after contacts were deleted
// or found invalid. Membership is the contacts themselves; this only brings the
// persisted counters back in line with it. Batch history is never rewritten:
// `allocated` stays what was handed out, even if some of those contacts have
// since been deleted. Runs under the list's lease so it cannot interleave with
// an allocation; if one is running, it waits for it.
async function reconcileAllocation(importId, { lockWaitMs = LOCK_WAIT_MS } = {}) {
  const imp = await Import.findById(importId);
  if (!imp || !imp.allocation || !imp.allocation.initializedAt) {
    return null; // not initialised yet: the first read counts live contacts
  }
  const owner = new mongoose.Types.ObjectId().toString();
  await acquireLease(importId, owner, lockWaitMs);
  try {
    const fresh = await loadImport(importId);
    const allocated = fresh.allocation.allocated || 0;
    const [remaining, excluded] = await Promise.all([
      Contact.countDocuments(poolFilter(fresh._id)),
      Contact.countDocuments(excludedFilter(fresh._id)),
    ]);
    await Import.updateOne(
      { _id: fresh._id, 'allocation.lockOwner': owner },
      {
        $set: {
          'allocation.remaining': remaining,
          'allocation.excluded': excluded,
          'allocation.total': allocated + remaining + excluded,
        },
      }
    );
  } finally {
    await releaseLease(importId, owner);
  }
  return present(await loadImport(importId));
}

// Record what enrolling a batch did, for the batch history.
async function recordBatchEnrollment(importId, batchId, summary) {
  await Import.updateOne(
    { _id: importId, 'allocation.batches._id': batchId },
    {
      $set: {
        'allocation.batches.$.enrollment': {
          enrolled: summary.enrolled || 0,
          skipped: summary.skipped || 0,
          notEligible: summary.notEligible || 0,
          failed: summary.failed || 0,
        },
      },
    }
  );
}

// Delete one batch once its work is done.
//
// SOFT, by design: the batch is marked 'deleted' and disappears from every
// batch selector, but nothing else changes —
//   * no Contact is deleted, and each keeps its membership marker, so the
//     contacts do NOT return to the remaining pool (their batch was worked;
//     re-allocating them would message the same people again);
//   * campaigns, enrollments, conversations and messages are untouched, and a
//     campaign that pointed at the batch still resolves to the same contacts;
//   * the counters and the rest of the history stay as they are.
// Refused while the batch still has live (active/paused) enrollments, so a
// running campaign is never pulled out from under itself. The conditional
// update makes two simultaneous deletes delete it once.
async function deleteBatch({ importId, batchId, userId, liveEnrollmentCount }) {
  const imp = await loadImport(importId);
  const batches = (imp.allocation && imp.allocation.batches) || [];
  const batch = batches.find((b) => String(b._id) === String(batchId));
  if (!batch) throw new AllocationError(404, 'That batch does not belong to this list', 'batch_not_found');
  const number = batches.indexOf(batch) + 1;
  if (batch.status === 'deleted') {
    throw new AllocationError(409, `Batch ${number} has already been deleted`, 'already_deleted');
  }
  if (batch.status !== 'complete') {
    throw new AllocationError(409, `Batch ${number} is still being allocated`, 'batch_allocating');
  }
  if (liveEnrollmentCount) {
    const live = await liveEnrollmentCount(batch._id);
    if (live > 0) {
      throw new AllocationError(
        409,
        `Batch ${number} still has ${live} active or paused enrollment${live === 1 ? '' : 's'}. Finish or cancel them before deleting the batch.`,
        'batch_in_use'
      );
    }
  }
  const result = await Import.updateOne(
    { _id: imp._id, 'allocation.batches': { $elemMatch: { _id: batch._id, status: 'complete' } } },
    {
      $set: {
        'allocation.batches.$.status': 'deleted',
        'allocation.batches.$.deletedAt': new Date(),
        'allocation.batches.$.deletedBy': userId || null,
      },
    }
  );
  if (!modified(result)) {
    throw new AllocationError(409, `Batch ${number} has already been deleted`, 'already_deleted');
  }
  return { number, allocation: await getAllocation(importId) };
}

module.exports = {
  deleteBatch,
  AllocationError,
  parseRequest,
  present,
  ensureInitialized,
  getAllocation,
  allocateBatch,
  recordBatchEnrollment,
  reconcileAllocation,
  poolFilter,
  excludedFilter,
  LOCK_TTL_MS,
  MARK_CHUNK,
};
