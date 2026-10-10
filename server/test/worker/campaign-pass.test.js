// Phase 10 — Stage 6D/6E/6F/6G/6I and Stage 4 consent inside the campaign pass.
'use strict';

require('../_support/env');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupWorkerEnv } = require('../_support/workerEnv');
const f = require('../_support/factories');

const state = setupWorkerEnv();
const worker = require('../../jobs/automationWorker');
const { config } = require('../../config/env');

const MIN = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  state.reset();
  // Unless a test is about the window, keep it out of the way.
  state.settings = f.settings({ sendingWindow: { enabled: false }, sendDays: [0, 1, 2, 3, 4, 5, 6] });
});

function arrange({ steps, enrollment = {}, contact = {}, campaign = {} } = {}) {
  const camp = state.addCampaign({ steps, ...campaign });
  const cont = state.addContact(contact);
  const enr = state.addEnrollment({
    contact: cont._id,
    campaign: camp._id,
    currentStepId: camp.steps[0] ? camp.steps[0]._id : null,
    currentStepIndex: 0,
    // The epoch, so the row is due whatever instant a test passes as `now`
    // (several window tests simulate a fixed date).
    nextRunAt: new Date(0),
    lockedUntil: new Date(0),
    ...enrollment,
  });
  return { campaign: camp, contact: cont, enrollment: enr };
}

describe('a due enrollment is sent and advanced', () => {
  test('one step: the message is sent, logged and the enrollment completes', async () => {
    const { enrollment, contact } = arrange();
    const summary = await worker.processDueEnrollments(new Date());

    assert.equal(summary.sent, 1);
    assert.equal(summary.completed, 1);
    assert.equal(state.sendCalls.length, 1);
    assert.equal(state.sendCalls[0].to, contact.phone);
    assert.equal(enrollment.status, 'completed');
    assert.equal(enrollment.sentSteps.length, 1);
    assert.equal(state.createdMessages.length, 1);
    assert.equal(state.createdMessages[0].source, 'campaign');
    assert.equal(String(state.createdMessages[0].campaign), String(enrollment.campaign));
    assert.ok(state.eventsOfType('automation.sent').length === 1);
  });

  test('merge fields are rendered against the contact', async () => {
    arrange({
      steps: [{ _id: f.oid(), body: 'Hi {{first_name}}!', delayValue: 0, delayUnit: 'hours' }],
      contact: { name: 'Ada Lovelace' },
    });
    await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls[0].body, 'Hi Ada Lovelace!');
  });

  test('a multi-step campaign advances to the next step and schedules its delay', async () => {
    const steps = [
      { _id: f.oid(), body: 'one', delayValue: 0, delayUnit: 'hours' },
      { _id: f.oid(), body: 'two', delayValue: 2, delayUnit: 'hours' },
    ];
    const { enrollment } = arrange({ steps });
    const now = new Date();
    await worker.processDueEnrollments(now);

    assert.equal(enrollment.status, 'active');
    assert.equal(String(enrollment.currentStepId), String(steps[1]._id));
    assert.equal(enrollment.currentStepIndex, 1);
    assert.equal(
      new Date(enrollment.nextRunAt).getTime(),
      now.getTime() + 2 * 60 * MIN,
      'the next step must be scheduled by its own delay'
    );
  });

  test('attempts are reset after a successful send', async () => {
    const { enrollment } = arrange({ enrollment: { attempts: 2 } });
    await worker.processDueEnrollments(new Date());
    assert.equal(enrollment.attempts, 0);
  });

  test('the claim is released so the next tick can pick the row up', async () => {
    const steps = [
      { _id: f.oid(), body: 'one', delayValue: 0, delayUnit: 'hours' },
      { _id: f.oid(), body: 'two', delayValue: 0, delayUnit: 'hours' },
    ];
    const { enrollment } = arrange({ steps });
    await worker.processDueEnrollments(new Date());
    assert.equal(new Date(enrollment.lockedUntil).getTime(), 0, 'the lease must be handed back');
  });

  test('an enrollment that is not yet due is left alone', async () => {
    const { enrollment } = arrange({ enrollment: { nextRunAt: new Date(Date.now() + 60 * MIN) } });
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.considered, 0);
    assert.equal(state.sendCalls.length, 0);
    assert.equal(enrollment.status, 'active');
  });

  test('an INACTIVE campaign is not processed (head-of-line blocking fix)', async () => {
    arrange({ campaign: { isActive: false } });
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.considered, 0);
    assert.equal(state.sendCalls.length, 0);
  });

  test('smsEnabled=false stops the whole pass before anything is sent', async () => {
    state.settings = f.settings({ smsEnabled: false, sendingWindow: { enabled: false } });
    arrange();
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.smsDisabled, true);
    assert.equal(state.sendCalls.length, 0);
    assert.equal(state.createdMessages.length, 0);
  });

  test('a deleted campaign or contact fails the enrollment rather than looping', async () => {
    const { enrollment } = arrange();
    state.contacts.clear();
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.failed, 1);
    assert.equal(enrollment.status, 'failed');
    assert.match(enrollment.lastError, /no longer exists/);
  });
});

describe('Stage 6D — idempotency', () => {
  test('a step already in sentSteps is NOT re-sent; the pointer just advances', async () => {
    const steps = [
      { _id: f.oid(), body: 'one', delayValue: 0, delayUnit: 'hours' },
      { _id: f.oid(), body: 'two', delayValue: 0, delayUnit: 'hours' },
    ];
    const { enrollment } = arrange({
      steps,
      enrollment: {
        sentSteps: [{ stepId: steps[0]._id, stepIndex: 0, twilioSid: 'SMold', status: 'sent' }],
      },
    });
    const summary = await worker.processDueEnrollments(new Date());

    assert.equal(summary.alreadySent, 1);
    assert.equal(state.sendCalls.length, 0, 'the recorded step must never be re-sent');
    assert.equal(String(enrollment.currentStepId), String(steps[1]._id));
  });

  test('running the pass TWICE sends each step exactly once', async () => {
    const steps = [
      { _id: f.oid(), body: 'one', delayValue: 0, delayUnit: 'hours' },
      { _id: f.oid(), body: 'two', delayValue: 0, delayUnit: 'hours' },
    ];
    arrange({ steps });
    await worker.processDueEnrollments(new Date());
    await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls.length, 2);
    assert.deepEqual(state.sendCalls.map((c) => c.body), ['one', 'two']);
  });

  test('running the pass more times than there are steps sends nothing extra', async () => {
    const steps = [{ _id: f.oid(), body: 'only', delayValue: 0, delayUnit: 'hours' }];
    arrange({ steps });
    for (let i = 0; i < 5; i += 1) await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls.length, 1);
  });

  test('the step is recorded BEFORE the pointer advances, so a crash cannot duplicate it', async () => {
    const steps = [{ _id: f.oid(), body: 'one', delayValue: 0, delayUnit: 'hours' }];
    const { enrollment } = arrange({ steps });
    await worker.processDueEnrollments(new Date());
    assert.equal(enrollment.sentSteps.length, 1);
    assert.equal(String(enrollment.sentSteps[0].stepId), String(steps[0]._id));
    assert.ok(enrollment.sentSteps[0].twilioSid);
    assert.ok(enrollment.sentSteps[0].sentAt instanceof Date);
  });

  test('a FAILED send records NO sentStep, so the same step is retried', async () => {
    const steps = [{ _id: f.oid(), body: 'one', delayValue: 0, delayUnit: 'hours' }];
    const { enrollment } = arrange({ steps });
    state.sendOutcome = () => {
      const err = new Error('transient');
      err.twilioCode = 20429;
      throw err;
    };
    await worker.processDueEnrollments(new Date());
    assert.equal(enrollment.sentSteps.length, 0, 'nothing may be marked sent when the send threw');
    assert.equal(String(enrollment.currentStepId), String(steps[0]._id), 'the pointer must not move');
  });
});

describe('Stage 6E — stable step identity under live campaign edits', () => {
  test('REORDERING steps keeps an in-flight enrollment on the SAME message', async () => {
    const stepA = { _id: f.oid(), body: 'A', delayValue: 0, delayUnit: 'hours' };
    const stepB = { _id: f.oid(), body: 'B', delayValue: 0, delayUnit: 'hours' };
    const { campaign, enrollment } = arrange({ steps: [stepA, stepB] });
    enrollment.currentStepId = stepB._id;
    enrollment.currentStepIndex = 1;

    // The operator reorders: B is now first.
    campaign.steps = [stepB, stepA];

    await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls[0].body, 'B', 'an index pointer would have sent A');
  });

  test('DELETING the step an enrollment waits on falls FORWARD without re-sending', async () => {
    const stepA = { _id: f.oid(), body: 'A', delayValue: 0, delayUnit: 'hours' };
    const stepB = { _id: f.oid(), body: 'B', delayValue: 0, delayUnit: 'hours' };
    const stepC = { _id: f.oid(), body: 'C', delayValue: 0, delayUnit: 'hours' };
    const { campaign, enrollment } = arrange({ steps: [stepA, stepB, stepC] });
    enrollment.sentSteps = [{ stepId: stepA._id, stepIndex: 0, twilioSid: 'SM1', status: 'sent' }];
    enrollment.currentStepId = stepB._id;

    campaign.steps = [stepA, stepC]; // B deleted

    await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls.length, 1);
    assert.equal(state.sendCalls[0].body, 'C', 'it must move on, never re-send the completed A');
  });

  test('INSERTING a step earlier cannot cause a re-send of a completed step', async () => {
    const stepA = { _id: f.oid(), body: 'A', delayValue: 0, delayUnit: 'hours' };
    const stepB = { _id: f.oid(), body: 'B', delayValue: 0, delayUnit: 'hours' };
    const inserted = { _id: f.oid(), body: 'NEW', delayValue: 0, delayUnit: 'hours' };
    const { campaign, enrollment } = arrange({ steps: [stepA, stepB] });
    enrollment.sentSteps = [{ stepId: stepA._id, stepIndex: 0, twilioSid: 'SM1', status: 'sent' }];
    enrollment.currentStepId = stepB._id;

    campaign.steps = [stepA, inserted, stepB];

    await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls[0].body, 'B', 'the pointer is by id, so the insert is skipped');
    const sentBodies = state.sendCalls.map((c) => c.body);
    assert.equal(sentBodies.includes('A'), false, 'A must never be sent twice');
  });

  test('a LEGACY enrollment with no currentStepId uses the index and gains an id', async () => {
    const steps = [
      { _id: f.oid(), body: 'one', delayValue: 0, delayUnit: 'hours' },
      { _id: f.oid(), body: 'two', delayValue: 0, delayUnit: 'hours' },
    ];
    const { enrollment } = arrange({ steps, enrollment: { currentStepId: null, currentStepIndex: 1 } });
    await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls[0].body, 'two', 'the legacy index must still be honoured');
    assert.equal(enrollment.sentSteps[0].stepIndex, 1);
  });

  test('a legacy sentSteps row with only a stepIndex still prevents a re-send', async () => {
    const steps = [
      { _id: f.oid(), body: 'one', delayValue: 0, delayUnit: 'hours' },
      { _id: f.oid(), body: 'two', delayValue: 0, delayUnit: 'hours' },
    ];
    const { enrollment } = arrange({
      steps,
      enrollment: {
        currentStepId: null,
        currentStepIndex: 0,
        sentSteps: [{ stepIndex: 0, twilioSid: 'SMlegacy', status: 'sent' }],
      },
    });
    await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls.length, 0, 'the index fallback must match the legacy row');
    assert.equal(enrollment.currentStepIndex, 1);
  });

  test('a legacy index beyond the step list completes the enrollment', async () => {
    const steps = [{ _id: f.oid(), body: 'one', delayValue: 0, delayUnit: 'hours' }];
    const { enrollment } = arrange({
      steps,
      enrollment: { currentStepId: null, currentStepIndex: 5 },
    });
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.completed, 1);
    assert.equal(enrollment.status, 'completed');
    assert.equal(state.sendCalls.length, 0);
  });

  test('a campaign with NO steps completes the enrollment rather than erroring', async () => {
    const camp = state.addCampaign({ steps: [] });
    const cont = state.addContact();
    const enr = state.addEnrollment({
      contact: cont._id,
      campaign: camp._id,
      nextRunAt: new Date(Date.now() - 1000),
      lockedUntil: new Date(0),
    });
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.completed, 1);
    assert.equal(enr.status, 'completed');
  });

  test('every step of a three-step campaign is delivered exactly once, in order', async () => {
    const steps = [
      { _id: f.oid(), body: 's1', delayValue: 0, delayUnit: 'hours' },
      { _id: f.oid(), body: 's2', delayValue: 0, delayUnit: 'hours' },
      { _id: f.oid(), body: 's3', delayValue: 0, delayUnit: 'hours' },
    ];
    const { enrollment } = arrange({ steps });
    for (let i = 0; i < 6; i += 1) await worker.processDueEnrollments(new Date());
    assert.deepEqual(state.sendCalls.map((c) => c.body), ['s1', 's2', 's3']);
    assert.equal(enrollment.status, 'completed');
  });
});

describe('Stage 6F — retry and backoff', () => {
  function failWith({ code, permanent }) {
    state.sendOutcome = () => {
      const err = new Error('send failed');
      err.twilioCode = code;
      err.permanent = !!permanent;
      throw err;
    };
  }

  test('a TRANSIENT failure increments attempts and schedules exponential backoff', async () => {
    const { enrollment } = arrange();
    failWith({ code: 20429 });
    const now = new Date();
    const summary = await worker.processDueEnrollments(now);

    assert.equal(summary.retried, 1);
    assert.equal(enrollment.status, 'active');
    assert.equal(enrollment.attempts, 1);
    assert.equal(
      new Date(enrollment.nextRunAt).getTime(),
      now.getTime() + config.automation.retryBackoffMinutes * MIN,
      'the first retry waits the base backoff'
    );
    assert.ok(state.eventsOfType('automation.failed').length === 1);
  });

  test('backoff doubles on each attempt', async () => {
    const { enrollment } = arrange({ enrollment: { attempts: 1 } });
    failWith({ code: 20429 });
    const now = new Date();
    await worker.processDueEnrollments(now);
    assert.equal(enrollment.attempts, 2);
    assert.equal(
      new Date(enrollment.nextRunAt).getTime(),
      now.getTime() + config.automation.retryBackoffMinutes * MIN * 2
    );
  });

  test('reaching maxRetries FAILS the enrollment', async () => {
    const { enrollment } = arrange({ enrollment: { attempts: config.automation.maxRetries - 1 } });
    failWith({ code: 20429 });
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.failed, 1);
    assert.equal(enrollment.status, 'failed');
    assert.equal(enrollment.attempts, config.automation.maxRetries);
  });

  test('a PERMANENT Twilio code fails immediately, without burning retries', async () => {
    const { enrollment } = arrange();
    failWith({ code: 21211, permanent: true });
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.failed, 1);
    assert.equal(enrollment.status, 'failed');
    assert.equal(enrollment.attempts, 1, 'it must not retry a hopeless send');
  });

  test('a temporary LOOKUP failure is retried with backoff, not failed', async () => {
    state.settings = f.settings({
      allowedLineTypes: ['mobile'],
      sendingWindow: { enabled: false },
    });
    const { enrollment } = arrange({ contact: { lookup: undefined } });
    state.contacts.get(String(enrollment.contact)).lookup = {
      status: 'unknown',
      type: '',
      lookedUpAt: undefined,
    };
    state.lookupResult = async () => {
      throw new Error('Lookup unavailable');
    };
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.retried, 1);
    assert.equal(enrollment.status, 'active');
    assert.equal(state.sendCalls.length, 0);
    const event = state.eventsOfType('automation.blocked')[0];
    assert.equal(event.meta.temporary, true);
  });

  test('a DEFINITIVE line-type block fails the enrollment and never retries', async () => {
    state.settings = f.settings({
      allowedLineTypes: ['mobile'],
      sendingWindow: { enabled: false },
    });
    const { enrollment } = arrange({
      contact: {
        lookup: { status: 'valid', type: 'landline', lookedUpAt: new Date(Date.now() - DAY) },
      },
    });
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.blockedNonMobile, 1);
    assert.equal(enrollment.status, 'failed');
    assert.equal(state.sendCalls.length, 0);
    const event = state.eventsOfType('automation.blocked')[0];
    assert.equal(event.meta.temporary, false);
    assert.equal(event.meta.type, 'landline');
  });
});

describe('Stage 4 — consent inside the campaign pass', () => {
  test('an OPTED-OUT contact cancels the enrollment, never retried', async () => {
    const { enrollment } = arrange({ contact: { optedOut: true } });
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.blockedCompliance, 1);
    assert.equal(enrollment.status, 'cancelled');
    assert.equal(enrollment.stopReason, 'opted_out');
    assert.equal(state.sendCalls.length, 0);
    assert.equal(state.createdMessages.length, 0);
    const event = state.eventsOfType('automation.blocked')[0];
    assert.equal(event.meta.temporary, false);
    assert.equal(event.meta.code, 'opted_out');
  });

  test('an INACTIVE contact cancels the enrollment', async () => {
    const { enrollment } = arrange({ contact: { isActive: false } });
    await worker.processDueEnrollments(new Date());
    assert.equal(enrollment.status, 'cancelled');
    assert.equal(enrollment.stopReason, 'inactive');
  });

  test('a DELIVERY-BLOCKED contact cancels the enrollment', async () => {
    const { enrollment } = arrange({ contact: { deliveryBlocked: true } });
    await worker.processDueEnrollments(new Date());
    assert.equal(enrollment.status, 'cancelled');
    assert.equal(enrollment.stopReason, 'delivery_blocked');
  });

  test('a 21610 during the send opts the contact out AND cancels the enrollment', async () => {
    const { enrollment, contact } = arrange();
    state.sendOutcome = () => {
      const err = new Error('unsubscribed');
      err.twilioCode = 21610;
      err.permanent = true;
      throw err;
    };
    const summary = await worker.processDueEnrollments(new Date());

    assert.equal(summary.blockedCompliance, 1);
    assert.equal(enrollment.status, 'cancelled');
    assert.equal(enrollment.stopReason, 'opted_out');
    assert.equal(contact.optedOut, true);
    assert.equal(contact.optOutSource, 'carrier');
    const event = state.eventsOfType('optout.received')[0];
    assert.ok(event);
    assert.equal(event.meta.twilioCode, 21610);
  });

  test('after a 21610 the contact’s OTHER enrollments are cancelled too', async () => {
    const campaignA = state.addCampaign();
    const campaignB = state.addCampaign();
    const contact = state.addContact();
    const enrA = state.addEnrollment({
      contact: contact._id,
      campaign: campaignA._id,
      currentStepId: campaignA.steps[0]._id,
      nextRunAt: new Date(Date.now() - 1000),
      lockedUntil: new Date(0),
    });
    const enrB = state.addEnrollment({
      contact: contact._id,
      campaign: campaignB._id,
      currentStepId: campaignB.steps[0]._id,
      nextRunAt: new Date(Date.now() + DAY),
      lockedUntil: new Date(0),
    });
    state.sendOutcome = () => {
      const err = new Error('unsubscribed');
      err.twilioCode = 21610;
      err.permanent = true;
      throw err;
    };
    await worker.processDueEnrollments(new Date());
    assert.equal(enrA.status, 'cancelled');
    assert.equal(enrB.status, 'cancelled', 'consent applies across every campaign');
  });

  test('a 21610 is never retried', async () => {
    const { enrollment } = arrange();
    state.sendOutcome = () => {
      const err = new Error('unsubscribed');
      err.twilioCode = 21610;
      err.permanent = true;
      throw err;
    };
    await worker.processDueEnrollments(new Date());
    const before = state.sendCalls.length;
    await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls.length, before, 'a cancelled enrollment must not be picked up again');
    assert.equal(enrollment.status, 'cancelled');
  });
});

describe('Stage 6G — sending window inside the pass', () => {
  const window = { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' };

  test('inside the window, the send proceeds', async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
    arrange();
    const summary = await worker.processDueEnrollments(new Date('2026-07-01T12:00:00Z'));
    assert.equal(summary.sent, 1);
  });

  test('BEFORE the window the row is deferred, not sent', async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
    const { enrollment } = arrange();
    const now = new Date('2026-07-01T03:00:00Z');
    const summary = await worker.processDueEnrollments(now);

    assert.equal(summary.skippedWindow, 1);
    assert.equal(summary.sent, 0);
    assert.equal(state.sendCalls.length, 0);
    assert.equal(
      new Date(enrollment.nextRunAt).toISOString(),
      '2026-07-01T09:00:00.000Z',
      'a deferred row must be pushed to the window opening, not left due every minute'
    );
  });

  test('AFTER the window the row rolls to the next morning', async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
    const { enrollment } = arrange();
    await worker.processDueEnrollments(new Date('2026-07-01T20:00:00Z'));
    assert.equal(new Date(enrollment.nextRunAt).toISOString(), '2026-07-02T09:00:00.000Z');
  });

  test('a disallowed SEND DAY defers the row', async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [1, 2, 3, 4, 5] });
    const { enrollment } = arrange();
    // 2026-07-05 is a Sunday.
    const summary = await worker.processDueEnrollments(new Date('2026-07-05T12:00:00Z'));
    assert.equal(summary.skippedWindow, 1);
    assert.equal(worker.weekdayInTimezone(new Date(enrollment.nextRunAt), 'UTC'), 1);
  });

  test("the CONTACT's timezone is used when they have one", async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
    // 16:00 UTC is outside a 9-18 UTC window? No - it is inside. Use 23:00 UTC,
    // which is outside in UTC but 09:00 in Asia/Tokyo (UTC+9) the next day.
    arrange({ contact: { timezone: 'Asia/Tokyo' } });
    const summary = await worker.processDueEnrollments(new Date('2026-07-01T00:30:00Z'));
    assert.equal(summary.sent, 1, '09:30 Tokyo time is inside the window');
    assert.equal(summary.skippedWindow, 0);
  });

  test("the contact's timezone can also BLOCK a send that UTC would allow", async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
    arrange({ contact: { timezone: 'Asia/Tokyo' } });
    // 12:00 UTC = 21:00 Tokyo, outside 9-18.
    const summary = await worker.processDueEnrollments(new Date('2026-07-01T12:00:00Z'));
    assert.equal(summary.skippedWindow, 1);
    assert.equal(state.sendCalls.length, 0);
  });

  test('an ENROLLMENT timezone overrides the contact timezone', async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
    arrange({ contact: { timezone: 'Asia/Tokyo' }, enrollment: { timezone: 'UTC' } });
    const summary = await worker.processDueEnrollments(new Date('2026-07-01T12:00:00Z'));
    assert.equal(summary.sent, 1, 'the enrollment override must win');
  });

  test('ignoreWindow bypasses the window for a manual run', async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
    arrange();
    const summary = await worker.processDueEnrollments(new Date('2026-07-01T03:00:00Z'), {
      ignoreWindow: true,
    });
    assert.equal(summary.sent, 1);
    assert.equal(summary.skippedWindow, 0);
  });

  test('ignoreWindow does NOT bypass consent', async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
    const { enrollment } = arrange({ contact: { optedOut: true } });
    const summary = await worker.processDueEnrollments(new Date('2026-07-01T03:00:00Z'), {
      ignoreWindow: true,
    });
    assert.equal(summary.sent, 0);
    assert.equal(summary.blockedCompliance, 1);
    assert.equal(enrollment.status, 'cancelled');
  });

  test('an INVALID contact timezone permits the send rather than stranding it', async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
    arrange({ contact: { timezone: 'Mars/Olympus_Mons' } });
    const summary = await worker.processDueEnrollments(new Date('2026-07-01T03:00:00Z'));
    assert.equal(summary.sent, 1);
  });
});

describe('Stage 6I — per-run send budget', () => {
  function arrangeMany(count) {
    const campaign = state.addCampaign();
    for (let i = 0; i < count; i += 1) {
      const contact = state.addContact();
      state.addEnrollment({
        contact: contact._id,
        campaign: campaign._id,
        currentStepId: campaign.steps[0]._id,
        nextRunAt: new Date(Date.now() - (count - i) * 1000),
        lockedUntil: new Date(0),
      });
    }
    return campaign;
  }

  test('the environment budget caps how many enrollments a pass considers', async () => {
    state.settings = f.settings({ maxSendsPerRun: null, sendingWindow: { enabled: false } });
    arrangeMany(30);
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.considered, config.automation.maxSendsPerRun);
    assert.equal(state.sendCalls.length, config.automation.maxSendsPerRun);
  });

  test('a configured budget OVERRIDES the environment value', async () => {
    state.settings = f.settings({ maxSendsPerRun: 3, sendingWindow: { enabled: false } });
    arrangeMany(10);
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.considered, 3);
    assert.equal(state.sendCalls.length, 3);
  });

  test('a configured budget of 1 is honoured exactly (?? not ||)', async () => {
    state.settings = f.settings({ maxSendsPerRun: 1, sendingWindow: { enabled: false } });
    arrangeMany(5);
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.considered, 1);
  });

  test('due enrollments are processed oldest-first', async () => {
    state.settings = f.settings({ maxSendsPerRun: 2, sendingWindow: { enabled: false } });
    arrangeMany(5);
    const oldest = [...state.enrollments]
      .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt))
      .slice(0, 2)
      .map((e) => String(e.contact));
    await worker.processDueEnrollments(new Date());
    const sentTo = state.sendCalls.map((c) => c.to);
    for (const contactId of oldest) {
      assert.ok(
        sentTo.includes(state.contacts.get(contactId).phone),
        'the oldest due rows should be the ones processed'
      );
    }
  });

  // DEFECT-3 regression. maxSendsPerRun is documented as a per-RUN throttle, but
  // the campaign pass and the follow-up pass each read it independently, so one
  // cron tick could send up to 2x the configured cap. runTick is the unit that
  // owns the budget, so it is what these tests drive.
  describe('one cron tick shares a single budget across both passes (DEFECT-3)', () => {
    function arrangeBothPasses(enrollments, recipients) {
      arrangeMany(enrollments);
      const contacts = [];
      for (let i = 0; i < recipients; i += 1) contacts.push(state.addContact());
      if (recipients > 0) {
        state.addFollowing({
          contactIds: contacts.map((c) => c._id),
          recipients: contacts.map((c) => ({ contact: c._id, status: 'pending', attempts: 0 })),
          nextRunAt: new Date(0),
          activatedAt: new Date(0),
        });
      }
    }

    test('ONE tick must not exceed the configured budget across BOTH passes', async () => {
      state.settings = f.settings({ maxSendsPerRun: 2, sendingWindow: { enabled: false } });
      arrangeBothPasses(2, 2);

      await worker.runTick(new Date());

      assert.equal(
        state.sendCalls.length,
        2,
        `maxSendsPerRun=2 but one tick sent ${state.sendCalls.length} messages`
      );
    });

    test('the enrollment pass is served first; the follow-up pass gets the remainder', async () => {
      state.settings = f.settings({ maxSendsPerRun: 3, sendingWindow: { enabled: false } });
      arrangeBothPasses(2, 5);

      const result = await worker.runTick(new Date());

      assert.equal(result.enrollments.sent, 2, 'both due enrollments are served');
      assert.equal(result.followings.sent, 1, 'only the leftover budget is spent on follow-ups');
      assert.equal(state.sendCalls.length, 3);
    });

    test('an enrollment pass that uses the whole budget leaves the follow-up pass none', async () => {
      state.settings = f.settings({ maxSendsPerRun: 2, sendingWindow: { enabled: false } });
      arrangeBothPasses(5, 5);

      const result = await worker.runTick(new Date());

      assert.equal(result.enrollments.sent, 2);
      assert.equal(result.followings.sent, 0, 'the budget was already spent');
      assert.equal(state.sendCalls.length, 2);
    });

    test('with no due enrollments the follow-up pass may spend the full budget', async () => {
      state.settings = f.settings({ maxSendsPerRun: 3, sendingWindow: { enabled: false } });
      arrangeBothPasses(0, 5);

      const result = await worker.runTick(new Date());

      assert.equal(result.followings.sent, 3);
      assert.equal(state.sendCalls.length, 3);
    });

    test('the tick takes the global lease and releases it afterwards', async () => {
      state.settings = f.settings({ maxSendsPerRun: 5, sendingWindow: { enabled: false } });
      arrangeBothPasses(1, 0);

      const result = await worker.runTick(new Date());
      assert.equal(result.heldLease, true);

      // Released, so the next tick (possibly another instance) can take it.
      const WorkerLock = require('../../models/WorkerLock');
      assert.equal(await WorkerLock.acquire('automation', 'another@instance', 60_000), true);
    });

    test('a tick that does NOT win the lease does no work at all', async () => {
      state.settings = f.settings({ maxSendsPerRun: 5, sendingWindow: { enabled: false } });
      arrangeBothPasses(2, 2);

      const WorkerLock = require('../../models/WorkerLock');
      await WorkerLock.acquire('automation', 'someone-else@instance', 60_000);

      const result = await worker.runTick(new Date());
      assert.equal(result.heldLease, false);
      assert.equal(result.enrollments, null);
      assert.equal(result.followings, null);
      assert.equal(state.sendCalls.length, 0, 'the losing instance must send nothing');
    });

    test('a DIRECT admin follow-up run still gets its own full budget (documented)', async () => {
      // "Run follow-ups now" is a separate operator action, not one cron tick.
      state.settings = f.settings({ maxSendsPerRun: 3, sendingWindow: { enabled: false } });
      arrangeBothPasses(0, 5);
      const summary = await worker.processDueFollowings(new Date());
      assert.equal(summary.sent, 3);
    });

    // A pass that never ran spent nothing, so it must not reduce the follow-up
    // pass's allowance. The first version of this fix read a `budget` the
    // skipped summary does not carry and silently handed follow-ups zero.
    describe('a SKIPPED enrollment pass must not starve follow-ups', () => {
      // Holds an enrollment pass open inside the Twilio call so the tick's own
      // pass finds `isRunning` already true and returns `skipped`.
      async function withEnrollmentPassInFlight(run) {
        let release;
        const held = new Promise((resolve) => {
          release = resolve;
        });
        const normalSend = state.sendOutcome;
        let first = true;
        state.sendOutcome = async (args) => {
          if (first) {
            first = false;
            await held;
          }
          return normalSend(args);
        };

        const inFlight = worker.processDueEnrollments(new Date());
        await new Promise((r) => setImmediate(r)); // let it take the guard
        try {
          return await run();
        } finally {
          release();
          await inFlight;
        }
      }

      test('the tick reports the enrollment pass as skipped', async () => {
        state.settings = f.settings({ maxSendsPerRun: 3, sendingWindow: { enabled: false } });
        arrangeBothPasses(1, 3);

        const result = await withEnrollmentPassInFlight(() => worker.runTick(new Date()));
        assert.equal(result.enrollments.skipped, true);
      });

      test('the FULL budget remains available, and the follow-up pass uses it', async () => {
        state.settings = f.settings({ maxSendsPerRun: 3, sendingWindow: { enabled: false } });
        arrangeBothPasses(1, 5);

        const result = await withEnrollmentPassInFlight(() => worker.runTick(new Date()));

        assert.equal(result.enrollments.skipped, true);
        assert.equal(result.followings.sent, 3, 'follow-ups must get the whole untouched budget');
      });

      test('the follow-up pass is still capped — a skip grants the budget, not an exemption', async () => {
        state.settings = f.settings({ maxSendsPerRun: 2, sendingWindow: { enabled: false } });
        arrangeBothPasses(1, 10);

        const result = await withEnrollmentPassInFlight(() => worker.runTick(new Date()));
        assert.equal(result.followings.sent, 2);
      });

      test('no enrollment is processed twice by the skipped tick', async () => {
        state.settings = f.settings({ maxSendsPerRun: 5, sendingWindow: { enabled: false } });
        arrangeBothPasses(1, 0);

        await withEnrollmentPassInFlight(() => worker.runTick(new Date()));

        // One enrollment and no follow-ups: the in-flight pass sent it once, and
        // the skipped tick must not have sent it again.
        assert.equal(state.sendCalls.length, 1, 'the overlapping tick must not duplicate a send');
        assert.equal(state.enrollments[0].sentSteps.length, 1);
        assert.equal(state.enrollments[0].status, 'completed');
      });
    });

    test('sending disabled leaves the budget unresolved without starving the follow-up pass', async () => {
      // runPass returns before it resolves a budget when smsEnabled is false.
      // The follow-up pass must not be handed 0 as though the budget were spent;
      // it independently refuses to send because the same switch is off.
      state.settings = f.settings({
        smsEnabled: false,
        maxSendsPerRun: 3,
        sendingWindow: { enabled: false },
      });
      arrangeBothPasses(2, 2);

      const result = await worker.runTick(new Date());

      assert.equal(result.enrollments.smsDisabled, true);
      assert.equal(result.followings.smsDisabled, true);
      assert.equal(state.sendCalls.length, 0, 'the master switch stops both passes');
    });
  });
});
