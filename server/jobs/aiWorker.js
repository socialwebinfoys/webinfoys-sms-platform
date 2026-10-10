// AI reply worker (Phase 8).
//
// Deliberately mirrors jobs/automationWorker.js rather than inventing a second
// pattern: the same WorkerLock lease, the same per-row atomic claim, the same
// in-process overlap guard, the same exponential backoff. No Redis, no BullMQ —
// the project does not use them and AI is not a reason to introduce them.
//
// It is a SEPARATE cron task from the automation worker, gated on its own
// AI_WORKER_ENABLED flag, so AI replies and campaign automation can be operated
// independently. Both are off by default.
//
// Three independent layers stop the same job being processed twice:
//   1. WorkerLock — only one instance runs a tick.
//   2. isRunning  — a tick that overlaps a still-running pass no-ops.
//   3. claimJob   — an atomic per-row lease, so even without 1 and 2 two workers
//                   cannot both take the same job.
'use strict';

const cron = require('node-cron');
const { config } = require('../config/env');
const AIReplyJob = require('../models/AIReplyJob');
const Conversation = require('../models/Conversation');
// Fix 3: recovery asks whether a stranded job already produced a message.
const SMSMessage = require('../models/SMSMessage');
const WorkerLock = require('../models/WorkerLock');
const { logEvent } = require('../services/logService');
const aiService = require('../services/ai/aiService');
const { RETRYABLE_KINDS } = require('../services/ai/providers/errors');

let isRunning = false;

// Graceful shutdown, mirroring jobs/automationWorker.js: once set, no new pass
// or tick starts and a running pass stops after the job it is on.
let shuttingDown = false;
const inFlight = new Set();
function track(promise) {
  inFlight.add(promise);
  const done = () => inFlight.delete(promise);
  promise.then(done, done);
  return promise;
}
let task = null;

const LOCK_KEY = 'ai-replies';
const LOCK_OWNER = `${process.pid}@${require('os').hostname()}`;
const LEASE_TTL_MS = 2 * 60 * 1000;
// How long a worker may hold a job before the claim is considered dead. Longer
// than the provider timeout so a slow generation does not lose its own claim.
const CLAIM_TTL_MS = 5 * 60 * 1000;

function backoffMsFor(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return config.ai.retryBackoffMinutes * 60 * 1000 * 2 ** (n - 1);
}

// Atomically claim one job. `lockedUntil: { $not: { $gte: now } }` rather than
// `{ $lt: now }` so a row whose field is ABSENT still matches — the plainer form
// would silently freeze any job created before the field existed.
async function claimJob(jobId, now) {
  return AIReplyJob.findOneAndUpdate(
    {
      _id: jobId,
      status: 'pending',
      lockedUntil: { $not: { $gte: now } },
    },
    { $set: { status: 'processing', lockedUntil: new Date(now.getTime() + CLAIM_TTL_MS) } },
    { new: true }
  );
}

// Release the claim and persist the terminal state in one write.
async function finish(job, fields) {
  Object.assign(job, fields, { lockedUntil: new Date(0), processedAt: new Date() });
  await job.save();
}

// Hand a job back for a later attempt.
async function reschedule(job, { reason, now }) {
  job.attempts += 1;
  job.lastError = String(reason || '').slice(0, 300);
  if (job.attempts >= config.ai.maxRetries) {
    await finish(job, { status: 'failed', reason: 'max_retries' });
    return 'failed';
  }
  job.status = 'pending';
  job.nextAttemptAt = new Date(now.getTime() + backoffMsFor(job.attempts));
  job.lockedUntil = new Date(0);
  await job.save();
  return 'retried';
}

// Count a reply the assistant actually produced — sent or drafted. Skips,
// escalations and failures do not count, so a provider outage cannot exhaust a
// customer's reply allowance.
async function recordReply(conversationId) {
  if (!conversationId) return;
  await Conversation.updateOne(
    { _id: conversationId },
    { $inc: { 'ai.replyCount': 1 }, $set: { 'ai.lastReplyAt': new Date() } }
  );
}

// Public entry point. Serialises passes so an overlapping cron tick or a manual
// run can never process the same job concurrently.
async function processDueJobs(now = new Date(), options = {}) {
  if (isRunning || shuttingDown) {
    return {
      considered: 0,
      sent: 0,
      drafted: 0,
      skipped: true,
      reason: shuttingDown ? 'The worker is shutting down' : 'A run is already in progress',
    };
  }
  isRunning = true;
  try {
    return await track(runPass(now, options));
  } finally {
    isRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Fix 3 — recovering jobs stranded in `processing`.
//
// A job is claimed by moving it to `processing` with a lease. If the process
// dies between the claim and the final write — a crash, a deploy, an OOM kill —
// nothing ever clears it, and that job sits in `processing` forever: never
// retried, never sent, never visible as failed.
//
// Recovery looks for claims whose lease has expired and puts each job back into
// a state the normal pipeline understands. It NEVER sends anything itself and
// never calls a provider: it restores the job to the lifecycle and lets the
// existing pipeline — including every Fix 2 staleness check — run as usual.
//
// THE ORDER MATTERS, and the first question is the important one: did this job
// already produce a message? A crash after Twilio accepted a send but before the
// job was marked sent is exactly the case that would otherwise send the customer
// the same reply twice.
const RECOVERY_LIMIT = 50;

async function recoverStuckJobs(now = new Date()) {
  const summary = {
    considered: 0,
    recoveredSent: 0,
    recoveredApproval: 0,
    recoveredFailed: 0,
    recoveredPending: 0,
    contended: 0,
  };

  // Bounded and ordered by the oldest expired lease, so a backlog is worked
  // through across ticks rather than scanned whole.
  const stuck = await AIReplyJob.find({ status: 'processing', lockedUntil: { $lt: now } })
    .sort({ lockedUntil: 1 })
    .limit(RECOVERY_LIMIT);

  for (const job of stuck) {
    summary.considered += 1;

    // 1. DID THIS JOB ALREADY SEND? Asked through the direct aiJob link, not
    //    inferred from the body or the clock. If a message exists, the work was
    //    done and only the bookkeeping was lost.
    const alreadySent = await SMSMessage.findOne({ aiJob: job._id });

    let update;
    let outcome;
    if (alreadySent) {
      update = {
        status: 'sent',
        reason: 'recovered_sent',
        sentMessage: alreadySent._id,
        lockedUntil: new Date(0),
        processedAt: new Date(),
      };
      outcome = 'recoveredSent';
    } else if (job.draftReply && String(job.draftReply).trim()) {
      // 2. A draft the job was holding — this is an approval that died
      //    mid-flight. Hand it back so the operator can approve it again.
      update = {
        status: 'drafted',
        reason: 'recovered_approval',
        lockedUntil: new Date(0),
      };
      outcome = 'recoveredApproval';
    } else if ((job.attempts || 0) >= config.ai.maxRetries) {
      // 3. Out of attempts. Failing it is what makes the problem visible.
      update = {
        status: 'failed',
        reason: 'recovered_max_attempts',
        lockedUntil: new Date(0),
        processedAt: new Date(),
      };
      outcome = 'recoveredFailed';
    } else {
      // 4. Nothing was sent and attempts remain: back to the queue, due now.
      update = {
        status: 'pending',
        reason: 'recovered',
        nextAttemptAt: now,
        lockedUntil: new Date(0),
      };
      outcome = 'recoveredPending';
    }

    // THE CONDITIONAL WRITE. The filter repeats the stale-claim condition, so a
    // job another worker has re-claimed since the read above matches nothing and
    // is left exactly as that worker set it. Without this, a slow recovery pass
    // could stamp its conclusion over live work.
    const result = await AIReplyJob.updateOne(
      { _id: job._id, status: 'processing', lockedUntil: { $lt: now } },
      { $set: update }
    );
    const changed = (result && (result.modifiedCount ?? result.nModified)) || 0;
    if (!changed) {
      summary.contended += 1;
      continue;
    }

    summary[outcome] += 1;

    await logEvent({
      eventType: 'ai.job.recovered',
      // A stranded job is an operational fault worth noticing, even though
      // recovery handled it.
      severity: outcome === 'recoveredFailed' ? 'error' : 'warning',
      message: `Recovered an AI job stuck in processing: ${update.reason}`,
      status: update.status,
      contact: job.contact,
      conversation: job.conversation,
      meta: {
        jobId: String(job._id),
        reason: update.reason,
        attempts: job.attempts || 0,
        // Ids and counts only — nothing from the message, the prompt or the key.
        sentMessage: alreadySent ? String(alreadySent._id) : undefined,
      },
    });
  }

  return summary;
}

async function runPass(now = new Date(), options = {}) {
  const summary = {
    considered: 0,
    sent: 0,
    drafted: 0,
    skippedByPolicy: 0,
    escalated: 0,
    retried: 0,
    failed: 0,
    errors: [],
  };

  // Fix 3: recovery runs FIRST, every tick, inside the same lease that guards
  // the rest of the pass. Before the budget check too — a throttle of zero must
  // not mean stranded jobs are never recovered.
  //
  // Its own failure must not stop the pass: a recovery that could not run leaves
  // jobs stuck exactly as they already were, whereas an exception here would
  // also stop the queue being served.
  try {
    summary.recovery = await recoverStuckJobs(now);
  } catch (err) {
    summary.recovery = { error: String(err.message || 'recovery failed').slice(0, 200) };
    console.error('AI stuck-job recovery failed:', err.message);
  }

  const budget = options.budget === undefined ? config.ai.maxJobsPerRun : options.budget;
  if (budget <= 0) return summary;

  const due = await AIReplyJob.find({ status: 'pending', nextAttemptAt: { $lte: now } })
    .sort({ nextAttemptAt: 1 })
    .limit(budget);

  for (const candidate of due) {
    // Shutting down: unclaimed jobs stay pending for the next instance.
    if (shuttingDown) break;
    const job = await claimJob(candidate._id, now);
    if (!job) continue; // another worker got there first
    summary.considered += 1;

    try {
      const result = await aiService.processJob(job, { now });

      if (result.outcome === 'sent') {
        await finish(job, {
          status: 'sent',
          draftReply: result.parsed.reply,
          confidence: result.parsed.confidence,
          provider: result.provider,
          model: result.model,
          usage: result.usage,
          sentMessage: result.sentMessage && result.sentMessage._id,
          reason: '',
        });
        await recordReply(job.conversation);
        summary.sent += 1;
        await logEvent({
          eventType: 'ai.reply.sent',
          severity: 'info',
          message: 'AI reply sent',
          status: 'sent',
          contact: job.contact,
          conversation: job.conversation,
          meta: {
            jobId: String(job._id),
            provider: result.provider,
            model: result.model,
            mode: job.mode,
            confidence: result.parsed.confidence,
            usage: result.usage,
          },
        });
      } else if (result.outcome === 'drafted') {
        await finish(job, {
          status: 'drafted',
          draftReply: result.parsed.reply,
          confidence: result.parsed.confidence,
          provider: result.provider,
          model: result.model,
          usage: result.usage,
          reason: result.reason || 'draft_mode',
        });
        await recordReply(job.conversation);
        summary.drafted += 1;
        await logEvent({
          eventType: 'ai.reply.drafted',
          severity: 'info',
          message: 'AI reply drafted for human review',
          status: 'drafted',
          contact: job.contact,
          conversation: job.conversation,
          meta: {
            jobId: String(job._id),
            provider: result.provider,
            model: result.model,
            mode: job.mode,
            confidence: result.parsed.confidence,
            reason: result.reason || 'draft_mode',
            usage: result.usage,
          },
        });
      } else if (result.outcome === 'escalated') {
        await finish(job, {
          status: 'escalated',
          escalated: true,
          reason: result.reason,
          draftReply: result.parsed ? result.parsed.reply : '',
          confidence: result.parsed ? result.parsed.confidence : undefined,
          provider: result.provider || '',
          model: result.model || '',
        });
        summary.escalated += 1;
        await logEvent({
          eventType: 'ai.reply.escalated',
          severity: 'warning',
          message: `AI escalated the conversation: ${result.reason}`,
          status: 'escalated',
          contact: job.contact,
          conversation: job.conversation,
          meta: { jobId: String(job._id), reason: result.reason, detail: result.detail, mode: job.mode },
        });
      } else if (result.outcome === 'retry') {
        // A good reply at a bad moment (quiet hours, unverifiable line type).
        summary.retried += 1;
        await reschedule(job, { reason: result.reason, now });
      } else {
        // 'skipped' — a policy said no. Terminal: nothing about this will change
        // on a retry, and an opted-out contact must never be retried.
        await finish(job, { status: 'skipped', reason: result.reason });
        summary.skippedByPolicy += 1;
        await logEvent({
          eventType: 'ai.reply.skipped',
          severity: 'info',
          message: `AI reply skipped: ${result.reason}`,
          status: 'skipped',
          contact: job.contact,
          conversation: job.conversation,
          meta: { jobId: String(job._id), reason: result.reason, detail: result.detail, mode: job.mode },
        });
      }
    } catch (err) {
      // Only transient provider problems are retried. An auth or invalid-request
      // failure will fail identically next time, so it stops immediately and the
      // operator finds out instead of it looping for hours.
      const retryable = err && err.kind ? RETRYABLE_KINDS.has(err.kind) : true;
      const safeMessage = String(err && err.message ? err.message : 'AI generation failed').slice(0, 300);

      if (!retryable) {
        await finish(job, { status: 'failed', reason: err.kind || 'permanent', lastError: safeMessage });
        summary.failed += 1;
      } else {
        const outcome = await reschedule(job, { reason: safeMessage, now });
        if (outcome === 'failed') summary.failed += 1;
        else summary.retried += 1;
      }
      summary.errors.push({ job: String(job._id), reason: safeMessage });

      await logEvent({
        eventType: 'ai.provider.error',
        severity: 'error',
        message: 'AI generation failed',
        status: job.status,
        contact: job.contact,
        conversation: job.conversation,
        error: safeMessage,
        meta: {
          jobId: String(job._id),
          kind: err && err.kind,
          provider: err && err.provider,
          attempts: job.attempts,
          retryable,
        },
      });
    }
  }

  if (summary.considered > 0) {
    await logEvent({
      eventType: 'ai.run',
      severity: 'info',
      message: `AI run: sent ${summary.sent}, drafted ${summary.drafted}, escalated ${summary.escalated}`,
      status: 'run',
      meta: { ...summary, errors: summary.errors.length },
    });
  }

  return summary;
}

// One scheduled tick: take the global lease, then run a pass.
async function runTick(now = new Date()) {
  let holdsLease = false;
  const result = { heldLease: false, summary: null };
  if (shuttingDown) return result;
  try {
    holdsLease = await WorkerLock.acquire(LOCK_KEY, LOCK_OWNER, LEASE_TTL_MS);
    if (!holdsLease) return result;
    result.heldLease = true;
    result.summary = await processDueJobs(now);
    return result;
  } finally {
    if (holdsLease) {
      try {
        await WorkerLock.release(LOCK_KEY, LOCK_OWNER);
      } catch (e) {
        console.error('AI worker lease release failed:', e.message);
      }
    }
  }
}

function start() {
  if (!config.ai.workerEnabled) {
    console.log('AI reply worker is disabled (AI_WORKER_ENABLED is not "true").');
    return;
  }
  if (!cron.validate(config.ai.cronSchedule)) {
    console.warn(`Invalid AI_WORKER_CRON "${config.ai.cronSchedule}"; AI worker not started.`);
    return;
  }
  task = cron.schedule(config.ai.cronSchedule, async () => {
    try {
      const { summary } = await track(runTick());
      if (summary && (summary.sent || summary.drafted || summary.failed)) {
        console.log('AI run:', JSON.stringify(summary));
      }
    } catch (e) {
      console.error('AI run error:', e.message);
    }
  });
  console.log(`AI reply worker started (schedule: ${config.ai.cronSchedule}).`);
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

// Stop scheduling, refuse new passes, and wait (up to `timeoutMs`) for a pass
// that is already running. A job cut off by the exit is left `processing` and
// is handled by recoverStuckJobs once its claim expires.
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
  processDueJobs,
  runTick,
  start,
  stop,
  shutdown,
  resetShutdownForTests,
  // exported for testing
  claimJob,
  backoffMsFor,
  CLAIM_TTL_MS,
  LOCK_KEY,
  // Fix 3.
  recoverStuckJobs,
  RECOVERY_LIMIT,
};
