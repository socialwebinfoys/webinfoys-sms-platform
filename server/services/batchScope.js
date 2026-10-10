// Batch scope: "this list, this batch" as a validated, server-side contact scope.
//
// Batches are the existing allocation batches (Import.allocation.batches); a
// contact's membership is its persisted `importBatch` marker. Nothing here
// invents a second grouping — it only turns a (list, batch) choice into the
// exact contact filter every batch-aware operation uses: Lookup All, the lookup
// counts, campaign audiences, enrollment and Select All.
//
// A batch is selectable while its status is 'complete'. 'allocating' (being
// created right now) and 'deleted' (removed by an operator) never are.
'use strict';

const Import = require('../models/Import');

class BatchScopeError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const allBatches = (imp) => (imp && imp.allocation && imp.allocation.batches) || [];
const activeBatches = (imp) => allBatches(imp).filter((b) => b.status === 'complete');
const hasActiveBatches = (imp) => activeBatches(imp).length > 0;

// Public description of one batch. `number` is its 1-based position in the
// list's full allocation history, exactly as the allocation API numbers it.
function describeBatch(imp, batch) {
  if (!batch) return null;
  return {
    _id: batch._id,
    number: allBatches(imp).indexOf(batch) + 1,
    size: batch.size,
    status: batch.status,
  };
}

function findBatch(imp, batchId) {
  return allBatches(imp).find((b) => String(b._id) === String(batchId)) || null;
}

// Resolve (importId, batchId) to { imp, batch, filter }. The filter selects
// exactly the batch's persisted members: { import, importBatch }.
async function resolveBatchScope(importId, batchId, { allowDeleted = false } = {}) {
  const imp = await Import.findById(importId);
  if (!imp) throw new BatchScopeError(404, 'Contact list (import) not found', 'import_not_found');
  const batch = findBatch(imp, batchId);
  if (!batch) {
    throw new BatchScopeError(400, 'That batch does not belong to this contact list', 'batch_not_in_list');
  }
  if (batch.status === 'deleted' && !allowDeleted) {
    throw new BatchScopeError(400, `Batch ${describeBatch(imp, batch).number} has been deleted`, 'batch_deleted');
  }
  if (batch.status === 'allocating') {
    throw new BatchScopeError(409, 'That batch is still being allocated. Try again in a moment.', 'batch_allocating');
  }
  return { imp, batch, filter: { import: imp._id, importBatch: batch._id } };
}

// Which contacts a campaign may draw from — the ONE rule used by the eligible-
// contacts picker and by enrollment (so the picker can never offer a contact
// the enroll endpoint would refuse):
//   * campaign bound to a batch  -> exactly that batch (a different requested
//                                   batch is refused; a deleted one is refused)
//   * list has batches           -> the requested batch, which is required —
//                                   the whole list is never the fallback
//   * list has no batches        -> the whole list, exactly as before batches
// Returns { imp, batch, filter, batches } or { requiresBatch: true, imp, batches }.
async function campaignScope(campaign, requestedBatchId) {
  // A legacy campaign with no contact list at all keeps its old behaviour.
  if (!campaign.import) {
    if (requestedBatchId) {
      throw new BatchScopeError(400, 'This campaign has no contact list, so it has no batches', 'no_list');
    }
    return { imp: null, batch: null, filter: {}, batches: [] };
  }
  const imp = await Import.findById(campaign.import);
  const requested = requestedBatchId ? String(requestedBatchId) : '';
  const listBatches = (i) => activeBatches(i).map((b) => describeBatch(i, b));

  if (campaign.batch) {
    if (!imp) throw new BatchScopeError(400, "This campaign's contact list no longer exists", 'import_not_found');
    const bound = findBatch(imp, campaign.batch);
    const label = bound ? `Batch ${describeBatch(imp, bound).number}` : 'its batch';
    if (requested && requested !== String(campaign.batch)) {
      throw new BatchScopeError(400, `This campaign is for ${label} only`, 'batch_mismatch');
    }
    if (!bound || bound.status === 'deleted') {
      throw new BatchScopeError(400, `This campaign's batch (${label}) has been deleted`, 'batch_deleted');
    }
    const scope = await resolveBatchScope(imp._id, campaign.batch);
    return { ...scope, batches: listBatches(imp) };
  }

  if (imp && hasActiveBatches(imp)) {
    if (!requested) return { requiresBatch: true, imp, batches: listBatches(imp) };
    const scope = await resolveBatchScope(imp._id, requested);
    return { ...scope, batches: listBatches(imp) };
  }
  if (requested) {
    throw new BatchScopeError(400, 'That batch does not belong to this campaign’s contact list', 'batch_not_in_list');
  }
  // No batches: the whole list (or, for a list record deleted since, the
  // contacts that still reference it) — the behaviour before batches existed.
  return { imp, batch: null, filter: { import: campaign.import }, batches: [] };
}

module.exports = {
  campaignScope,
  BatchScopeError,
  allBatches,
  activeBatches,
  hasActiveBatches,
  describeBatch,
  findBatch,
  resolveBatchScope,
};
