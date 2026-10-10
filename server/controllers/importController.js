// Contact-import listing (read-only). Powers the "Contact list / CSV" picker on
// the Campaign form. Reports the LIVE contact count per import (contacts that
// still reference the import), not just the count captured at import time.
const Import = require('../models/Import');
const Contact = require('../models/Contact');
const Campaign = require('../models/Campaign');
const Enrollment = require('../models/Enrollment');
const { enrollContactIds } = require('./enrollmentController');
const allocation = require('../services/importAllocation');
const { logEvent } = require('../services/logService');

// GET /api/contact-imports
async function listImports(req, res, next) {
  try {
    const imports = await Import.find({}).sort('-createdAt').limit(500).lean();

    // Live contact counts grouped by import, in one aggregation.
    const counts = await Contact.aggregate([
      { $match: { import: { $ne: null } } },
      { $group: { _id: '$import', n: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.n]));

    const data = imports.map((imp) => {
      const contactCount = countMap.get(String(imp._id)) || 0;
      const a = imp.allocation || {};
      return {
        ...imp,
        contactCount,
        // Batch allocation summary only (the full history is served per import).
        // A list never allocated from has nothing allocated: all of it remains.
        allocation: a.initializedAt
          ? { total: a.total || 0, allocated: a.allocated || 0, remaining: a.remaining || 0, excluded: a.excluded || 0 }
          : { total: contactCount, allocated: 0, remaining: contactCount, excluded: 0 },
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/contact-imports/:id
// Removes ONLY the import (CSV list) record so it stops appearing in the list.
// This is deliberately non-destructive to everything else: the contacts it once
// created, along with any campaigns, enrollments, conversations and SMS history,
// are intentionally preserved. Contacts keep their `import` back-reference (a
// harmless stale id) — the list is built from the Import collection, not from
// contacts, so a deleted import never reappears.
async function deleteImport(req, res, next) {
  try {
    const imp = await Import.findByIdAndDelete(req.params.id);
    if (!imp) {
      return res.status(404).json({ success: false, message: 'Import not found' });
    }
    return res.json({ success: true, message: 'Import deleted' });
  } catch (err) {
    return next(err);
  }
}

// Batch history shows which campaign each batch went to by name.
async function withCampaignNames(data) {
  const ids = [...new Set(data.batches.filter((b) => b.campaign).map((b) => String(b.campaign)))];
  if (!ids.length) return data;
  const found = await Campaign.find({ _id: { $in: ids } }).select('name').lean();
  const names = new Map(found.map((c) => [String(c._id), c.name]));
  return {
    ...data,
    batches: data.batches.map((b) =>
      b.campaign ? { ...b, campaignName: names.get(String(b.campaign)) || '(deleted campaign)' } : b
    ),
  };
}

function sendAllocationError(res, err) {
  return res.status(err.status).json({ success: false, message: err.message, code: err.code });
}

// GET /api/contact-imports/:id/allocation
// The persisted queue state: total, allocated, remaining and the batch history.
async function getAllocation(req, res, next) {
  try {
    const data = await withCampaignNames(await allocation.getAllocation(req.params.id));
    return res.json({ success: true, data });
  } catch (err) {
    if (err instanceof allocation.AllocationError) return sendAllocationError(res, err);
    return next(err);
  }
}

// POST /api/contact-imports/:id/allocate
//   { mode: 'all' }                       -> every remaining contact
//   { mode: 'custom', count: 300 }        -> the next 300
//   + optional campaignId                 -> enroll the batch into that campaign
//
// Enrollment reuses enrollContactIds, so opt-out, inactive, delivery-blocked
// and already-enrolled contacts are skipped exactly as everywhere else. The
// import-scope check is waived, as it is for enroll-after-import: the operator
// is explicitly choosing which list feeds this campaign.
async function allocate(req, res, next) {
  try {
    const { mode, count, campaignId } = req.body || {};

    // Validate the request and the campaign BEFORE taking anything from the
    // queue, so a bad campaign never leaves contacts allocated to nothing.
    allocation.parseRequest({ mode, count });
    let campaign = null;
    if (campaignId !== undefined && campaignId !== null && campaignId !== '') {
      campaign = await Campaign.findById(String(campaignId));
      if (!campaign) {
        return res.status(400).json({ success: false, message: 'Selected campaign was not found' });
      }
      if (!campaign.steps || campaign.steps.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: 'Cannot enroll into a campaign with no steps' });
      }
      // A campaign bound to one batch takes ONLY that batch's contacts. A new
      // batch can never be poured into it.
      if (campaign.batch) {
        return res.status(400).json({
          success: false,
          message: 'That campaign is limited to one batch of its list. Allocate the batch first, then create a campaign for it.',
        });
      }
    }

    const result = await allocation.allocateBatch({
      importId: req.params.id,
      mode,
      count,
      campaignId: campaign ? campaign._id : null,
      userId: req.user ? req.user._id : undefined,
    });

    let enrollment = null;
    if (campaign && result.contactIds.length > 0) {
      enrollment = await enrollContactIds({
        campaign,
        targetIds: result.contactIds,
        selectAll: false,
        userId: req.user ? req.user._id : undefined,
        ignoreImportScope: true,
      });
      await allocation.recordBatchEnrollment(req.params.id, result.batch._id, enrollment);
    }

    await logEvent({
      eventType: 'import.batch_allocated',
      severity: 'info',
      message: `Allocated ${result.batch.size} contact(s) from ${result.allocation.filename || 'an import'} (${result.allocation.remaining} remain)`,
      status: 'allocated',
      campaign: campaign ? campaign._id : undefined,
      meta: {
        importId: String(result.allocation.importId),
        batchId: String(result.batch._id),
        mode: result.batch.mode,
        size: result.batch.size,
        from: result.batch.from,
        to: result.batch.to,
        remaining: result.allocation.remaining,
        enrolled: enrollment ? enrollment.enrolled : 0,
        by: req.user ? String(req.user._id) : undefined,
      },
    });

    const fresh = await withCampaignNames(await allocation.getAllocation(req.params.id));
    const batch = fresh.batches.find((b) => String(b._id) === String(result.batch._id));
    return res.status(201).json({
      success: true,
      data: fresh,
      batch,
      enrollment: enrollment
        ? {
            total: enrollment.total,
            enrolled: enrollment.enrolled,
            skipped: enrollment.skipped,
            notEligible: enrollment.notEligible,
            notFound: enrollment.notFound,
            failed: enrollment.failed,
          }
        : null,
    });
  } catch (err) {
    if (err instanceof allocation.AllocationError) return sendAllocationError(res, err);
    return next(err);
  }
}

// DELETE /api/contact-imports/:id/batches/:batchId   (admin)
// Removes the batch grouping once its work is done. Contacts, campaigns,
// enrollments and messages are never deleted by this — see
// importAllocation.deleteBatch for the exact semantics.
async function deleteBatch(req, res, next) {
  try {
    const result = await allocation.deleteBatch({
      importId: req.params.id,
      batchId: req.params.batchId,
      userId: req.user ? req.user._id : undefined,
      // Any live enrollment of any member blocks the delete, whichever campaign
      // it belongs to.
      liveEnrollmentCount: async (batchId) => {
        const members = await Contact.find({ importBatch: batchId }).select('_id').lean();
        if (!members.length) return 0;
        return Enrollment.countDocuments({
          contact: { $in: members.map((c) => c._id) },
          status: { $in: ['active', 'paused'] },
        });
      },
    });
    await logEvent({
      eventType: 'import.batch_deleted',
      severity: 'warning',
      message: `Batch ${result.number} of ${result.allocation.filename || 'an import'} was deleted (contacts kept)`,
      status: 'deleted',
      meta: {
        importId: String(req.params.id),
        batchId: String(req.params.batchId),
        by: req.user ? String(req.user._id) : undefined,
        contactsKept: true,
      },
    });
    const data = await withCampaignNames(result.allocation);
    return res.json({ success: true, data, message: `Batch ${result.number} deleted. Its contacts were kept.` });
  } catch (err) {
    if (err instanceof allocation.AllocationError) return sendAllocationError(res, err);
    return next(err);
  }
}

module.exports = { listImports, deleteImport, getAllocation, allocate, deleteBatch };
