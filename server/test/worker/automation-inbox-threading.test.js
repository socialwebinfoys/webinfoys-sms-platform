// Inbox threading for automated outbound SMS.
//
// A campaign step or follow-up that goes out must land in the contact's Inbox
// thread straight away — WhatsApp-style — instead of the contact only appearing
// once they reply. The thread comes from the SAME Conversation.findOrCreateForContact
// the inbound webhook uses (the real static runs against the in-memory store),
// so there is still exactly one conversation per contact, whoever spoke first.
'use strict';

require('../_support/env');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupWorkerEnv } = require('../_support/workerEnv');
const { stubModule, fakeModel, fakeDoc } = require('../_support/stubs');
const f = require('../_support/factories');

const state = setupWorkerEnv();

// --- extra doubles for the inbound webhook (test g) -------------------------
// The webhook upserts the contact by phone and the message by MessageSid. Both
// write into the same stores the worker uses, so a reply can be checked against
// the thread the worker created.
const Contact = require('../../models/Contact');
Contact.findOneAndUpdate = async (filter) => {
  const existing = [...state.contacts.values()].find((c) => c.phone === filter.phone);
  if (existing) return existing;
  const created = fakeDoc(f.contact({ _id: f.oid(), phone: filter.phone }));
  state.contacts.set(String(created._id), created);
  return created;
};
const SMSMessage = require('../../models/SMSMessage');
SMSMessage.updateOne = async (filter, update, options = {}) => {
  const existing = state.createdMessages.find(
    (m) => m.direction === filter.direction && m.twilioSid === filter.twilioSid
  );
  if (existing || !options.upsert) return { matchedCount: existing ? 1 : 0, upsertedCount: 0 };
  state.createdMessages.push(fakeDoc({ ...(update.$setOnInsert || {}), _id: f.oid() }));
  return { matchedCount: 0, upsertedCount: 1 };
};
SMSMessage.findOne = async (filter) =>
  state.createdMessages.find(
    (m) => m.direction === filter.direction && m.twilioSid === filter.twilioSid
  ) || null;
stubModule('models/AIReplyJob', fakeModel('AIReplyJob'));

const worker = require('../../jobs/automationWorker');
const { config } = require('../../config/env');
const { startApp } = require('../_support/http');

const LONG_BODY = 'x'.repeat(300);

let api;
before(async () => {
  api = await startApp();
});
after(async () => {
  await api.close();
});

beforeEach(() => {
  state.reset();
  state.settings = f.settings({ sendingWindow: { enabled: false }, sendDays: [0, 1, 2, 3, 4, 5, 6] });
  config.webhook.validate = false;
});

function arrangeCampaign({ steps, contact = {}, enrollment = {} } = {}) {
  const camp = state.addCampaign(steps ? { steps } : {});
  const cont = state.addContact(contact);
  const enr = state.addEnrollment({
    contact: cont._id,
    campaign: camp._id,
    currentStepId: camp.steps[0] ? camp.steps[0]._id : null,
    currentStepIndex: 0,
    nextRunAt: new Date(0),
    lockedUntil: new Date(0),
    ...enrollment,
  });
  return { campaign: camp, contact: cont, enrollment: enr };
}

function arrangeFollowing({ contact, body } = {}) {
  const cont = contact || state.addContact();
  const following = state.addFollowing({
    contactIds: [cont._id],
    recipients: [{ contact: cont._id, status: 'pending', attempts: 0, lastError: '' }],
    nextRunAt: new Date(0),
    activatedAt: new Date(0),
    ...(body ? { body } : {}),
  });
  return { contact: cont, following };
}

// An existing thread with inbound history, as the webhook would have left it.
function seedConversation(contact, overrides = {}) {
  const convo = fakeDoc(
    f.conversation({
      _id: f.oid(),
      contact: contact._id,
      unreadCount: 2,
      lastMessageAt: new Date(Date.now() - 60 * 60 * 1000),
      lastMessagePreview: 'an earlier reply from the customer',
      lastMessageDirection: 'inbound',
      ...overrides,
    })
  );
  state.conversations.push(convo);
  return convo;
}

const outbound = () => state.createdMessages.filter((m) => m.direction === 'outbound');

// ---------------------------------------------------------------------------
describe('campaign send — thread creation and reuse', () => {
  test('(a) creates a Conversation when the contact has none', async () => {
    const { contact } = arrangeCampaign({ contact: { name: 'Ada Lovelace' } });
    assert.equal(state.conversations.length, 0);

    const summary = await worker.processDueEnrollments(new Date());

    assert.equal(summary.sent, 1);
    assert.equal(state.conversations.length, 1, 'a thread must exist after the first send');
    const convo = state.conversations[0];
    assert.equal(String(convo.contact), String(contact._id));
    assert.equal(convo.status, 'open');
    assert.equal(convo.contactName, 'Ada Lovelace', 'inbox search fields filled on insert');
    assert.equal(convo.contactPhone, contact.phone);
  });

  test('(a) the thread comes from Conversation.findOrCreateForContact', async () => {
    arrangeCampaign();
    await worker.processDueEnrollments(new Date());
    const upserts = state.Conversation.__callsTo('findOneAndUpdate');
    assert.equal(upserts.length, 1);
    const [filter, update, options] = upserts[0].args;
    assert.ok(filter.contact, 'keyed on the contact');
    assert.ok(update.$setOnInsert, 'insert-only fields, so an existing thread is untouched');
    assert.equal(options.upsert, true);
  });

  test('(b) reuses the existing Conversation — never a second one', async () => {
    const { contact } = arrangeCampaign();
    const existing = seedConversation(contact);

    await worker.processDueEnrollments(new Date());

    assert.equal(state.conversations.length, 1);
    assert.equal(String(outbound()[0].conversation), String(existing._id));
  });

  test('(b) existing thread state is preserved (status, assignment, AI state)', async () => {
    const { contact } = arrangeCampaign();
    const assignee = f.oid();
    const existing = seedConversation(contact, {
      assignedTo: assignee,
      contactName: 'Original Name',
      ai: { takeover: true, mode: 'draft', replyCount: 1 },
    });

    await worker.processDueEnrollments(new Date());

    assert.equal(existing.status, 'open');
    assert.equal(String(existing.assignedTo), String(assignee));
    assert.equal(existing.contactName, 'Original Name', '$setOnInsert must not overwrite');
    assert.deepEqual(existing.ai, { takeover: true, mode: 'draft', replyCount: 1 });
  });

  test('a closed thread keeps its status (outbound does not reopen it)', async () => {
    const { contact } = arrangeCampaign();
    const existing = seedConversation(contact, { status: 'closed' });
    await worker.processDueEnrollments(new Date());
    assert.equal(existing.status, 'closed');
    assert.equal(String(outbound()[0].conversation), String(existing._id));
  });

  test('a multi-step campaign threads every step into the same conversation', async () => {
    const steps = [
      { _id: f.oid(), body: 'step one', delayValue: 0, delayUnit: 'hours' },
      { _id: f.oid(), body: 'step two', delayValue: 0, delayUnit: 'hours' },
    ];
    const { enrollment } = arrangeCampaign({ steps });

    await worker.processDueEnrollments(new Date());
    enrollment.nextRunAt = new Date(0);
    await worker.processDueEnrollments(new Date());

    assert.equal(outbound().length, 2);
    assert.equal(state.conversations.length, 1);
    const [first, second] = outbound();
    assert.equal(String(first.conversation), String(state.conversations[0]._id));
    assert.equal(String(second.conversation), String(state.conversations[0]._id));
    assert.equal(state.conversations[0].lastMessagePreview, 'step two');
  });
});

describe('campaign send — the message record', () => {
  test('(c) the outbound SMSMessage carries the conversation and all campaign metadata', async () => {
    const { contact, campaign, enrollment } = arrangeCampaign({
      steps: [{ _id: f.oid(), body: 'Hello there', delayValue: 0, delayUnit: 'hours' }],
    });
    state.sendOutcome = () => ({ sid: 'SMcampaign1', status: 'queued', from: '+15005550006' });

    await worker.processDueEnrollments(new Date());

    assert.equal(state.createdMessages.length, 1, 'exactly one record');
    const msg = state.createdMessages[0];
    assert.equal(String(msg.conversation), String(state.conversations[0]._id));
    assert.equal(msg.direction, 'outbound');
    assert.equal(String(msg.contact), String(contact._id));
    assert.equal(msg.to, contact.phone);
    assert.equal(msg.from, '+15005550006');
    assert.equal(msg.body, 'Hello there');
    assert.equal(msg.twilioSid, 'SMcampaign1');
    assert.equal(msg.status, 'queued');
    assert.equal(msg.source, 'campaign');
    assert.equal(String(msg.campaign), String(campaign._id));
    assert.equal(String(msg.enrollment), String(enrollment._id));
    assert.equal(msg.stepIndex, 0);
  });

  test('(d) lastMessageAt / lastMessagePreview / lastMessageDirection are updated', async () => {
    const { contact } = arrangeCampaign({
      steps: [{ _id: f.oid(), body: 'Your appointment is tomorrow', delayValue: 0, delayUnit: 'hours' }],
    });
    const existing = seedConversation(contact);
    const before = existing.lastMessageAt.getTime();

    await worker.processDueEnrollments(new Date());

    assert.ok(existing.lastMessageAt.getTime() > before, 'moves up the Inbox');
    assert.equal(existing.lastMessagePreview, 'Your appointment is tomorrow');
    assert.equal(existing.lastMessageDirection, 'outbound');
  });

  test('(d) the preview is capped at 140 characters, like every other path', async () => {
    arrangeCampaign({ steps: [{ _id: f.oid(), body: LONG_BODY, delayValue: 0, delayUnit: 'hours' }] });
    await worker.processDueEnrollments(new Date());
    assert.equal(state.conversations[0].lastMessagePreview.length, 140);
    assert.equal(outbound()[0].body.length, 300, 'the message itself is not truncated');
  });

  test('(e) unreadCount does NOT increase — a new thread stays at 0', async () => {
    arrangeCampaign();
    await worker.processDueEnrollments(new Date());
    assert.equal(state.conversations[0].unreadCount, 0);
  });

  test('(e) unreadCount does NOT change on an existing thread with unread replies', async () => {
    const { contact } = arrangeCampaign();
    const existing = seedConversation(contact, { unreadCount: 3 });
    await worker.processDueEnrollments(new Date());
    assert.equal(existing.unreadCount, 3);
  });

  test('the thread update writes ONLY the three activity fields', async () => {
    arrangeCampaign();
    await worker.processDueEnrollments(new Date());
    const updates = state.Conversation.__callsTo('updateOne');
    assert.equal(updates.length, 1);
    const update = updates[0].args[1];
    assert.deepEqual(Object.keys(update), ['$set']);
    assert.deepEqual(
      Object.keys(update.$set).sort(),
      ['lastMessageAt', 'lastMessageDirection', 'lastMessagePreview']
    );
  });
});

describe('campaign send — failure and retry safety', () => {
  test('a FAILED Twilio send creates no thread and touches no thread', async () => {
    arrangeCampaign();
    state.sendOutcome = () => {
      throw Object.assign(new Error('Twilio down'), { permanent: false });
    };
    await worker.processDueEnrollments(new Date());
    assert.equal(state.conversations.length, 0);
    assert.equal(state.Conversation.__callsTo('updateOne').length, 0);
  });

  test('a step already in sentSteps is not re-sent, re-recorded or re-threaded', async () => {
    const steps = [{ _id: f.oid(), body: 'one', delayValue: 0, delayUnit: 'hours' }];
    arrangeCampaign({
      steps,
      enrollment: { sentSteps: [{ stepId: steps[0]._id, stepIndex: 0, twilioSid: 'SMold' }] },
    });
    await worker.processDueEnrollments(new Date());
    assert.equal(state.sendCalls.length, 0);
    assert.equal(state.createdMessages.length, 0);
    assert.equal(state.conversations.length, 0);
  });

  test('a threading failure does NOT turn a delivered SMS into a retry', async () => {
    const { enrollment } = arrangeCampaign();
    const original = state.Conversation.findOneAndUpdate;
    state.Conversation.findOneAndUpdate = async () => {
      throw new Error('db hiccup');
    };
    const errors = console.error;
    console.error = () => {};
    try {
      const summary = await worker.processDueEnrollments(new Date());
      assert.equal(summary.sent, 1);
      assert.equal(summary.retried, 0);
      assert.equal(enrollment.status, 'completed');
      assert.equal(enrollment.attempts, 0);
      assert.equal(state.sendCalls.length, 1, 'sent exactly once');
      assert.equal(state.createdMessages.length, 1, 'still recorded, as before this change');
      assert.equal(state.createdMessages[0].conversation, undefined);
    } finally {
      state.Conversation.findOneAndUpdate = original;
      console.error = errors;
    }
  });

  test('an activity-update failure does NOT turn a delivered SMS into a retry', async () => {
    const { enrollment } = arrangeCampaign();
    const original = state.Conversation.updateOne;
    state.Conversation.updateOne = async () => {
      throw new Error('db hiccup');
    };
    const errors = console.error;
    console.error = () => {};
    try {
      const summary = await worker.processDueEnrollments(new Date());
      assert.equal(summary.sent, 1);
      assert.equal(enrollment.status, 'completed');
      assert.equal(state.sendCalls.length, 1);
      assert.ok(state.createdMessages[0].conversation, 'the link itself was still written');
    } finally {
      state.Conversation.updateOne = original;
      console.error = errors;
    }
  });
});

// ---------------------------------------------------------------------------
describe('(f) follow-up send behaves the same way', () => {
  test('creates a Conversation when none exists', async () => {
    const { contact } = arrangeFollowing();
    const summary = await worker.processDueFollowings(new Date());
    assert.equal(summary.sent, 1);
    assert.equal(state.conversations.length, 1);
    assert.equal(String(state.conversations[0].contact), String(contact._id));
  });

  test('reuses an existing Conversation', async () => {
    const contact = state.addContact();
    const existing = seedConversation(contact);
    arrangeFollowing({ contact });
    await worker.processDueFollowings(new Date());
    assert.equal(state.conversations.length, 1);
    assert.equal(String(outbound()[0].conversation), String(existing._id));
  });

  test('the SMSMessage carries the conversation and keeps its follow-up metadata', async () => {
    const { contact, following } = arrangeFollowing({ body: 'Checking in' });
    state.sendOutcome = () => ({ sid: 'SMfollow1', status: 'queued', from: '+15005550006' });
    await worker.processDueFollowings(new Date());

    assert.equal(state.createdMessages.length, 1);
    const msg = state.createdMessages[0];
    assert.equal(String(msg.conversation), String(state.conversations[0]._id));
    assert.equal(msg.direction, 'outbound');
    assert.equal(msg.source, 'following');
    assert.equal(String(msg.following), String(following._id));
    assert.equal(String(msg.contact), String(contact._id));
    assert.equal(msg.to, contact.phone);
    assert.equal(msg.from, '+15005550006');
    assert.equal(msg.body, 'Checking in');
    assert.equal(msg.twilioSid, 'SMfollow1');
    assert.equal(msg.status, 'queued');
    assert.equal(following.recipients[0].twilioSid, 'SMfollow1', 'recipient metadata intact');
  });

  test('updates the activity fields and leaves unreadCount alone', async () => {
    const contact = state.addContact();
    const existing = seedConversation(contact, { unreadCount: 4 });
    const before = existing.lastMessageAt.getTime();
    arrangeFollowing({ contact, body: 'Checking in' });

    await worker.processDueFollowings(new Date());

    assert.ok(existing.lastMessageAt.getTime() > before);
    assert.equal(existing.lastMessagePreview, 'Checking in');
    assert.equal(existing.lastMessageDirection, 'outbound');
    assert.equal(existing.unreadCount, 4);
  });

  test('a threading failure does not fail the recipient', async () => {
    const { following } = arrangeFollowing();
    const original = state.Conversation.findOneAndUpdate;
    state.Conversation.findOneAndUpdate = async () => {
      throw new Error('db hiccup');
    };
    const errors = console.error;
    console.error = () => {};
    try {
      const summary = await worker.processDueFollowings(new Date());
      assert.equal(summary.sent, 1);
      assert.equal(following.recipients[0].status, 'sent');
      assert.equal(following.recipients[0].attempts, 0);
      assert.equal(state.sendCalls.length, 1);
    } finally {
      state.Conversation.findOneAndUpdate = original;
      console.error = errors;
    }
  });

  test('a FAILED follow-up send creates no thread', async () => {
    arrangeFollowing();
    state.sendOutcome = () => {
      throw Object.assign(new Error('Twilio down'), { permanent: true });
    };
    await worker.processDueFollowings(new Date());
    assert.equal(state.conversations.length, 0);
  });

  test('a campaign step and a follow-up to the same contact share one thread', async () => {
    const { contact } = arrangeCampaign();
    arrangeFollowing({ contact });
    await worker.processDueEnrollments(new Date());
    await worker.processDueFollowings(new Date());
    assert.equal(outbound().length, 2);
    assert.equal(state.conversations.length, 1);
    for (const m of outbound()) {
      assert.equal(String(m.conversation), String(state.conversations[0]._id));
    }
  });
});

// ---------------------------------------------------------------------------
describe('(g) the customer reply lands in the same conversation', () => {
  async function inbound(contact, body, sid) {
    return api.post('/api/webhooks/twilio/inbound', {
      raw: new URLSearchParams({ From: contact.phone, To: '+15005550006', Body: body, MessageSid: sid }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  }

  test('campaign first, then the reply: one thread holding both messages', async () => {
    const { contact } = arrangeCampaign();
    await worker.processDueEnrollments(new Date());
    const convo = state.conversations[0];

    const res = await inbound(contact, 'Thanks!', 'SMinbound1');
    assert.equal(res.status, 200);

    assert.equal(state.conversations.length, 1, 'the reply must not open a second thread');
    const reply = state.createdMessages.find((m) => m.direction === 'inbound');
    assert.ok(reply);
    assert.equal(String(reply.conversation), String(convo._id));
    assert.equal(String(outbound()[0].conversation), String(convo._id));
    assert.equal(convo.unreadCount, 1, 'only the inbound message is unread');
    assert.equal(convo.lastMessageDirection, 'inbound');
    assert.equal(convo.lastMessagePreview, 'Thanks!');
  });

  test('reply first, then a follow-up: history kept, still one thread', async () => {
    const contact = state.addContact();
    await inbound(contact, 'Hello?', 'SMinbound2');
    assert.equal(state.conversations.length, 1);
    const convo = state.conversations[0];
    const replyId = state.createdMessages[0]._id;

    // The follow-up is configured to keep going after a reply.
    arrangeFollowing({ contact, body: 'Following up' });
    state.followings[0].stopOnReply = false;
    contact.lastInboundAt = undefined; // the stub does not persist touchLastInboundAt
    await worker.processDueFollowings(new Date());

    assert.equal(state.conversations.length, 1);
    assert.ok(state.createdMessages.some((m) => m._id === replyId), 'the reply is still there');
    assert.equal(String(outbound()[0].conversation), String(convo._id));
    assert.equal(convo.unreadCount, 1, 'the unread reply is still unread');
    assert.equal(convo.lastMessageDirection, 'outbound');
  });
});
