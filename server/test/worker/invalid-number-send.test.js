// A number Twilio Lookup DEFINITIVELY reported invalid is never sent to by the
// automation worker — campaign steps and follow-ups alike — whatever the
// line-type filter is set to, and even when the enrollment or follow-up was
// created before the number was found invalid.
//
// The real worker and the real send policy run; Twilio and Lookup are the
// workerEnv doubles, so nothing is sent and nothing is looked up for real.
'use strict';

require('../_support/env');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupWorkerEnv } = require('../_support/workerEnv');
const f = require('../_support/factories');

const state = setupWorkerEnv();
const worker = require('../../jobs/automationWorker');
const { config } = require('../../config/env');

const DAY = 24 * 60 * 60 * 1000;
const ALL_TYPES = ['mobile', 'landline', 'fixedVoip', 'nonFixedVoip', 'tollFree', 'unknown'];
const quiet = { sendingWindow: { enabled: false }, sendDays: [0, 1, 2, 3, 4, 5, 6] };

// The line-type settings under which an invalid number used to get through
// (the first two), plus the one that already blocked it.
const POLICIES = {
  'mobileOnly=false (the default)': { mobileOnly: false },
  'every line type allowed': { allowedLineTypes: [...ALL_TYPES] },
  'mobile only': { allowedLineTypes: ['mobile'] },
};

const INVALID = () => ({ status: 'invalid', type: '', carrier: '', lookedUpAt: new Date(), lastError: '' });
// Everything that is NOT a definitive invalid result.
const NOT_INVALID = {
  'not checked': { status: 'unknown', type: '', lastError: '' },
  'a failed lookup attempt': { status: 'unknown', type: '', lastError: 'Lookup failed: Twilio 503', lastAttemptAt: new Date() },
  'valid but unclassifiable (Unknown)': { status: 'valid', type: '', lookedUpAt: new Date(Date.now() - DAY) },
  landline: { status: 'valid', type: 'landline', lookedUpAt: new Date(Date.now() - DAY) },
  VoIP: { status: 'valid', type: 'nonFixedVoip', lookedUpAt: new Date(Date.now() - DAY) },
};

beforeEach(() => {
  state.reset();
  state.settings = f.settings(quiet);
});

const twoSteps = () => [
  { _id: f.oid(), body: 'one', delayValue: 0, delayUnit: 'hours' },
  { _id: f.oid(), body: 'two', delayValue: 0, delayUnit: 'hours' },
];

function arrangeEnrollment({ contact = {}, steps, enrollment = {} } = {}) {
  const camp = state.addCampaign({ steps });
  const cont = state.addContact(contact);
  const enr = state.addEnrollment({
    contact: cont._id,
    campaign: camp._id,
    currentStepId: camp.steps[0]._id,
    currentStepIndex: 0,
    nextRunAt: new Date(0),
    lockedUntil: new Date(0),
    ...enrollment,
  });
  return { campaign: camp, contact: cont, enrollment: enr };
}

function arrangeFollowing(contactOverrides = [{}]) {
  const made = contactOverrides.map((o) => state.addContact(o));
  const following = state.addFollowing({
    contactIds: made.map((c) => c._id),
    recipients: made.map((c) => ({ contact: c._id, status: 'pending', attempts: 0, lastError: '' })),
    nextRunAt: new Date(0),
    activatedAt: new Date(0),
  });
  return { contacts: made, following };
}

// ===========================================================================
describe('campaign automation never sends to an invalid number', () => {
  for (const [label, policy] of Object.entries(POLICIES)) {
    test(`blocked with ${label}`, async () => {
      state.settings = f.settings({ ...quiet, ...policy });
      const { enrollment } = arrangeEnrollment({ contact: { lookup: INVALID() } });

      const summary = await worker.processDueEnrollments(new Date());

      assert.equal(state.sendCalls.length, 0, 'nothing may reach Twilio');
      assert.equal(state.createdMessages.length, 0, 'no message record for a send that never happened');
      assert.equal(state.conversations.length, 0, 'no Inbox thread is opened for it');
      assert.deepEqual(state.lookupCalls, [], 'the cached result is used; no billable Lookup');
      assert.equal(summary.sent, 0);
      assert.equal(enrollment.status, 'cancelled');
      assert.equal(enrollment.stopReason, 'invalid_number');
      assert.match(enrollment.lastError, /invalid/i);
      assert.equal(enrollment.sentSteps.length, 0);
      const event = state.eventsOfType('automation.blocked')[0];
      assert.ok(event, 'the block is logged');
      assert.equal(event.meta.code, 'invalid_number');
      assert.equal(event.meta.temporary, false);
    });
  }

  test('an ACTIVE enrollment stops as soon as Lookup marks its contact invalid', async () => {
    // Enrolled and partly sent while the number was a valid mobile.
    const { contact, enrollment } = arrangeEnrollment({ steps: twoSteps() });
    await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls.length, 1, 'step one went out while the number was valid');
    assert.equal(enrollment.status, 'active');

    // Lookup now reports it invalid.
    contact.lookup = INVALID();
    enrollment.nextRunAt = new Date(0);
    const summary = await worker.processDueEnrollments(new Date());

    assert.equal(state.sendCalls.length, 1, 'step two is never sent');
    assert.equal(summary.sent, 0);
    assert.equal(enrollment.status, 'cancelled');
    assert.equal(enrollment.stopReason, 'invalid_number');
    assert.equal(enrollment.sentSteps.length, 1, 'the history of what WAS sent is kept');
  });

  test('it is a definitive stop: no attempts are burned and later passes do nothing', async () => {
    const { enrollment } = arrangeEnrollment({ contact: { lookup: INVALID() } });
    await worker.processDueEnrollments(new Date());
    await worker.processDueEnrollments(new Date());
    await worker.processDueEnrollments(new Date());
    assert.equal(enrollment.attempts, 0);
    assert.equal(state.sendCalls.length, 0);
    assert.equal(state.eventsOfType('automation.blocked').length, 1, 'blocked once, not on every tick');
  });

  test('ignoreWindow (a manual run) does not bypass it', async () => {
    arrangeEnrollment({ contact: { lookup: INVALID() } });
    await worker.processDueEnrollments(new Date(), { ignoreWindow: true });
    assert.equal(state.sendCalls.length, 0);
  });

  test('only that contact is affected — a valid contact in the same pass is still sent', async () => {
    arrangeEnrollment({ contact: { lookup: INVALID(), phone: '+14155550001' } });
    const ok = arrangeEnrollment({ contact: { phone: '+14155550002' } });
    const summary = await worker.processDueEnrollments(new Date());
    assert.equal(summary.sent, 1);
    assert.deepEqual(state.sendCalls.map((c) => c.to), ['+14155550002']);
    assert.equal(ok.enrollment.status, 'completed');
  });

  for (const [label, lookup] of Object.entries(NOT_INVALID)) {
    test(`${label} is NOT treated as invalid: sent as before when the filter is off`, async () => {
      const { enrollment } = arrangeEnrollment({ contact: { lookup } });
      const summary = await worker.processDueEnrollments(new Date());
      assert.equal(summary.sent, 1);
      assert.equal(enrollment.status, 'completed');
      assert.deepEqual(state.lookupCalls, [], 'and still without a Lookup call');
    });
  }

  test('a TEMPORARY Lookup failure keeps its retry and backoff, and marks nothing invalid', async () => {
    state.settings = f.settings({ ...quiet, allowedLineTypes: ['mobile'] });
    state.lookupResult = async () => {
      throw new Error('Lookup failed: upstream');
    };
    const { contact, enrollment } = arrangeEnrollment({ contact: { lookup: NOT_INVALID['not checked'] } });
    const now = new Date();
    const summary = await worker.processDueEnrollments(now);

    assert.equal(summary.retried, 1);
    assert.equal(enrollment.status, 'active', 'still active: it will be retried');
    assert.equal(enrollment.attempts, 1);
    assert.equal(enrollment.stopReason, '');
    assert.equal(
      enrollment.nextRunAt.getTime(),
      now.getTime() + config.automation.retryBackoffMinutes * 60 * 1000,
      'the existing backoff'
    );
    assert.equal(contact.lookup.status, 'unknown', 'a failed lookup is never recorded as invalid');
    assert.equal(state.sendCalls.length, 0);
  });

  test('a number the send-time Lookup finds invalid is blocked then, and by the gate from then on', async () => {
    state.settings = f.settings({ ...quiet, allowedLineTypes: ['mobile'] });
    state.lookupResult = async () => ({ valid: false, phone: '+14155552671', type: '', lookedUpAt: new Date() });
    const first = arrangeEnrollment({ contact: { lookup: NOT_INVALID['not checked'] } });
    await worker.processDueEnrollments(new Date());
    assert.equal(first.enrollment.status, 'failed', 'the existing line-type outcome is unchanged');
    assert.equal(first.contact.lookup.status, 'invalid', 'and the result is cached');
    assert.equal(state.lookupCalls.length, 1);

    // A second enrollment for the same contact — even with the filter now off.
    state.settings = f.settings(quiet);
    const camp = state.addCampaign();
    const second = state.addEnrollment({
      contact: first.contact._id,
      campaign: camp._id,
      currentStepId: camp.steps[0]._id,
      nextRunAt: new Date(0),
      lockedUntil: new Date(0),
    });
    await worker.processDueEnrollments(new Date());
    assert.equal(second.status, 'cancelled');
    assert.equal(second.stopReason, 'invalid_number');
    assert.equal(state.sendCalls.length, 0);
    assert.equal(state.lookupCalls.length, 1, 'no second Lookup');
  });
});

// ===========================================================================
describe('follow-ups never send to an invalid number', () => {
  for (const [label, policy] of Object.entries(POLICIES)) {
    test(`an invalid recipient is skipped with ${label}`, async () => {
      state.settings = f.settings({ ...quiet, ...policy });
      const { following } = arrangeFollowing([{ lookup: INVALID() }]);

      const summary = await worker.processDueFollowings(new Date());

      assert.equal(state.sendCalls.length, 0);
      assert.equal(state.createdMessages.length, 0);
      assert.deepEqual(state.lookupCalls, []);
      assert.equal(summary.sent, 0);
      assert.equal(summary.blockedCompliance, 1);
      assert.equal(following.recipients[0].status, 'skipped');
      assert.equal(following.recipients[0].lastError, 'invalid_number');
      const event = state.eventsOfType('following.blocked')[0];
      assert.equal(event.meta.code, 'invalid_number');
    });
  }

  test('a follow-up created BEFORE the number was found invalid does not send to it', async () => {
    // Three recipients, all valid when the follow-up was created and activated.
    const { contacts, following } = arrangeFollowing([
      { phone: '+14155550001' },
      { phone: '+14155550002' },
      { phone: '+14155550003' },
    ]);
    // One has already been sent to; Lookup then reports the second invalid.
    following.recipients[0].status = 'sent';
    following.recipients[0].twilioSid = 'SMearlier';
    following.recipients[0].sentAt = new Date(Date.now() - DAY);
    contacts[1].lookup = INVALID();

    const summary = await worker.processDueFollowings(new Date());

    assert.deepEqual(state.sendCalls.map((c) => c.to), ['+14155550003'], 'only the still-valid pending recipient');
    assert.equal(summary.sent, 1);
    // Recipient history is preserved.
    assert.equal(following.recipients[0].status, 'sent');
    assert.equal(following.recipients[0].twilioSid, 'SMearlier');
    assert.equal(following.recipients[1].status, 'skipped');
    assert.equal(following.recipients[1].lastError, 'invalid_number');
    assert.equal(following.recipients[2].status, 'sent');
    assert.equal(following.status, 'completed', 'nothing is left pending');
  });

  test('the skip is permanent: no retry attempts, nothing on later passes', async () => {
    const { following } = arrangeFollowing([{ lookup: INVALID() }]);
    await worker.processDueFollowings(new Date());
    following.status = 'active';
    following.nextRunAt = new Date(0);
    await worker.processDueFollowings(new Date());
    assert.equal(following.recipients[0].attempts, 0);
    assert.equal(state.sendCalls.length, 0);
    assert.equal(state.eventsOfType('following.blocked').length, 1);
  });

  for (const [label, lookup] of Object.entries(NOT_INVALID)) {
    test(`${label} is NOT treated as invalid: sent as before when the filter is off`, async () => {
      const { following } = arrangeFollowing([{ lookup }]);
      const summary = await worker.processDueFollowings(new Date());
      assert.equal(summary.sent, 1);
      assert.equal(following.recipients[0].status, 'sent');
      assert.deepEqual(state.lookupCalls, []);
    });
  }

  test('a TEMPORARY Lookup failure keeps the recipient pending with a retry, not invalid', async () => {
    state.settings = f.settings({ ...quiet, allowedLineTypes: ['mobile'] });
    state.lookupResult = async () => {
      throw new Error('Lookup failed: upstream');
    };
    const { contacts, following } = arrangeFollowing([{ lookup: NOT_INVALID['not checked'] }]);
    await worker.processDueFollowings(new Date());
    assert.equal(following.recipients[0].status, 'pending');
    assert.equal(following.recipients[0].attempts, 1);
    assert.notEqual(following.recipients[0].lastError, 'invalid_number');
    assert.equal(contacts[0].lookup.status, 'unknown');
    assert.equal(following.status, 'active');
  });
});

// ===========================================================================
describe('what a valid contact gets is unchanged', () => {
  test('a campaign step is still sent, recorded and threaded into the Inbox', async () => {
    const { contact, enrollment } = arrangeEnrollment();
    await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls.length, 1);
    assert.equal(enrollment.status, 'completed');
    assert.equal(state.createdMessages[0].source, 'campaign');
    assert.equal(state.conversations.length, 1);
    assert.equal(String(state.conversations[0].contact), String(contact._id));
    assert.equal(state.conversations[0].lastMessageDirection, 'outbound');
    assert.equal(state.conversations[0].unreadCount, 0);
  });

  test('an opted-out contact is still cancelled as opted_out, not as invalid', async () => {
    const { enrollment } = arrangeEnrollment({ contact: { optedOut: true, lookup: INVALID() } });
    await worker.processDueEnrollments(new Date());
    assert.equal(enrollment.stopReason, 'opted_out');
  });
});
