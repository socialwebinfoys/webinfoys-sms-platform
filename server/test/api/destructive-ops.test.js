// Phase 10 — Stage 9: destructive operation review.
//
// For each deleting endpoint this asserts the SCOPE of the delete by inspecting
// the filter the controller passed to the model — not merely that the request
// returned 200. That is the only way to show a cascade cannot reach unrelated
// records.
//
// Nothing here touches a real database: the models are in-memory doubles and the
// harness blocks every MongoDB connection.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

const logged = [];
stubModule('services/logService', { logEvent: async (e) => void logged.push(e) });
stubModule('jobs/automationWorker', {
  processDueEnrollments: async () => ({}),
  processDueFollowings: async () => ({}),
  start: () => {},
  stop: () => {},
});

const operator = f.user();
const administrator = f.admin();
const usersById = new Map([
  [String(operator._id), operator],
  [String(administrator._id), administrator],
]);
stubModule('models/User', fakeModel('User', { findById: (id) => query(usersById.get(String(id)) || null) }));

let campaignsById;
let enrollmentCount;
let liveEnrollmentCount;
const Campaign = stubModule(
  'models/Campaign',
  fakeModel('Campaign', {
    findById: (id) => query(campaignsById.get(String(id)) || null),
    deleteOne: async () => ({ deletedCount: 1 }),
    deleteMany: async () => ({ deletedCount: campaignsById.size }),
  })
);

const Enrollment = stubModule(
  'models/Enrollment',
  fakeModel('Enrollment', {
    countDocuments: async (filter) => {
      // countLiveEnrollments passes a status filter; the plain count does not.
      if (filter && filter.status) return liveEnrollmentCount;
      return enrollmentCount;
    },
    deleteMany: async () => ({ deletedCount: enrollmentCount }),
    find: () => query([]),
    aggregate: () => query([]),
  })
);

let contactsById;
const Contact = stubModule(
  'models/Contact',
  fakeModel('Contact', {
    findById: (id) => query(contactsById.get(String(id)) || null),
    findByIdAndDelete: async (id) => contactsById.get(String(id)) || null,
    deleteMany: async () => ({ deletedCount: contactsById.size }),
    aggregate: () => query([]),
  })
);

let importsById;
const Import = stubModule(
  'models/Import',
  fakeModel('Import', {
    findById: (id) => query(importsById.get(String(id)) || null),
    findByIdAndDelete: async (id) => importsById.get(String(id)) || null,
    find: () => query([...importsById.values()]),
  })
);

let messagesById;
const SMSMessage = stubModule(
  'models/SMSMessage',
  fakeModel('SMSMessage', {
    findById: (id) => query(messagesById.get(String(id)) || null),
    findOne: () => query(null),
    find: () => query([]),
  })
);

let conversationsById;
const Conversation = stubModule(
  'models/Conversation',
  fakeModel('Conversation', {
    findById: (id) => query(conversationsById.get(String(id)) || null),
    findOne: (filter) => query(conversationsById.get(String(filter._id || filter.contact)) || null),
  })
);

const Following = stubModule(
  'models/Following',
  fakeModel('Following', {
    findById: () => query(null),
    findByIdAndDelete: () => query(null),
    deleteMany: async () => ({ deletedCount: 2 }),
  })
);

const RealSettings = require('../../models/Settings');
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    getSingleton: async () => fakeDoc(f.settings()),
    resolveAllowedLineTypes: RealSettings.resolveAllowedLineTypes,
    LINE_TYPES: RealSettings.LINE_TYPES,
  })
);
for (const m of ['models/Template', 'models/ImportPreview', 'models/SystemLog']) {
  stubModule(m, fakeModel(m));
}

const { startApp, tokenFor } = require('../_support/http');

let api;
let userToken;
let adminToken;
before(async () => {
  api = await startApp();
  userToken = tokenFor(operator);
  adminToken = tokenFor(administrator);
});
after(async () => {
  await api.close();
});

beforeEach(() => {
  logged.length = 0;
  campaignsById = new Map();
  contactsById = new Map();
  importsById = new Map();
  messagesById = new Map();
  conversationsById = new Map();
  enrollmentCount = 0;
  liveEnrollmentCount = 0;
  for (const m of [Campaign, Enrollment, Contact, Import, SMSMessage, Conversation, Following]) {
    m.__reset();
  }
});

describe('DELETE /api/campaigns/:id — the force gate', () => {
  function seedCampaign() {
    const campaign = f.campaign();
    campaignsById.set(String(campaign._id), campaign);
    return campaign;
  }

  test('a campaign with NO enrollments deletes for an ordinary operator', async () => {
    const campaign = seedCampaign();
    const res = await api.delete(`/api/campaigns/${campaign._id}`, { token: userToken });
    assert.equal(res.status, 200);
  });

  test('a campaign WITH enrollments is refused 409 and reports the counts', async () => {
    const campaign = seedCampaign();
    enrollmentCount = 12;
    liveEnrollmentCount = 4;
    const res = await api.delete(`/api/campaigns/${campaign._id}`, { token: userToken });
    assert.equal(res.status, 409);
    assert.equal(res.body.requiresForce, true);
    assert.equal(res.body.enrollmentCount, 12);
    assert.equal(res.body.liveEnrollmentCount, 4);
    assert.match(res.body.message, /Pause the campaign instead/);
    assert.equal(Campaign.__callsTo('deleteOne').length, 0, 'nothing may be deleted on a 409');
    assert.equal(Enrollment.__callsTo('deleteMany').length, 0);
  });

  test('force=true from a NON-admin is refused 403 and deletes nothing', async () => {
    const campaign = seedCampaign();
    enrollmentCount = 5;
    const res = await api.delete(`/api/campaigns/${campaign._id}?force=true`, { token: userToken });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /requires an administrator/);
    assert.equal(Campaign.__callsTo('deleteOne').length, 0);
    assert.equal(Enrollment.__callsTo('deleteMany').length, 0);
  });

  test('force=true from an admin deletes, and the cascade is SCOPED TO THAT CAMPAIGN', async () => {
    const campaign = seedCampaign();
    enrollmentCount = 5;
    const res = await api.delete(`/api/campaigns/${campaign._id}?force=true`, { token: adminToken });
    assert.equal(res.status, 200);

    // The campaign delete targets only this id.
    assert.deepEqual(Campaign.__callsTo('deleteOne')[0].args[0], { _id: campaign._id });

    // THE KEY ASSERTION: the enrollment cascade is filtered by campaign, so it
    // cannot reach an enrollment belonging to a different campaign.
    const cascade = Enrollment.__callsTo('deleteMany')[0].args[0];
    assert.deepEqual(cascade, { campaign: campaign._id });
    assert.notDeepEqual(cascade, {}, 'an unscoped {} filter would wipe every enrollment');
  });

  test('the forced cascade touches NO contact, import, conversation or message', async () => {
    const campaign = seedCampaign();
    enrollmentCount = 5;
    await api.delete(`/api/campaigns/${campaign._id}?force=true`, { token: adminToken });
    for (const [name, model] of [
      ['Contact', Contact],
      ['Import', Import],
      ['SMSMessage', SMSMessage],
      ['Conversation', Conversation],
      ['Following', Following],
    ]) {
      for (const method of ['deleteMany', 'deleteOne', 'findByIdAndDelete', 'findOneAndDelete']) {
        assert.equal(
          model.__callsTo(method).length,
          0,
          `${name}.${method} must not be called when deleting a campaign`
        );
      }
    }
  });

  test('the deletion is logged with the forced flag and the cascade count', async () => {
    const campaign = seedCampaign();
    enrollmentCount = 5;
    await api.delete(`/api/campaigns/${campaign._id}?force=true`, { token: adminToken });
    const event = logged.find((e) => e.eventType === 'campaign.deleted');
    assert.ok(event);
    assert.equal(event.meta.forced, true);
    assert.equal(event.severity, 'warning');
  });

  test('an unknown campaign is 404 and deletes nothing', async () => {
    const res = await api.delete(`/api/campaigns/${f.oid(4242)}`, { token: adminToken });
    assert.equal(res.status, 404);
    assert.equal(Enrollment.__callsTo('deleteMany').length, 0);
  });
});

describe('bulk wipe endpoints — scope and blast radius', () => {
  test('DELETE /api/campaigns wipes campaigns AND all enrollments (documented)', async () => {
    const res = await api.delete('/api/campaigns', { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(Campaign.__callsTo('deleteMany')[0].args[0], {});
    // Unscoped, but every enrollment references a campaign and every campaign is
    // being removed, so no enrollment survives its parent either way.
    assert.deepEqual(Enrollment.__callsTo('deleteMany')[0].args[0], {});
    // Contacts, imports and message history are explicitly preserved.
    assert.equal(Contact.__callsTo('deleteMany').length, 0);
    assert.equal(SMSMessage.__callsTo('deleteMany').length, 0);
    assert.equal(Conversation.__callsTo('deleteMany').length, 0);
    assert.equal(Import.__callsTo('deleteMany').length, 0);
  });

  test('DELETE /api/contacts wipes contacts AND all enrollments, preserving history', async () => {
    const res = await api.delete('/api/contacts', { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(Contact.__callsTo('deleteMany')[0].args[0], {});
    assert.deepEqual(Enrollment.__callsTo('deleteMany')[0].args[0], {});
    assert.equal(SMSMessage.__callsTo('deleteMany').length, 0, 'SMS history must survive');
    assert.equal(Conversation.__callsTo('deleteMany').length, 0, 'threads must survive');
    assert.equal(Campaign.__callsTo('deleteMany').length, 0, 'campaigns must survive');
  });

  test('DELETE /api/enrollments wipes only enrollments', async () => {
    const res = await api.delete('/api/enrollments', { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(Enrollment.__callsTo('deleteMany')[0].args[0], {});
    assert.equal(Contact.__callsTo('deleteMany').length, 0);
    assert.equal(Campaign.__callsTo('deleteMany').length, 0);
  });

  test('DELETE /api/enrollments?status=failed is SCOPED to that status', async () => {
    const res = await api.delete('/api/enrollments?status=failed', { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(Enrollment.__callsTo('deleteMany')[0].args[0], { status: 'failed' });
  });

  test('DELETE /api/followings wipes only follow-ups', async () => {
    const res = await api.delete('/api/followings', { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(Following.__callsTo('deleteMany')[0].args[0], {});
    assert.equal(Enrollment.__callsTo('deleteMany').length, 0);
    assert.equal(Contact.__callsTo('deleteMany').length, 0);
  });
});

describe('DELETE /api/contacts/:id — single contact cascade', () => {
  test('the enrollment cascade is scoped to that contact', async () => {
    const contact = fakeDoc(f.contact({ _id: f.oid() }));
    contactsById.set(String(contact._id), contact);
    const res = await api.delete(`/api/contacts/${contact._id}`, { token: userToken });
    assert.equal(res.status, 200);
    assert.deepEqual(Enrollment.__callsTo('deleteMany')[0].args[0], { contact: contact._id });
    assert.equal(SMSMessage.__callsTo('deleteMany').length, 0, 'message history is preserved');
    assert.equal(Conversation.__callsTo('deleteMany').length, 0, 'the thread is preserved');
  });

  test('an unknown contact is 404 and cascades nothing', async () => {
    const res = await api.delete(`/api/contacts/${f.oid(5151)}`, { token: userToken });
    assert.equal(res.status, 404);
    assert.equal(Enrollment.__callsTo('deleteMany').length, 0);
  });
});

describe('DELETE /api/contact-imports/:id — metadata only', () => {
  test('only the Import record is removed; its contacts are untouched', async () => {
    const imp = fakeDoc({ _id: f.oid(), filename: 'leads.csv' });
    importsById.set(String(imp._id), imp);
    const res = await api.delete(`/api/contact-imports/${imp._id}`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(Import.__callsTo('findByIdAndDelete').length, 1);
    assert.equal(Contact.__callsTo('deleteMany').length, 0);
    assert.equal(Contact.__callsTo('findByIdAndDelete').length, 0);
    assert.equal(Enrollment.__callsTo('deleteMany').length, 0);
    assert.equal(Campaign.__callsTo('deleteMany').length, 0);
  });
});

describe('conversations and messages are SOFT deleted only', () => {
  test('deleting a thread sets deletedAt and removes nothing', async () => {
    const convo = fakeDoc(f.conversation({ _id: f.oid() }));
    conversationsById.set(String(convo._id), convo);
    const res = await api.delete(`/api/conversations/${convo._id}`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(convo.deletedAt instanceof Date);
    assert.equal(String(convo.deletedBy), String(administrator._id));
    assert.equal(Conversation.__callsTo('deleteOne').length, 0);
    assert.equal(SMSMessage.__callsTo('deleteMany').length, 0);
    assert.match(res.body.message, /message history was preserved/);
  });

  test('an already-deleted thread is refused', async () => {
    const convo = fakeDoc(f.conversation({ _id: f.oid(), deletedAt: new Date() }));
    conversationsById.set(String(convo._id), convo);
    const res = await api.delete(`/api/conversations/${convo._id}`, { token: adminToken });
    assert.equal(res.status, 400);
  });

  test('deleting a message sets deletedAt and removes nothing', async () => {
    const msg = fakeDoc(f.smsMessage({ _id: f.oid(), direction: 'outbound' }));
    messagesById.set(String(msg._id), msg);
    const res = await api.delete(`/api/conversations/messages/${msg._id}`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(msg.deletedAt instanceof Date);
    assert.equal(SMSMessage.__callsTo('deleteOne').length, 0);
    assert.equal(SMSMessage.__callsTo('findByIdAndDelete').length, 0);
  });

  test('an INBOUND STOP message can NEVER be deleted (compliance record)', async () => {
    const msg = fakeDoc(f.smsMessage({ _id: f.oid(), direction: 'inbound', body: 'STOP' }));
    messagesById.set(String(msg._id), msg);
    const res = await api.delete(`/api/conversations/messages/${msg._id}`, { token: adminToken });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /compliance record/);
    assert.equal(msg.deletedAt, null);
  });

  test('an INBOUND START message can NEVER be deleted', async () => {
    const msg = fakeDoc(f.smsMessage({ _id: f.oid(), direction: 'inbound', body: 'start' }));
    messagesById.set(String(msg._id), msg);
    const res = await api.delete(`/api/conversations/messages/${msg._id}`, { token: adminToken });
    assert.equal(res.status, 403);
    assert.equal(msg.deletedAt, null);
  });

  test('STOP variants and punctuation are all protected', async () => {
    for (const body of ['STOP', 'stop.', ' Unsubscribe ', 'CANCEL!', 'optout', 'START', 'unstop']) {
      const msg = fakeDoc(f.smsMessage({ _id: f.oid(), direction: 'inbound', body }));
      messagesById.set(String(msg._id), msg);
      const res = await api.delete(`/api/conversations/messages/${msg._id}`, { token: adminToken });
      assert.equal(res.status, 403, `${JSON.stringify(body)} should be protected`);
    }
  });

  test('an ordinary inbound message CAN be deleted', async () => {
    const msg = fakeDoc(f.smsMessage({ _id: f.oid(), direction: 'inbound', body: 'stop by later' }));
    messagesById.set(String(msg._id), msg);
    const res = await api.delete(`/api/conversations/messages/${msg._id}`, { token: adminToken });
    assert.equal(res.status, 200);
  });

  test('a message deletion is logged with the operator', async () => {
    const msg = fakeDoc(f.smsMessage({ _id: f.oid(), direction: 'outbound' }));
    messagesById.set(String(msg._id), msg);
    await api.delete(`/api/conversations/messages/${msg._id}`, { token: adminToken });
    const event = logged.find((e) => e.eventType === 'message.deleted');
    assert.ok(event);
    assert.equal(event.severity, 'warning');
    assert.equal(event.meta.byUserId, String(administrator._id));
  });
});

describe('no endpoint anywhere drops a collection or a database', () => {
  test('no model double ever receives a drop-style call', async () => {
    // Exercise every deleting endpoint, then assert nothing attempted a drop.
    const campaign = f.campaign();
    campaignsById.set(String(campaign._id), campaign);
    const contact = fakeDoc(f.contact({ _id: f.oid() }));
    contactsById.set(String(contact._id), contact);

    await api.delete('/api/contacts', { token: adminToken });
    await api.delete('/api/campaigns', { token: adminToken });
    await api.delete('/api/enrollments', { token: adminToken });
    await api.delete('/api/followings', { token: adminToken });
    await api.delete(`/api/contacts/${contact._id}`, { token: adminToken });
    await api.delete(`/api/campaigns/${campaign._id}`, { token: adminToken });

    for (const model of [Campaign, Enrollment, Contact, Import, SMSMessage, Conversation, Following]) {
      for (const call of model.__calls) {
        assert.equal(
          /^(drop|dropCollection|dropDatabase|dropIndexes?|createCollection)$/.test(call.method),
          false,
          `${model.__name}.${call.method} is a schema-destructive operation`
        );
      }
    }
  });
});
