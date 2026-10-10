// Merge fields in what the automation worker actually sends.
//
// Campaign steps (every step of a sequence) and follow-ups are rendered by the
// same resolver as the preview endpoint; these tests run the real worker and
// the real preview route and compare the two. Twilio and Lookup are doubles —
// nothing is sent and no number is looked up.
'use strict';

require('../_support/env');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupWorkerEnv } = require('../_support/workerEnv');
const { stubModule, fakeModel, query } = require('../_support/stubs');
const f = require('../_support/factories');

const state = setupWorkerEnv();
stubModule('models/AIReplyJob', fakeModel('AIReplyJob'));

// The preview route is authenticated.
const operator = f.user();
require('../../models/User').findById = (id) => query(String(id) === String(operator._id) ? operator : null);

const worker = require('../../jobs/automationWorker');
const { startApp, tokenFor } = require('../_support/http');

let api;
let token;
before(async () => {
  api = await startApp();
  token = tokenFor(operator);
});
after(async () => {
  await api.close();
});

beforeEach(() => {
  state.reset();
  state.settings = f.settings({ sendingWindow: { enabled: false }, sendDays: [0, 1, 2, 3, 4, 5, 6] });
});

const step = (body) => ({ _id: f.oid(), body, delayValue: 0, delayUnit: 'hours' });

function enroll(contact, steps) {
  const campaign = state.addCampaign({ steps });
  const enrollment = state.addEnrollment({
    contact: contact._id,
    campaign: campaign._id,
    currentStepId: campaign.steps[0]._id,
    currentStepIndex: 0,
    nextRunAt: new Date(0),
    lockedUntil: new Date(0),
  });
  return { campaign, enrollment };
}

// Run the worker until the enrollment has gone through every step.
async function runSequence(enrollment, steps) {
  for (let i = 0; i < steps.length; i += 1) {
    enrollment.nextRunAt = new Date(0);
    await worker.processDueEnrollments(new Date());
  }
}

function follow(contact, body) {
  return state.addFollowing({
    contactIds: [contact._id],
    recipients: [{ contact: contact._id, status: 'pending', attempts: 0, lastError: '' }],
    nextRunAt: new Date(0),
    activatedAt: new Date(0),
    body,
  });
}

const preview = async (body, contact) =>
  (await api.post('/api/templates/preview', { token, body: { body, contactId: String(contact._id) } })).body.rendered;

// ---------------------------------------------------------------------------
describe('campaign sequence — every step', () => {
  test('{{first_name}} and {{name}} resolve to the imported contact name in each step', async () => {
    const contact = state.addContact({ name: 'Austin City Dental', phone: '+15122345678' });
    const steps = [
      step('Hi {{first_name}}, quick question about your practice.'),
      step('Following up, {{name}} — did you see my note?'),
      step('Last one for {{First Name}} at {{phone}}.'),
    ];
    const { enrollment } = enroll(contact, steps);
    await runSequence(enrollment, steps);

    assert.deepEqual(state.sendCalls.map((c) => c.body), [
      'Hi Austin City Dental, quick question about your practice.',
      'Following up, Austin City Dental — did you see my note?',
      'Last one for Austin City Dental at +15122345678.',
    ]);
    assert.equal(enrollment.status, 'completed');
  });

  test('the stored message record is exactly what was sent', async () => {
    const contact = state.addContact({ name: 'Austin City Dental' });
    const steps = [step('Hi {{first_name}}!')];
    await runSequence(enroll(contact, steps).enrollment, steps);
    assert.equal(state.createdMessages[0].body, 'Hi Austin City Dental!');
    assert.equal(state.createdMessages[0].body, state.sendCalls[0].body);
  });

  test('custom fields from the import are still available in every step', async () => {
    const contact = state.addContact({ name: 'Austin City Dental', customFields: { city: 'Austin', 'Practice Type': 'Family' } });
    const steps = [step('{{name}} in {{city}}'), step('{{practice_type}} dentistry in {{City}}')];
    await runSequence(enroll(contact, steps).enrollment, steps);
    assert.deepEqual(state.sendCalls.map((c) => c.body), ['Austin City Dental in Austin', 'Family dentistry in Austin']);
  });

  test('a contact with NO name never receives a literal placeholder, in any step', async () => {
    const contact = state.addContact({ name: '' });
    const steps = [step('Hi {{first_name}}, are you open today?'), step('{{name}}, one more thing: call us.'), step('Bye {{First Name}}')];
    await runSequence(enroll(contact, steps).enrollment, steps);
    const bodies = state.sendCalls.map((c) => c.body);
    assert.deepEqual(bodies, ['Hi, are you open today?', 'one more thing: call us.', 'Bye']);
    assert.ok(bodies.every((b) => !b.includes('{{')));
  });

  test('a step with no merge fields is sent exactly as written', async () => {
    const contact = state.addContact({ name: 'Austin City Dental' });
    const body = 'Reply STOP to opt out.  Two  spaces , kept.';
    const steps = [step(body)];
    await runSequence(enroll(contact, steps).enrollment, steps);
    assert.equal(state.sendCalls[0].body, body);
  });

  test('two contacts in one pass each get their OWN name', async () => {
    const a = state.addContact({ name: 'Austin City Dental', phone: '+15122345601' });
    const b = state.addContact({ name: '', phone: '+15122345602' });
    const c = state.addContact({ name: 'Round Rock Smiles', phone: '+15122345603' });
    const steps = [step('Hi {{first_name}}!')];
    const campaign = state.addCampaign({ steps });
    for (const contact of [a, b, c]) {
      state.addEnrollment({ contact: contact._id, campaign: campaign._id, currentStepId: steps[0]._id, currentStepIndex: 0, nextRunAt: new Date(0), lockedUntil: new Date(0) });
    }
    await worker.processDueEnrollments(new Date());
    const byPhone = Object.fromEntries(state.sendCalls.map((s) => [s.to, s.body]));
    assert.deepEqual(byPhone, {
      '+15122345601': 'Hi Austin City Dental!',
      '+15122345602': 'Hi!',
      '+15122345603': 'Hi Round Rock Smiles!',
    });
  });
});

// ---------------------------------------------------------------------------
describe('follow-up', () => {
  test('{{first_name}} and {{name}} resolve to the contact name', async () => {
    const contact = state.addContact({ name: 'Austin City Dental' });
    follow(contact, 'Hi {{first_name}}, just checking in with {{name}}.');
    await worker.processDueFollowings(new Date());
    assert.equal(state.sendCalls[0].body, 'Hi Austin City Dental, just checking in with Austin City Dental.');
    assert.equal(state.createdMessages[0].body, state.sendCalls[0].body);
  });

  test('a contact with no name gets no literal placeholder', async () => {
    const contact = state.addContact({ name: '' });
    follow(contact, 'Hi {{first_name}}, just checking in.');
    await worker.processDueFollowings(new Date());
    assert.equal(state.sendCalls[0].body, 'Hi, just checking in.');
  });
});

// ---------------------------------------------------------------------------
describe('the preview is what gets sent', () => {
  const bodies = [
    'Hi {{first_name}}, is {{Name}} in {{city}} taking new patients?',
    'Hello {{ FIRST_NAME }} — {{unknown}} thanks',
    'No merge fields here.',
  ];

  for (const body of bodies) {
    test(JSON.stringify(body), async () => {
      const contact = state.addContact({ name: 'Austin City Dental', customFields: { city: 'Austin' } });
      const expected = await preview(body, contact);

      const steps = [step(body)];
      await runSequence(enroll(contact, steps).enrollment, steps);
      follow(contact, body);
      await worker.processDueFollowings(new Date());

      assert.equal(state.sendCalls.length, 2);
      assert.equal(state.sendCalls[0].body, expected, 'campaign step');
      assert.equal(state.sendCalls[1].body, expected, 'follow-up');
      assert.ok(!expected.includes('{{'));
    });
  }
});

describe('safety', () => {
  test('rendering never looks a number up and only ever calls the stubbed sender', async () => {
    const contact = state.addContact({ name: 'Austin City Dental' });
    const steps = [step('Hi {{first_name}}')];
    await runSequence(enroll(contact, steps).enrollment, steps);
    assert.equal(state.lookupCalls.length, 0, 'no billable Lookup');
    assert.equal(state.sendCalls.length, 1);
  });
});
