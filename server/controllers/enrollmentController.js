// Enrollment management: enroll contacts into campaigns, track/list progress,
// change status (pause/resume/cancel), and trigger the automation worker.
const Enrollment = require('../models/Enrollment');
const Campaign = require('../models/Campaign');
const Contact = require('../models/Contact');
const automationWorker = require('../jobs/automationWorker');
const batchScope = require('../services/batchScope');
const { checkCanSend, isLookupInvalid } = require('../services/sendPolicy');

const MAX_LIMIT = 100;
// Enrollment states that make a contact ineligible for (re-)enrollment (already
// received / receiving the campaign). cancelled/failed remain re-enrollable.
const ENROLLED_STATES = ['active', 'paused', 'completed'];

// ms until the first step is due, given its delay.
function firstStepDelayMs(step) {
  const v = Number(step.delayValue) || 0;
  const unit = step.delayUnit || 'hours';
  if (unit === 'minutes') return v * 60 * 1000;
  if (unit === 'days') return v * 24 * 60 * 60 * 1000;
  return v * 60 * 60 * 1000;
}

// POST /api/enrollments
// Accepts three interchangeable selection forms (campaignId always required):
//   { campaignId, contactId }                             -> single contact
//   { campaignId, contactIds: [...] }                     -> explicit multiple
//   { campaignId, selectAll: true, excludeContactIds }    -> every contact minus
//                                                            any excluded ids
// Duplicate-safe: contacts already active/paused-enrolled in the campaign are
// skipped (never re-enrolled), and the partial-unique {contact,campaign} index
// guards against races. New rows are written in a single insertMany so bulk
// enrollment of thousands of contacts stays one request + one bulk write.
// Response shape is unchanged (`summary`); `total`/`failed` are added fields.
async function createEnrollment(req, res, next) {
  try {
    const { campaignId, contactId, contactIds, selectAll, excludeContactIds, batchId } = req.body || {};
    if (!campaignId) {
      return res.status(400).json({ success: false, message: 'campaignId is required' });
    }

    const campaign = await Campaign.findById(campaignId);
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }
    if (!campaign.steps || campaign.steps.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: 'Cannot enroll into a campaign with no steps' });
    }

    // A contact is only enrollable if it belongs to the campaign's contact list
    // (import) — and, when that list has batches, to ONE batch of it: the
    // campaign's own batch, or the batch chosen for this enrollment. The whole
    // list is never the fallback. Legacy campaigns without an import allow any
    // contact (back-compat).
    let scope;
    try {
      scope = await batchScope.campaignScope(campaign, batchId ? String(batchId) : '');
    } catch (err) {
      if (err instanceof batchScope.BatchScopeError) {
        return res.status(err.status).json({ success: false, message: err.message, code: err.code });
      }
      throw err;
    }
    if (scope.requiresBatch) {
      return res.status(400).json({
        success: false,
        message: 'This contact list has batches — choose the batch to enroll contacts from',
        code: 'batch_required',
      });
    }

    // ---- Resolve the target contact id set ----
    let targetIds;
    if (selectAll === true) {
      // "Select all" resolves the eligible set server-side (no huge id list over
      // the wire): all contacts in the campaign's import, minus any individually
      // unchecked contacts. Already-enrolled ones are skipped further below.
      const exclude = (Array.isArray(excludeContactIds) ? excludeContactIds : []).map(String);
      // Opted-out, inactive (Phase 1) and delivery-blocked (Phase 3) contacts
      // are never enrolled.
      const q = {
        optedOut: { $ne: true },
        isActive: { $ne: false },
        deliveryBlocked: { $ne: true },
        // A number Twilio Lookup reported invalid can never receive a message.
        'lookup.status': { $ne: 'invalid' },
      };
      Object.assign(q, scope.filter);
      if (exclude.length) q._id = { $nin: exclude };
      const all = await Contact.find(q).select('_id').lean();
      targetIds = all.map((c) => String(c._id));
    } else {
      const raw = Array.isArray(contactIds) && contactIds.length ? contactIds : contactId ? [contactId] : [];
      targetIds = [...new Set(raw.map(String))]; // de-dupe within the request
    }
    if (targetIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: 'Provide contactId, contactIds, or selectAll' });
    }

    // Batch boundary, enforced here and not just in the picker: every explicitly
    // chosen contact must be a member of the batch. One outsider rejects the
    // whole request — nothing is silently skipped, moved or accepted.
    if (scope.batch && selectAll !== true) {
      const inside = await Contact.countDocuments({ ...scope.filter, _id: { $in: targetIds } });
      if (inside !== targetIds.length) {
        const outside = targetIds.length - inside;
        const label = `Batch ${batchScope.describeBatch(scope.imp, scope.batch).number}`;
        return res.status(400).json({
          success: false,
          message: `${outside} selected contact${outside === 1 ? ' is' : 's are'} not in ${label} of ${scope.imp.filename || 'this list'}. Nothing was enrolled.`,
          code: 'outside_batch',
        });
      }
    }

    const summary = await enrollContactIds({
      campaign,
      targetIds,
      selectAll: selectAll === true,
      userId: req.user ? req.user._id : undefined,
    });
    return res.status(201).json({ success: true, summary });
  } catch (err) {
    return next(err);
  }
}

// The enrollment pipeline itself, separated from the HTTP handler so other
// flows can enroll contacts under EXACTLY the same rules — notably Phase 6's
// "enroll after import". Every eligibility guard (import scope, opt-out,
// inactive, delivery-blocked, already-enrolled) lives here and nowhere else.
//
// Returns the same `summary` shape the API has always returned.
// `ignoreImportScope` is used ONLY by Phase 6's enroll-after-import. A campaign
// normally refuses contacts outside its own contact list, which is the right
// default: it stops someone enrolling another CSV's contacts by mistake. But
// when an operator uploads a file and in the same action says "enroll these
// into campaign X", the contacts being enrolled ARE the ones they just chose —
// they simply belong to the import that was created seconds earlier, so the
// scope check would reject every single one and the feature would do nothing.
// The explicit instruction supersedes the heuristic. Every COMPLIANCE guard
// (opt-out, inactive, delivery-blocked, already-enrolled) still applies.
async function enrollContactIds({ campaign, targetIds, selectAll = false, userId, ignoreImportScope = false }) {
  {
    const campaignId = campaign._id;
    const scopeImport = ignoreImportScope ? null : campaign.import || null;
    // A campaign bound to a batch takes ONLY that batch's members. Unlike the
    // import scope this is never waived — not even by enroll-after-import.
    const scopeBatch = campaign.batch || null;
    const summary = { total: targetIds.length, enrolled: 0, skipped: 0, notFound: 0, notEligible: 0, failed: 0, created: [], errors: [] };

    // ---- Validate the contacts exist AND belong to the campaign's import ----
    let validIds;
    if (selectAll) {
      validIds = targetIds; // already scoped to the import (or all, for legacy)
    } else {
      const found = await Contact.find({ _id: { $in: targetIds } })
        .select('_id import importBatch optedOut isActive deliveryBlocked lookup.status')
        .lean();
      const foundMap = new Map(found.map((c) => [String(c._id), c]));
      validIds = [];
      for (const id of targetIds) {
        const c = foundMap.get(id);
        if (!c) {
          summary.notFound += 1;
          summary.errors.push({ contactId: id, reason: 'Contact not found' });
        } else if (scopeImport && String(c.import) !== String(scopeImport)) {
          // Backend re-validation: never enroll a contact from a different CSV.
          summary.notEligible += 1;
          summary.errors.push({ contactId: id, reason: "Contact is not in this campaign's contact list" });
        } else if (scopeBatch && String(c.importBatch) !== String(scopeBatch)) {
          summary.notEligible += 1;
          summary.errors.push({ contactId: id, reason: "Contact is not in this campaign's batch" });
        } else if (c.optedOut === true) {
          // Phase 1: an opted-out contact is never enrolled, however they were
          // selected.
          summary.notEligible += 1;
          summary.errors.push({ contactId: id, reason: 'Contact has opted out' });
        } else if (c.isActive === false) {
          summary.notEligible += 1;
          summary.errors.push({ contactId: id, reason: 'Contact is inactive' });
        } else if (c.deliveryBlocked === true) {
          // Phase 3: messages to this number keep failing to be delivered.
          summary.notEligible += 1;
          summary.errors.push({ contactId: id, reason: 'Contact is blocked for delivery failures' });
        } else if (isLookupInvalid(c)) {
          // Twilio Lookup has definitively reported this number invalid. (An
          // unchecked number, or one whose lookup failed, is NOT excluded.)
          summary.notEligible += 1;
          summary.errors.push({ contactId: id, reason: 'Number is invalid (Twilio Lookup)' });
        } else {
          validIds.push(id);
        }
      }
    }
    if (validIds.length === 0) {
      return summary;
    }

    // ---- Skip contacts already enrolled in this campaign (one query) ----
    const existing = await Enrollment.find({
      campaign: campaignId,
      contact: { $in: validIds },
      status: { $in: ENROLLED_STATES },
    })
      .select('contact')
      .lean();
    const already = new Set(existing.map((e) => String(e.contact)));
    already.forEach((id) => {
      summary.skipped += 1;
      summary.errors.push({ contactId: id, reason: 'Already enrolled' });
    });

    // ---- Insert the remainder in one bulk write ----
    const now = Date.now();
    const firstStep = campaign.steps[0];
    const firstDelay = firstStepDelayMs(firstStep);
    const docs = validIds
      .filter((id) => !already.has(id))
      .map((id) => ({
        contact: id,
        campaign: campaignId,
        status: 'active',
        // Phase 5: pin the enrollment to the FIRST STEP'S STABLE ID at creation,
        // so it keeps waiting for that exact message even if the campaign's
        // steps are reordered before it comes due. The index is kept in step for
        // display and backwards compatibility.
        currentStepId: firstStep && firstStep._id ? firstStep._id : null,
        currentStepIndex: 0,
        nextRunAt: new Date(now + firstDelay),
        createdBy: userId,
      }));

    if (docs.length > 0) {
      try {
        const inserted = await Enrollment.insertMany(docs, { ordered: false });
        summary.enrolled = inserted.length;
        summary.created = inserted.map((e) => e._id);
      } catch (bulkErr) {
        // Partial success (ordered:false). Duplicate-key races (E11000) count as
        // skipped; any other write error counts as failed. Nothing is
        // re-enrolled or duplicated.
        const insertedDocs = bulkErr.insertedDocs || [];
        summary.enrolled = insertedDocs.length;
        summary.created = insertedDocs.map((e) => e._id);
        const writeErrors =
          bulkErr.writeErrors || (bulkErr.result && bulkErr.result.writeErrors) || [];
        writeErrors.forEach((we) => {
          const code = (we.err && we.err.code) || we.code;
          if (code === 11000) {
            summary.skipped += 1;
            summary.errors.push({ reason: 'Enrollment already exists' });
          } else {
            summary.failed += 1;
            summary.errors.push({ reason: (we.err && we.err.errmsg) || 'Insert failed' });
          }
        });
      }
    }

    return summary;
  }
}

// GET /api/enrollments  (filters: status, campaign, contact; pagination)
async function listEnrollments(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;

    const filter = {};
    // Coerce to strings so query-operator objects cannot be injected into the
    // filter. For campaign/contact, a non-ObjectId string yields a clean 400
    // (Mongoose CastError) rather than passing an operator object through.
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.campaign) filter.campaign = String(req.query.campaign);
    if (req.query.contact) filter.contact = String(req.query.contact);

    const [items, total] = await Promise.all([
      Enrollment.find(filter)
        .sort('-createdAt')
        .skip(skip)
        .limit(limit)
        .populate('contact', 'name phone')
        .populate('campaign', 'name steps'),
      Enrollment.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 0 },
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/enrollments/:id
async function getEnrollment(req, res, next) {
  try {
    const enr = await Enrollment.findById(req.params.id)
      .populate('contact', 'name phone')
      .populate('campaign', 'name steps');
    if (!enr) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }
    return res.json({ success: true, data: enr });
  } catch (err) {
    return next(err);
  }
}

// Why an enrollment cannot be put back into the sending queue, in operator
// language, keyed by the code sendPolicy.checkCanSend returns.
const REACTIVATION_BLOCKS = {
  opted_out: 'the contact has opted out of SMS',
  inactive: 'the contact is marked inactive',
  delivery_blocked: 'messages to this number keep failing to be delivered',
  invalid_number: 'Twilio Lookup reports this number as invalid',
};

// PATCH /api/enrollments/:id  { status: 'paused' | 'active' | 'cancelled' }
async function updateEnrollmentStatus(req, res, next) {
  try {
    const { status } = req.body || {};
    const allowed = ['active', 'paused', 'cancelled'];
    if (!allowed.includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: `status must be one of ${allowed.join(', ')}` });
    }

    const enr = await Enrollment.findById(req.params.id);
    if (!enr) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }
    if (['completed', 'failed'].includes(enr.status)) {
      return res
        .status(400)
        .json({ success: false, message: `Cannot change a ${enr.status} enrollment` });
    }

    // Reactivating (resuming a paused row, or re-opening a cancelled one) puts
    // the contact back in line for a send, so their CURRENT eligibility is
    // checked first, through the same gate every send path uses. A contact who
    // may not be messaged — opted out, inactive, delivery-blocked, or a number
    // Lookup has reported invalid — is refused and the enrollment is left
    // exactly as it was. The worker re-checks at send time regardless, because
    // any of these can change after a successful reactivation.
    if (status === 'active' && enr.status !== 'active') {
      const contact = await Contact.findById(enr.contact);
      if (!contact) {
        return res.status(409).json({
          success: false,
          code: 'no_contact',
          message: 'This enrollment cannot be reactivated: its contact no longer exists',
          data: enr,
        });
      }
      const eligibility = await checkCanSend({ contact, phone: contact.phone });
      if (!eligibility.allowed) {
        return res.status(409).json({
          success: false,
          code: eligibility.code,
          message: `This enrollment cannot be reactivated: ${REACTIVATION_BLOCKS[eligibility.code] || 'the contact cannot be messaged'}`,
          data: enr,
        });
      }
    }

    // Resuming makes the next step due now.
    if (status === 'active' && enr.status === 'paused') {
      enr.nextRunAt = new Date();
    }
    enr.status = status;
    await enr.save();

    return res.json({ success: true, data: enr });
  } catch (err) {
    return next(err);
  }
}

// POST /api/enrollments/run  (admin) — trigger one worker pass immediately.
// Body: { ignoreWindow?: boolean }, default FALSE (Phase 2) — a manual run now
// respects the sending window unless the operator deliberately opts out, and
// the route is admin-only so only an admin can ask for the bypass. Only the
// window/send-day check is ever bypassed: smsEnabled, opt-out compliance,
// mobile-only, idempotency, retries and completion all still apply.
async function runNow(req, res, next) {
  try {
    const ignoreWindow = (req.body && req.body.ignoreWindow) === true;
    const summary = await automationWorker.processDueEnrollments(new Date(), { ignoreWindow });
    return res.json({ success: true, ignoreWindow, summary });
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/enrollments/:id  — remove one enrollment ("un-enroll" a contact
// from a campaign). Contact, campaign, conversation and SMS history are NOT
// touched. Safe w.r.t. automation: the cron worker only queries live active
// enrollments, so a deleted row is simply never processed again.
async function deleteEnrollment(req, res, next) {
  try {
    const enr = await Enrollment.findByIdAndDelete(req.params.id);
    if (!enr) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }
    return res.json({ success: true, message: 'Enrollment deleted' });
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/enrollments?status=  — delete all enrollments, optionally scoped to
// a status filter (filter-aware, matching the list filter). Only Enrollment
// records are removed; contacts, campaigns, conversations and SMS history remain.
async function deleteAllEnrollments(req, res, next) {
  try {
    const filter = {};
    if (req.query.status) {
      const allowed = ['active', 'paused', 'completed', 'failed', 'cancelled'];
      const st = String(req.query.status);
      if (!allowed.includes(st)) {
        return res.status(400).json({ success: false, message: 'Invalid status filter' });
      }
      filter.status = st;
    }
    const r = await Enrollment.deleteMany(filter);
    return res.json({ success: true, deletedCount: r.deletedCount });
  } catch (err) {
    return next(err);
  }
}

// GET /api/enrollments/by-contact/:contactId
// The LATEST enrollment per campaign for one contact — what the inbox side
// panel needs to show "this person is on campaign X, at step 2, active".
// A contact re-enrolled into the same campaign several times yields one row:
// the most recent. Returns ids, status and progress only, no contact PII.
async function getEnrollmentsByContact(req, res, next) {
  try {
    const contact = await Contact.findById(req.params.contactId).select('_id');
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }

    const rows = await Enrollment.aggregate([
      { $match: { contact: contact._id } },
      // Newest first so $first below picks the latest per campaign.
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$campaign', doc: { $first: '$$ROOT' } } },
      { $lookup: { from: 'campaigns', localField: '_id', foreignField: '_id', as: 'campaign' } },
      { $unwind: { path: '$campaign', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: '$doc._id',
          campaignId: '$_id',
          campaignName: '$campaign.name',
          campaignActive: '$campaign.isActive',
          totalSteps: { $size: { $ifNull: ['$campaign.steps', []] } },
          status: '$doc.status',
          currentStepIndex: '$doc.currentStepIndex',
          nextRunAt: '$doc.nextRunAt',
          lastStepSentAt: '$doc.lastStepSentAt',
          repliedAt: '$doc.repliedAt',
          stopReason: '$doc.stopReason',
          lastError: '$doc.lastError',
          createdAt: '$doc.createdAt',
        },
      },
      { $sort: { createdAt: -1 } },
    ]);

    return res.json({ success: true, data: rows });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getEnrollmentsByContact,
  createEnrollment,
  // Phase 6: reused by the import-confirm flow so enroll-after-import obeys the
  // identical eligibility rules (no second implementation).
  enrollContactIds,
  listEnrollments,
  getEnrollment,
  updateEnrollmentStatus,
  runNow,
  deleteEnrollment,
  deleteAllEnrollments,
};
