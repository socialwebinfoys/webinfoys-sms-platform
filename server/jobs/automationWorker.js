// Automation engine (Phase 5).
//
// A scheduled worker finds enrollments whose next step is due and sends it via
// the existing Phase 4 Twilio service. Key safety properties:
//   * Duplicate-send safe: a step is recorded in `sentSteps` and the pointer
//     advances ONLY after a successful send; a step already in `sentSteps` is
//     never re-sent.
//   * Retries re-send only steps that never went out (the send threw), with
//     exponential backoff, up to a max, then the enrollment is failed.
//   * Respects step ordering, the configurable sending window (timezone-aware),
//     per-run throttling, and campaign active state.
//   * Overlapping runs are prevented so two ticks can't process the same row.
const cron = require('node-cron');
const { config } = require('../config/env');
const Enrollment = require('../models/Enrollment');
const Campaign = require('../models/Campaign');
const Following = require('../models/Following');
const Contact = require('../models/Contact');
const Settings = require('../models/Settings');
const SMSMessage = require('../models/SMSMessage');
const Conversation = require('../models/Conversation');
const WorkerLock = require('../models/WorkerLock');
const twilioService = require('../services/twilioService');
const { renderForContact } = require('../utils/mergeFields');
const { checkCanSend, checkMobileOnly } = require('../services/sendPolicy');
const { applyOptOut } = require('../utils/optOut');
const { logEvent } = require('../services/logService');

let isRunning = false;
let isRunningFollowing = false;
let task = null;

// Graceful shutdown. Once set, no new pass or tick starts, and a pass that is
// already running finishes the item it is on and takes no more.
let shuttingDown = false;
// Every pass and tick currently running, so shutdown() can wait for them.
const inFlight = new Set();
function track(promise) {
  inFlight.add(promise);
  const done = () => inFlight.delete(promise);
  promise.then(done, done);
  return promise;
}

// Phase 2: global lease identity for the scheduled tick. The TTL is deliberately
// a little longer than a tick so a slow pass keeps its lease, but short enough
// that a crashed instance frees it quickly.
const LOCK_KEY = 'automation';
const LOCK_OWNER = `${process.pid}@${require('os').hostname()}`;
const LEASE_TTL_MS = 2 * 60 * 1000;

// Inbox threading for automated sends, so a contact appears in the Inbox as
// soon as we message them rather than only once they reply.
//
// Both helpers run AFTER the SMS has gone out and NEVER throw: they sit inside
// the send's try block, whose catch treats any error as a failed send and
// retries it — a threading problem must not be mistaken for that. On failure
// the message is still recorded, just without a thread (as before this change).
const PREVIEW_LEN = 140;

async function threadForContact(contact) {
  try {
    // The same atomic find-or-create the inbound webhook uses: one thread per
    // contact, reused if it exists, existing history untouched.
    return await Conversation.findOrCreateForContact(contact);
  } catch (err) {
    console.error('Automation: could not thread outbound message:', err.message);
    return null;
  }
}

async function recordOutboundActivity(conversation, body) {
  if (!conversation) return;
  try {
    // Same fields the AI and manual reply paths set. Outbound never touches
    // unreadCount, status or deletedAt.
    await Conversation.updateOne(
      { _id: conversation._id },
      {
        $set: {
          lastMessageAt: new Date(),
          lastMessagePreview: String(body || '').slice(0, PREVIEW_LEN),
          lastMessageDirection: 'outbound',
        },
      }
    );
  } catch (err) {
    console.error('Automation: could not update thread activity:', err.message);
  }
}

// Convert a step delay (value + unit) into milliseconds.
function delayToMs(value, unit) {
  const v = Number(value) || 0;
  switch (unit) {
    case 'minutes':
      return v * 60 * 1000;
    case 'days':
      return v * 24 * 60 * 60 * 1000;
    case 'hours':
    default:
      return v * 60 * 60 * 1000;
  }
}

// Hour (0-23) for a given instant in an IANA timezone. Returns null on an
// invalid timezone so callers can decide how to handle it.
function hourInTimezone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    return hour % 24; // Intl can render midnight as "24"
  } catch (e) {
    return null;
  }
}

// Day of week (0 = Sunday … 6 = Saturday) for an instant in an IANA timezone.
// Returns null on an invalid timezone.
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function weekdayInTimezone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
    }).formatToParts(date);
    const name = parts.find((p) => p.type === 'weekday').value;
    const idx = WEEKDAY_INDEX[name];
    return idx === undefined ? null : idx;
  } catch (e) {
    return null;
  }
}

// Is `now` within the sending window? Supports normal (9-18) and overnight
// (22-6) ranges. A per-enrollment timezone overrides the window's timezone.
function withinSendingWindow(window, tzOverride, now = new Date()) {
  if (!window || !window.enabled) return true;
  const zone = tzOverride || window.timezone || 'UTC';
  const hour = hourInTimezone(now, zone);
  if (hour === null) return true; // unknown tz -> don't strand messages
  const { startHour, endHour } = window;
  if (startHour <= endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

// Phase 2: is this an allowed send day, evaluated in the sending window's zone?
// An empty/absent list means "no restriction" (legacy settings documents).
function isAllowedSendDay(sendDays, tzOverride, window, now = new Date()) {
  if (!Array.isArray(sendDays) || sendDays.length === 0) return true;
  if (sendDays.length >= 7) return true;
  const zone = tzOverride || (window && window.timezone) || 'UTC';
  const day = weekdayInTimezone(now, zone);
  if (day === null) return true; // unknown tz -> don't strand messages
  return sendDays.includes(day);
}

// May automation send at this instant: inside the window AND on an allowed day.
function isSendableAt(when, window, sendDays, tz) {
  return (
    withinSendingWindow(window, tz, when) && isAllowedSendDay(sendDays, tz, window, when)
  );
}

// Phase 2: the next instant at which sending is permitted, at or after `from`.
// Stepped in 15-minute increments (not whole hours) because some zones sit on
// :30/:45 offsets, and computed with Intl throughout so DST shifts are handled
// by the platform rather than by arithmetic. Falls back to "one hour later" if
// no slot is found within 8 days, so a row can never be stranded forever.
const RESCHEDULE_STEP_MS = 15 * 60 * 1000;
const RESCHEDULE_MAX_STEPS = 8 * 24 * 4;
function nextSendableTime(from, window, sendDays, tz) {
  let t = new Date(Math.ceil(from.getTime() / RESCHEDULE_STEP_MS) * RESCHEDULE_STEP_MS);
  for (let i = 0; i < RESCHEDULE_MAX_STEPS; i += 1) {
    if (isSendableAt(t, window, sendDays, tz)) return t;
    t = new Date(t.getTime() + RESCHEDULE_STEP_MS);
  }
  return new Date(from.getTime() + 60 * 60 * 1000);
}

// Resolve the timezone for one enrollment: enrollment override, then the
// contact's own zone, then the global sending-window zone.
function resolveTimezone(enrollment, contact, window) {
  return (
    (enrollment && enrollment.timezone) ||
    (contact && contact.timezone) ||
    (window && window.timezone) ||
    'UTC'
  );
}

// Exponential backoff for attempt N (1-based), from the configured base delay.
function retryBackoffFor(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return config.automation.retryBackoffMinutes * 60 * 1000 * 2 ** (n - 1);
}

// How long a worker may hold an enrollment before the claim is considered dead.
const CLAIM_TTL_MS = 5 * 60 * 1000;

// Phase 2: atomically claim one enrollment for this worker. Returns the claimed
// document, or null when another worker already holds it.
//
// `lockedUntil: { $not: { $gte: now } }` deliberately replaces the plainer
// `{ $lt: now }`: the latter does NOT match documents where the field is
// absent, which would permanently freeze every enrollment created before this
// field existed.
async function claimEnrollment(enrollmentId, now) {
  return Enrollment.findOneAndUpdate(
    {
      _id: enrollmentId,
      status: 'active',
      lockedUntil: { $not: { $gte: now } },
    },
    { $set: { lockedUntil: new Date(now.getTime() + CLAIM_TTL_MS) } },
    { new: true }
  );
}

// Release the claim on an in-memory enrollment and persist it in the same
// write, so a finished row is immediately available to the next tick.
async function saveAndRelease(enr) {
  enr.lockedUntil = new Date(0);
  await enr.save();
}

// --- Phase 5: stable step identity -----------------------------------------
//
// A campaign step carries its own _id, and an enrollment points at one with
// `currentStepId`. Positions are NOT identity: reordering or deleting a step
// changes every index after it, so an index-based pointer silently starts
// meaning a different message. These helpers make the worker resolve steps by
// id, while still running pre-Phase-5 enrollments (which have no id) correctly.

// Has this enrollment already been sent this step? Prefers the stable id and
// falls back to the index for legacy sentSteps rows written before Phase 5.
function hasSentStep(enr, step, idx) {
  const stepId = step && step._id ? String(step._id) : null;
  return (enr.sentSteps || []).some((s) => {
    if (stepId && s.stepId) return String(s.stepId) === stepId;
    return s.stepIndex === idx;
  });
}

// The set of step ids this enrollment has already received.
function sentStepIdSet(enr) {
  return new Set(
    (enr.sentSteps || []).filter((s) => s.stepId).map((s) => String(s.stepId))
  );
}

// Work out which step an enrollment should send next.
// Returns { step, index } or null when the sequence is finished.
//
// Resolution order:
//   1. currentStepId still exists in the campaign -> use it. This is the
//      guarantee that an in-flight enrollment keeps waiting for the SAME
//      message even if the operator reorders the sequence around it.
//   2. currentStepId is set but GONE (that step was deleted) -> fall forward to
//      the first step this enrollment has not already been sent, in the
//      campaign's current order. Never re-sends, never silently substitutes a
//      different step for the deleted one without moving on.
//   3. No currentStepId at all (legacy enrollment) -> use currentStepIndex
//      positionally, exactly as before Phase 5.
function resolveCurrentStep(enr, campaign) {
  const steps = campaign.steps || [];
  if (steps.length === 0) return null;

  if (enr.currentStepId) {
    const idx = steps.findIndex((s) => String(s._id) === String(enr.currentStepId));
    if (idx >= 0) return { step: steps[idx], index: idx };

    // The step was removed while this enrollment was waiting on it.
    const already = sentStepIdSet(enr);
    const nextIdx = steps.findIndex((s) => !already.has(String(s._id)));
    if (nextIdx < 0) return null; // nothing left that they have not had
    return { step: steps[nextIdx], index: nextIdx };
  }

  // Legacy, index-based.
  const idx = enr.currentStepIndex;
  if (idx < 0 || idx >= steps.length) return null;
  return { step: steps[idx], index: idx };
}

// Point the enrollment at a step (or finish it). Writes BOTH the stable id and
// the index: the id is authoritative, the index is kept so "Step 2 of 4" still
// renders and so a rollback to pre-Phase-5 code would still function.
function pointAt(enr, steps, index, now, { reschedule }) {
  if (index < 0 || index >= steps.length) {
    enr.currentStepId = null;
    enr.currentStepIndex = steps.length;
    enr.status = 'completed';
    return;
  }
  const next = steps[index];
  enr.currentStepId = next._id || null;
  enr.currentStepIndex = index;
  if (reschedule) {
    enr.nextRunAt = new Date(now.getTime() + delayToMs(next.delayValue, next.delayUnit));
  }
}

// Advance past the step at `idx` that has just been sent (or was already sent).
// The next step is the first one AFTER it, in the campaign's current order,
// that this enrollment has not already received — so an edit that inserted a
// step earlier in the sequence cannot cause a re-send.
function scheduleNext(enr, campaign, idx, now) {
  const steps = campaign.steps || [];
  enr.attempts = 0;
  const already = sentStepIdSet(enr);
  let nextIdx = -1;
  for (let i = idx + 1; i < steps.length; i += 1) {
    if (!steps[i]._id || !already.has(String(steps[i]._id))) {
      nextIdx = i;
      break;
    }
  }
  pointAt(enr, steps, nextIdx, now, { reschedule: true });
}

// Public entry point. Serializes worker passes so overlapping cron ticks and
// manual POST /api/enrollments/run calls can never process the same enrollment
// concurrently — the root cause of duplicate sends. This is a single-process
// guard; the check-and-set is atomic under Node's single-threaded model (there
// is no `await` between the check and the assignment). No step is ever marked
// sent before Twilio succeeds, so retry/backoff, sentSteps, throttling, the
// sending window, timezone handling and restart recovery are all unchanged.
async function processDueEnrollments(now = new Date(), options = {}) {
  if (isRunning || shuttingDown) {
    return {
      considered: 0,
      sent: 0,
      completed: 0,
      retried: 0,
      failed: 0,
      skippedWindow: 0,
      skippedInactive: 0,
      skippedLocked: 0,
      alreadySent: 0,
      blockedNonMobile: 0,
      blockedCompliance: 0,
      errors: [],
      skipped: true,
      reason: shuttingDown ? 'The worker is shutting down' : 'A worker run is already in progress',
    };
  }
  isRunning = true;
  try {
    return await track(runPass(now, options));
  } finally {
    isRunning = false;
  }
}

// Process all due enrollments once (internal — always invoked through
// processDueEnrollments so the concurrency guard above applies). Exported
// indirectly via processDueEnrollments for tests/ops.
async function runPass(now = new Date(), options = {}) {
  // Manual "Run automation now" passes { ignoreWindow: true } to force immediate
  // processing of due enrollments regardless of the sending window. The cron
  // worker calls without options, so it keeps respecting the window (default).
  const { ignoreWindow = false } = options;
  const summary = {
    considered: 0,
    sent: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    skippedWindow: 0,
    skippedInactive: 0,
    skippedLocked: 0,
    alreadySent: 0,
    blockedNonMobile: 0,
    blockedCompliance: 0,
    errors: [],
  };

  const settings = await Settings.getSingleton();
  if (!settings.smsEnabled) {
    summary.smsDisabled = true;
    return summary;
  }
  const window = settings.sendingWindow;
  const sendDays = settings.sendDays;
  // Phase 2: a configured DB value overrides the environment. Read with ??,
  // never ||, so an explicit value is used exactly as stored.
  const maxSends = settings.maxSendsPerRun ?? config.automation.maxSendsPerRun;
  // Reported so a scheduled tick can give the follow-up pass whatever is left of
  // the budget rather than a second full one (see runTick).
  summary.budget = maxSends;

  // Phase 2 (head-of-line blocking): only consider enrollments whose campaign
  // is currently active. Previously a paused campaign with many due rows filled
  // the whole per-run budget and starved every other campaign indefinitely.
  const activeCampaignIds = (await Campaign.find({ isActive: true }).select('_id').lean()).map(
    (c) => c._id
  );
  if (activeCampaignIds.length === 0) return summary;

  const due = await Enrollment.find({
    status: 'active',
    nextRunAt: { $lte: now },
    campaign: { $in: activeCampaignIds },
  })
    .sort({ nextRunAt: 1 })
    .limit(maxSends);

  for (const candidate of due) {
    // Shutting down: finish what is already saved and take no more. Anything
    // left is still due and is picked up by the next instance.
    if (shuttingDown) break;
    summary.considered += 1;

    // Phase 2: take an exclusive, expiring claim before touching anything.
    // Another instance (or an overlapping manual run) holding the row returns
    // null here and we simply move on — this is what makes duplicate sends
    // impossible across processes.
    const enr = await claimEnrollment(candidate._id, now);
    if (!enr) {
      summary.skippedLocked += 1;
      continue;
    }

    const [campaign, contact] = await Promise.all([
      Campaign.findById(enr.campaign),
      Contact.findById(enr.contact),
    ]);

    if (!campaign || !contact) {
      enr.status = 'failed';
      enr.lastError = 'Campaign or contact no longer exists';
      await saveAndRelease(enr);
      summary.failed += 1;
      continue;
    }

    // Defence in depth: the query above already excludes inactive campaigns.
    if (!campaign.isActive) {
      await saveAndRelease(enr);
      summary.skippedInactive += 1;
      continue;
    }

    // Phase 5: resolve the step by its STABLE id (falling back to the index for
    // legacy rows). This is what keeps an in-flight enrollment on the right
    // message after the campaign's steps are edited or reordered.
    const resolved = resolveCurrentStep(enr, campaign);

    // Completion guard: nothing left to send.
    if (!resolved) {
      enr.currentStepId = null;
      enr.currentStepIndex = (campaign.steps || []).length;
      enr.status = 'completed';
      await saveAndRelease(enr);
      summary.completed += 1;
      continue;
    }

    const idx = resolved.index;
    // Keep the stored pointer in step with what we actually resolved, so a
    // legacy row gains its stable id on first touch and an orphaned row records
    // where it moved to.
    if (String(enr.currentStepId || '') !== String(resolved.step._id || '')) {
      enr.currentStepId = resolved.step._id || null;
      enr.currentStepIndex = idx;
    }

    // Idempotency guard: if this step was already sent, advance without resending.
    if (hasSentStep(enr, resolved.step, idx)) {
      scheduleNext(enr, campaign, idx, now);
      await saveAndRelease(enr);
      summary.alreadySent += 1;
      if (enr.status === 'completed') summary.completed += 1;
      continue;
    }

    // Phase 2: sending window + allowed send days, in the contact's own zone
    // when they have one (enrollment tz -> contact tz -> global tz). A manual
    // run may bypass this; the cron tick never does.
    const tz = resolveTimezone(enr, contact, window);
    if (!ignoreWindow && !isSendableAt(now, window, sendDays, tz)) {
      // Push the row to the next permitted moment instead of leaving it due,
      // so skipped rows stop consuming the per-run budget every minute.
      enr.nextRunAt = nextSendableTime(now, window, sendDays, tz);
      await saveAndRelease(enr);
      summary.skippedWindow += 1;
      continue;
    }

    // Phase 1: compliance gate, checked BEFORE the mobile-only filter. An
    // opted-out or inactive contact cancels the enrollment outright — this is a
    // decision, not a transient error, so it is never retried. A number Lookup
    // has reported invalid is refused here too (stopReason 'invalid_number'),
    // including for an enrollment created before it was found invalid.
    const eligibility = await checkCanSend({ contact, phone: contact.phone });
    if (!eligibility.allowed) {
      enr.status = 'cancelled';
      enr.lastError = eligibility.reason;
      enr.stopReason = eligibility.code;
      await saveAndRelease(enr);
      summary.blockedCompliance += 1;
      await logEvent({
        eventType: 'automation.blocked',
        severity: 'warning',
        message: eligibility.reason,
        status: 'cancelled',
        enrollment: enr._id,
        contact: contact._id,
        campaign: campaign._id,
        meta: { temporary: false, code: eligibility.code },
      });
      continue;
    }

    // Phase 7: mobile-only sending filter (fails closed). A definitive
    // non-mobile number blocks (and fails) the enrollment; a temporary Lookup
    // failure is retried via the existing backoff so it can try again later.
    const policy = await checkMobileOnly({ contact, phone: contact.phone });
    if (!policy.allowed) {
      if (policy.temporary) {
        enr.attempts += 1;
        enr.lastError = policy.reason;
        if (enr.attempts >= config.automation.maxRetries) {
          enr.status = 'failed';
          summary.failed += 1;
        } else {
          const backoffMs =
            config.automation.retryBackoffMinutes * 60 * 1000 * 2 ** (enr.attempts - 1);
          enr.nextRunAt = new Date(now.getTime() + backoffMs);
          summary.retried += 1;
        }
        await saveAndRelease(enr);
        await logEvent({
          eventType: 'automation.blocked',
          severity: 'warning',
          message: policy.reason,
          status: enr.status === 'failed' ? 'failed' : 'retry',
          enrollment: enr._id,
          contact: contact._id,
          campaign: campaign._id,
          meta: { temporary: true, attempts: enr.attempts },
        });
      } else {
        // Definitive non-mobile: the number will never be mobile, so stop.
        enr.status = 'failed';
        enr.lastError = policy.reason;
        await saveAndRelease(enr);
        summary.blockedNonMobile += 1;
        await logEvent({
          eventType: 'automation.blocked',
          severity: 'warning',
          message: policy.reason,
          status: 'blocked',
          enrollment: enr._id,
          contact: contact._id,
          campaign: campaign._id,
          meta: { temporary: false, type: policy.type || '' },
        });
      }
      continue;
    }

    const step = resolved.step;
    const { rendered } = renderForContact(step.body, contact);

    try {
      const result = await twilioService.sendSms({
        to: contact.phone,
        body: rendered,
        from: settings.defaultFrom || undefined,
      });

      // Record the send BEFORE advancing so a step can never be re-sent.
      // Phase 5: the stable id is what makes this guarantee survive a campaign
      // edit — an index alone would start pointing at a different step.
      enr.sentSteps.push({
        stepId: step._id || undefined,
        stepIndex: idx,
        twilioSid: result.sid,
        status: result.status,
        sentAt: new Date(),
      });
      enr.lastStepSentAt = new Date();
      enr.lastError = '';
      scheduleNext(enr, campaign, idx, now);
      await saveAndRelease(enr);

      // Reuse the Phase 4 message log (no duplicate sending logic here).
      // Phase 2 links the record back to what produced it so later phases can
      // attribute sends without introducing a second write path.
      const conversation = await threadForContact(contact);
      await SMSMessage.create({
        direction: 'outbound',
        to: contact.phone,
        from: result.from || '',
        body: rendered,
        twilioSid: result.sid,
        status: result.status,
        contact: contact._id,
        conversation: conversation ? conversation._id : undefined,
        source: 'campaign',
        campaign: campaign._id,
        enrollment: enr._id,
        stepIndex: idx,
      });
      await recordOutboundActivity(conversation, rendered);

      summary.sent += 1;
      if (enr.status === 'completed') summary.completed += 1;

      await logEvent({
        eventType: 'automation.sent',
        severity: 'info',
        message: `Automation sent step ${idx + 1} ${result.simulated ? '(simulated) ' : ''}to ${contact.phone}`,
        status: result.status,
        enrollment: enr._id,
        contact: contact._id,
        campaign: campaign._id,
        twilioSid: result.sid,
        meta: { stepIndex: idx, simulated: !!result.simulated },
      });
    } catch (err) {
      enr.attempts += 1;
      enr.lastError = err.message || 'Send failed';

      // Phase 1: Twilio 21610 means the recipient unsubscribed at carrier
      // level. Record the opt-out and stop — retrying would keep messaging
      // someone who has opted out.
      const carrierOptOut = err.twilioCode === 21610;
      if (carrierOptOut) {
        enr.status = 'cancelled';
        enr.stopReason = 'opted_out';
        summary.blockedCompliance += 1;
      } else if (err.permanent) {
        // Any other permanent Twilio error can never succeed: fail at once.
        enr.status = 'failed';
        summary.failed += 1;
      } else if (enr.attempts >= config.automation.maxRetries) {
        enr.status = 'failed';
        summary.failed += 1;
      } else {
        // Exponential backoff; the same step is retried (it never went out).
        const backoffMs =
          config.automation.retryBackoffMinutes * 60 * 1000 * 2 ** (enr.attempts - 1);
        enr.nextRunAt = new Date(now.getTime() + backoffMs);
        summary.retried += 1;
      }
      await saveAndRelease(enr);
      // Applied after the save so this enrollment's final state is not
      // overwritten; it also cancels the contact's other enrollments and skips
      // their pending follow-ups.
      if (carrierOptOut) {
        await applyOptOut(contact, 'carrier');
        await logEvent({
          eventType: 'optout.received',
          severity: 'warning',
          message: `Twilio reported ${contact.phone} as unsubscribed (21610); contact opted out`,
          status: 'opted_out',
          enrollment: enr._id,
          contact: contact._id,
          campaign: campaign._id,
          meta: { source: 'carrier', twilioCode: 21610 },
        });
      }
      summary.errors.push({ enrollment: enr._id.toString(), reason: enr.lastError });

      await logEvent({
        eventType: 'automation.failed',
        severity: 'error',
        message: `Automation send failed for step ${idx + 1} to ${contact.phone}`,
        status: enr.status === 'active' ? 'retry' : enr.status,
        enrollment: enr._id,
        contact: contact._id,
        campaign: campaign._id,
        error: enr.lastError,
        meta: {
          stepIndex: idx,
          attempts: enr.attempts,
          twilioCode: err.twilioCode,
          permanent: !!err.permanent,
        },
      });
    }
  }

  // Record a run summary only when the pass did something meaningful.
  if (
    summary.sent ||
    summary.failed ||
    summary.retried ||
    summary.blockedNonMobile ||
    summary.blockedCompliance
  ) {
    await logEvent({
      eventType: 'automation.run',
      severity: 'info',
      message: `Automation run: sent ${summary.sent}, failed ${summary.failed}, retried ${summary.retried}, blocked ${summary.blockedNonMobile}`,
      status: 'run',
      meta: {
        considered: summary.considered,
        sent: summary.sent,
        completed: summary.completed,
        failed: summary.failed,
        retried: summary.retried,
        blockedNonMobile: summary.blockedNonMobile,
        blockedCompliance: summary.blockedCompliance,
        skippedWindow: summary.skippedWindow,
        skippedLocked: summary.skippedLocked,
        skippedInactive: summary.skippedInactive,
      },
    });
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Following (follow-up automation) pass.
//
// Same design + reuse as the enrollment pass above: it advances "active"
// Following records whose delay has elapsed, sending each selected contact's
// message once through the SAME Twilio service, recording the SAME SMSMessage
// log, applying the SAME mobile-only policy, sending window and per-run throttle,
// and rendering with the SAME merge-field engine. Per-recipient state gives
// idempotency (a recipient is never sent twice) and bounded retries.
// ---------------------------------------------------------------------------

// Public entry point. Serializes follow-up passes so a cron tick and a manual
// POST /api/followings/run can never process the same record concurrently.
// `options.budget` (Phase 10) caps how many recipients this pass may process.
// The scheduled tick passes the budget the enrollment pass left over, so one
// cron tick honours maxSendsPerRun ONCE across both passes rather than twice.
// Omitted (a direct admin "run follow-ups now") means "take the full budget".
async function processDueFollowings(now = new Date(), options = {}) {
  if (isRunningFollowing || shuttingDown) {
    return {
      considered: 0,
      sent: 0,
      failed: 0,
      blockedNonMobile: 0,
      blockedCompliance: 0,
      skippedReplied: 0,
      completed: 0,
      skippedWindow: 0,
      errors: [],
      skipped: true,
      reason: shuttingDown ? 'The worker is shutting down' : 'A follow-up run is already in progress',
    };
  }
  isRunningFollowing = true;
  try {
    return await track(runFollowingPass(now, options));
  } finally {
    isRunningFollowing = false;
  }
}

// --- Follow-up recipients: claim before sending, save straight after ---------
//
// A follow-up's recipients live in ONE document. Their results used to be kept
// in memory and written once, when the whole follow-up had been worked through —
// so a restart, a crash or a failed write part-way lost every result of that
// pass, and the next pass messaged all of those people again.
//
// Each recipient is now handled on its own:
//   1. CLAIM  — an atomic, expiring lease on that one recipient. Two passes (two
//      instances during a deploy, or a manual run beside the cron tick) can
//      never both take the same recipient, and a paused or deleted follow-up
//      stops being claimable at once.
//   2. SEND.
//   3. SAVE   — that recipient's result is written immediately, by itself, and
//      the claim is released in the same write.
// An interruption can therefore affect at most the ONE recipient in flight.
//
// WHAT THIS DOES NOT GUARANTEE. Delivery is at-least-once, not exactly-once.
// Twilio's send is not idempotent, so two windows remain:
//   * the process dies after Twilio accepted the message but before the result
//     reached the database (a single write);
//   * Twilio accepted the message but the response never arrived (a network
//     failure or timeout), which is indistinguishable from a failed send.
// In both, the recipient is still 'pending' and is retried — one possible
// duplicate, to one person. The first window is narrowed further on the next
// pass: a recipient whose earlier claim was never released is looked up in the
// message log first and, if a message to them is recorded there, marked sent
// instead of being messaged again.
const RECIPIENT_CLAIM_TTL_MS = 5 * 60 * 1000;
// Saving a result is retried briefly: it is the write that prevents a re-send.
const RESULT_SAVE_ATTEMPTS = 3;
const RESULT_SAVE_RETRY_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Take the lease on one pending recipient. False when another pass holds it,
// when it is no longer pending, or when the follow-up is no longer active.
// `lockedUntil: { $not: { $gte: now } }` also matches recipients that have no
// such field (every follow-up created before this change).
async function claimRecipient(followingId, contactId, now) {
  const res = await Following.updateOne(
    {
      _id: followingId,
      status: 'active',
      recipients: {
        $elemMatch: { contact: contactId, status: 'pending', lockedUntil: { $not: { $gte: now } } },
      },
    },
    { $set: { 'recipients.$.lockedUntil': new Date(now.getTime() + RECIPIENT_CLAIM_TTL_MS) } }
  );
  return !!(res && res.modifiedCount === 1);
}

// Write ONE recipient's result and release its claim, touching nothing else in
// the document. Resolves to:
//   'saved'  — written.
//   'gone'   — the follow-up, or this recipient, no longer exists (deleted, or
//              removed by an edit while the pass was running).
//   'failed' — the database refused every attempt. The claim is left in place,
//              so the recipient is not retried until it expires.
async function saveRecipient(following, rcpt) {
  const set = {
    'recipients.$.status': rcpt.status,
    'recipients.$.attempts': rcpt.attempts || 0,
    'recipients.$.lastError': rcpt.lastError || '',
    'recipients.$.lockedUntil': new Date(0),
  };
  if (rcpt.status === 'sent') {
    set['recipients.$.twilioSid'] = rcpt.twilioSid || '';
    set['recipients.$.sentAt'] = rcpt.sentAt || new Date();
  }
  for (let attempt = 1; attempt <= RESULT_SAVE_ATTEMPTS; attempt += 1) {
    try {
      const res = await Following.updateOne(
        { _id: following._id, 'recipients.contact': rcpt.contact },
        { $set: set }
      );
      if (!res || !res.matchedCount) return 'gone';
      rcpt.lockedUntil = new Date(0);
      return 'saved';
    } catch (err) {
      console.error(
        `Follow-up result save failed (attempt ${attempt}/${RESULT_SAVE_ATTEMPTS}):`,
        err.message
      );
      if (attempt < RESULT_SAVE_ATTEMPTS) await sleep(RESULT_SAVE_RETRY_MS * attempt);
    }
  }
  return 'failed';
}

async function runFollowingPass(now = new Date(), options = {}) {
  const summary = {
    considered: 0,
    sent: 0,
    failed: 0,
    blockedNonMobile: 0,
    blockedCompliance: 0,
    skippedReplied: 0,
    completed: 0,
    skippedWindow: 0,
    errors: [],
  };

  const settings = await Settings.getSingleton();
  if (!settings.smsEnabled) {
    summary.smsDisabled = true;
    return summary;
  }
  const window = settings.sendingWindow;
  const sendDays = settings.sendDays;

  const due = await Following.find({ status: 'active', nextRunAt: { $lte: now } }).sort({ nextRunAt: 1 });

  // Per-run send budget so a large follow-up can't monopolize a tick; remaining
  // recipients are processed on subsequent ticks (idempotent).
  //
  // Phase 10: when the scheduled tick supplies a budget, it is what the
  // enrollment pass left over, so maxSendsPerRun caps one TICK rather than one
  // pass. A direct admin run gets the full budget.
  const fullBudget = settings.maxSendsPerRun ?? config.automation.maxSendsPerRun;
  let budget = options.budget === undefined ? fullBudget : options.budget;

  // Set when a result could not be written. The database is not accepting
  // writes, so nothing further is sent in this pass: every additional send
  // would be one more result that could not be recorded.
  let aborted = false;

  for (const f of due) {
    if (budget <= 0 || aborted || shuttingDown) break;
    summary.considered += 1;

    // Phase 10: the earliest moment at which a recipient deferred by quiet hours
    // becomes sendable. The window is now evaluated PER RECIPIENT (see below), so
    // the follow-up as a whole is rescheduled to the soonest of those moments
    // instead of being re-examined every minute.
    let deferredUntil = null;
    // Phase 2: the largest backoff requested by a temporary failure in this
    // pass. Applied to the follow-up's nextRunAt at the end so transient
    // problems stop being retried every single minute.
    let backoffMs = 0;
    // The follow-up was paused, deleted or edited while this pass was running:
    // stop working on it, and leave its schedule and status alone.
    let followingChanged = false;
    // Contacts Twilio reported as unsubscribed during this pass. Opting them
    // out happens after the recipient loop, once their own result is saved.
    const carrierOptOuts = [];

    // Save one recipient's result. Returns false when the loop must stop.
    const settle = async (rcpt) => {
      const outcome = await saveRecipient(f, rcpt);
      if (outcome === 'saved') return true;
      if (outcome === 'gone') {
        followingChanged = true;
        return false;
      }
      aborted = true;
      summary.aborted = true;
      summary.errors.push({
        following: f._id.toString(),
        reason: 'A recipient result could not be saved; the pass was stopped',
      });
      await logEvent({
        eventType: 'following.failed',
        severity: 'error',
        message: `Follow-up "${f.name}": a recipient result could not be saved, so the run was stopped. The recipient is held until its claim expires and is checked against the message log before anything is sent again.`,
        status: 'save_failed',
        contact: rcpt.contact,
        meta: { followingId: f._id.toString(), name: f.name, recipientStatus: rcpt.status },
      });
      return false;
    };

    for (const rcpt of f.recipients) {
      if (budget <= 0 || aborted || followingChanged || shuttingDown) break;
      if (rcpt.status !== 'pending') continue;

      const contact = await Contact.findById(rcpt.contact);

      // Phase 10: quiet hours are evaluated in the RECIPIENT's own timezone
      // (contact tz -> global window tz), exactly as the enrollment pass does.
      // Previously the whole follow-up was judged against the global window
      // only, so a recipient in another zone could be messaged inside their
      // local quiet hours. The sending window exists for TCPA compliance, which
      // does not distinguish a campaign step from a follow-up.
      //
      // The recipient stays `pending` and consumes no budget — nothing was
      // attempted, so nothing is claimed or written — and the follow-up is
      // rescheduled to the soonest permitted moment at the end of the loop.
      if (contact) {
        const recipientZone = resolveTimezone(null, contact, window);
        if (!isSendableAt(now, window, sendDays, recipientZone)) {
          const next = nextSendableTime(now, window, sendDays, recipientZone);
          if (deferredUntil === null || next.getTime() < deferredUntil.getTime()) {
            deferredUntil = next;
          }
          summary.skippedWindow += 1;
          continue;
        }
      }

      // A claim that was taken earlier and never released means a previous pass
      // was interrupted while working on this recipient. Read BEFORE claiming.
      const interruptedBefore = !!(rcpt.lockedUntil && new Date(rcpt.lockedUntil).getTime() > 0);

      // Claims are timed against the real clock (or `now`, when a caller passes
      // a later one), so a long pass cannot hand out a lease that has already
      // lapsed.
      const claimedAt = new Date(Math.max(now.getTime(), Date.now()));
      if (!(await claimRecipient(f._id, rcpt.contact, claimedAt))) {
        summary.skippedLocked = (summary.skippedLocked || 0) + 1;
        // Either another pass holds this recipient (carry on with the rest), or
        // the follow-up itself is no longer active (stop).
        const stillActive = await Following.countDocuments({ _id: f._id, status: 'active' });
        if (!stillActive) followingChanged = true;
        continue;
      }

      if (!contact) {
        rcpt.status = 'failed';
        rcpt.lastError = 'Contact no longer exists';
        summary.failed += 1;
        budget -= 1;
        if (!(await settle(rcpt))) break;
        continue;
      }

      // The earlier attempt on this recipient was cut short. If it got as far as
      // recording the message, the recipient has been messaged: mark them sent
      // from that record rather than sending again.
      if (interruptedBefore) {
        const earlier = await SMSMessage.findOne({
          following: f._id,
          contact: contact._id,
          direction: 'outbound',
        }).sort({ createdAt: -1 });
        if (earlier) {
          rcpt.status = 'sent';
          rcpt.twilioSid = earlier.twilioSid || '';
          rcpt.sentAt = earlier.createdAt || new Date();
          rcpt.lastError = '';
          summary.recovered = (summary.recovered || 0) + 1;
          await logEvent({
            eventType: 'following.recovered',
            severity: 'warning',
            message: `Follow-up "${f.name}": an interrupted send to ${contact.phone} was found in the message log and marked sent without sending again`,
            status: 'recovered',
            contact: contact._id,
            twilioSid: rcpt.twilioSid,
            meta: { followingId: f._id.toString(), name: f.name, recovered: true },
          });
          if (!(await settle(rcpt))) break;
          continue;
        }
      }

      // Phase 2: a recipient who replied after this follow-up was activated is
      // skipped, when the follow-up is configured to stop on replies. Legacy
      // records have no stopOnReply field, so only an explicit false opts out.
      if (
        f.stopOnReply !== false &&
        f.activatedAt &&
        contact.lastInboundAt &&
        contact.lastInboundAt > f.activatedAt
      ) {
        rcpt.status = 'skipped';
        rcpt.lastError = 'replied';
        budget -= 1;
        summary.skippedReplied += 1;
        await logEvent({
          eventType: 'following.blocked',
          severity: 'info',
          message: `Follow-up "${f.name}" skipped ${contact.phone}: contact replied after activation`,
          status: 'skipped',
          contact: contact._id,
          meta: { followingId: f._id.toString(), name: f.name, code: 'replied' },
        });
        if (!(await settle(rcpt))) break;
        continue;
      }

      // Phase 1: compliance gate, before the mobile-only filter. An opted-out
      // or inactive contact is skipped permanently — never retried. So is a
      // number Lookup has reported invalid since this follow-up was created.
      const eligibility = await checkCanSend({ contact, phone: contact.phone });
      if (!eligibility.allowed) {
        rcpt.status = 'skipped';
        rcpt.lastError = eligibility.code;
        budget -= 1;
        summary.blockedCompliance += 1;
        await logEvent({
          eventType: 'following.blocked',
          severity: 'warning',
          message: eligibility.reason,
          status: 'skipped',
          contact: contact._id,
          meta: {
            followingId: f._id.toString(),
            name: f.name,
            temporary: false,
            code: eligibility.code,
          },
        });
        if (!(await settle(rcpt))) break;
        continue;
      }

      // Mobile-only policy (shared, fails closed). Temporary failures are retried
      // via attempts; a definitive non-mobile number fails that recipient.
      const policy = await checkMobileOnly({ contact, phone: contact.phone });
      if (!policy.allowed) {
        rcpt.attempts += 1;
        rcpt.lastError = policy.reason;
        if (policy.temporary) {
          if (rcpt.attempts >= config.automation.maxRetries) {
            rcpt.status = 'failed';
            summary.failed += 1;
          } else {
            // Phase 2: back off instead of retrying on every single tick.
            backoffMs = Math.max(backoffMs, retryBackoffFor(rcpt.attempts));
          }
        } else {
          rcpt.status = 'failed';
          summary.blockedNonMobile += 1;
        }
        budget -= 1;
        await logEvent({
          eventType: 'following.blocked',
          severity: 'warning',
          message: policy.reason,
          status: rcpt.status === 'failed' ? 'blocked' : 'retry',
          contact: contact._id,
          meta: { followingId: f._id.toString(), name: f.name, temporary: !!policy.temporary },
        });
        if (!(await settle(rcpt))) break;
        continue;
      }

      const { rendered } = renderForContact(f.body, contact);
      let result;
      try {
        result = await twilioService.sendSms({
          to: contact.phone,
          body: rendered,
          from: settings.defaultFrom || undefined,
        });
      } catch (err) {
        rcpt.attempts += 1;
        rcpt.lastError = err.message || 'Send failed';
        // Phase 1: 21610 means the recipient unsubscribed at carrier level, and
        // any other permanent Twilio code can never succeed — stop either way.
        if (err.twilioCode === 21610) {
          rcpt.status = 'failed';
          rcpt.lastError = 'opted_out (carrier)';
          carrierOptOuts.push(contact);
          summary.blockedCompliance += 1;
        } else if (err.permanent) {
          rcpt.status = 'failed';
          summary.failed += 1;
        } else if (rcpt.attempts >= config.automation.maxRetries) {
          rcpt.status = 'failed';
          summary.failed += 1;
        } else {
          // Phase 2: same backoff rule as temporary lookup failures, so a
          // transient Twilio problem is not retried every minute either.
          backoffMs = Math.max(backoffMs, retryBackoffFor(rcpt.attempts));
        }
        budget -= 1;
        summary.errors.push({ following: f._id.toString(), reason: rcpt.lastError });
        await logEvent({
          eventType: 'following.failed',
          severity: 'error',
          message: `Follow-up "${f.name}" send failed to ${contact.phone}`,
          status: rcpt.status === 'failed' ? 'failed' : 'retry',
          contact: contact._id,
          error: rcpt.lastError,
          meta: {
            followingId: f._id.toString(),
            name: f.name,
            attempts: rcpt.attempts,
            twilioCode: err.twilioCode,
            permanent: !!err.permanent,
          },
        });
        if (!(await settle(rcpt))) break;
        continue;
      }

      // Twilio accepted the message. Saving that fact is the very next thing
      // that happens — before the message log, the Inbox thread or the event
      // log — because it is what stops this recipient being messaged again.
      rcpt.status = 'sent';
      rcpt.twilioSid = result.sid;
      rcpt.sentAt = new Date();
      rcpt.lastError = '';
      budget -= 1;
      summary.sent += 1;
      const saved = await settle(rcpt);

      // Reuse the shared message log (no duplicate sending logic). A failure
      // here is a bookkeeping problem, never a failed send: the message has
      // gone, so it must not be counted as an attempt or retried.
      try {
        const conversation = await threadForContact(contact);
        await SMSMessage.create({
          direction: 'outbound',
          to: contact.phone,
          from: result.from || '',
          body: rendered,
          twilioSid: result.sid,
          status: result.status,
          contact: contact._id,
          conversation: conversation ? conversation._id : undefined,
          source: 'following',
          following: f._id,
        });
        await recordOutboundActivity(conversation, rendered);
      } catch (err) {
        console.error('Follow-up: message sent but could not be recorded:', err.message);
        await logEvent({
          eventType: 'following.failed',
          severity: 'error',
          message: `Follow-up "${f.name}": the message to ${contact.phone} was sent but could not be added to the message log`,
          status: 'record_failed',
          contact: contact._id,
          twilioSid: result.sid,
          error: String(err.message || 'record failed').slice(0, 200),
          meta: { followingId: f._id.toString(), name: f.name },
        });
      }

      await logEvent({
        eventType: 'following.sent',
        severity: 'info',
        message: `Follow-up "${f.name}" sent ${result.simulated ? '(simulated) ' : ''}to ${contact.phone}`,
        status: result.status,
        contact: contact._id,
        twilioSid: result.sid,
        meta: { followingId: f._id.toString(), name: f.name, simulated: !!result.simulated },
      });

      if (!saved) break;
    }

    // The follow-up's own state. Skipped when it changed underneath this pass
    // (its owner decides what happens next) or when the database is refusing
    // writes. Both updates are conditional on the STORED document, so a
    // recipient added by an edit during the pass can never be stranded by a
    // stale "nothing left to do".
    if (!followingChanged && !aborted) {
      try {
        if (!f.recipients.some((r) => r.status === 'pending')) {
          // Complete the follow-up when no recipients remain pending.
          const res = await Following.updateOne(
            {
              _id: f._id,
              status: 'active',
              recipients: { $not: { $elemMatch: { status: 'pending' } } },
            },
            { $set: { status: 'completed' } }
          );
          if (res && res.modifiedCount === 1) {
            f.status = 'completed';
            summary.completed += 1;
          }
        } else {
          // Still pending work. Wait for the later of: a transient failure's
          // backoff, and the soonest moment a quiet-hours-deferred recipient
          // becomes sendable. Either way the row stops being re-examined every
          // minute.
          const waitUntil = [];
          if (backoffMs > 0) waitUntil.push(now.getTime() + backoffMs);
          if (deferredUntil) waitUntil.push(deferredUntil.getTime());
          if (waitUntil.length > 0) {
            const nextRunAt = new Date(Math.max(...waitUntil));
            await Following.updateOne({ _id: f._id, status: 'active' }, { $set: { nextRunAt } });
            f.nextRunAt = nextRunAt;
          }
        }
      } catch (err) {
        // Not fatal: every recipient result is already saved, and the follow-up
        // is simply looked at again on the next tick.
        console.error('Follow-up schedule update failed:', err.message);
      }
    }

    // Carrier opt-outs are applied only now, after each recipient's own result
    // has been written, so applyOptOut's updates to other follow-ups and
    // enrollments cannot be interleaved with it. They are consent, so they are
    // attempted even when the pass is being stopped.
    for (const c of carrierOptOuts) {
      try {
        await applyOptOut(c, 'carrier');
        await logEvent({
          eventType: 'optout.received',
          severity: 'warning',
          message: `Twilio reported ${c.phone} as unsubscribed (21610); contact opted out`,
          status: 'opted_out',
          contact: c._id,
          meta: { source: 'carrier', twilioCode: 21610, followingId: f._id.toString() },
        });
      } catch (err) {
        console.error('Follow-up: carrier opt-out could not be recorded:', err.message);
      }
    }
  }

  if (
    summary.sent ||
    summary.failed ||
    summary.blockedNonMobile ||
    summary.blockedCompliance ||
    summary.skippedReplied ||
    summary.completed
  ) {
    await logEvent({
      eventType: 'following.run',
      severity: 'info',
      message: `Follow-up run: sent ${summary.sent}, failed ${summary.failed}, blocked ${summary.blockedNonMobile}, completed ${summary.completed}`,
      status: 'run',
      meta: {
        considered: summary.considered,
        sent: summary.sent,
        failed: summary.failed,
        blockedNonMobile: summary.blockedNonMobile,
        blockedCompliance: summary.blockedCompliance,
        completed: summary.completed,
        skippedWindow: summary.skippedWindow,
        skippedReplied: summary.skippedReplied,
      },
    });
  }

  return summary;
}

// One scheduled tick: take the global lease, run the enrollment pass, then run
// the follow-up pass with whatever send budget the first pass left.
//
// Extracted (Phase 10) so the per-tick budget is testable: maxSendsPerRun is a
// property of a TICK, so the two passes have to be exercised as one unit. The
// cron callback below is now just a wrapper around this.
async function runTick(now = new Date()) {
  let holdsLease = false;
  const result = { heldLease: false, enrollments: null, followings: null };
  if (shuttingDown) return result;
  try {
    // Phase 2: take the global lease so only ONE instance runs this tick (two can
    // briefly overlap during a zero-downtime deploy). Per-enrollment claims
    // already make duplicate sends impossible; this just avoids two instances
    // doing the same work. Manual runs deliberately ignore it.
    holdsLease = await WorkerLock.acquire(LOCK_KEY, LOCK_OWNER, LEASE_TTL_MS);
    if (!holdsLease) return result;
    result.heldLease = true;

    // The concurrency guard lives inside processDueEnrollments, so a tick that
    // overlaps a still-running pass (cron or manual) simply no-ops.
    const summary = await processDueEnrollments(now);
    result.enrollments = summary;

    // Follow-up automation shares this tick, the same send/log infrastructure,
    // AND the same per-run send budget: whatever the enrollment pass did not use
    // is all the follow-up pass may spend.
    //
    // A pass only reports a `budget` once it has read Settings and started work.
    // It reports none when it was SKIPPED (another run already in progress) or
    // when it stopped at the master send switch — in both cases it spent nothing,
    // so it must not reduce the follow-up pass's allowance. Omitting the option
    // entirely makes runFollowingPass resolve the full budget from Settings
    // itself, which is exactly right: nothing has been spent this tick.
    const enrollmentsSpentBudget = typeof summary.budget === 'number' && !summary.skipped;
    const followingOptions = enrollmentsSpentBudget
      ? { budget: Math.max(0, summary.budget - (summary.considered || 0)) }
      : {};
    result.followings = await processDueFollowings(now, followingOptions);
    return result;
  } finally {
    // Hand the lease back immediately; if this process dies first it simply
    // expires after LEASE_TTL_MS and another instance picks it up.
    if (holdsLease) {
      try {
        await WorkerLock.release(LOCK_KEY, LOCK_OWNER);
      } catch (e) {
        console.error('Worker lease release failed:', e.message);
      }
    }
  }
}

// Start the cron-scheduled worker (unless disabled). Overlapping runs are
// skipped so a long run can't collide with the next tick.
function start() {
  if (!config.automation.enabled) {
    console.log('Automation worker is disabled (AUTOMATION_ENABLED=false).');
    return;
  }
  if (!cron.validate(config.automation.cronSchedule)) {
    console.warn(`Invalid AUTOMATION_CRON "${config.automation.cronSchedule}"; worker not started.`);
    return;
  }
  task = cron.schedule(config.automation.cronSchedule, async () => {
    try {
      const { enrollments, followings } = await track(runTick());
      if (enrollments && (enrollments.sent || enrollments.failed || enrollments.retried)) {
        console.log('Automation run:', JSON.stringify(enrollments));
      }
      if (followings && (followings.sent || followings.failed || followings.completed)) {
        console.log('Following run:', JSON.stringify(followings));
      }
    } catch (e) {
      console.error('Automation run error:', e.message);
    }
  });
  console.log(`Automation worker started (schedule: ${config.automation.cronSchedule}).`);
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

// Graceful shutdown, for SIGTERM/SIGINT (a deploy, a restart, a scale-down).
//   1. stop scheduling ticks;
//   2. refuse to start any new pass, and have a running pass stop after the
//      enrollment or recipient it is on (whose result is saved as usual);
//   3. wait for whatever is running, up to `timeoutMs`.
// Resolves to { drained, waitedFor }. `drained: false` means a pass was still
// running at the timeout and is about to be cut off by the exit — at most the
// one item it was on is affected, and its claim expires by itself.
async function shutdown({ timeoutMs = 20000 } = {}) {
  stop();
  shuttingDown = true;
  const pending = [...inFlight];
  if (pending.length === 0) return { drained: true, waitedFor: 0 };
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([Promise.allSettled(pending).then(() => 'drained'), timedOut]);
  clearTimeout(timer);
  return { drained: outcome === 'drained', waitedFor: pending.length };
}

// Test seam: undo shutdown() between tests.
function resetShutdownForTests() {
  shuttingDown = false;
  inFlight.clear();
}

module.exports = {
  processDueEnrollments,
  processDueFollowings,
  // One scheduled tick (lease + both passes, sharing a single send budget).
  runTick,
  start,
  stop,
  shutdown,
  resetShutdownForTests,
  // exported for unit testing
  delayToMs,
  hourInTimezone,
  withinSendingWindow,
  weekdayInTimezone,
  isAllowedSendDay,
  isSendableAt,
  nextSendableTime,
  resolveTimezone,
  claimEnrollment,
  claimRecipient,
  saveRecipient,
  RECIPIENT_CLAIM_TTL_MS,
  RESULT_SAVE_ATTEMPTS,
  retryBackoffFor,
  CLAIM_TTL_MS,
};
