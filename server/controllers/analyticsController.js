// Analytics (Phase 8). Read-only operational metrics computed from existing
// persisted data via MongoDB aggregation. No data is modified here.
//
// Timezone: date ranges are computed in UTC (consistent with the rest of the
// app, which never assumes a local timezone). "Today" means since 00:00 UTC.
//
// TWO DIFFERENT MEASURES, deliberately both reported:
//
//   acceptedRate  — OUTBOUND messages whose status is queued/sent/delivered/
//                   accepted/simulated, i.e. "Twilio took it". `deliveryRate` is
//                   a back-compat alias of this and means the same thing.
//   deliveredRate — of the messages that reached a FINAL state, the share Twilio
//                   confirmed as 'delivered' via a Phase 3 status callback. This
//                   is real delivery, not acceptance.
//
// Receipts only arrive when PUBLIC_API_URL is configured (that is what attaches
// the statusCallback) and never for simulated sends, so deliveredRate reads 0
// under SMS_SIMULATE=true or an unset PUBLIC_API_URL. `awaitingReceipt` reports
// how many are still in flight, so the two can always be reconciled.
const Contact = require('../models/Contact');
const Campaign = require('../models/Campaign');
const Enrollment = require('../models/Enrollment');
const SMSMessage = require('../models/SMSMessage');
const Conversation = require('../models/Conversation');
// Phase 10 (AI analytics).
const AIReplyJob = require('../models/AIReplyJob');
const SystemLog = require('../models/SystemLog');
const Settings = require('../models/Settings');

const SUCCESS_STATUSES = ['queued', 'sent', 'delivered', 'accepted', 'simulated'];

// Start Date for a named range (UTC), or null for "all time".
function rangeStart(range) {
  const now = new Date();
  if (range === 'today') {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  if (range === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (range === '30d') return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return null; // all
}

function rate(numerator, denominator) {
  if (!denominator || denominator <= 0) return 0;
  return numerator / denominator;
}

// GET /api/analytics/overview?range=today|7d|30d|all
async function getOverview(req, res, next) {
  try {
    const range = ['today', '7d', '30d', 'all'].includes(req.query.range)
      ? req.query.range
      : 'all';
    const start = rangeStart(range);
    const msgMatch = start ? { createdAt: { $gte: start } } : {};
    const inRangeMatch = start ? { createdAt: { $gte: start } } : {};

    const [
      contactsTotal,
      contactsActive,
      contactsInactive,
      contactsAddedInRange,
      contactsOptedOut,
      contactsOptedOutInRange,
      campaignsTotal,
      campaignsActive,
      enrollmentAgg,
      messageAgg,
      convAgg,
      lookupAgg,
    ] = await Promise.all([
      Contact.countDocuments({}),
      Contact.countDocuments({ isActive: true }),
      Contact.countDocuments({ isActive: false }),
      Contact.countDocuments(inRangeMatch),
      // Opt-outs (Phase 1): the current total, plus those recorded within the
      // selected range (by optedOutAt, which only new opt-outs carry).
      Contact.countDocuments({ optedOut: true }),
      Contact.countDocuments(
        start ? { optedOut: true, optedOutAt: { $gte: start } } : { optedOut: true }
      ),
      Campaign.countDocuments({}),
      Campaign.countDocuments({ isActive: true }),
      Enrollment.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      SMSMessage.aggregate([
        { $match: msgMatch },
        { $group: { _id: { direction: '$direction', status: '$status' }, n: { $sum: 1 } } },
      ]),
      Conversation.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
            closed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
            unreadMessages: { $sum: '$unreadCount' },
            unreadConversations: { $sum: { $cond: [{ $gt: ['$unreadCount', 0] }, 1, 0] } },
            assigned: { $sum: { $cond: [{ $ne: ['$assignedTo', null] }, 1, 0] } },
          },
        },
      ]),
      Contact.aggregate([
        { $match: { 'lookup.status': { $in: ['valid', 'invalid'] } } },
        {
          $group: {
            _id: null,
            lookedUp: { $sum: 1 },
            valid: { $sum: { $cond: [{ $eq: ['$lookup.status', 'valid'] }, 1, 0] } },
            invalid: { $sum: { $cond: [{ $eq: ['$lookup.status', 'invalid'] }, 1, 0] } },
            mobile: { $sum: { $cond: [{ $eq: ['$lookup.type', 'mobile'] }, 1, 0] } },
            landline: { $sum: { $cond: [{ $eq: ['$lookup.type', 'landline'] }, 1, 0] } },
            // Phase 3: Twilio Lookup v2 reports fixedVoip / nonFixedVoip rather
            // than a plain "voip", and tollFree separately. Group them so the
            // VoIP count is not silently zero.
            voip: {
              $sum: {
                $cond: [
                  { $in: ['$lookup.type', ['voip', 'fixedVoip', 'nonFixedVoip']] },
                  1,
                  0,
                ],
              },
            },
            tollFree: { $sum: { $cond: [{ $eq: ['$lookup.type', 'tollFree'] }, 1, 0] } },
          },
        },
      ]),
    ]);

    // Enrollments by status.
    // 'replied' is included so the per-status numbers still add up to total
    // now that automation can stop on a reply (Phase 1).
    const enr = { total: 0, active: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, replied: 0 };
    enrollmentAgg.forEach((r) => {
      enr.total += r.n;
      if (enr[r._id] !== undefined) enr[r._id] += r.n;
    });
    const completionRate = rate(enr.completed, enr.total);

    // Messages: totals, direction, and outbound status breakdown.
    let msgTotal = 0;
    let inbound = 0;
    let outbound = 0;
    let successfulOutbound = 0;
    let failedOutbound = 0;
    // Phase 3: real delivery outcomes, from Twilio receipts.
    let deliveredOutbound = 0;
    let undeliveredOutbound = 0;
    const outboundByStatus = {};
    messageAgg.forEach((r) => {
      msgTotal += r.n;
      if (r._id.direction === 'inbound') {
        inbound += r.n;
      } else if (r._id.direction === 'outbound') {
        outbound += r.n;
        const st = r._id.status || 'unknown';
        outboundByStatus[st] = (outboundByStatus[st] || 0) + r.n;
        if (st === 'failed') failedOutbound += r.n;
        else if (SUCCESS_STATUSES.includes(st)) successfulOutbound += r.n;
        if (st === 'delivered') deliveredOutbound += r.n;
        else if (st === 'undelivered') undeliveredOutbound += r.n;
      }
    });
    // Only messages with a final receipt count toward the delivered rate;
    // anything still in flight neither helps nor hurts it.
    const finishedOutbound = deliveredOutbound + undeliveredOutbound + failedOutbound;

    const conv = convAgg[0] || {
      total: 0,
      open: 0,
      closed: 0,
      unreadMessages: 0,
      unreadConversations: 0,
      assigned: 0,
    };
    const lk = lookupAgg[0] || {
      lookedUp: 0, valid: 0, invalid: 0, mobile: 0, landline: 0, voip: 0, tollFree: 0,
    };

    return res.json({
      success: true,
      range,
      rangeStart: start,
      generatedAt: new Date(),
      contacts: {
        total: contactsTotal,
        active: contactsActive,
        inactive: contactsInactive,
        addedInRange: contactsAddedInRange,
        optedOut: contactsOptedOut,
        optedOutInRange: contactsOptedOutInRange,
      },
      campaigns: {
        total: campaignsTotal,
        active: campaignsActive,
        inactive: campaignsTotal - campaignsActive,
      },
      enrollments: { ...enr, completionRate },
      messages: {
        total: msgTotal,
        inbound,
        outbound,
        successfulOutbound,
        failedOutbound,
        deliveredOutbound,
        undeliveredOutbound,
        // Phase 3 renames the old metric: this only ever meant "Twilio accepted
        // it", never "it arrived". `deliveredRate` is the real one, from
        // delivery receipts. `deliveryRate` is kept as an alias of the old
        // meaning so existing API consumers do not break.
        acceptedRate: rate(successfulOutbound, outbound),
        deliveryRate: rate(successfulOutbound, outbound),
        deliveredRate: rate(deliveredOutbound, finishedOutbound),
        awaitingReceipt: outbound - finishedOutbound < 0 ? 0 : outbound - finishedOutbound,
        outboundByStatus,
      },
      conversations: {
        total: conv.total,
        open: conv.open,
        closed: conv.closed,
        unreadConversations: conv.unreadConversations,
        unreadMessages: conv.unreadMessages,
        assigned: conv.assigned,
        unassigned: conv.total - conv.assigned,
      },
      lookup: {
        lookedUp: lk.lookedUp,
        valid: lk.valid,
        invalid: lk.invalid,
        mobile: lk.mobile,
        landline: lk.landline,
        voip: lk.voip,
        tollFree: lk.tollFree || 0,
        other: lk.valid - lk.mobile - lk.landline - lk.voip - (lk.tollFree || 0),
      },
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/analytics/campaigns
// Per-campaign enrollment breakdown (name + counts + completion rate).
async function getCampaignAnalytics(req, res, next) {
  try {
    const rows = await Enrollment.aggregate([
      {
        $group: {
          _id: '$campaign',
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          paused: { $sum: { $cond: [{ $eq: ['$status', 'paused'] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          replied: { $sum: { $cond: [{ $eq: ['$status', 'replied'] }, 1, 0] } },
        },
      },
      { $lookup: { from: 'campaigns', localField: '_id', foreignField: '_id', as: 'campaign' } },
      { $unwind: '$campaign' },
      {
        $project: {
          _id: 0,
          campaignId: '$_id',
          name: '$campaign.name',
          isActive: '$campaign.isActive',
          total: 1,
          active: 1,
          paused: 1,
          completed: 1,
          failed: 1,
          cancelled: 1,
          replied: 1,
          completionRate: {
            $cond: [{ $gt: ['$total', 0] }, { $divide: ['$completed', '$total'] }, 0],
          },
        },
      },
      { $sort: { total: -1 } },
    ]);

    return res.json({ success: true, data: rows });
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// AI analytics (Phase 10)
//
// WHERE EACH NUMBER COMES FROM, and why it cannot double-count.
//
// Two sources, split along a line that makes overlap impossible:
//
//   AIReplyJob  — ONE ROW PER INBOUND MESSAGE the assistant was asked to answer
//       (the unique index on inboundMessage guarantees that). Its `status` is a
//       single terminal value, so grouping by status partitions the rows: a job
//       counted as `sent` cannot also be counted as `drafted`. Everything about
//       the OUTCOME of a reply — status, confidence, provider, model, tokens and
//       the reason it was not sent — is read from here and nowhere else.
//
//   SystemLog   — one row per ACTION, for things that are not a job outcome: a
//       worker pass (ai.run), an operator taking a thread over, a settings
//       change, a provider error (a single job can produce several). These are
//       never mixed with job counts.
//
// The trap this avoids: `ai.reply.sent` is logged when the worker sends, and the
// job's status also becomes `sent`. Counting both would report every automatic
// reply twice. Sends are therefore counted ONLY from AIReplyJob.status, and the
// log is used only for activity that has no job row of its own.
//
// Anything that cannot be derived honestly is omitted rather than estimated —
// see `notes` in the response, which says so in the payload itself.

const AI_JOB_STATUSES = [
  'pending',
  'processing',
  'drafted',
  'sent',
  'skipped',
  'escalated',
  'failed',
  'rejected',
];

// Outcomes where `reason` explains why nothing was sent.
const NON_SENT_STATUSES = ['skipped', 'escalated', 'failed', 'rejected'];

// Five bands rather than ten: enough shape to see a distribution, few enough to
// read on a phone. The upper bound is above 1 so a confidence of exactly 1.0
// lands in the top band instead of the $bucket default.
const CONFIDENCE_BOUNDARIES = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];

function emptyStatusCounts() {
  return AI_JOB_STATUSES.reduce((acc, s) => ({ ...acc, [s]: 0 }), {});
}

// GET /api/analytics/ai?range=today|7d|30d|all
async function getAiAnalytics(req, res, next) {
  try {
    const range = ['today', '7d', '30d', 'all'].includes(req.query.range) ? req.query.range : 'all';
    const start = rangeStart(range);
    const inRange = start ? { createdAt: { $gte: start } } : {};

    // The confidence policy is the one the backend already enforces. The UI must
    // not invent a second one, so the configured threshold is reported with the
    // numbers it explains.
    const settings = await Settings.findOne({ key: 'twilio' });
    const ai = (settings && settings.ai) || {};
    const threshold = Number.isFinite(Number(ai.confidenceThreshold))
      ? Number(ai.confidenceThreshold)
      : 0.7;

    const [
      statusAgg,
      confidenceAgg,
      confidenceBands,
      thresholdAgg,
      providerAgg,
      usageAgg,
      reasonAgg,
      conversationsTouchedAgg,
      eventAgg,
      conversationsEscalated,
      conversationsUnderTakeover,
    ] = await Promise.all([
      // --- outcomes: the authoritative partition of every AI reply attempt ---
      AIReplyJob.aggregate([
        { $match: inRange },
        {
          $group: {
            _id: '$status',
            n: { $sum: 1 },
            // A human-approved send carries approvedBy; an automatic one does not.
            // This is what separates "the assistant sent it" from "a person did".
            approved: { $sum: { $cond: [{ $ifNull: ['$approvedBy', false] }, 1, 0] } },
            edited: { $sum: { $cond: [{ $eq: ['$edited', true] }, 1, 0] } },
          },
        },
      ]),

      // --- confidence: ONLY rows that actually carry a number ---------------
      // A job with no confidence is excluded, never read as 0. Phase 9 fixed the
      // same mistake in the UI; the aggregation must not reintroduce it.
      AIReplyJob.aggregate([
        { $match: { ...inRange, confidence: { $type: 'number' } } },
        {
          $group: {
            _id: null,
            n: { $sum: 1 },
            avg: { $avg: '$confidence' },
            min: { $min: '$confidence' },
            max: { $max: '$confidence' },
          },
        },
      ]),
      AIReplyJob.aggregate([
        { $match: { ...inRange, confidence: { $type: 'number' } } },
        {
          $bucket: {
            groupBy: '$confidence',
            boundaries: CONFIDENCE_BOUNDARIES,
            default: 'other',
            output: { n: { $sum: 1 } },
          },
        },
      ]),
      // Split by the CONFIGURED threshold, which is the real policy boundary.
      AIReplyJob.aggregate([
        { $match: { ...inRange, confidence: { $type: 'number' } } },
        {
          $group: {
            _id: null,
            atOrAbove: { $sum: { $cond: [{ $gte: ['$confidence', threshold] }, 1, 0] } },
            below: { $sum: { $cond: [{ $lt: ['$confidence', threshold] }, 1, 0] } },
          },
        },
      ]),

      // --- providers and models actually present in the data ----------------
      AIReplyJob.aggregate([
        { $match: { ...inRange, provider: { $nin: ['', null] } } },
        {
          $group: {
            _id: { provider: '$provider', model: '$model' },
            jobs: { $sum: 1 },
            sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            totalTokens: { $sum: '$usage.totalTokens' },
          },
        },
        { $sort: { jobs: -1 } },
        { $limit: 50 },
      ]),

      // --- token usage, exactly as the providers reported it ----------------
      // No pricing: this platform has no cost model, so no cost is shown.
      AIReplyJob.aggregate([
        { $match: inRange },
        {
          $group: {
            _id: null,
            promptTokens: { $sum: '$usage.promptTokens' },
            completionTokens: { $sum: '$usage.completionTokens' },
            totalTokens: { $sum: '$usage.totalTokens' },
            jobsWithUsage: {
              $sum: { $cond: [{ $gt: [{ $ifNull: ['$usage.totalTokens', 0] }, 0] }, 1, 0] },
            },
          },
        },
      ]),

      // --- why replies were not sent, from the stored reason tokens ---------
      AIReplyJob.aggregate([
        {
          $match: {
            ...inRange,
            status: { $in: NON_SENT_STATUSES },
            reason: { $nin: ['', null] },
          },
        },
        { $group: { _id: { reason: '$reason', status: '$status' }, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 40 },
      ]),

      // --- how many distinct conversations the assistant worked on ----------
      AIReplyJob.aggregate([
        { $match: inRange },
        { $group: { _id: '$conversation' } },
        { $count: 'n' },
      ]),

      // --- activity that has no job row: runs, takeovers, errors, config ----
      SystemLog.aggregate([
        { $match: { eventType: { $regex: '^ai\\.' }, ...inRange } },
        { $group: { _id: { eventType: '$eventType', severity: '$severity' }, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]),

      // --- current state, NOT range-filtered (labelled as such below) -------
      Conversation.countDocuments({ 'ai.escalated': true, deletedAt: null }),
      Conversation.countDocuments({ 'ai.takeover': true, deletedAt: null }),
    ]);

    // --- outcomes ---------------------------------------------------------
    const byStatus = emptyStatusCounts();
    let jobsTotal = 0;
    let sentApproved = 0;
    let edited = 0;
    for (const row of statusAgg) {
      const status = row._id || 'unknown';
      jobsTotal += row.n;
      if (byStatus[status] === undefined) byStatus[status] = 0;
      byStatus[status] += row.n;
      if (status === 'sent') {
        sentApproved += row.approved || 0;
        edited += row.edited || 0;
      }
    }
    const sent = byStatus.sent || 0;
    // Everything sent that a human did not approve was sent by the assistant.
    const sentAuto = Math.max(0, sent - sentApproved);

    // --- confidence --------------------------------------------------------
    const c = confidenceAgg[0] || null;
    const t = thresholdAgg[0] || { atOrAbove: 0, below: 0 };
    const measured = c ? c.n : 0;
    const distribution = CONFIDENCE_BOUNDARIES.slice(0, -1).map((from, i) => {
      const to = CONFIDENCE_BOUNDARIES[i + 1];
      const bucket = confidenceBands.find((b) => b._id === from);
      return {
        from,
        // The last band is inclusive of 1.0; report it as such rather than 1.0001.
        to: to > 1 ? 1 : to,
        n: bucket ? bucket.n : 0,
      };
    });

    // --- providers ---------------------------------------------------------
    const providers = providerAgg.map((row) => ({
      provider: row._id.provider,
      model: row._id.model || '',
      jobs: row.jobs,
      sent: row.sent,
      failed: row.failed,
      totalTokens: row.totalTokens || 0,
    }));

    // --- usage -------------------------------------------------------------
    const u = usageAgg[0] || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      jobsWithUsage: 0,
    };

    // --- reasons -----------------------------------------------------------
    const reasons = reasonAgg.map((row) => ({
      reason: row._id.reason,
      status: row._id.status,
      n: row.n,
    }));

    // --- activity ----------------------------------------------------------
    const byEventType = eventAgg.map((row) => ({
      eventType: row._id.eventType,
      severity: row._id.severity,
      n: row.n,
    }));
    const eventCount = (type) =>
      byEventType.filter((e) => e.eventType === type).reduce((sum, e) => sum + e.n, 0);

    const conversationsTouched = (conversationsTouchedAgg[0] && conversationsTouchedAgg[0].n) || 0;

    return res.json({
      success: true,
      range,
      rangeStart: start,
      generatedAt: new Date(),

      jobs: {
        total: jobsTotal,
        byStatus,
        sent,
        sentAuto,
        sentApproved,
        edited,
        awaitingReview: byStatus.drafted || 0,
        // Rates share ONE denominator — every AI reply attempt in the range —
        // so they are comparable with each other and cannot exceed 1.
        sentRate: rate(sent, jobsTotal),
        skipRate: rate(byStatus.skipped || 0, jobsTotal),
        escalationRate: rate(byStatus.escalated || 0, jobsTotal),
        failureRate: rate(byStatus.failed || 0, jobsTotal),
        rejectionRate: rate(byStatus.rejected || 0, jobsTotal),
      },

      confidence: {
        // Stated explicitly so the UI can say "of N measured" rather than
        // implying every job had a confidence.
        measured,
        missing: Math.max(0, jobsTotal - measured),
        average: measured > 0 ? c.avg : null,
        min: measured > 0 ? c.min : null,
        max: measured > 0 ? c.max : null,
        threshold,
        atOrAboveThreshold: t.atOrAbove || 0,
        belowThreshold: t.below || 0,
        distribution,
      },

      providers,

      usage: {
        promptTokens: u.promptTokens || 0,
        completionTokens: u.completionTokens || 0,
        totalTokens: u.totalTokens || 0,
        jobsWithUsage: u.jobsWithUsage || 0,
        jobsWithoutUsage: Math.max(0, jobsTotal - (u.jobsWithUsage || 0)),
      },

      reasons,

      handoff: {
        // From SystemLog: operator actions, which have no job row.
        takeoversEnabled: eventCount('ai.takeover.enabled'),
        takeoversReleased: eventCount('ai.takeover.released'),
        // From AIReplyJob: replies the rules handed to a human.
        escalatedJobs: byStatus.escalated || 0,
        // Denominator for context, NOT used to compute a takeover rate here —
        // see `notes.takeoverRate`.
        conversationsWithAiActivity: conversationsTouched,
        // Point-in-time counts; they describe now, not the selected range.
        conversationsEscalatedNow: conversationsEscalated,
        conversationsUnderTakeoverNow: conversationsUnderTakeover,
      },

      activity: {
        runs: eventCount('ai.run'),
        providerErrors: eventCount('ai.provider.error'),
        settingsChanges: eventCount('ai.settings.updated'),
        draftsApproved: eventCount('ai.draft.approved'),
        draftsRejected: eventCount('ai.draft.rejected'),
        draftsBlocked: eventCount('ai.draft.blocked'),
        sendFailures: eventCount('ai.draft.send_failed'),
        modeChanges: eventCount('ai.mode.changed'),
        byEventType,
      },

      // Said in the payload, so a future UI cannot quietly start implying more
      // than the data supports.
      notes: {
        sources:
          'Reply outcomes, confidence, providers, tokens and reasons come from AIReplyJob ' +
          '(one row per inbound message). Runs, takeovers, provider errors and configuration ' +
          'changes come from SystemLog. Sends are counted once, from the job status only.',
        takeoverRate:
          'Not calculated: a takeover can be recorded for a conversation that had no AI reply ' +
          'attempt in this range, so takeovers and conversations-with-AI-activity are different ' +
          'populations and their ratio would be misleading.',
        cost: 'Not calculated: this platform has no provider pricing model, so only token counts are reported.',
        pointInTime:
          'conversationsEscalatedNow and conversationsUnderTakeoverNow describe the present ' +
          'moment and are not affected by the selected range.',
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getOverview, getCampaignAnalytics, getAiAnalytics };
