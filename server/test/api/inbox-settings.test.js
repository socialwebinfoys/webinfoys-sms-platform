// Inbox auto-refresh setting: GET/PUT /api/settings/inbox, the schema default
// existing installations inherit, and the /changes clock the Inbox polls with.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

stubModule('services/logService', { logEvent: async () => {} });
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
stubModule(
  'models/User',
  fakeModel('User', { findById: (id) => query(usersById.get(String(id)) || null) })
);

// A settings document saved BEFORE this field existed: no inboxRefreshSeconds.
let settingsDoc;
const RealSettings = require('../../models/Settings');
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    getSingleton: async () => settingsDoc,
    resolveAllowedLineTypes: RealSettings.resolveAllowedLineTypes,
    LINE_TYPES: RealSettings.LINE_TYPES,
    INBOX_REFRESH_OPTIONS: RealSettings.INBOX_REFRESH_OPTIONS,
  })
);

// /changes: the query resolves a little later, standing in for a thread that is
// updated while the query is running.
let queryResolvedAt = 0;
stubModule(
  'models/Conversation',
  fakeModel('Conversation', {
    find: () => {
      const p = new Promise((resolve) =>
        setTimeout(() => {
          queryResolvedAt = Date.now();
          resolve([]);
        }, 25)
      );
      for (const m of ['sort', 'limit', 'populate', 'select', 'lean']) p[m] = () => p;
      return p;
    },
    countDocuments: async () => 0,
  })
);

for (const m of [
  'models/SystemLog',
  'models/Contact',
  'models/Campaign',
  'models/Enrollment',
  'models/Following',
  'models/Import',
  'models/SMSMessage',
  'models/Template',
  'models/ImportPreview',
]) {
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
  settingsDoc = fakeDoc(f.settings());
  delete settingsDoc.inboxRefreshSeconds;
});

const OPTIONS = [0, 5, 10, 15, 30, 60];

// ---------------------------------------------------------------------------
describe('the schema', () => {
  test('a NEW settings document defaults to 10 seconds', () => {
    const doc = new RealSettings({ key: 'twilio' });
    assert.equal(doc.inboxRefreshSeconds, 10);
  });

  test('an EXISTING document saved without the field reads 10 seconds', () => {
    // hydrate() is how Mongoose builds a document from a stored row.
    const legacy = RealSettings.hydrate({ _id: f.oid(), key: 'twilio', smsEnabled: true });
    assert.equal(legacy.inboxRefreshSeconds, 10);
  });

  test('exposes exactly the six choices', () => {
    assert.deepEqual(RealSettings.INBOX_REFRESH_OPTIONS, OPTIONS);
  });

  for (const value of OPTIONS) {
    test(`${value} passes schema validation`, () => {
      const doc = new RealSettings({ key: 'twilio', inboxRefreshSeconds: value });
      assert.equal(doc.validateSync(), undefined);
    });
  }

  for (const value of [1, 7, 20, 120, -5]) {
    test(`${value} fails schema validation`, () => {
      const doc = new RealSettings({ key: 'twilio', inboxRefreshSeconds: value });
      const err = doc.validateSync();
      assert.ok(err && err.errors.inboxRefreshSeconds, `${value} must be rejected`);
    });
  }
});

// ---------------------------------------------------------------------------
describe('GET /api/settings/inbox', () => {
  test('requires a session', async () => {
    const res = await api.get('/api/settings/inbox');
    assert.equal(res.status, 401);
  });

  test('a non-admin can read it (every operator\'s Inbox needs it)', async () => {
    const res = await api.get('/api/settings/inbox', { token: userToken });
    assert.equal(res.status, 200);
  });

  test('an existing installation with no saved value gets the 10-second default', async () => {
    const res = await api.get('/api/settings/inbox', { token: userToken });
    assert.equal(res.body.settings.inboxRefreshSeconds, 10);
    assert.deepEqual(res.body.settings.inboxRefreshOptions, OPTIONS);
  });

  test('returns the stored value', async () => {
    settingsDoc.inboxRefreshSeconds = 30;
    const res = await api.get('/api/settings/inbox', { token: userToken });
    assert.equal(res.body.settings.inboxRefreshSeconds, 30);
  });

  test('a stored 0 is reported as 0 (Off), not replaced by the default', async () => {
    settingsDoc.inboxRefreshSeconds = 0;
    const res = await api.get('/api/settings/inbox', { token: userToken });
    assert.equal(res.body.settings.inboxRefreshSeconds, 0);
  });

  test('exposes nothing but the inbox fields', async () => {
    const res = await api.get('/api/settings/inbox', { token: userToken });
    assert.deepEqual(Object.keys(res.body.settings).sort(), ['inboxRefreshOptions', 'inboxRefreshSeconds']);
  });
});

// ---------------------------------------------------------------------------
describe('PUT /api/settings/inbox', () => {
  for (const value of OPTIONS) {
    test(`saves ${value === 0 ? 'Off (0)' : `${value} seconds`} and it persists`, async () => {
      const res = await api.put('/api/settings/inbox', {
        token: adminToken,
        body: { inboxRefreshSeconds: value },
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.settings.inboxRefreshSeconds, value);
      assert.equal(settingsDoc.inboxRefreshSeconds, value);
      assert.equal(settingsDoc.__saves, 1, 'written to the settings document');

      const read = await api.get('/api/settings/inbox', { token: userToken });
      assert.equal(read.body.settings.inboxRefreshSeconds, value, 'read back after save');
    });
  }

  test('is admin-only', async () => {
    const res = await api.put('/api/settings/inbox', {
      token: userToken,
      body: { inboxRefreshSeconds: 5 },
    });
    assert.equal(res.status, 403);
    assert.equal(settingsDoc.__saves, 0);
  });

  const invalid = [
    ['an unlisted number', 7],
    ['a numeric string', '10'],
    ['a fraction', 10.5],
    ['a negative', -10],
    ['null', null],
    ['a boolean', true],
  ];
  for (const [label, value] of invalid) {
    test(`rejects ${label} with 400 and saves nothing`, async () => {
      settingsDoc.inboxRefreshSeconds = 15;
      const res = await api.put('/api/settings/inbox', {
        token: adminToken,
        body: { inboxRefreshSeconds: value },
      });
      assert.equal(res.status, 400);
      assert.equal(settingsDoc.inboxRefreshSeconds, 15);
      assert.equal(settingsDoc.__saves, 0);
    });
  }

  test('rejects a body without the field', async () => {
    const res = await api.put('/api/settings/inbox', { token: adminToken, body: {} });
    assert.equal(res.status, 400);
    assert.equal(settingsDoc.__saves, 0);
  });

  test('cannot be used to change any other setting', async () => {
    const res = await api.put('/api/settings/inbox', {
      token: adminToken,
      body: { inboxRefreshSeconds: 5, smsEnabled: false, defaultFrom: '+15550000000' },
    });
    assert.equal(res.status, 200);
    assert.equal(settingsDoc.smsEnabled, true);
    assert.equal(settingsDoc.defaultFrom, '');
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/conversations/changes — the polling clock', () => {
  test('`now` is taken BEFORE the query, so an update during it is not skipped', async () => {
    const res = await api.get('/api/conversations/changes', { token: userToken });
    assert.equal(res.status, 200);
    const now = new Date(res.body.now).getTime();
    // Anything updated while the query ran has updatedAt > now, so the next
    // poll's `since=now` still reports it.
    assert.ok(now < queryResolvedAt, `now (${now}) must precede the query result (${queryResolvedAt})`);
  });
});
