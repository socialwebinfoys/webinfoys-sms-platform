// Phase 10 — Stage 7: delivery receipt policy and status ranking.
'use strict';

require('../_support/env');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const Settings = require('../../models/Settings');
const deliveryPolicy = require('../../services/deliveryPolicy');
const { rankOf, STATUS_RANK } = require('../../controllers/webhookController');
const f = require('../_support/factories');
const { fakeDoc } = require('../_support/stubs');

let currentSettings;
Settings.getSingleton = async () => currentSettings;
beforeEach(() => {
  currentSettings = f.settings();
});

describe('status ranking — a receipt may only move a message FORWARD', () => {
  test('the lifecycle order is queued < sending < sent < delivered', () => {
    assert.ok(rankOf('queued') < rankOf('sending'));
    assert.ok(rankOf('sending') < rankOf('sent'));
    assert.ok(rankOf('sent') < rankOf('delivered'));
  });

  test('all three terminal states share the top rank', () => {
    assert.equal(rankOf('delivered'), rankOf('undelivered'));
    assert.equal(rankOf('undelivered'), rankOf('failed'));
    assert.equal(rankOf('failed'), rankOf('canceled'));
  });

  test('a simulated send ranks with sent, so a later real receipt can supersede it', () => {
    assert.equal(rankOf('simulated'), rankOf('sent'));
    assert.ok(rankOf('delivered') > rankOf('simulated'));
  });

  test('an unknown or empty status ranks 0, so legacy rows can always be advanced', () => {
    assert.equal(rankOf('nonsense'), 0);
    assert.equal(rankOf(''), 0);
    assert.equal(rankOf(undefined), 0);
    assert.equal(rankOf(null), 0);
  });

  test('ranking is case-insensitive', () => {
    assert.equal(rankOf('DELIVERED'), rankOf('delivered'));
    assert.equal(rankOf('Sent'), rankOf('sent'));
  });

  test('equal ranks are NOT strictly higher, which is what makes duplicates no-ops', () => {
    // The controller applies an update only when newRank is strictly greater
    // than the stored rank, so delivered-after-delivered changes nothing.
    assert.equal(rankOf('delivered') > rankOf('delivered'), false);
    assert.equal(rankOf('failed') > rankOf('delivered'), false);
  });

  test('every documented Twilio status is ranked', () => {
    for (const s of ['queued', 'accepted', 'scheduled', 'sending', 'sent', 'receiving',
      'delivered', 'undelivered', 'failed', 'canceled', 'simulated']) {
      assert.ok(STATUS_RANK[s] > 0, `${s} should be ranked`);
    }
  });
});

describe('error-code classification', () => {
  test('21610 is an opt-out signal, not a delivery failure', () => {
    assert.equal(deliveryPolicy.isOptOutCode(21610), true);
    assert.equal(deliveryPolicy.isOptOutCode('21610'), true);
    assert.equal(deliveryPolicy.isPermanentCode(21610), false,
      '21610 must NOT be treated as a deliverability block');
  });

  test('30005 and 30006 are permanent', () => {
    assert.equal(deliveryPolicy.isPermanentCode(30005), true);
    assert.equal(deliveryPolicy.isPermanentCode(30006), true);
  });

  test('a single transient code is NOT permanent', () => {
    for (const code of [30001, 30002, 30003, 30004, 30007, 30008, 30009, 30010]) {
      assert.equal(deliveryPolicy.isPermanentCode(code), false, `${code} should be transient`);
    }
  });

  test('an unknown code is not permanent (fail open on classification, not on sending)', () => {
    assert.equal(deliveryPolicy.isPermanentCode(99999), false);
    assert.equal(deliveryPolicy.isPermanentCode(undefined), false);
  });

  test('describeCode gives plain English for known codes and a fallback otherwise', () => {
    assert.match(deliveryPolicy.describeCode(30005), /does not exist/);
    assert.match(deliveryPolicy.describeCode(21610), /unsubscribed/i);
    assert.equal(deliveryPolicy.describeCode(424242), 'Twilio error 424242');
    assert.equal(deliveryPolicy.describeCode(undefined), '');
    assert.equal(deliveryPolicy.describeCode(null), '');
    assert.equal(deliveryPolicy.describeCode(''), '');
  });

  test('being listed in CODE_MEANINGS does not make a code permanent', () => {
    assert.ok(deliveryPolicy.CODE_MEANINGS[30003], '30003 is documented');
    assert.equal(deliveryPolicy.isPermanentCode(30003), false);
  });
});

describe('recordFailure — consecutive failures and the block threshold', () => {
  test('a permanent code blocks on the FIRST receipt', async () => {
    const contact = fakeDoc(f.contact());
    const outcome = await deliveryPolicy.recordFailure(contact, 'undelivered', 30005);
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.permanent, true);
    assert.equal(outcome.failureCount, 1);
    assert.equal(contact.deliveryBlocked, true);
    assert.ok(contact.deliveryBlockedAt instanceof Date);
    assert.equal(contact.__saves, 1);
  });

  test('a single transient failure does NOT block (why one 30003 is harmless)', async () => {
    const contact = fakeDoc(f.contact());
    const outcome = await deliveryPolicy.recordFailure(contact, 'undelivered', 30003);
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.failureCount, 1);
    assert.equal(contact.deliveryBlocked, false);
  });

  test('transient failures block exactly at the configured threshold', async () => {
    const contact = fakeDoc(f.contact());
    const first = await deliveryPolicy.recordFailure(contact, 'undelivered', 30003);
    const second = await deliveryPolicy.recordFailure(contact, 'undelivered', 30003);
    const third = await deliveryPolicy.recordFailure(contact, 'undelivered', 30003);
    assert.equal(first.blocked, false);
    assert.equal(second.blocked, false);
    assert.equal(third.blocked, true);
    assert.equal(third.failureCount, 3);
    assert.equal(third.threshold, 3);
    assert.match(third.reason, /3 consecutive delivery failures/);
  });

  test('a configured threshold is honoured exactly (?? not ||)', async () => {
    currentSettings = f.settings({ deliveryFailureThreshold: 1 });
    const contact = fakeDoc(f.contact());
    const outcome = await deliveryPolicy.recordFailure(contact, 'failed', 30003);
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.threshold, 1);
  });

  test('a legacy contact with no counter is treated as zero', async () => {
    const legacy = fakeDoc(f.contact());
    delete legacy.deliveryFailureCount;
    const outcome = await deliveryPolicy.recordFailure(legacy, 'failed', 30003);
    assert.equal(outcome.failureCount, 1);
  });

  test('the error code and status are recorded on the contact', async () => {
    const contact = fakeDoc(f.contact());
    await deliveryPolicy.recordFailure(contact, 'undelivered', 30007);
    assert.equal(contact.lastDeliveryStatus, 'undelivered');
    assert.equal(contact.lastDeliveryErrorCode, 30007);
  });

  test('a missing error code does not overwrite a previously recorded one', async () => {
    const contact = fakeDoc(f.contact({ lastDeliveryErrorCode: 30007 }));
    await deliveryPolicy.recordFailure(contact, 'failed', undefined);
    assert.equal(contact.lastDeliveryErrorCode, 30007);
  });

  test('an already-blocked contact keeps its original block timestamp', async () => {
    const originalDate = new Date('2026-01-01T00:00:00Z');
    const contact = fakeDoc(
      f.contact({ deliveryBlocked: true, deliveryBlockedAt: originalDate, deliveryFailureCount: 9 })
    );
    await deliveryPolicy.recordFailure(contact, 'failed', 30005);
    assert.equal(contact.deliveryBlockedAt.getTime(), originalDate.getTime());
  });
});

describe('recordSuccess', () => {
  test('a delivered receipt resets the consecutive-failure streak', async () => {
    const contact = fakeDoc(f.contact({ deliveryFailureCount: 2, lastDeliveryErrorCode: 30003 }));
    await deliveryPolicy.recordSuccess(contact, 'delivered');
    assert.equal(contact.deliveryFailureCount, 0);
    assert.equal(contact.lastDeliveryStatus, 'delivered');
    assert.equal(contact.lastDeliveryErrorCode, undefined);
  });

  test('a delivered receipt does NOT clear an existing block (unblocking stays an admin action)', async () => {
    const contact = fakeDoc(f.contact({ deliveryBlocked: true, deliveryFailureCount: 5 }));
    await deliveryPolicy.recordSuccess(contact);
    assert.equal(contact.deliveryBlocked, true);
    assert.equal(contact.deliveryFailureCount, 0);
  });

  test('"3 failures" always means three IN A ROW, never three over a lifetime', async () => {
    const contact = fakeDoc(f.contact());
    await deliveryPolicy.recordFailure(contact, 'failed', 30003);
    await deliveryPolicy.recordFailure(contact, 'failed', 30003);
    await deliveryPolicy.recordSuccess(contact); // streak broken
    const next = await deliveryPolicy.recordFailure(contact, 'failed', 30003);
    assert.equal(next.failureCount, 1);
    assert.equal(next.blocked, false);
  });
});
