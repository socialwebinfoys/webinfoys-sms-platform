// Bug #1 — a customer reply must not burn the recipients of a follow-up that is
// not running.
//
// Marking a recipient 'skipped' is irreversible: reconcileRecipients keeps every
// row whose status is not 'pending', so nothing can put it back. That is fine
// for an ACTIVE follow-up (it only pre-empts what the worker is about to decide)
// but wrong for a DRAFT or PAUSED one, where the operator can still change
// stopOnReply, edit the audience, or simply decide later — and the worker
// re-applies the stopOnReply / activatedAt rule at send time anyway.
//
// Opt-out is deliberately NOT scoped this way: withdrawn consent must reach
// every follow-up in every state and must never be undone by a config change.
'use strict';

require('../_support/env');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

const logged = [];
stubModule('services/logService', { logEvent: async (e) => void logged.push(e) });

// --- a Following store that actually APPLIES the filter -------------------
// Faithful enough to prove behaviour rather than just assert on arguments:
// it evaluates the recipients $elemMatch, the optional stopOnReply clause and
// the optional status clause, then applies the positional arrayFilter.
let followings;

function matchesFilter(doc, filter) {
  if (filter.status !== undefined && doc.status !== filter.status) return false;
  if (filter.stopOnReply !== undefined) {
    // { $ne: false } — legacy docs with the field absent still match.
    if (doc.stopOnReply === false) return false;
  }
  const elem = filter.recipients && filter.recipients.$elemMatch;
  if (elem) {
    const hit = (doc.recipients || []).some(
      (r) => String(r.contact) === String(elem.contact) && r.status === elem.status
    );
    if (!hit) return false;
  }
  return true;
}

stubModule(
  'models/Following',
  fakeModel('Following', {
    updateMany: async (filter, update, options) => {
      const arrayFilter = (options && options.arrayFilters && options.arrayFilters[0]) || {};
      const contactId = String(arrayFilter['r.contact']);
      const wantStatus = arrayFilter['r.status'];
      let modified = 0;
      for (const doc of followings) {
        if (!matchesFilter(doc, filter)) continue;
        let touched = false;
        for (const r of doc.recipients || []) {
          if (String(r.contact) === contactId && r.status === wantStatus) {
            r.status = update.$set['recipients.$[r].status'];
            r.lastError = update.$set['recipients.$[r].lastError'];
            touched = true;
          }
        }
        if (touched) modified += 1;
      }
      return { modifiedCount: modified };
    },
  })
);

let enrollments;
stubModule(
  'models/Enrollment',
  fakeModel('Enrollment', {
    updateMany: async (filter, update) => {
      let modified = 0;
      for (const doc of enrollments) {
        if (String(doc.contact) !== String(filter.contact)) continue;
        if (filter.status) {
          if (filter.status.$in && !filter.status.$in.includes(doc.status)) continue;
          if (typeof filter.status === 'string' && doc.status !== filter.status) continue;
        }
        Object.assign(doc, update.$set);
        modified += 1;
      }
      return { modifiedCount: modified };
    },
  })
);

stubModule('models/Contact', fakeModel('Contact', { findOne: () => query(null) }));

const { stopAutomationOnReply, applyOptOut } = require('../../utils/optOut');

const CONTACT = f.oid(4001);
const OTHER_CONTACT = f.oid(4002);

function makeFollowing(status, overrides = {}) {
  return fakeDoc({
    _id: f.oid(),
    name: `${status} follow-up`,
    status,
    stopOnReply: true,
    activatedAt: status === 'draft' ? undefined : new Date(Date.now() - 86400000),
    recipients:
      status === 'draft'
        ? []
        : [
            { contact: CONTACT, status: 'pending', attempts: 0, lastError: '' },
            { contact: OTHER_CONTACT, status: 'pending', attempts: 0, lastError: '' },
          ],
    ...overrides,
  });
}

const recipientFor = (doc, contactId) =>
  (doc.recipients || []).find((r) => String(r.contact) === String(contactId));

beforeEach(() => {
  logged.length = 0;
  followings = [];
  enrollments = [];
});

describe('an ordinary reply skips ONLY an active follow-up', () => {
  test('ACTIVE: the replying contact is skipped', async () => {
    const active = makeFollowing('active');
    followings.push(active);

    const result = await stopAutomationOnReply(CONTACT);

    assert.equal(result.followings, 1);
    assert.equal(recipientFor(active, CONTACT).status, 'skipped');
    assert.equal(recipientFor(active, CONTACT).lastError, 'replied');
  });

  test('PAUSED: recipients stay pending and the follow-up stays paused', async () => {
    const paused = makeFollowing('paused');
    followings.push(paused);

    const result = await stopAutomationOnReply(CONTACT);

    assert.equal(result.followings, 0, 'a paused follow-up must not be touched by a reply');
    assert.equal(
      recipientFor(paused, CONTACT).status,
      'pending',
      'the recipient must remain eligible for when the operator resumes'
    );
    assert.equal(paused.status, 'paused', 'the lifecycle state itself must not change');
  });

  test('DRAFT: nothing is touched and it stays draft', async () => {
    const draft = makeFollowing('draft');
    // A draft normally has no recipients (they are built at activation). Give it
    // some anyway, so the test proves the STATUS filter is what protects it
    // rather than an empty array doing so by accident.
    draft.recipients = [{ contact: CONTACT, status: 'pending', attempts: 0, lastError: '' }];
    followings.push(draft);

    const result = await stopAutomationOnReply(CONTACT);

    assert.equal(result.followings, 0);
    assert.equal(recipientFor(draft, CONTACT).status, 'pending');
    assert.equal(draft.status, 'draft');
  });

  test('COMPLETED: not touched', async () => {
    const completed = makeFollowing('completed');
    followings.push(completed);
    await stopAutomationOnReply(CONTACT);
    assert.equal(recipientFor(completed, CONTACT).status, 'pending');
  });

  test('a mixed set: only the active follow-up is affected', async () => {
    const active = makeFollowing('active');
    const paused = makeFollowing('paused');
    const draft = makeFollowing('draft');
    draft.recipients = [{ contact: CONTACT, status: 'pending', attempts: 0, lastError: '' }];
    followings.push(active, paused, draft);

    const result = await stopAutomationOnReply(CONTACT);

    assert.equal(result.followings, 1);
    assert.equal(recipientFor(active, CONTACT).status, 'skipped');
    assert.equal(recipientFor(paused, CONTACT).status, 'pending');
    assert.equal(recipientFor(draft, CONTACT).status, 'pending');
  });

  test('other recipients of the same follow-up are never touched', async () => {
    const active = makeFollowing('active');
    followings.push(active);
    await stopAutomationOnReply(CONTACT);
    assert.equal(recipientFor(active, OTHER_CONTACT).status, 'pending');
  });

  test('a reply still stops ACTIVE enrollments regardless of follow-up state', async () => {
    enrollments.push(fakeDoc({ _id: f.oid(), contact: CONTACT, status: 'active' }));
    followings.push(makeFollowing('paused'));

    const result = await stopAutomationOnReply(CONTACT);

    assert.equal(result.enrollments, 1);
    assert.equal(enrollments[0].status, 'replied');
    assert.equal(enrollments[0].stopReason, 'replied');
  });
});

describe('stopOnReply still governs the active case', () => {
  test('stopOnReply=false on an ACTIVE follow-up: not skipped', async () => {
    const active = makeFollowing('active', { stopOnReply: false });
    followings.push(active);

    const result = await stopAutomationOnReply(CONTACT);

    assert.equal(result.followings, 0);
    assert.equal(recipientFor(active, CONTACT).status, 'pending');
  });

  test('a LEGACY active follow-up with no stopOnReply field is still skipped', async () => {
    const active = makeFollowing('active');
    delete active.stopOnReply;
    followings.push(active);

    const result = await stopAutomationOnReply(CONTACT);

    assert.equal(result.followings, 1, 'only an explicit false opts out');
    assert.equal(recipientFor(active, CONTACT).status, 'skipped');
  });

  // The scenario the fix exists for.
  test('pause -> reply -> stopOnReply=false -> resume now actually sends', async () => {
    const paused = makeFollowing('paused');
    followings.push(paused);

    await stopAutomationOnReply(CONTACT); // the reply arrives while paused

    // The operator changes their mind and resumes.
    paused.stopOnReply = false;
    paused.status = 'active';

    assert.equal(
      recipientFor(paused, CONTACT).status,
      'pending',
      'the recipient must still be sendable — the old behaviour had already burned them'
    );
  });
});

describe('opt-out is authoritative and reaches EVERY follow-up state', () => {
  function contactDoc() {
    return fakeDoc(f.contact({ _id: CONTACT }));
  }

  test('an opt-out skips active, paused AND draft recipients', async () => {
    const active = makeFollowing('active');
    const paused = makeFollowing('paused');
    const draft = makeFollowing('draft');
    draft.recipients = [{ contact: CONTACT, status: 'pending', attempts: 0, lastError: '' }];
    followings.push(active, paused, draft);

    const result = await applyOptOut(contactDoc(), 'keyword');

    assert.equal(result.skippedFollowings, 3, 'consent must not respect lifecycle state');
    assert.equal(recipientFor(active, CONTACT).status, 'skipped');
    assert.equal(recipientFor(paused, CONTACT).status, 'skipped');
    assert.equal(recipientFor(draft, CONTACT).status, 'skipped');
  });

  test('an opt-out ignores stopOnReply=false', async () => {
    const active = makeFollowing('active', { stopOnReply: false });
    followings.push(active);

    await applyOptOut(contactDoc(), 'keyword');

    assert.equal(
      recipientFor(active, CONTACT).status,
      'skipped',
      'per-follow-up configuration must never override withdrawn consent'
    );
  });

  test('an opt-out records the reason as opted_out, not replied', async () => {
    const active = makeFollowing('active');
    followings.push(active);
    await applyOptOut(contactDoc(), 'keyword');
    assert.equal(recipientFor(active, CONTACT).lastError, 'opted_out');
  });

  test('an opt-out also cancels active AND paused enrollments', async () => {
    enrollments.push(
      fakeDoc({ _id: f.oid(), contact: CONTACT, status: 'active' }),
      fakeDoc({ _id: f.oid(), contact: CONTACT, status: 'paused' })
    );
    const result = await applyOptOut(contactDoc(), 'keyword');
    assert.equal(result.cancelledEnrollments, 2);
  });
});

describe('no duplicate or repeated state changes', () => {
  test('replying twice does not change an already-skipped recipient again', async () => {
    const active = makeFollowing('active');
    followings.push(active);

    const first = await stopAutomationOnReply(CONTACT);
    const second = await stopAutomationOnReply(CONTACT);

    assert.equal(first.followings, 1);
    assert.equal(second.followings, 0, 'the second reply has nothing left to skip');
    assert.equal(recipientFor(active, CONTACT).status, 'skipped');
  });

  test('a reply does not resurrect or alter a recipient that already failed', async () => {
    const active = makeFollowing('active');
    recipientFor(active, CONTACT).status = 'failed';
    recipientFor(active, CONTACT).lastError = 'carrier rejected';
    followings.push(active);

    await stopAutomationOnReply(CONTACT);

    assert.equal(recipientFor(active, CONTACT).status, 'failed');
    assert.equal(recipientFor(active, CONTACT).lastError, 'carrier rejected');
  });

  test('a reply does not alter a recipient that was already sent', async () => {
    const active = makeFollowing('active');
    recipientFor(active, CONTACT).status = 'sent';
    followings.push(active);

    await stopAutomationOnReply(CONTACT);

    assert.equal(recipientFor(active, CONTACT).status, 'sent');
  });

  test('a reply from an unrelated contact changes nothing', async () => {
    const active = makeFollowing('active');
    followings.push(active);

    const result = await stopAutomationOnReply(f.oid(4099));

    assert.equal(result.followings, 0);
    assert.equal(recipientFor(active, CONTACT).status, 'pending');
    assert.equal(recipientFor(active, OTHER_CONTACT).status, 'pending');
  });
});
