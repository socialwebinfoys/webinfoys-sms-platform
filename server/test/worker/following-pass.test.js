// Phase 10 — Stage 6H and Stage 4 consent inside the follow-up pass.
//
// TIMEZONE (Phase 10 decision): Contact.timezone is documented on the model as
// "optional IANA timezone for this contact, so automation can send inside their
// local hours. The worker resolves enrollment tz -> contact tz -> the global
// sending-window tz." The sending window exists for quiet-hour (TCPA) compliance,
// which does not distinguish a campaign step from a follow-up. The follow-up pass
// is therefore expected to honour the contact's timezone, exactly as the campaign
// pass does. See DEFECT-4.
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
  state.settings = f.settings({ sendingWindow: { enabled: false }, sendDays: [0, 1, 2, 3, 4, 5, 6] });
});

function arrangeFollowing({ contacts = 1, contactOverrides = {}, following = {} } = {}) {
  const made = [];
  for (let i = 0; i < contacts; i += 1) made.push(state.addContact(contactOverrides));
  const doc = state.addFollowing({
    contactIds: made.map((c) => c._id),
    recipients: made.map((c) => ({ contact: c._id, status: 'pending', attempts: 0, lastError: '' })),
    nextRunAt: new Date(0),
    activatedAt: new Date(0),
    ...following,
  });
  return { contacts: made, following: doc };
}

describe('a due follow-up sends to its pending recipients', () => {
  test('a single recipient is sent, recorded and marked sent', async () => {
    const { contacts: [contact], following } = arrangeFollowing();
    const summary = await worker.processDueFollowings(new Date());

    assert.equal(summary.sent, 1);
    assert.equal(state.sendCalls.length, 1);
    assert.equal(state.sendCalls[0].to, contact.phone);
    assert.equal(following.recipients[0].status, 'sent');
    assert.ok(following.recipients[0].twilioSid);
    assert.ok(following.recipients[0].sentAt instanceof Date);
    assert.equal(state.createdMessages[0].source, 'following');
    assert.equal(state.eventsOfType('following.sent').length, 1);
  });

  test('merge fields are rendered per recipient', async () => {
    const { following } = arrangeFollowing({ contactOverrides: { name: 'Grace Hopper' } });
    following.body = 'Hello {{first_name}}';
    await worker.processDueFollowings(new Date());
    assert.equal(state.sendCalls[0].body, 'Hello Grace Hopper');
  });

  test('the follow-up COMPLETES once no recipient is pending', async () => {
    const { following } = arrangeFollowing({ contacts: 2 });
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.sent, 2);
    assert.equal(summary.completed, 1);
    assert.equal(following.status, 'completed');
  });

  test('a DRAFT follow-up is never processed', async () => {
    arrangeFollowing({ following: { status: 'draft' } });
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.considered, 0);
    assert.equal(state.sendCalls.length, 0);
  });

  test('a PAUSED follow-up is never processed', async () => {
    arrangeFollowing({ following: { status: 'paused' } });
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.considered, 0);
    assert.equal(state.sendCalls.length, 0);
  });

  test('a follow-up not yet due is left alone', async () => {
    arrangeFollowing({ following: { nextRunAt: new Date(Date.now() + DAY) } });
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.considered, 0);
  });

  test('smsEnabled=false stops the pass before anything is sent', async () => {
    state.settings = f.settings({ smsEnabled: false, sendingWindow: { enabled: false } });
    arrangeFollowing();
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.smsDisabled, true);
    assert.equal(state.sendCalls.length, 0);
  });

  test('a deleted contact fails that recipient without affecting the others', async () => {
    const { contacts: [first], following } = arrangeFollowing({ contacts: 2 });
    state.contacts.delete(String(first._id));
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.failed, 1);
    assert.equal(summary.sent, 1);
    assert.equal(following.recipients[0].status, 'failed');
    assert.equal(following.recipients[1].status, 'sent');
  });

  test('a recipient already sent is never sent again (idempotency)', async () => {
    const { following } = arrangeFollowing();
    following.recipients[0].status = 'sent';
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(state.sendCalls.length, 0);
    assert.equal(summary.completed, 1, 'nothing pending means the follow-up is finished');
  });

  test('running the pass repeatedly sends each recipient exactly once', async () => {
    arrangeFollowing({ contacts: 3 });
    for (let i = 0; i < 4; i += 1) await worker.processDueFollowings(new Date());
    assert.equal(state.sendCalls.length, 3);
  });
});

describe('Stage 4 — consent inside the follow-up pass', () => {
  test('an OPTED-OUT recipient is SKIPPED, not failed and not retried', async () => {
    const { following } = arrangeFollowing({ contactOverrides: { optedOut: true } });
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.blockedCompliance, 1);
    assert.equal(following.recipients[0].status, 'skipped');
    assert.equal(following.recipients[0].lastError, 'opted_out');
    assert.equal(state.sendCalls.length, 0);
    assert.equal(state.createdMessages.length, 0);
    const event = state.eventsOfType('following.blocked')[0];
    assert.equal(event.meta.code, 'opted_out');
    assert.equal(event.meta.temporary, false);
  });

  test('an INACTIVE recipient is skipped', async () => {
    const { following } = arrangeFollowing({ contactOverrides: { isActive: false } });
    await worker.processDueFollowings(new Date());
    assert.equal(following.recipients[0].status, 'skipped');
    assert.equal(following.recipients[0].lastError, 'inactive');
  });

  test('a DELIVERY-BLOCKED recipient is skipped', async () => {
    const { following } = arrangeFollowing({ contactOverrides: { deliveryBlocked: true } });
    await worker.processDueFollowings(new Date());
    assert.equal(following.recipients[0].status, 'skipped');
    assert.equal(following.recipients[0].lastError, 'delivery_blocked');
  });

  test('a recipient who REPLIED after activation is skipped when stopOnReply is on', async () => {
    const { following } = arrangeFollowing({
      contactOverrides: { lastInboundAt: new Date() },
      following: { activatedAt: new Date(Date.now() - DAY), stopOnReply: true },
    });
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.skippedReplied, 1);
    assert.equal(following.recipients[0].status, 'skipped');
    assert.equal(following.recipients[0].lastError, 'replied');
    assert.equal(state.sendCalls.length, 0);
  });

  test('a reply BEFORE activation does not skip the recipient', async () => {
    arrangeFollowing({
      contactOverrides: { lastInboundAt: new Date(Date.now() - 2 * DAY) },
      following: { activatedAt: new Date(Date.now() - DAY) },
    });
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.sent, 1);
  });

  test('stopOnReply=false sends anyway', async () => {
    arrangeFollowing({
      contactOverrides: { lastInboundAt: new Date() },
      following: { activatedAt: new Date(Date.now() - DAY), stopOnReply: false },
    });
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.sent, 1);
    assert.equal(summary.skippedReplied, 0);
  });

  test('a LEGACY follow-up with no stopOnReply field defaults to stopping', async () => {
    const { following } = arrangeFollowing({
      contactOverrides: { lastInboundAt: new Date() },
      following: { activatedAt: new Date(Date.now() - DAY) },
    });
    delete following.stopOnReply;
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.skippedReplied, 1, 'only an explicit false may opt out of stop-on-reply');
  });

  test('a 21610 marks the recipient failed AND opts the contact out', async () => {
    const { contacts: [contact], following } = arrangeFollowing();
    state.sendOutcome = () => {
      const err = new Error('unsubscribed');
      err.twilioCode = 21610;
      err.permanent = true;
      throw err;
    };
    const summary = await worker.processDueFollowings(new Date());

    assert.equal(summary.blockedCompliance, 1);
    assert.equal(following.recipients[0].status, 'failed');
    assert.equal(following.recipients[0].lastError, 'opted_out (carrier)');
    assert.equal(contact.optedOut, true);
    assert.equal(contact.optOutSource, 'carrier');
    const event = state.eventsOfType('optout.received')[0];
    assert.ok(event);
    assert.equal(event.meta.twilioCode, 21610);
  });

  test('the carrier opt-out is applied AFTER the document is saved, so recipient state survives', async () => {
    const { contacts: [contact], following } = arrangeFollowing({ contacts: 2 });
    state.sendOutcome = () => {
      const err = new Error('unsubscribed');
      err.twilioCode = 21610;
      err.permanent = true;
      throw err;
    };
    await worker.processDueFollowings(new Date());
    // Both recipients hit 21610; their recorded state must not be clobbered by
    // applyOptOut writing to the same document.
    assert.equal(following.recipients[0].status, 'failed');
    assert.equal(following.recipients[1].status, 'failed');
    assert.equal(contact.optedOut, true);
  });

  test('a DEFINITIVE line-type block fails the recipient', async () => {
    state.settings = f.settings({
      allowedLineTypes: ['mobile'],
      sendingWindow: { enabled: false },
    });
    const { following } = arrangeFollowing({
      contactOverrides: {
        lookup: { status: 'valid', type: 'landline', lookedUpAt: new Date(Date.now() - DAY) },
      },
    });
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.blockedNonMobile, 1);
    assert.equal(following.recipients[0].status, 'failed');
    assert.equal(state.sendCalls.length, 0);
  });

  test('a TEMPORARY lookup failure backs the follow-up off instead of retrying every tick', async () => {
    state.settings = f.settings({
      allowedLineTypes: ['mobile'],
      sendingWindow: { enabled: false },
    });
    const { following } = arrangeFollowing();
    state.contacts.get(String(following.recipients[0].contact)).lookup = {
      status: 'unknown',
      type: '',
      lookedUpAt: undefined,
    };
    state.lookupResult = async () => {
      throw new Error('Lookup unavailable');
    };
    const now = new Date();
    await worker.processDueFollowings(now);

    assert.equal(following.recipients[0].status, 'pending', 'it stays pending for a later attempt');
    assert.equal(following.recipients[0].attempts, 1);
    assert.ok(
      new Date(following.nextRunAt).getTime() >= now.getTime() + config.automation.retryBackoffMinutes * MIN,
      'the follow-up must be pushed into the future, not retried next minute'
    );
  });

  test('reaching maxRetries fails the recipient', async () => {
    const { following } = arrangeFollowing();
    following.recipients[0].attempts = config.automation.maxRetries - 1;
    state.sendOutcome = () => {
      const err = new Error('transient');
      err.twilioCode = 20429;
      throw err;
    };
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.failed, 1);
    assert.equal(following.recipients[0].status, 'failed');
  });

  test('a PERMANENT Twilio error fails the recipient at once', async () => {
    const { following } = arrangeFollowing();
    state.sendOutcome = () => {
      const err = new Error('invalid number');
      err.twilioCode = 21211;
      err.permanent = true;
      throw err;
    };
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.failed, 1);
    assert.equal(following.recipients[0].status, 'failed');
    assert.equal(following.recipients[0].attempts, 1);
  });
});

describe('Stage 6G — sending window in the follow-up pass', () => {
  const window = { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' };

  test('inside the global window the follow-up sends', async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
    arrangeFollowing();
    const summary = await worker.processDueFollowings(new Date('2026-07-01T12:00:00Z'));
    assert.equal(summary.sent, 1);
  });

  test('outside the global window the follow-up is deferred to the next opening', async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
    const { following } = arrangeFollowing();
    const summary = await worker.processDueFollowings(new Date('2026-07-01T03:00:00Z'));
    assert.equal(summary.skippedWindow, 1);
    assert.equal(state.sendCalls.length, 0);
    assert.equal(new Date(following.nextRunAt).toISOString(), '2026-07-01T09:00:00.000Z');
  });

  test('a disallowed send day defers the follow-up', async () => {
    state.settings = f.settings({ sendingWindow: window, sendDays: [1, 2, 3, 4, 5] });
    const { following } = arrangeFollowing();
    const summary = await worker.processDueFollowings(new Date('2026-07-05T12:00:00Z')); // Sunday
    assert.equal(summary.skippedWindow, 1);
    assert.equal(worker.weekdayInTimezone(new Date(following.nextRunAt), 'UTC'), 1);
  });

  // --- DEFECT-4: the follow-up pass must honour the contact's timezone -----
  describe("contact timezone in the follow-up pass (DEFECT-4 regression)", () => {
    test("a recipient whose LOCAL time is outside the window is NOT messaged", async () => {
      state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
      // 12:00 UTC is inside 9-18 UTC, but it is 21:00 in Tokyo — quiet hours.
      arrangeFollowing({ contactOverrides: { timezone: 'Asia/Tokyo' } });
      const summary = await worker.processDueFollowings(new Date('2026-07-01T12:00:00Z'));
      assert.equal(
        state.sendCalls.length,
        0,
        'a follow-up must respect the recipient’s local quiet hours, like a campaign step does'
      );
      assert.equal(summary.sent, 0);
    });

    test('a recipient whose local time IS inside the window is messaged', async () => {
      state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
      // 00:30 UTC = 09:30 Tokyo: inside the window locally, outside it in UTC.
      arrangeFollowing({ contactOverrides: { timezone: 'Asia/Tokyo' } });
      const summary = await worker.processDueFollowings(new Date('2026-07-01T00:30:00Z'));
      assert.equal(summary.sent, 1, 'the recipient’s own local hours should permit this');
    });

    test('a recipient with NO timezone falls back to the global window', async () => {
      state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
      arrangeFollowing({ contactOverrides: { timezone: '' } });
      const summary = await worker.processDueFollowings(new Date('2026-07-01T12:00:00Z'));
      assert.equal(summary.sent, 1);
    });

    test('an invalid contact timezone permits the send rather than stranding it', async () => {
      state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
      arrangeFollowing({ contactOverrides: { timezone: 'Mars/Olympus_Mons' } });
      const summary = await worker.processDueFollowings(new Date('2026-07-01T03:00:00Z'));
      assert.equal(summary.sent, 1);
    });

    test('recipients in different zones are handled independently within one follow-up', async () => {
      state.settings = f.settings({ sendingWindow: window, sendDays: [0, 1, 2, 3, 4, 5, 6] });
      const tokyo = state.addContact({ timezone: 'Asia/Tokyo' });
      const london = state.addContact({ timezone: 'Europe/London' });
      const following = state.addFollowing({
        contactIds: [tokyo._id, london._id],
        recipients: [
          { contact: tokyo._id, status: 'pending', attempts: 0 },
          { contact: london._id, status: 'pending', attempts: 0 },
        ],
        nextRunAt: new Date(0),
        activatedAt: new Date(0),
      });
      // 12:00 UTC = 21:00 Tokyo (quiet) and 13:00 London (fine).
      await worker.processDueFollowings(new Date('2026-07-01T12:00:00Z'));

      const tokyoRecipient = following.recipients.find((r) => String(r.contact) === String(tokyo._id));
      const londonRecipient = following.recipients.find((r) => String(r.contact) === String(london._id));
      assert.equal(londonRecipient.status, 'sent', 'the London recipient is inside their local hours');
      assert.equal(
        tokyoRecipient.status,
        'pending',
        'the Tokyo recipient must wait for their own local window'
      );
    });
  });
});
