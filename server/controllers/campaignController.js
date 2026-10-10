// Campaign management: CRUD for multi-step campaign sequences, cloning and
// per-campaign statistics.
const mongoose = require('mongoose');

const Campaign = require('../models/Campaign');
const Contact = require('../models/Contact');
const Enrollment = require('../models/Enrollment');
const Import = require('../models/Import');
const SMSMessage = require('../models/SMSMessage');
const { resolveMessage } = require('../utils/messageSource');
const { queryString, pickSort, queryBool } = require('../utils/queryGuards');
const { logEvent } = require('../services/logService');
const batchScope = require('../services/batchScope');

// Validate a campaign's (list, batch) choice. When the list has batches, one
// must be chosen and it must be an active batch of THAT list — the whole list
// is never used silently. Returns { batchId } or { error }.
async function validateCampaignBatch(imp, batchId) {
  if (batchId) {
    try {
      const scope = await batchScope.resolveBatchScope(imp._id, batchId);
      return { batchId: scope.batch._id };
    } catch (err) {
      if (err instanceof batchScope.BatchScopeError) return { error: err.message };
      throw err;
    }
  }
  if (batchScope.hasActiveBatches(imp)) {
    return { error: 'This contact list has batches — select the batch this campaign is for' };
  }
  return { batchId: null };
}

// Describe each campaign's batch for display: "Batch 2 — 100 contacts".
// Contact counts are LIVE (members that still exist).
async function withBatchInfo(campaigns) {
  const bound = campaigns.filter((c) => c.batch && c.import);
  if (!bound.length) return campaigns.map((c) => (c.toJSON ? c.toJSON() : c));
  const importIds = [...new Set(bound.map((c) => String(c.import._id || c.import)))];
  const imps = await Import.find({ _id: { $in: importIds } }).select('filename allocation.batches').lean();
  const byId = new Map(imps.map((i) => [String(i._id), i]));
  const counts = await Promise.all(bound.map((c) => Contact.countDocuments({ importBatch: c.batch })));
  const countOf = new Map(bound.map((c, i) => [String(c._id), counts[i]]));
  return campaigns.map((c) => {
    const obj = c.toJSON ? c.toJSON() : c;
    if (!c.batch || !c.import) return obj;
    const imp = byId.get(String(c.import._id || c.import));
    const b = imp ? batchScope.findBatch(imp, c.batch) : null;
    obj.batchInfo = b
      ? { ...batchScope.describeBatch(imp, b), contacts: countOf.get(String(c._id)) }
      : { _id: c.batch, number: null, status: 'missing', contacts: countOf.get(String(c._id)) };
    return obj;
  });
}

const MAX_LIMIT = 100;
// Phase 0: allow-listed sort fields for the campaign list.
const CAMPAIGN_SORT_FIELDS = ['createdAt', 'name'];
const VALID_UNITS = ['minutes', 'hours', 'days'];
// Phase 5: a sanity bound on sequence length — not a product limit, just a
// guard so one request cannot create an unbounded array.
const MAX_STEPS = 50;
// Enrollment states that make a contact ineligible for (re-)enrollment — they
// have already received or are receiving the campaign. cancelled/failed remain
// eligible (a retry is allowed).
const ENROLLED_STATES = ['active', 'paused', 'completed'];
// Phase 5: enrollments the worker could still act on. A step edit can only
// affect these.
const LIVE_STATES = ['active', 'paused'];
// Phase 3: an outbound message counts as DELIVERED only on a real carrier
// receipt. Everything else is "we handed it to Twilio".
const DELIVERED_STATUSES = ['delivered'];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Phase 5: normalize an incoming steps[] array into clean step documents.
//
// Each step accepts EITHER a templateId OR a custom body (resolveMessage
// enforces "exactly one"), plus a delay expressed as value + unit. The delay is
// measured from the previous step's send — step 1's delay is the wait after
// enrollment.
//
// STABLE IDENTITY: a step that already exists keeps its `_id`. The client sends
// the `_id` back for steps it is preserving, and omits it for new ones (Mongoose
// then mints a fresh id). This is what lets an in-flight enrollment keep
// pointing at the same message across an edit — see applyStepEdit below.
//
// Returns { steps } or { error } with a safe validation message.
async function sanitizeSteps(rawSteps) {
  if (rawSteps === undefined) return { steps: undefined }; // not provided -> leave as is
  if (!Array.isArray(rawSteps)) {
    return { error: 'steps must be an array' };
  }
  if (rawSteps.length === 0) {
    return { error: 'A campaign needs at least one step' };
  }
  if (rawSteps.length > MAX_STEPS) {
    return { error: `A campaign can have at most ${MAX_STEPS} steps` };
  }

  const steps = [];
  const seenIds = new Set();
  for (let i = 0; i < rawSteps.length; i += 1) {
    const s = rawSteps[i] || {};

    // Resolve the message from a template or a custom body, exactly as the
    // single-message path does (shared helper — no second implementation).
    const msg = await resolveMessage({ templateId: s.templateId || s.template, body: s.body });
    if (msg.error) {
      return { error: `Step ${i + 1}: ${msg.error}` };
    }

    const delayValue = s.delayValue === undefined || s.delayValue === '' ? 0 : Number(s.delayValue);
    if (!Number.isFinite(delayValue) || delayValue < 0) {
      return { error: `Step ${i + 1}: delayValue must be a non-negative number` };
    }
    const delayUnit = s.delayUnit || 'hours';
    if (!VALID_UNITS.includes(delayUnit)) {
      return { error: `Step ${i + 1}: delayUnit must be one of ${VALID_UNITS.join(', ')}` };
    }

    const step = { body: msg.body, delayValue, delayUnit };
    if (msg.template) step.template = msg.template;

    // Preserve the id of a step the caller is keeping. A repeated id would make
    // "which step is this enrollment on?" ambiguous, so it is refused.
    const rawId = s._id === undefined || s._id === null ? '' : String(s._id).trim();
    if (rawId) {
      if (!mongoose.Types.ObjectId.isValid(rawId)) {
        return { error: `Step ${i + 1}: invalid step id` };
      }
      if (seenIds.has(rawId)) {
        return { error: `Step ${i + 1}: duplicate step id` };
      }
      seenIds.add(rawId);
      step._id = new mongoose.Types.ObjectId(rawId);
    }

    steps.push(step);
  }
  return { steps };
}

// Phase 5: how many enrollments are still in flight for a campaign. "In flight"
// means the worker could still send them something — active or paused. A
// completed/replied/cancelled/failed enrollment is finished and cannot be
// affected by a step edit.
async function countLiveEnrollments(campaignId) {
  return Enrollment.countDocuments({ campaign: campaignId, status: { $in: LIVE_STATES } });
}

// Phase 5: describe what a step edit does to in-flight enrollments, so the API
// can warn instead of silently changing what someone is about to receive.
//
// Returns { affected, orphaned } where:
//   affected — enrollments the edit could touch at all (active/paused)
//   orphaned — enrollments whose current step was REMOVED by this edit; the
//              worker moves them to the next step they have not had yet
//              (see resolveCurrentStep in jobs/automationWorker.js)
async function describeStepEdit(campaignId, nextSteps) {
  const live = await Enrollment.find({
    campaign: campaignId,
    status: { $in: LIVE_STATES },
  })
    .select('currentStepId')
    .lean();

  const keptIds = new Set(nextSteps.filter((s) => s._id).map((s) => String(s._id)));
  let orphaned = 0;
  for (const e of live) {
    // A legacy enrollment (no currentStepId) is index-based; it is counted as
    // affected but never as orphaned, because there is no id to lose.
    if (e.currentStepId && !keptIds.has(String(e.currentStepId))) orphaned += 1;
  }
  return { affected: live.length, orphaned };
}

// GET /api/campaigns  (search, page, limit)
async function listCampaigns(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;

    const filter = {};
    // Phase 0: single-string coercion before the value reaches a RegExp or the
    // Mongo filter.
    const search = queryString(req.query.search);
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ name: re }, { description: re }];
    }
    const isActive = queryBool(req.query.isActive);
    if (isActive !== undefined) {
      filter.isActive = isActive;
    }

    const { sort, invalid } = pickSort(req.query.sort, CAMPAIGN_SORT_FIELDS);
    if (invalid) {
      return res.status(400).json({
        success: false,
        message: `Invalid sort "${invalid}". Allowed fields: ${CAMPAIGN_SORT_FIELDS.join(', ')} (prefix with "-" for descending).`,
      });
    }

    const [items, total] = await Promise.all([
      Campaign.find(filter).sort(sort).skip(skip).limit(limit).populate('import', 'filename'),
      Campaign.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: await withBatchInfo(items),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 0 },
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/campaigns/:id
async function getCampaign(req, res, next) {
  try {
    const campaign = await Campaign.findById(req.params.id).populate('import', 'filename');
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }
    const [data] = await withBatchInfo([campaign]);
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
}

// GET /api/campaigns/:id/eligible-contacts?search=&page=&limit=
// Contacts that can still be enrolled in this campaign: members of the
// campaign's contact import (CSV) that are NOT already enrolled (active/paused/
// completed). Paginated + searchable (name/phone/email) and scoped to the
// import, so it scales to thousands of contacts.
// (This file previously declared a SECOND `escapeRegex` here, shadowing the one
// at the top. Legal in CommonJS but an immediate SyntaxError under ESM — removed.)
async function getEligibleContacts(req, res, next) {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }
    // Legacy campaign with no contact list: nothing eligible until one is set.
    if (!campaign.import) {
      return res.json({
        success: true,
        noImport: true,
        data: [],
        pagination: { page: 1, limit: 0, total: 0, pages: 0 },
      });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;

    // Batch scope: the campaign's own batch, or (for a campaign on a list that
    // has batches) the batch requested. The whole list is never the fallback.
    let scope;
    try {
      scope = await batchScope.campaignScope(campaign, queryString(req.query.batch));
    } catch (err) {
      if (err instanceof batchScope.BatchScopeError) {
        return res.status(err.status).json({ success: false, message: err.message, code: err.code });
      }
      throw err;
    }
    const scopeInfo = {
      import: scope.imp ? { _id: scope.imp._id, filename: scope.imp.filename } : null,
      batch: scope.batch ? batchScope.describeBatch(scope.imp, scope.batch) : null,
      batches: scope.batches,
      fixed: !!campaign.batch,
    };
    if (scope.requiresBatch) {
      return res.json({
        success: true,
        requiresBatch: true,
        scope: scopeInfo,
        data: [],
        pagination: { page: 1, limit, total: 0, pages: 0 },
      });
    }

    // Contacts already enrolled (and therefore not eligible).
    const enrolled = await Enrollment.find({
      campaign: campaign._id,
      status: { $in: ENROLLED_STATES },
    })
      .select('contact')
      .lean();
    const enrolledIds = enrolled.map((e) => e.contact);

    // Opted-out, inactive (Phase 1) and delivery-blocked (Phase 3) contacts are
    // never eligible — the same three conditions checkCanSend refuses at send
    // time. $ne:true / $ne:false also match legacy contacts predating the fields.
    const filter = {
      ...scope.filter,
      _id: { $nin: enrolledIds },
      optedOut: { $ne: true },
      isActive: { $ne: false },
      deliveryBlocked: { $ne: true },
      // Nor is a number Twilio Lookup reported invalid.
      'lookup.status': { $ne: 'invalid' },
    };
    if (req.query.search) {
      const re = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
      filter.$or = [{ name: re }, { phone: re }, { email: re }];
    }

    const [items, total] = await Promise.all([
      Contact.find(filter).sort('-createdAt').skip(skip).limit(limit).select('name phone email'),
      Contact.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      scope: scopeInfo,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 0 },
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/campaigns
//
// Phase 5: a campaign is an ordered SEQUENCE of steps again. Two payload shapes
// are accepted and both produce the same stored document:
//
//   multi-step  { steps: [{ templateId|body, delayValue, delayUnit }, ...] }
//   single      { templateId|body }            <- the pre-Phase-5 shape
//
// The single-message shape is still supported so existing clients and saved
// integrations keep working; it is simply stored as a one-step sequence, which
// is exactly what it already was.
async function createCampaign(req, res, next) {
  try {
    const { name, description, isActive, import: importId, batch: batchId, templateId, body, steps: rawSteps } =
      req.body || {};
    if (!name) {
      return res.status(400).json({ success: false, message: 'Campaign name is required' });
    }
    // A contact list (CSV import) is required for new campaigns so enrollment
    // can be scoped to it. Validate the referenced import exists.
    if (!importId) {
      return res.status(400).json({ success: false, message: 'A contact list (CSV import) is required' });
    }
    const imp = await Import.findById(importId);
    if (!imp) {
      return res.status(400).json({ success: false, message: 'Selected contact list (import) not found' });
    }

    // Build the step list from whichever payload shape was used.
    let steps;
    if (rawSteps !== undefined) {
      const result = await sanitizeSteps(rawSteps);
      if (result.error) {
        return res.status(400).json({ success: false, message: result.error });
      }
      steps = result.steps;
    } else {
      // Back-compat: one message, sent as soon as the enrollment is due.
      const msg = await resolveMessage({ templateId, body });
      if (msg.error) {
        return res.status(400).json({ success: false, message: msg.error });
      }
      steps = [{ body: msg.body, delayValue: 0, delayUnit: 'hours', template: msg.template }];
    }

    // The audience: one batch of the list when it has batches (required).
    const batchCheck = await validateCampaignBatch(imp, queryString(batchId));
    if (batchCheck.error) {
      return res.status(400).json({ success: false, message: batchCheck.error });
    }

    const campaign = await Campaign.create({
      name,
      description: description || '',
      steps,
      isActive: isActive === undefined ? true : !!isActive,
      import: imp._id,
      batch: batchCheck.batchId,
      createdBy: req.user ? req.user._id : undefined,
    });

    return res.status(201).json({ success: true, data: campaign });
  } catch (err) {
    return next(err);
  }
}

// PUT /api/campaigns/:id
async function updateCampaign(req, res, next) {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    const { name, description, isActive, import: importId, batch: batchId, templateId, body, steps: rawSteps } =
      req.body || {};

    // Phase 5: replacing the sequence. Steps the caller sends back WITH their
    // `_id` keep that id, so an in-flight enrollment waiting on one of them is
    // untouched. Steps sent without an id are new.
    let editWarning;
    if (rawSteps !== undefined) {
      const result = await sanitizeSteps(rawSteps);
      if (result.error) {
        return res.status(400).json({ success: false, message: result.error });
      }
      // Work out the blast radius BEFORE writing, so the response can report it.
      const impact = await describeStepEdit(campaign._id, result.steps);
      campaign.steps = result.steps;
      if (impact.affected > 0) {
        editWarning = {
          affectedEnrollments: impact.affected,
          orphanedEnrollments: impact.orphaned,
          message:
            impact.orphaned > 0
              ? `${impact.affected} in-flight enrollment(s) are on this campaign. ${impact.orphaned} of them were waiting on a step you removed and will move on to their next unsent step instead.`
              : `${impact.affected} in-flight enrollment(s) are on this campaign. Each one keeps waiting for the same step it was already on.`,
        };
        await logEvent({
          eventType: 'campaign.steps_edited',
          severity: 'warning',
          message: `Campaign "${campaign.name}" steps edited with ${impact.affected} enrollment(s) in flight`,
          status: 'edited',
          campaign: campaign._id,
          meta: {
            affected: impact.affected,
            orphaned: impact.orphaned,
            stepCount: result.steps.length,
            by: req.user ? String(req.user._id) : undefined,
          },
        });
      }
    } else if (templateId !== undefined || body !== undefined) {
      // Back-compat single-message edit. This DOES collapse a sequence to one
      // step — an explicit user save through the old payload shape, never an
      // automatic migration.
      const msg = await resolveMessage({ templateId, body });
      if (msg.error) {
        return res.status(400).json({ success: false, message: msg.error });
      }
      campaign.steps = [{ body: msg.body, delayValue: 0, delayUnit: 'hours', template: msg.template }];
    }
    if (name !== undefined) campaign.name = name;
    if (description !== undefined) campaign.description = description;
    if (isActive !== undefined) campaign.isActive = !!isActive;
    // Allow changing the campaign's contact list. Historical enrollments are NOT
    // touched — this only affects which contacts are eligible for FUTURE
    // enrollment. (The UI warns before changing a campaign that has enrollments.)
    // The batch is (re)validated whenever the list or the batch CHANGES: a
    // campaign moved to (or re-pointed within) a list with batches must name one
    // of that list's batches. Re-sending the same pair — e.g. when only the
    // steps were edited — leaves an existing campaign as it is.
    const listChanged = !!importId && String(importId) !== String(campaign.import || '');
    const batchChanged = batchId !== undefined && String(batchId || '') !== String(campaign.batch || '');
    if (listChanged || batchChanged) {
      const imp = await Import.findById(importId || campaign.import);
      if (!imp) {
        return res.status(400).json({ success: false, message: 'Selected contact list (import) not found' });
      }
      const batchCheck = await validateCampaignBatch(imp, queryString(batchId));
      if (batchCheck.error) {
        return res.status(400).json({ success: false, message: batchCheck.error });
      }
      campaign.import = imp._id;
      campaign.batch = batchCheck.batchId;
    }

    await campaign.save();
    return res.json({ success: true, data: campaign, warning: editWarning });
  } catch (err) {
    return next(err);
  }
}

// POST /api/campaigns/:id/clone
//
// Phase 5: duplicate the DEFINITION only — name, description, steps (with their
// delays and template references) and the contact list. Nothing about execution
// is copied: no enrollments, no sentSteps, no message history, no schedule.
//
// Each cloned step gets a FRESH _id. Reusing the source ids would mean two
// campaigns share step identities, which makes "which step is this enrollment
// waiting on?" ambiguous to read even though the lookup is campaign-scoped.
//
// The clone is always created INACTIVE, so duplicating a live campaign can never
// start sending to anyone by accident. The operator activates it deliberately.
async function cloneCampaign(req, res, next) {
  try {
    const source = await Campaign.findById(req.params.id);
    if (!source) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    const steps = (source.steps || []).map((s) => ({
      // No _id here -> Mongoose mints a new one.
      body: s.body,
      delayValue: s.delayValue,
      delayUnit: s.delayUnit,
      template: s.template,
    }));

    const clone = await Campaign.create({
      name: `${source.name} (copy)`,
      description: source.description || '',
      steps,
      isActive: false,
      import: source.import,
      // Same audience: the clone is for the same batch.
      batch: source.batch || null,
      createdBy: req.user ? req.user._id : undefined,
    });

    await logEvent({
      eventType: 'campaign.cloned',
      severity: 'info',
      message: `Campaign "${source.name}" cloned to "${clone.name}"`,
      status: 'cloned',
      campaign: clone._id,
      meta: { sourceCampaign: String(source._id), steps: steps.length },
    });

    return res.status(201).json({ success: true, data: clone });
  } catch (err) {
    return next(err);
  }
}

// GET /api/campaigns/stats
//
// Per-campaign performance. Everything is computed with MongoDB aggregation —
// nothing is loaded into Node memory, and this endpoint never writes.
//
// DEFINITIONS (fixed and documented, so the numbers mean one thing only):
//
//   enrolled    — ENROLLMENT ROWS for the campaign, in any state. Re-enrolling
//                 a contact creates a second row and counts twice, because an
//                 enrollment is one pass of someone through the sequence.
//   replied     — enrollment rows in state 'replied' (Phase 1 sets this when a
//                 contact answers, which stops the remaining steps).
//   replyRate   — replied / enrolled, i.e. ENROLLMENT-ROW based, NOT
//                 replies-per-delivered-message. Chosen because the campaign's
//                 own unit of work is the enrollment: a 3-step sequence sends 3
//                 messages to one person, and dividing by messages would make a
//                 longer sequence look worse for the same human response. Both
//                 numbers are returned, so a per-message view can still be
//                 derived by the caller.
//   sent        — outbound SMSMessage rows stamped with this campaign (the
//                 worker stamps every automation send). Soft-deleted rows are
//                 excluded.
//   delivered   — of those, the ones with a Phase 3 carrier receipt of
//                 'delivered'. NOT "accepted by Twilio".
//   optOuts     — see attributeOptOuts below.
async function getCampaignStats(req, res, next) {
  try {
    const campaigns = await Campaign.find({}).select('name isActive steps createdAt').lean();

    const [byStatus, byMessages, optOuts] = await Promise.all([
      Enrollment.aggregate([
        { $group: { _id: { campaign: '$campaign', status: '$status' }, n: { $sum: 1 } } },
      ]),
      SMSMessage.aggregate([
        {
          $match: {
            campaign: { $ne: null },
            direction: 'outbound',
            deletedAt: null,
          },
        },
        {
          $group: {
            _id: '$campaign',
            sent: { $sum: 1 },
            delivered: {
              $sum: { $cond: [{ $in: ['$status', DELIVERED_STATUSES] }, 1, 0] },
            },
          },
        },
      ]),
      attributeOptOuts(),
    ]);

    // Index the aggregation results by campaign id.
    const statusMap = new Map();
    for (const row of byStatus) {
      const cid = String(row._id.campaign);
      if (!statusMap.has(cid)) statusMap.set(cid, {});
      statusMap.get(cid)[row._id.status] = row.n;
    }
    const msgMap = new Map(byMessages.map((m) => [String(m._id), m]));
    const optOutMap = new Map(optOuts.map((o) => [String(o._id), o.optOuts]));

    const rate = (num, den) => (den > 0 ? Number((num / den).toFixed(4)) : 0);

    const data = campaigns.map((c) => {
      const cid = String(c._id);
      const s = statusMap.get(cid) || {};
      const active = s.active || 0;
      const paused = s.paused || 0;
      const completed = s.completed || 0;
      const replied = s.replied || 0;
      const cancelled = s.cancelled || 0;
      const failed = s.failed || 0;
      const enrolled = active + paused + completed + replied + cancelled + failed;
      const m = msgMap.get(cid) || { sent: 0, delivered: 0 };
      const campaignOptOuts = optOutMap.get(cid) || 0;

      return {
        campaign: cid,
        name: c.name,
        isActive: c.isActive,
        steps: (c.steps || []).length,
        enrolled,
        active,
        paused,
        completed,
        replied,
        cancelled,
        failed,
        sent: m.sent,
        delivered: m.delivered,
        // replied enrollments / all enrollments (see the note above).
        replyRate: rate(replied, enrolled),
        optOuts: campaignOptOuts,
        optOutRate: rate(campaignOptOuts, enrolled),
      };
    });

    return res.json({
      success: true,
      data,
      // Shipped with the payload so a reader never has to guess what a rate means.
      definitions: {
        enrolled: 'Enrollment rows for this campaign, in any state (re-enrolment counts again).',
        replyRate: 'replied enrollments / enrolled enrollments.',
        sent: 'Outbound messages stamped with this campaign (excludes soft-deleted).',
        delivered: 'Of those, messages with a Twilio delivery receipt of "delivered".',
        optOuts:
          'Opt-outs attributed to the campaign that sent the contact their most recent campaign message before they opted out. Each opted-out contact is attributed to at most one campaign.',
      },
    });
  } catch (err) {
    return next(err);
  }
}

// Phase 5: deterministic opt-out attribution.
//
// THE SCHEMA DOES NOT RECORD WHICH CAMPAIGN CAUSED AN OPT-OUT.
// Contact.optOutSource only says HOW it happened ('keyword' | 'manual' |
// 'carrier'), never from what. So attribution here is DERIVED, by one explicit
// rule:
//
//   An opted-out contact is attributed to the campaign of the most recent
//   OUTBOUND message carrying a campaign id that was sent to that contact
//   STRICTLY BEFORE their optedOutAt timestamp.
//
// Properties of this rule:
//   * Deterministic — "most recent before the timestamp" has exactly one answer
//     (ties broken by _id, since createdAt could collide).
//   * No double counting — each contact yields at most one campaign.
//   * Honest — a contact who opted out without ever receiving a campaign
//     message is attributed to NOTHING, rather than being blamed on a campaign.
//
// LIMITATION, stated plainly: this is a heuristic, not recorded fact. A contact
// who received campaign A, then a manual reply, then opted out is still
// attributed to A. Recording the true cause would need a campaign reference
// written at opt-out time, which is a schema change outside Phase 5.
async function attributeOptOuts() {
  return Contact.aggregate([
    { $match: { optedOut: true, optedOutAt: { $ne: null } } },
    {
      $lookup: {
        from: SMSMessage.collection.name,
        let: { cid: '$_id', optOutAt: '$optedOutAt' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$contact', '$$cid'] },
                  { $eq: ['$direction', 'outbound'] },
                  { $ne: ['$campaign', null] },
                  { $lt: ['$createdAt', '$$optOutAt'] },
                ],
              },
            },
          },
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: 1 },
          { $project: { campaign: 1 } },
        ],
        as: 'lastCampaignMessage',
      },
    },
    { $unwind: '$lastCampaignMessage' },
    { $group: { _id: '$lastCampaignMessage.campaign', optOuts: { $sum: 1 } } },
  ]);
}

// DELETE /api/campaigns/:id        (no enrollments: any operator)
// DELETE /api/campaigns/:id?force=true  (has enrollments: ADMIN only)
//
// Phase 5: deleting a campaign cascades to its enrollments, which destroys the
// record of who was sent what. That used to happen silently on a plain DELETE.
// Now:
//   * no enrollments            -> deleted, as before
//   * enrollments, no force     -> 409, with the counts and a nudge to pause
//   * enrollments, force, admin -> deleted + cascade
//   * enrollments, force, user  -> 403
//
// SMS history, contacts and imports are never touched — only the campaign and
// its enrollment rows.
async function deleteCampaign(req, res, next) {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    const force = queryString(req.query.force) === 'true';
    const enrollmentCount = await Enrollment.countDocuments({ campaign: campaign._id });

    if (enrollmentCount > 0) {
      const live = await countLiveEnrollments(campaign._id);
      if (!force) {
        return res.status(409).json({
          success: false,
          requiresForce: true,
          enrollmentCount,
          liveEnrollmentCount: live,
          message:
            `This campaign has ${enrollmentCount} enrollment(s)` +
            (live > 0 ? ` (${live} still in flight)` : '') +
            '. Deleting it also deletes that history. Pause the campaign instead, ' +
            'or repeat this request with ?force=true to delete both.',
        });
      }
      // Forced cascade is the genuinely destructive path — admin only.
      if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message:
            'Deleting a campaign that has enrollments requires an administrator. ' +
            'Pause the campaign instead, or ask an admin to delete it.',
        });
      }
    }

    await Campaign.deleteOne({ _id: campaign._id });
    const enr = await Enrollment.deleteMany({ campaign: campaign._id });

    await logEvent({
      eventType: 'campaign.deleted',
      severity: 'warning',
      message: `Campaign "${campaign.name}" deleted`,
      status: 'deleted',
      meta: {
        forced: force,
        deletedEnrollments: enr.deletedCount,
        by: req.user ? String(req.user._id) : undefined,
      },
    });

    return res.json({
      success: true,
      message: 'Campaign deleted',
      deletedEnrollments: enr.deletedCount,
    });
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/campaigns   (delete ALL campaigns)
// Removes every campaign and cascades to ALL enrollments. Contacts, imports,
// conversations, and SMS message history are preserved.
async function deleteAllCampaigns(req, res, next) {
  try {
    const c = await Campaign.deleteMany({});
    const e = await Enrollment.deleteMany({});
    return res.json({ success: true, deletedCount: c.deletedCount, deletedEnrollments: e.deletedCount });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  deleteAllCampaigns,
  getEligibleContacts,
  cloneCampaign,
  getCampaignStats,
};
