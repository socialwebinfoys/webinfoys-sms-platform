// Phase 10 — Stage 6A/6B/6C/6J: the three concurrency layers and the
// automation-disabled guarantee.
'use strict';

require('../_support/env');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupWorkerEnv } = require('../_support/workerEnv');

const state = setupWorkerEnv();
const worker = require('../../jobs/automationWorker');
const WorkerLock = require('../../models/WorkerLock');
const { config } = require('../../config/env');

beforeEach(() => {
  state.reset();
});

describe('Stage 6A — WorkerLock global lease', () => {
  const KEY = 'automation';
  const TTL = 60_000;

  test('the first instance acquires the lease', async () => {
    assert.equal(await WorkerLock.acquire(KEY, 'pid1@hostA', TTL), true);
  });

  test('a SECOND instance cannot acquire a held lease', async () => {
    assert.equal(await WorkerLock.acquire(KEY, 'pid1@hostA', TTL), true);
    assert.equal(
      await WorkerLock.acquire(KEY, 'pid2@hostB', TTL),
      false,
      'two instances must never both hold the lease'
    );
  });

  test('the SAME owner may renew its own lease', async () => {
    await WorkerLock.acquire(KEY, 'pid1@hostA', TTL);
    assert.equal(await WorkerLock.acquire(KEY, 'pid1@hostA', TTL), true);
  });

  test('two instances racing for a free lease: exactly one wins', async () => {
    const results = await Promise.all([
      WorkerLock.acquire(KEY, 'pid1@hostA', TTL),
      WorkerLock.acquire(KEY, 'pid2@hostB', TTL),
      WorkerLock.acquire(KEY, 'pid3@hostC', TTL),
    ]);
    assert.equal(results.filter(Boolean).length, 1, `exactly one winner, got ${results}`);
  });

  test('an EXPIRED lease can be taken over (a crashed holder self-heals)', async () => {
    await WorkerLock.acquire(KEY, 'crashed@hostA', -1000); // already expired
    assert.equal(
      await WorkerLock.acquire(KEY, 'fresh@hostB', TTL),
      true,
      'an expired lease must not block the next tick forever'
    );
  });

  test('release makes the lease immediately available to another instance', async () => {
    await WorkerLock.acquire(KEY, 'pid1@hostA', TTL);
    await WorkerLock.release(KEY, 'pid1@hostA');
    assert.equal(await WorkerLock.acquire(KEY, 'pid2@hostB', TTL), true);
  });

  test('a non-owner cannot release someone else’s lease', async () => {
    await WorkerLock.acquire(KEY, 'pid1@hostA', TTL);
    await WorkerLock.release(KEY, 'impostor@hostX');
    assert.equal(
      await WorkerLock.acquire(KEY, 'pid2@hostB', TTL),
      false,
      'the lease must still be held by its real owner'
    );
  });

  test('a duplicate-key error is reported as "not acquired", never thrown', async () => {
    await WorkerLock.acquire(KEY, 'pid1@hostA', TTL);
    await assert.doesNotReject(() => WorkerLock.acquire(KEY, 'pid2@hostB', TTL));
  });

  test('separate lock keys are independent', async () => {
    assert.equal(await WorkerLock.acquire('automation', 'pid1@hostA', TTL), true);
    assert.equal(await WorkerLock.acquire('something-else', 'pid1@hostA', TTL), true);
  });
});

describe('Stage 6C — per-row atomic claim', () => {
  test('a free enrollment can be claimed', async () => {
    const enr = state.addEnrollment({ lockedUntil: new Date(0) });
    const now = new Date();
    const claimed = await worker.claimEnrollment(enr._id, now);
    assert.ok(claimed, 'expected the claim to succeed');
    assert.ok(new Date(claimed.lockedUntil).getTime() > now.getTime(), 'the lease must move forward');
  });

  test('a SECOND worker racing the same enrollment gets null — exactly one claim', async () => {
    const enr = state.addEnrollment({ lockedUntil: new Date(0) });
    const now = new Date();
    const first = await worker.claimEnrollment(enr._id, now);
    const second = await worker.claimEnrollment(enr._id, now);
    assert.ok(first);
    assert.equal(second, null, 'a claimed row must not be claimable again');
  });

  test('three workers racing: exactly one claim succeeds', async () => {
    const enr = state.addEnrollment({ lockedUntil: new Date(0) });
    const now = new Date();
    const results = await Promise.all([
      worker.claimEnrollment(enr._id, now),
      worker.claimEnrollment(enr._id, now),
      worker.claimEnrollment(enr._id, now),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  test('a LEGACY row with NO lockedUntil field is claimable (the $not/$gte reason)', async () => {
    const enr = state.addEnrollment();
    delete enr.lockedUntil;
    const claimed = await worker.claimEnrollment(enr._id, new Date());
    assert.ok(claimed, 'a plain { $lt: now } filter would never match a missing field');
  });

  test('an EXPIRED claim is reclaimable', async () => {
    const enr = state.addEnrollment({ lockedUntil: new Date(Date.now() - 60_000) });
    assert.ok(await worker.claimEnrollment(enr._id, new Date()));
  });

  test('a claim held into the future is not reclaimable', async () => {
    const enr = state.addEnrollment({ lockedUntil: new Date(Date.now() + 60_000) });
    assert.equal(await worker.claimEnrollment(enr._id, new Date()), null);
  });

  test('a non-active enrollment can never be claimed', async () => {
    for (const status of ['paused', 'completed', 'failed', 'cancelled', 'replied']) {
      const enr = state.addEnrollment({ status, lockedUntil: new Date(0) });
      assert.equal(
        await worker.claimEnrollment(enr._id, new Date()),
        null,
        `${status} must not be claimable`
      );
    }
  });

  test('the claim TTL is applied to the lease', async () => {
    const enr = state.addEnrollment({ lockedUntil: new Date(0) });
    const now = new Date();
    const claimed = await worker.claimEnrollment(enr._id, now);
    assert.equal(
      new Date(claimed.lockedUntil).getTime(),
      now.getTime() + worker.CLAIM_TTL_MS
    );
  });
});

describe('Stage 6B — in-process overlap guard', () => {
  test('a pass that starts while another is running is skipped, not run concurrently', async () => {
    const campaign = state.addCampaign();
    const contact = state.addContact();
    state.addEnrollment({
      contact: contact._id,
      campaign: campaign._id,
      currentStepId: campaign.steps[0]._id,
      nextRunAt: new Date(Date.now() - 1000),
      lockedUntil: new Date(0),
    });
    state.settings = { ...state.settings, sendingWindow: { enabled: false } };

    // Hold the first pass open inside the Twilio call.
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    state.sendOutcome = async () => {
      await held;
      return { sid: 'SMheld', status: 'queued', simulated: false, from: '' };
    };

    const first = worker.processDueEnrollments(new Date());
    // Give the first pass time to take the in-process flag.
    await new Promise((r) => setImmediate(r));
    const second = await worker.processDueEnrollments(new Date());

    assert.equal(second.skipped, true, 'the overlapping pass must no-op');
    assert.match(second.reason, /already in progress/);
    assert.equal(second.sent, 0);

    release();
    const firstSummary = await first;
    assert.equal(firstSummary.sent, 1, 'the original pass still completes normally');
    assert.equal(state.sendCalls.length, 1, 'exactly one send, never two');
  });

  test('the follow-up pass has its own independent overlap guard', async () => {
    const contact = state.addContact();
    state.addFollowing({ recipients: [{ contact: contact._id, status: 'pending', attempts: 0 }] });
    state.settings = { ...state.settings, sendingWindow: { enabled: false } };

    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    state.sendOutcome = async () => {
      await held;
      return { sid: 'SMheld2', status: 'queued', simulated: false, from: '' };
    };

    const first = worker.processDueFollowings(new Date());
    await new Promise((r) => setImmediate(r));
    const second = await worker.processDueFollowings(new Date());

    assert.equal(second.skipped, true);
    release();
    await first;
    assert.equal(state.sendCalls.length, 1);
  });

  test('after a pass finishes, the next one runs normally', async () => {
    const first = await worker.processDueEnrollments(new Date());
    assert.notEqual(first.skipped, true);
    const second = await worker.processDueEnrollments(new Date());
    assert.notEqual(second.skipped, true, 'the guard must be released in a finally block');
  });

  test('a pass that THROWS still releases the guard', async () => {
    const Settings = require('../../models/Settings');
    const original = Settings.getSingleton;
    Settings.getSingleton = async () => {
      throw new Error('settings unavailable');
    };
    try {
      await assert.rejects(() => worker.processDueEnrollments(new Date()));
    } finally {
      Settings.getSingleton = original;
    }
    const after = await worker.processDueEnrollments(new Date());
    assert.notEqual(after.skipped, true, 'a thrown pass must not wedge the worker permanently');
  });
});

describe('Stage 6J — automation disabled means the cron worker does not run', () => {
  test('config reports automation disabled in the test environment', () => {
    assert.equal(config.automation.enabled, false);
  });

  test('start() schedules nothing while disabled', () => {
    const cron = require('node-cron');
    const originalSchedule = cron.schedule;
    let scheduled = 0;
    cron.schedule = (...args) => {
      scheduled += 1;
      return originalSchedule(...args);
    };
    try {
      worker.start();
      assert.equal(scheduled, 0, 'no cron task may be registered while AUTOMATION_ENABLED=false');
    } finally {
      cron.schedule = originalSchedule;
      worker.stop();
    }
  });

  test('an invalid cron expression also prevents scheduling (fails safe)', () => {
    const cron = require('node-cron');
    const originalSchedule = cron.schedule;
    const originalEnabled = config.automation.enabled;
    const originalCron = config.automation.cronSchedule;
    let scheduled = 0;
    cron.schedule = (...args) => {
      scheduled += 1;
      return originalSchedule(...args);
    };
    config.automation.enabled = true;
    config.automation.cronSchedule = 'not a cron expression';
    try {
      worker.start();
      assert.equal(scheduled, 0, 'an unparseable schedule must not start a worker');
    } finally {
      cron.schedule = originalSchedule;
      config.automation.enabled = originalEnabled;
      config.automation.cronSchedule = originalCron;
      worker.stop();
    }
  });

  test('a manual pass still works while the cron worker is disabled (documented behaviour)', async () => {
    const campaign = state.addCampaign();
    const contact = state.addContact();
    state.addEnrollment({
      contact: contact._id,
      campaign: campaign._id,
      currentStepId: campaign.steps[0]._id,
      nextRunAt: new Date(Date.now() - 1000),
      lockedUntil: new Date(0),
    });
    state.settings = { ...state.settings, sendingWindow: { enabled: false } };
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.sent, 1, 'AUTOMATION_ENABLED=false stops the CRON, not a manual run');
  });
});
