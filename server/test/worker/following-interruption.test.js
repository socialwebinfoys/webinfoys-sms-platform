// Follow-up pass: duplicate-send safety under interruption, failed writes,
// overlapping passes and shutdown.
//
// Follow-ups are held in a document store that hands the worker COPIES, exactly
// as MongoDB does: whatever the worker only changed in memory is lost when the
// "process" dies, and only what it actually wrote survives. A dead process is
// simulated by a database or Twilio call that never returns; a restart is a
// freshly loaded worker module reading the same store.
//
// WHAT IS — AND IS NOT — PROVEN HERE. An interruption costs at most the ONE
// recipient that was in flight. It does not prove exactly-once delivery, and the
// code does not provide it: if the process dies after Twilio accepted a message
// but before that fact is written, that one recipient is messaged again once
// its claim expires. The test "killed between Twilio and the first write"
// pins that remaining window down rather than hiding it.
'use strict';

require('../_support/env');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupWorkerEnv } = require('../_support/workerEnv');
const { stubModule, fakeModel, query, resolveAppModule } = require('../_support/stubs');
const { storeModel, matches, same } = require('../_support/docStore');
const f = require('../_support/factories');

const state = setupWorkerEnv();

// --- follow-ups: a store that returns copies -----------------------------------
let followings = [];
// Runs before every follow-up write. A test makes it throw (a database error)
// or never resolve (the process died mid-write).
let beforeFollowingWrite = async () => {};
const followingStore = storeModel('FollowingStore', () => followings, (r) => { followings = r; });
stubModule(
  'models/Following',
  storeModel('Following', () => followings, (r) => { followings = r; }, {
    updateOne: async (filter, update) => {
      await beforeFollowingWrite({ filter, update });
      return followingStore.updateOne(filter, update);
    },
  })
);

// --- message log -----------------------------------------------------------------
let messages = [];
let beforeMessageWrite = async () => {};
stubModule(
  'models/SMSMessage',
  fakeModel('SMSMessage', {
    create: async (doc) => {
      await beforeMessageWrite(doc);
      const saved = { ...doc, _id: f.oid(), createdAt: new Date() };
      messages.push(saved);
      return saved;
    },
    findOne: (filter) => query([...messages].reverse().find((m) => matches(m, filter || {})) || null),
  })
);

const { config } = require('../../config/env');
const WORKER = resolveAppModule('jobs/automationWorker');
// A newly started process: fresh module state (no pass in progress, not
// shutting down), the same database.
function startWorker() {
  delete require.cache[WORKER];
  return require(WORKER);
}

const MIN = 60 * 1000;
const NEVER = new Promise(() => {});
const afterClaimExpiry = () => new Date(Date.now() + 6 * MIN);
const tick = () => new Promise((resolve) => setImmediate(resolve));
// Let a pass that is stuck on a never-returning call reach that call.
async function settleLoop() {
  for (let i = 0; i < 50; i += 1) await tick();
}

let worker;
let contacts;
let sidSeq;

beforeEach(() => {
  state.reset();
  state.settings = f.settings({ sendingWindow: { enabled: false }, sendDays: [0, 1, 2, 3, 4, 5, 6] });
  followings = [];
  messages = [];
  beforeFollowingWrite = async () => {};
  beforeMessageWrite = async () => {};
  sidSeq = 0;
  state.sendOutcome = () => {
    sidSeq += 1;
    return { sid: `SM${String(sidSeq).padStart(4, '0')}`, status: 'queued', simulated: false, from: '+15005550006' };
  };
  worker = startWorker();
});

// A follow-up with `count` pending recipients, stored — not handed to the worker.
function arrange(count, overrides = {}) {
  contacts = [];
  for (let i = 0; i < count; i += 1) {
    contacts.push(state.addContact({ phone: `+1415555${String(1000 + i)}`, name: `Contact ${i + 1}` }));
  }
  const doc = {
    _id: f.oid(),
    name: 'Check-in',
    import: f.oid(),
    contactIds: contacts.map((c) => c._id),
    delayValue: 0,
    delayUnit: 'hours',
    body: 'Hello {{name}}',
    status: 'active',
    stopOnReply: true,
    activatedAt: new Date(0),
    nextRunAt: new Date(0),
    recipients: contacts.map((c) => ({ contact: c._id, status: 'pending', attempts: 0, lastError: '', twilioSid: '' })),
    ...overrides,
  };
  followings.push(doc);
  return doc;
}

const stored = () => followings[0];
const recipient = (i) => stored().recipients[i];
const statuses = () => stored().recipients.map((r) => r.status);
const sendsTo = (i) => state.sendCalls.filter((c) => c.to === contacts[i].phone).length;
const sendCounts = () => contacts.map((_, i) => sendsTo(i));
const released = (r) => new Date(r.lockedUntil).getTime() === 0;
const claimed = (r) => r.lockedUntil && new Date(r.lockedUntil).getTime() > Date.now();
const isResultWrite = ({ update }) => update.$set && 'recipients.$.status' in update.$set;
const resultWriteFor = (i) => (w) => isResultWrite(w) && same(w.filter['recipients.contact'], contacts[i]._id);

// ===========================================================================
describe('each recipient’s result is saved as soon as it is known', () => {
  test('while the third message is being sent, the first two are already stored as sent', async () => {
    arrange(5);
    let seenAtThirdSend = null;
    const base = state.sendOutcome;
    state.sendOutcome = (args) => {
      if (state.sendCalls.length === 3) {
        seenAtThirdSend = JSON.parse(JSON.stringify(stored().recipients));
      }
      return base(args);
    };

    await worker.processDueFollowings(new Date());

    assert.deepEqual(seenAtThirdSend.map((r) => r.status), ['sent', 'sent', 'pending', 'pending', 'pending']);
    assert.equal(seenAtThirdSend[0].twilioSid, 'SM0001');
    assert.equal(seenAtThirdSend[1].twilioSid, 'SM0002');
    assert.equal(new Date(seenAtThirdSend[0].lockedUntil).getTime(), 0, 'its claim is released with the result');
    assert.ok(new Date(seenAtThirdSend[2].lockedUntil).getTime() > Date.now(), 'the one in flight is claimed');
    assert.equal(seenAtThirdSend[3].lockedUntil, undefined, 'the rest are untouched');
  });

  test('a completed pass leaves every result, SID and send time in the store', async () => {
    arrange(3);
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.sent, 3);
    assert.equal(summary.completed, 1);
    assert.deepEqual(statuses(), ['sent', 'sent', 'sent']);
    assert.deepEqual(stored().recipients.map((r) => r.twilioSid), ['SM0001', 'SM0002', 'SM0003']);
    assert.ok(stored().recipients.every((r) => r.sentAt instanceof Date && released(r)));
    assert.equal(stored().status, 'completed');
    assert.equal(messages.length, 3);
  });

  test('recipients created before the claim field existed are processed normally', async () => {
    const doc = arrange(2);
    assert.equal('lockedUntil' in doc.recipients[0], false);
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.sent, 2);
  });
});

// ===========================================================================
describe('the process is killed part-way through a pass', () => {
  test('killed between Twilio and the first write: only THAT recipient can be repeated', async () => {
    arrange(5);
    // Twilio accepts the third message; the process dies before anything about
    // it reaches the database.
    beforeFollowingWrite = (w) => (resultWriteFor(2)(w) ? NEVER : Promise.resolve());
    worker.processDueFollowings(new Date());
    await settleLoop();

    assert.deepEqual(sendCounts(), [1, 1, 1, 0, 0]);
    assert.deepEqual(statuses(), ['sent', 'sent', 'pending', 'pending', 'pending'], 'the first two survive the crash');
    assert.ok(claimed(recipient(2)), 'the interrupted recipient is still claimed');

    // Restart straight away. The claim has not expired, so the interrupted
    // recipient is left alone; everyone else is finished.
    beforeFollowingWrite = async () => {};
    worker = startWorker();
    const second = await worker.processDueFollowings(new Date());
    assert.equal(second.sent, 2);
    assert.deepEqual(sendCounts(), [1, 1, 1, 1, 1], 'nobody has been messaged twice');
    assert.deepEqual(statuses(), ['sent', 'sent', 'pending', 'sent', 'sent']);
    assert.equal(stored().status, 'active', 'not complete while one result is unknown');

    // After the claim expires there is no record of that message anywhere, so it
    // cannot be told apart from one that was never sent — it is sent again.
    // THIS is the remaining at-least-once window: one message, to one person.
    const third = await worker.processDueFollowings(afterClaimExpiry());
    assert.equal(third.sent, 1);
    assert.deepEqual(sendCounts(), [1, 1, 2, 1, 1], 'exactly one repeat, to the recipient that was in flight');
    assert.deepEqual(statuses(), ['sent', 'sent', 'sent', 'sent', 'sent']);
    assert.equal(stored().status, 'completed');
  });

  test('before this fix every recipient of the pass would have been repeated — now none of the saved ones are', async () => {
    arrange(20);
    beforeFollowingWrite = (w) => (resultWriteFor(19)(w) ? NEVER : Promise.resolve());
    worker.processDueFollowings(new Date());
    await settleLoop();
    assert.equal(state.sendCalls.length, 20);

    beforeFollowingWrite = async () => {};
    worker = startWorker();
    await worker.processDueFollowings(new Date());
    await worker.processDueFollowings(afterClaimExpiry());

    const counts = sendCounts();
    assert.deepEqual(counts.slice(0, 19), new Array(19).fill(1), 'the 19 saved recipients are never sent again');
    assert.equal(counts[19], 2);
  });

  test('killed after the result was saved, while writing the message log: nobody is repeated', async () => {
    arrange(4);
    beforeMessageWrite = (doc) => (doc.to === contacts[1].phone ? NEVER : Promise.resolve());
    worker.processDueFollowings(new Date());
    await settleLoop();

    assert.deepEqual(statuses(), ['sent', 'sent', 'pending', 'pending']);
    assert.ok(released(recipient(1)), 'saved and released before the message log was touched');

    beforeMessageWrite = async () => {};
    worker = startWorker();
    await worker.processDueFollowings(new Date());
    await worker.processDueFollowings(afterClaimExpiry());

    assert.deepEqual(sendCounts(), [1, 1, 1, 1]);
    assert.equal(stored().status, 'completed');
    assert.equal(messages.length, 3, 'the cost is one missing message-log entry, not a second SMS');
  });

  test('killed while Twilio was still being called: the claim holds, then the send is retried once', async () => {
    arrange(3);
    const base = state.sendOutcome;
    state.sendOutcome = (args) => (args.to === contacts[1].phone ? NEVER : base(args));
    worker.processDueFollowings(new Date());
    await settleLoop();
    assert.deepEqual(statuses(), ['sent', 'pending', 'pending']);

    state.sendOutcome = base;
    worker = startWorker();
    await worker.processDueFollowings(new Date());
    assert.deepEqual(statuses(), ['sent', 'pending', 'sent'], 'held while its claim is live');

    await worker.processDueFollowings(afterClaimExpiry());
    assert.deepEqual(statuses(), ['sent', 'sent', 'sent']);
    // Two attempts reached the Twilio stub for recipient 2; the first never
    // returned, which is the "accepted but no response" ambiguity.
    assert.equal(sendsTo(0), 1);
    assert.equal(sendsTo(2), 1);
  });
});

// ===========================================================================
describe('a result cannot be written (database error)', () => {
  test('the pass stops at once, and the recipient is recovered from the message log instead of re-sent', async () => {
    arrange(5);
    let failures = 0;
    beforeFollowingWrite = async (w) => {
      if (resultWriteFor(1)(w)) {
        failures += 1;
        throw new Error('MongoServerSelectionError: connection timed out');
      }
    };

    const first = await worker.processDueFollowings(new Date());

    assert.equal(failures, worker.RESULT_SAVE_ATTEMPTS, 'the write is retried before giving up');
    assert.equal(first.aborted, true);
    assert.deepEqual(sendCounts(), [1, 1, 0, 0, 0], 'nothing more is sent once a result cannot be saved');
    assert.deepEqual(statuses(), ['sent', 'pending', 'pending', 'pending', 'pending']);
    assert.ok(claimed(recipient(1)), 'the unsaved recipient stays claimed');
    assert.equal(stored().status, 'active');
    const event = state.logged.find((e) => e.status === 'save_failed');
    assert.ok(event, 'the failure is logged');
    assert.equal(event.severity, 'error');
    assert.equal(messages.length, 2, 'the message itself was recorded');

    // The database is back. The held recipient is skipped; the others go out.
    beforeFollowingWrite = async () => {};
    const second = await worker.processDueFollowings(new Date());
    assert.equal(second.sent, 3);
    assert.deepEqual(sendCounts(), [1, 1, 1, 1, 1]);

    // Claim expired: the message log shows it was sent, so it is NOT sent again.
    const third = await worker.processDueFollowings(afterClaimExpiry());
    assert.equal(third.sent, 0);
    assert.equal(third.recovered, 1);
    assert.deepEqual(sendCounts(), [1, 1, 1, 1, 1], 'exactly once, despite the failed write');
    assert.equal(recipient(1).status, 'sent');
    assert.equal(recipient(1).twilioSid, 'SM0002', 'with the SID of the message that really went out');
    assert.equal(stored().status, 'completed');
    assert.equal(state.eventsOfType('following.recovered').length, 1);
  });

  test('once a result cannot be saved, no OTHER follow-up is worked on in that pass either', async () => {
    arrange(2);
    const firstContacts = contacts;
    arrange(2, { name: 'Second follow-up' });
    const secondContacts = contacts;
    beforeFollowingWrite = async ({ filter, update }) => {
      if (isResultWrite({ update }) && same(filter['recipients.contact'], firstContacts[0]._id)) {
        throw new Error('database unavailable');
      }
    };

    const summary = await worker.processDueFollowings(new Date());

    assert.equal(summary.aborted, true);
    assert.deepEqual(state.sendCalls.map((c) => c.to), [firstContacts[0].phone], 'one send, then nothing');
    assert.deepEqual(followings[1].recipients.map((r) => r.status), ['pending', 'pending']);
    assert.equal(followings[1].recipients[0].lockedUntil, undefined, 'the second follow-up was never touched');
    assert.equal(secondContacts.length, 2);
  });

  test('a write that fails once and then succeeds does not stop the pass', async () => {
    arrange(4);
    let failed = false;
    beforeFollowingWrite = async (w) => {
      if (resultWriteFor(1)(w) && !failed) {
        failed = true;
        throw new Error('transient network error');
      }
    };
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.aborted, undefined);
    assert.equal(summary.sent, 4);
    assert.deepEqual(sendCounts(), [1, 1, 1, 1]);
    assert.deepEqual(statuses(), ['sent', 'sent', 'sent', 'sent']);
  });

  test('a failed message-log write is not treated as a failed send', async () => {
    arrange(2);
    beforeMessageWrite = async (doc) => {
      if (doc.to === contacts[0].phone) throw new Error('write failed');
    };
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.sent, 2);
    assert.equal(recipient(0).status, 'sent');
    assert.equal(recipient(0).attempts, 0, 'no attempt is counted: the message went out');
    assert.equal(recipient(0).lastError, '');
    assert.deepEqual(sendCounts(), [1, 1]);
    assert.ok(state.logged.some((e) => e.status === 'record_failed'));
    await worker.processDueFollowings(afterClaimExpiry());
    assert.deepEqual(sendCounts(), [1, 1]);
  });
});

// ===========================================================================
describe('overlapping passes', () => {
  test('two instances working the same follow-up send to each recipient once', async () => {
    arrange(12);
    const other = (() => {
      delete require.cache[WORKER];
      return require(WORKER);
    })();
    const now = new Date();
    const [a, b] = await Promise.all([worker.processDueFollowings(now), other.processDueFollowings(now)]);

    assert.equal(a.sent + b.sent, 12);
    assert.deepEqual(sendCounts(), new Array(12).fill(1));
    assert.equal(stored().status, 'completed');
    assert.equal(messages.length, 12);
  });

  test('a second pass in the SAME process is refused while one is running', async () => {
    arrange(3);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const base = state.sendOutcome;
    state.sendOutcome = async (args) => {
      if (state.sendCalls.length === 1) await gate;
      return base(args);
    };
    const first = worker.processDueFollowings(new Date());
    await settleLoop();
    const second = await worker.processDueFollowings(new Date());
    assert.equal(second.skipped, true);
    release();
    assert.equal((await first).sent, 3);
    assert.deepEqual(sendCounts(), [1, 1, 1]);
  });

  test('a claim held by another worker is respected, and released claims can be taken', async () => {
    arrange(2);
    const now = new Date();
    assert.equal(await worker.claimRecipient(stored()._id, contacts[0]._id, now), true);
    assert.equal(await worker.claimRecipient(stored()._id, contacts[0]._id, now), false, 'already held');
    assert.equal(await worker.claimRecipient(stored()._id, contacts[1]._id, now), true, 'a different recipient is free');
    assert.equal(
      await worker.claimRecipient(stored()._id, contacts[0]._id, new Date(now.getTime() + worker.RECIPIENT_CLAIM_TTL_MS + 1)),
      true,
      'and it can be taken again once it has expired'
    );
  });
});

// ===========================================================================
describe('the follow-up changes while a pass is running', () => {
  const duringSend = (n, change) => {
    const base = state.sendOutcome;
    state.sendOutcome = (args) => {
      if (state.sendCalls.length === n) change();
      return base(args);
    };
  };

  test('pausing it stops the pass after the message in flight', async () => {
    arrange(5);
    duringSend(2, () => { stored().status = 'paused'; });
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.sent, 2);
    assert.deepEqual(statuses(), ['sent', 'sent', 'pending', 'pending', 'pending']);
    assert.equal(stored().status, 'paused', 'the pass does not overwrite the operator’s decision');
    assert.equal(summary.completed, 0);
  });

  test('deleting it stops the pass without an error', async () => {
    arrange(4);
    duringSend(2, () => { followings = []; });
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(state.sendCalls.length, 2);
    assert.equal(summary.aborted, undefined);
  });

  test('a recipient added by an edit is not stranded by a stale "all done"', async () => {
    arrange(2);
    const late = state.addContact({ phone: '+14155559999' });
    duringSend(2, () => {
      stored().recipients.push({ contact: late._id, status: 'pending', attempts: 0, lastError: '' });
    });
    const first = await worker.processDueFollowings(new Date());
    assert.equal(first.completed, 0);
    assert.equal(stored().status, 'active', 'still active: the stored list has a pending recipient');

    const second = await worker.processDueFollowings(new Date());
    assert.equal(second.sent, 1);
    assert.equal(stored().status, 'completed');
  });
});

// ===========================================================================
describe('retry, backoff and history are unchanged — and now stored per recipient', () => {
  const transient = () => {
    const err = new Error('Failed to send SMS: service unavailable');
    err.twilioCode = 20429;
    err.permanent = false;
    return err;
  };

  test('a temporary Twilio failure is stored as a pending retry with its backoff', async () => {
    arrange(2);
    const base = state.sendOutcome;
    state.sendOutcome = (args) => {
      if (args.to === contacts[0].phone) throw transient();
      return base(args);
    };
    const now = new Date();
    await worker.processDueFollowings(now);

    assert.equal(recipient(0).status, 'pending');
    assert.equal(recipient(0).attempts, 1);
    assert.match(recipient(0).lastError, /service unavailable/);
    assert.ok(released(recipient(0)), 'a retry is not left claimed');
    assert.equal(recipient(1).status, 'sent');
    assert.equal(
      new Date(stored().nextRunAt).getTime(),
      now.getTime() + config.automation.retryBackoffMinutes * MIN,
      'the existing backoff, saved on the follow-up'
    );
    assert.equal(stored().status, 'active');

    // The retry, once the backoff has passed.
    state.sendOutcome = base;
    const later = new Date(now.getTime() + config.automation.retryBackoffMinutes * MIN + 1);
    const retry = await worker.processDueFollowings(later);
    assert.equal(retry.sent, 1);
    assert.equal(recipient(0).status, 'sent');
    assert.deepEqual(sendCounts(), [2, 1], 'the failed attempt and the successful retry');
    assert.equal(stored().status, 'completed');
  });

  test('the retry limit still fails the recipient, and that is stored', async () => {
    arrange(1);
    state.sendOutcome = () => { throw transient(); };
    let now = new Date();
    for (let i = 0; i < config.automation.maxRetries; i += 1) {
      await worker.processDueFollowings(now);
      now = new Date(now.getTime() + 24 * 60 * MIN);
    }
    assert.equal(recipient(0).status, 'failed');
    assert.equal(recipient(0).attempts, config.automation.maxRetries);
    assert.equal(stored().status, 'completed');
  });

  test('a permanent Twilio error fails the recipient immediately, stored, never retried', async () => {
    arrange(2);
    const base = state.sendOutcome;
    state.sendOutcome = (args) => {
      if (args.to === contacts[0].phone) {
        const err = new Error('invalid number');
        err.twilioCode = 21211;
        err.permanent = true;
        throw err;
      }
      return base(args);
    };
    await worker.processDueFollowings(new Date());
    await worker.processDueFollowings(afterClaimExpiry());
    assert.equal(recipient(0).status, 'failed');
    assert.equal(sendsTo(0), 1);
    assert.equal(recipient(1).status, 'sent');
  });

  test('recipients already sent, failed or skipped are left exactly as they were', async () => {
    const earlier = new Date('2026-01-01T00:00:00Z');
    const doc = arrange(4);
    Object.assign(doc.recipients[0], { status: 'sent', twilioSid: 'SMearlier', sentAt: earlier });
    Object.assign(doc.recipients[1], { status: 'failed', lastError: 'delivery undelivered', attempts: 2 });
    Object.assign(doc.recipients[2], { status: 'skipped', lastError: 'replied' });
    const before = JSON.stringify(doc.recipients.slice(0, 3));

    const summary = await worker.processDueFollowings(new Date());

    assert.equal(summary.sent, 1);
    assert.equal(JSON.stringify(stored().recipients.slice(0, 3)), before);
    assert.deepEqual(sendCounts(), [0, 0, 0, 1]);
    assert.equal(stored().status, 'completed');
  });

  test('skips are stored too: opted-out, invalid-number and replied recipients', async () => {
    arrange(4);
    contacts[0].optedOut = true;
    contacts[1].lookup = { status: 'invalid', type: '', lookedUpAt: new Date() };
    contacts[2].lastInboundAt = new Date();
    await worker.processDueFollowings(new Date());
    assert.deepEqual(statuses(), ['skipped', 'skipped', 'skipped', 'sent']);
    assert.deepEqual(stored().recipients.slice(0, 3).map((r) => r.lastError), ['opted_out', 'invalid_number', 'replied']);
    assert.ok(stored().recipients.every(released));
    assert.deepEqual(sendCounts(), [0, 0, 0, 1]);
  });

  test('the per-run budget still applies, and the rest is picked up next time', async () => {
    arrange(5);
    const first = await worker.processDueFollowings(new Date(), { budget: 2 });
    assert.equal(first.sent, 2);
    assert.deepEqual(statuses(), ['sent', 'sent', 'pending', 'pending', 'pending']);
    assert.equal(recipient(2).lockedUntil, undefined, 'recipients beyond the budget are never claimed');
    const second = await worker.processDueFollowings(new Date());
    assert.equal(second.sent, 3);
    assert.deepEqual(sendCounts(), [1, 1, 1, 1, 1]);
  });
});

// ===========================================================================
describe('graceful shutdown of the worker', () => {
  function gateSend(n) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const base = state.sendOutcome;
    state.sendOutcome = async (args) => {
      if (state.sendCalls.length === n) await gate;
      return base(args);
    };
    return release;
  }

  test('a running pass finishes the recipient it is on, saves it, and takes no more', async () => {
    arrange(5);
    const release = gateSend(2);
    const pass = worker.processDueFollowings(new Date());
    await settleLoop();

    const stopping = worker.shutdown({ timeoutMs: 5000 });
    release();
    const result = await stopping;
    const summary = await pass;

    assert.deepEqual(result, { drained: true, waitedFor: 1 });
    assert.equal(summary.sent, 2);
    assert.deepEqual(statuses(), ['sent', 'sent', 'pending', 'pending', 'pending']);
    assert.ok(released(recipient(1)), 'the recipient in flight was saved before the worker stopped');
    assert.equal(recipient(2).lockedUntil, undefined, 'nothing new was claimed');
    assert.equal(stored().status, 'active');

    // The next process picks up exactly where this one stopped.
    worker = startWorker();
    const next = await worker.processDueFollowings(new Date());
    assert.equal(next.sent, 3);
    assert.deepEqual(sendCounts(), [1, 1, 1, 1, 1]);
  });

  test('no new pass or tick starts once shutdown has begun', async () => {
    arrange(2);
    assert.deepEqual(await worker.shutdown(), { drained: true, waitedFor: 0 });

    const followUps = await worker.processDueFollowings(new Date());
    assert.equal(followUps.skipped, true);
    assert.match(followUps.reason, /shutting down/);
    const enrollments = await worker.processDueEnrollments(new Date());
    assert.equal(enrollments.skipped, true);
    assert.match(enrollments.reason, /shutting down/);
    const tickResult = await worker.runTick(new Date());
    assert.equal(tickResult.heldLease, false, 'no lease is taken');
    assert.equal(state.locks.size, 0);
    assert.equal(state.sendCalls.length, 0);
  });

  test('shutdown stops the scheduler', async () => {
    const cron = require('node-cron');
    const originalSchedule = cron.schedule;
    const originalEnabled = config.automation.enabled;
    let stopped = 0;
    cron.schedule = () => ({ stop: () => { stopped += 1; } });
    config.automation.enabled = true;
    try {
      worker.start();
      await worker.shutdown();
      assert.equal(stopped, 1);
    } finally {
      cron.schedule = originalSchedule;
      config.automation.enabled = originalEnabled;
    }
  });

  test('a pass that will not finish is given up on at the timeout, and reported', async () => {
    arrange(3);
    const base = state.sendOutcome;
    state.sendOutcome = (args) => (state.sendCalls.length === 2 ? NEVER : base(args));
    worker.processDueFollowings(new Date());
    await settleLoop();

    const started = Date.now();
    const result = await worker.shutdown({ timeoutMs: 60 });
    assert.deepEqual(result, { drained: false, waitedFor: 1 });
    assert.ok(Date.now() - started < 2000, 'it does not wait past the timeout');
    // What was saved before the cut-off is safe.
    assert.deepEqual(statuses(), ['sent', 'pending', 'pending']);
    assert.ok(claimed(recipient(1)), 'the cut-off recipient is protected by its claim');
  });

  test('an enrollment pass also stops after the enrollment it is on', async () => {
    const campaign = state.addCampaign();
    const people = [0, 1, 2].map((i) => state.addContact({ phone: `+1415555200${i}` }));
    const rows = people.map((c) =>
      state.addEnrollment({
        contact: c._id,
        campaign: campaign._id,
        currentStepId: campaign.steps[0]._id,
        nextRunAt: new Date(0),
        lockedUntil: new Date(0),
      })
    );
    const release = gateSend(1);
    const pass = worker.processDueEnrollments(new Date());
    await settleLoop();
    const stopping = worker.shutdown({ timeoutMs: 5000 });
    release();
    assert.equal((await stopping).drained, true);
    const summary = await pass;

    assert.equal(summary.sent, 1);
    assert.equal(rows[0].status, 'completed');
    assert.equal(rows[1].status, 'active', 'left for the next instance');
    assert.equal(rows[1].sentSteps.length, 0);
    assert.equal(state.sendCalls.length, 1);
  });
});
