// Following automation: create/list/edit/delete automated follow-ups, plus
// activate/pause. A Following sends one message to a selected set of contacts
// (from one import) after a delay, executed by the shared automation worker.
//
// Reuses existing infrastructure: the Import + Contact models and their
// relationships, the shared template-vs-custom resolver (utils/messageSource),
// and the shared automation worker (jobs/automationWorker) for execution.
const Following = require('../models/Following');
const Import = require('../models/Import');
const Contact = require('../models/Contact');
const { resolveMessage } = require('../utils/messageSource');
const automationWorker = require('../jobs/automationWorker');

const MAX_LIMIT = 100;
const VALID_UNITS = ['minutes', 'hours'];

// Delay -> milliseconds (minutes/hours only).
function delayMs(value, unit) {
  const v = Number(value) || 0;
  return unit === 'minutes' ? v * 60 * 1000 : v * 60 * 60 * 1000;
}

// Validate + normalize the follow-up timing. Returns { delayValue, delayUnit } or { error }.
function sanitizeTiming(delayValue, delayUnit) {
  const unit = delayUnit || 'hours';
  if (!VALID_UNITS.includes(unit)) {
    return { error: `delayUnit must be one of ${VALID_UNITS.join(', ')}` };
  }
  const value = delayValue === undefined ? 0 : Number(delayValue);
  if (Number.isNaN(value) || value < 0) {
    return { error: 'delayValue must be a non-negative number' };
  }
  return { delayValue: value, delayUnit: unit };
}

// Resolve the target contact ids, scoped to (and re-validated against) the
// import — the same duplicate-safe, backend-validated approach the enrollment
// flow uses. Accepts either an explicit list or selectAll + exclusions.
// Opted-out and inactive contacts are never included (Phase 1); $ne also
// matches legacy contacts created before those fields existed.
// Returns { ids, notEligible } (contacts that exist, belong to the import and
// may be messaged; notEligible counts those filtered out by compliance).
const ELIGIBLE = {
  optedOut: { $ne: true },
  isActive: { $ne: false },
  // Phase 3: numbers Twilio keeps failing to deliver to are not eligible either.
  deliveryBlocked: { $ne: true },
  // A number Twilio Lookup DEFINITIVELY reported invalid — the same rule the
  // enrollment picker applies. $ne keeps unchecked numbers, unclassifiable ones
  // and failed lookups (none of which is 'invalid') eligible.
  'lookup.status': { $ne: 'invalid' },
};
// The inverse of ELIGIBLE, for counting what a selection lost.
const NOT_ELIGIBLE = [
  { optedOut: true },
  { isActive: false },
  { deliveryBlocked: true },
  { 'lookup.status': 'invalid' },
];
const NONE_ELIGIBLE_MESSAGE =
  'None of the selected contacts can be messaged (opted out, inactive, delivery-blocked or an invalid number)';

async function resolveContactIds({ importId, contactIds, selectAll, excludeContactIds }) {
  if (selectAll === true) {
    const exclude = (Array.isArray(excludeContactIds) ? excludeContactIds : []).map(String);
    const q = { import: importId, ...ELIGIBLE };
    if (exclude.length) q._id = { $nin: exclude };
    const all = await Contact.find(q).select('_id').lean();
    return { ids: all.map((c) => String(c._id)), notEligible: 0 };
  }
  const raw = Array.isArray(contactIds) ? contactIds : [];
  const unique = [...new Set(raw.map(String))];
  if (unique.length === 0) return { ids: [], notEligible: 0 };
  // Only keep contacts that exist, belong to this import, and may be messaged.
  const found = await Contact.find({ _id: { $in: unique }, import: importId, ...ELIGIBLE })
    .select('_id')
    .lean();
  // Anything requested but filtered out: wrong import, deleted, or compliance.
  const blocked = await Contact.countDocuments({
    _id: { $in: unique },
    import: importId,
    $or: NOT_ELIGIBLE,
  });
  return { ids: found.map((c) => String(c._id)), notEligible: blocked };
}

function buildRecipients(contactIds) {
  return contactIds.map((id) => ({ contact: id, status: 'pending' }));
}

// Reconcile the runtime recipient list against a new selection while preserving
// history: already sent/failed recipients are kept; pending ones no longer
// selected are dropped; newly selected contacts are added as pending.
function reconcileRecipients(existing, contactIds) {
  const wanted = new Set(contactIds.map(String));
  const kept = existing.filter((r) => wanted.has(String(r.contact)) || r.status !== 'pending');
  const keptIds = new Set(kept.map((r) => String(r.contact)));
  for (const id of contactIds) {
    if (!keptIds.has(String(id))) kept.push({ contact: id, status: 'pending' });
  }
  return kept;
}

// POST /api/followings
async function createFollowing(req, res, next) {
  try {
    const {
      name, importId, contactIds, selectAll, excludeContactIds,
      delayValue, delayUnit, templateId, body, stopOnReply,
    } = req.body || {};

    if (!name || String(name).trim() === '') {
      return res.status(400).json({ success: false, message: 'Following name is required' });
    }
    if (!importId) {
      return res.status(400).json({ success: false, message: 'A contact list (CSV import) is required' });
    }
    const imp = await Import.findById(importId);
    if (!imp) {
      return res.status(400).json({ success: false, message: 'Selected contact list (import) not found' });
    }

    const timing = sanitizeTiming(delayValue, delayUnit);
    if (timing.error) return res.status(400).json({ success: false, message: timing.error });

    const msg = await resolveMessage({ templateId, body });
    if (msg.error) return res.status(400).json({ success: false, message: msg.error });

    const { ids, notEligible } = await resolveContactIds({
      importId,
      contactIds,
      selectAll,
      excludeContactIds,
    });
    if (ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: notEligible
          ? NONE_ELIGIBLE_MESSAGE
          : 'Select at least one contact from the chosen contact list',
      });
    }

    const following = await Following.create({
      name: String(name).trim(),
      import: imp._id,
      contactIds: ids,
      delayValue: timing.delayValue,
      delayUnit: timing.delayUnit,
      template: msg.template,
      body: msg.body,
      // Phase 2: default on — a contact who replies is left alone.
      stopOnReply: stopOnReply === undefined ? true : !!stopOnReply,
      status: 'draft', // never auto-send on create
      createdBy: req.user ? req.user._id : undefined,
    });

    return res.status(201).json({ success: true, data: following, notEligible });
  } catch (err) {
    return next(err);
  }
}

// GET /api/followings  (paginated; recipients omitted for a light list payload)
async function listFollowings(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = String(req.query.status);

    const [items, total] = await Promise.all([
      Following.find(filter)
        .sort('-createdAt')
        .skip(skip)
        .limit(limit)
        .select('-recipients')
        .populate('import', 'filename')
        .populate('template', 'name'),
      Following.countDocuments(filter),
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

// GET /api/followings/:id
async function getFollowing(req, res, next) {
  try {
    const following = await Following.findById(req.params.id)
      .populate('import', 'filename')
      .populate('template', 'name body')
      // Recipient contacts are populated so the UI can show each recipient's
      // status (including 'skipped') with a name instead of a raw id.
      .populate('recipients.contact', 'name phone optedOut');
    if (!following) {
      return res.status(404).json({ success: false, message: 'Following not found' });
    }
    return res.json({ success: true, data: following });
  } catch (err) {
    return next(err);
  }
}

// PUT /api/followings/:id  — update configuration (idempotent; never duplicates).
async function updateFollowing(req, res, next) {
  try {
    const following = await Following.findById(req.params.id);
    if (!following) {
      return res.status(404).json({ success: false, message: 'Following not found' });
    }

    const {
      name, importId, contactIds, selectAll, excludeContactIds,
      delayValue, delayUnit, templateId, body, stopOnReply,
    } = req.body || {};

    if (stopOnReply !== undefined) following.stopOnReply = !!stopOnReply;

    if (name !== undefined) {
      if (String(name).trim() === '') {
        return res.status(400).json({ success: false, message: 'Following name cannot be empty' });
      }
      following.name = String(name).trim();
    }

    // Determine the effective import for contact re-validation (new one if provided).
    let effectiveImportId = following.import;
    if (importId !== undefined && String(importId) !== String(following.import)) {
      const imp = await Import.findById(importId);
      if (!imp) {
        return res.status(400).json({ success: false, message: 'Selected contact list (import) not found' });
      }
      following.import = imp._id;
      effectiveImportId = imp._id;
    }

    if (delayValue !== undefined || delayUnit !== undefined) {
      const timing = sanitizeTiming(
        delayValue !== undefined ? delayValue : following.delayValue,
        delayUnit !== undefined ? delayUnit : following.delayUnit
      );
      if (timing.error) return res.status(400).json({ success: false, message: timing.error });
      following.delayValue = timing.delayValue;
      following.delayUnit = timing.delayUnit;
    }

    if (templateId !== undefined || body !== undefined) {
      const msg = await resolveMessage({ templateId, body });
      if (msg.error) return res.status(400).json({ success: false, message: msg.error });
      following.template = msg.template;
      following.body = msg.body;
    }

    // Re-resolve the selection when any selection input is provided (or when the
    // import changed, since old ids may not belong to the new import).
    const selectionProvided =
      contactIds !== undefined || selectAll !== undefined || excludeContactIds !== undefined;
    if (selectionProvided) {
      const { ids, notEligible } = await resolveContactIds({
        importId: effectiveImportId,
        contactIds,
        selectAll,
        excludeContactIds,
      });
      if (ids.length === 0) {
        return res.status(400).json({
          success: false,
          message: notEligible
            ? NONE_ELIGIBLE_MESSAGE
            : 'Select at least one contact from the chosen contact list',
        });
      }
      following.contactIds = ids;
      // If already activated, keep sent/failed history and sync pending recipients.
      if (following.recipients.length > 0) {
        following.recipients = reconcileRecipients(following.recipients, ids);
      }
    }

    await following.save();
    return res.json({ success: true, data: following });
  } catch (err) {
    return next(err);
  }
}

// PATCH /api/followings/:id  { status: 'active' | 'paused' }  — activate/pause.
async function updateFollowingStatus(req, res, next) {
  try {
    const { status } = req.body || {};
    if (!['active', 'paused'].includes(status)) {
      return res.status(400).json({ success: false, message: "status must be 'active' or 'paused'" });
    }

    const following = await Following.findById(req.params.id);
    if (!following) {
      return res.status(404).json({ success: false, message: 'Following not found' });
    }
    if (following.status === 'completed') {
      return res.status(400).json({ success: false, message: 'This follow-up has already completed' });
    }

    if (status === 'active') {
      if (!following.contactIds || following.contactIds.length === 0) {
        return res.status(400).json({ success: false, message: 'Cannot activate a follow-up with no contacts' });
      }
      const now = Date.now();
      if (following.status === 'draft') {
        // First activation: build the recipient list and schedule the send.
        following.recipients = buildRecipients(following.contactIds);
        following.activatedAt = new Date(now);
        following.nextRunAt = new Date(now + delayMs(following.delayValue, following.delayUnit));
      } else if (following.status === 'paused') {
        // Resume: keep recipients/history; ensure a run time exists.
        if (!following.nextRunAt) {
          following.nextRunAt = new Date(now + delayMs(following.delayValue, following.delayUnit));
        }
      }
      following.status = 'active';
    } else {
      // status === 'paused'
      if (following.status !== 'active') {
        return res.status(400).json({ success: false, message: 'Only an active follow-up can be paused' });
      }
      following.status = 'paused';
    }

    await following.save();
    return res.json({ success: true, data: following });
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/followings/:id — removes ONLY the follow-up automation record. Its
// future execution stops because the worker only ever queries live 'active'
// Following documents. Contacts, imports, campaigns, enrollments, conversations,
// SMS history and templates are all preserved.
async function deleteFollowing(req, res, next) {
  try {
    const following = await Following.findByIdAndDelete(req.params.id);
    if (!following) {
      return res.status(404).json({ success: false, message: 'Following not found' });
    }
    return res.json({ success: true, message: 'Following deleted' });
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/followings — delete ALL follow-up records (only this collection).
async function deleteAllFollowings(req, res, next) {
  try {
    const r = await Following.deleteMany({});
    return res.json({ success: true, deletedCount: r.deletedCount });
  } catch (err) {
    return next(err);
  }
}

// POST /api/followings/run  (admin) — trigger one follow-up worker pass now.
async function runNow(req, res, next) {
  try {
    const summary = await automationWorker.processDueFollowings();
    return res.json({ success: true, summary });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createFollowing,
  listFollowings,
  getFollowing,
  updateFollowing,
  updateFollowingStatus,
  deleteFollowing,
  deleteAllFollowings,
  runNow,
};
