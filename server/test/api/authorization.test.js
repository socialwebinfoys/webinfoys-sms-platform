// Phase 10 — Stage 2B/2C: admin authorization matrix and admin self-protection.
//
// Every admin-only endpoint is asserted three ways: unauthenticated -> 401,
// ordinary operator -> 403, administrator -> gets past the guard. Driving the
// real router means a route that loses its `authorize('admin')` guard in a future
// refactor fails here.
'use strict';

require('../_support/env');

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

const logged = [];
stubModule('services/logService', { logEvent: async (e) => void logged.push(e) });

// The worker must never actually run from an HTTP test.
let workerRuns = 0;
stubModule('jobs/automationWorker', {
  processDueEnrollments: async () => {
    workerRuns += 1;
    return { considered: 0, sent: 0 };
  },
  processDueFollowings: async () => {
    workerRuns += 1;
    return { considered: 0, sent: 0 };
  },
  start: () => {},
  stop: () => {},
});

const operator = f.user({ email: 'operator@test.invalid' });
const administrator = f.admin({ email: 'boss@test.invalid' });
const otherAdmin = f.admin({ email: 'second@test.invalid' });

const usersById = new Map([
  [String(operator._id), operator],
  [String(administrator._id), administrator],
  [String(otherAdmin._id), otherAdmin],
]);

// A mutable target for the self-protection tests.
let patchTarget = null;

stubModule(
  'models/User',
  fakeModel('User', {
    findById: (id) => {
      if (patchTarget && String(id) === String(patchTarget._id)) return query(patchTarget);
      return query(usersById.get(String(id)) || null);
    },
    findOne: () => query(null),
    find: () => query([...usersById.values()]),
  })
);

const settingsDoc = fakeDoc(f.settings());
const Settings = require('../../models/Settings');
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    getSingleton: async () => settingsDoc,
    resolveAllowedLineTypes: Settings.resolveAllowedLineTypes,
    LINE_TYPES: Settings.LINE_TYPES,
  })
);

for (const model of [
  'models/Contact',
  'models/Campaign',
  'models/Enrollment',
  'models/Following',
  'models/Import',
  'models/Conversation',
  'models/SMSMessage',
  'models/Template',
  'models/ImportPreview',
  'models/SystemLog',
]) {
  stubModule(model, fakeModel(model));
}

const { startApp, tokenFor } = require('../_support/http');

let api;
before(async () => {
  api = await startApp();
});
after(async () => {
  await api.close();
});

// Every admin-only route in the application, with a body where one is needed to
// get past input validation and reach the authorization decision.
const ADMIN_ONLY = [
  ['POST', '/api/auth/register', { name: 'N', email: 'n@test.invalid', password: 'twelve-chars-ok' }],
  ['DELETE', '/api/contacts', undefined],
  ['DELETE', '/api/campaigns', undefined],
  ['DELETE', '/api/enrollments', undefined],
  ['DELETE', '/api/followings', undefined],
  ['DELETE', `/api/contact-imports/${f.oid(1)}`, undefined],
  ['PATCH', `/api/users/${f.oid(2)}`, { role: 'user' }],
  ['PUT', '/api/settings/twilio', { smsEnabled: true }],
  ['PUT', '/api/settings/automation', { sendingWindow: { startHour: 9, endHour: 18 } }],
  ['POST', '/api/enrollments/run', {}],
  ['POST', '/api/followings/run', {}],
  ['DELETE', `/api/conversations/${f.oid(3)}`, undefined],
  ['DELETE', `/api/conversations/messages/${f.oid(4)}`, undefined],
  ['PATCH', `/api/delivery/unblock/${f.oid(5)}`, undefined],
];

describe('admin-only endpoints reject unauthenticated callers with 401', () => {
  for (const [method, path, body] of ADMIN_ONLY) {
    test(`${method} ${path}`, async () => {
      const res = await api.request(method, path, { body });
      assert.equal(res.status, 401, `expected 401, got ${res.status}: ${res.text}`);
    });
  }
});

describe('admin-only endpoints reject an ordinary operator with 403', () => {
  for (const [method, path, body] of ADMIN_ONLY) {
    test(`${method} ${path}`, async () => {
      const res = await api.request(method, path, { body, token: tokenFor(operator) });
      assert.equal(res.status, 403, `expected 403, got ${res.status}: ${res.text}`);
      assert.match(res.body.message, /Forbidden|administrator/i);
    });
  }
});

describe('admin-only endpoints let an administrator past the guard', () => {
  for (const [method, path, body] of ADMIN_ONLY) {
    test(`${method} ${path}`, async () => {
      patchTarget = null;
      const res = await api.request(method, path, { body, token: tokenFor(administrator) });
      assert.notEqual(res.status, 401, `admin was rejected as unauthenticated: ${res.text}`);
      assert.notEqual(res.status, 403, `admin was rejected as forbidden: ${res.text}`);
      assert.notEqual(res.status, 500, `admin request errored: ${res.text}`);
    });
  }
});

describe('routes that are deliberately open to any authenticated operator', () => {
  const OPERATOR_ROUTES = [
    ['GET', '/api/contacts'],
    ['GET', '/api/templates'],
    ['GET', '/api/campaigns'],
    ['GET', '/api/enrollments'],
    ['GET', '/api/followings'],
    ['GET', '/api/conversations'],
    ['GET', '/api/conversations/unread-count'],
    ['GET', '/api/users'],
    ['GET', '/api/analytics/overview'],
    ['GET', '/api/analytics/campaigns'],
    ['GET', '/api/logs'],
    ['GET', '/api/contact-imports'],
    ['GET', '/api/delivery/report'],
    ['GET', '/api/settings/twilio'],
    ['GET', '/api/settings/automation'],
  ];

  for (const [method, path] of OPERATOR_ROUTES) {
    test(`${method} ${path} is 401 without a token`, async () => {
      const res = await api.request(method, path);
      assert.equal(res.status, 401);
    });
    test(`${method} ${path} is NOT 403 for an ordinary operator`, async () => {
      const res = await api.request(method, path, { token: tokenFor(operator) });
      assert.notEqual(res.status, 403, `unexpectedly admin-gated: ${res.text}`);
      assert.notEqual(res.status, 401, `token rejected: ${res.text}`);
    });
  }
});

describe('GET /api/users — only an admin may list deactivated accounts', () => {
  test('an operator asking for inactive accounts silently gets the active-only filter', async () => {
    const User = require('../../models/User');
    User.__reset();
    await api.get('/api/users?includeInactive=true', { token: tokenFor(operator) });
    const call = User.__callsTo('find')[0];
    assert.deepEqual(call.args[0], { isActive: true }, 'operator must not see inactive accounts');
  });

  test('an admin asking for inactive accounts gets an unfiltered query', async () => {
    const User = require('../../models/User');
    User.__reset();
    await api.get('/api/users?includeInactive=true', { token: tokenFor(administrator) });
    const call = User.__callsTo('find')[0];
    assert.deepEqual(call.args[0], {}, 'admin should see every account');
  });

  test('the user list never includes a password field', async () => {
    const res = await api.get('/api/users', { token: tokenFor(operator) });
    assert.equal(res.status, 200);
    assert.equal(res.text.includes('password'), false);
  });
});

describe('admin self-protection (Stage 2C)', () => {
  test('an admin CANNOT deactivate their own account', async () => {
    patchTarget = fakeDoc({ ...administrator, password: 'hash' });
    const res = await api.patch(`/api/users/${administrator._id}`, {
      token: tokenFor(administrator),
      body: { isActive: false },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /cannot deactivate your own account/i);
    assert.equal(patchTarget.__saves, 0, 'nothing may be persisted on a refused change');
  });

  test('an admin CANNOT demote themselves out of the admin role', async () => {
    patchTarget = fakeDoc({ ...administrator, password: 'hash' });
    const res = await api.patch(`/api/users/${administrator._id}`, {
      token: tokenFor(administrator),
      body: { role: 'user' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /cannot remove your own admin role/i);
    assert.equal(patchTarget.__saves, 0);
  });

  test('an admin MAY reset their own password', async () => {
    patchTarget = fakeDoc({ ...administrator, password: 'hash' });
    const res = await api.patch(`/api/users/${administrator._id}`, {
      token: tokenFor(administrator),
      body: { password: 'a-brand-new-long-password' },
    });
    assert.equal(res.status, 200);
    assert.equal(patchTarget.__saves, 1);
  });

  test('an admin MAY deactivate a DIFFERENT admin', async () => {
    patchTarget = fakeDoc({ ...otherAdmin, password: 'hash' });
    const res = await api.patch(`/api/users/${otherAdmin._id}`, {
      token: tokenFor(administrator),
      body: { isActive: false },
    });
    assert.equal(res.status, 200);
    assert.equal(patchTarget.isActive, false);
  });

  test('a password reset below 12 characters is refused', async () => {
    patchTarget = fakeDoc({ ...operator, password: 'hash' });
    const res = await api.patch(`/api/users/${operator._id}`, {
      token: tokenFor(administrator),
      body: { password: 'eleven-char' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /at least 12 characters/);
    assert.equal(patchTarget.__saves, 0);
  });

  test('an unknown role value is refused rather than stored', async () => {
    patchTarget = fakeDoc({ ...operator, password: 'hash' });
    const res = await api.patch(`/api/users/${operator._id}`, {
      token: tokenFor(administrator),
      body: { role: 'superuser' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /role must be one of/);
  });

  test('an empty update is refused with 400 rather than silently doing nothing', async () => {
    patchTarget = fakeDoc({ ...operator, password: 'hash' });
    const res = await api.patch(`/api/users/${operator._id}`, {
      token: tokenFor(administrator),
      body: {},
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Nothing to update/);
  });

  test('a user update is logged WITHOUT the new password', async () => {
    logged.length = 0;
    patchTarget = fakeDoc({ ...operator, password: 'hash' });
    const secret = 'another-fresh-long-password';
    await api.patch(`/api/users/${operator._id}`, {
      token: tokenFor(administrator),
      body: { password: secret },
    });
    const event = logged.find((e) => e.eventType === 'user.updated');
    assert.ok(event, 'expected a user.updated event');
    assert.equal(JSON.stringify(logged).includes(secret), false, 'the password must never be logged');
    assert.ok(event.meta.changes.includes('password reset'));
  });
});

describe('the manual worker trigger is admin-gated AND does not run for a non-admin', () => {
  test('an operator cannot trigger the enrollment worker', async () => {
    const before = workerRuns;
    const res = await api.post('/api/enrollments/run', { token: tokenFor(operator), body: {} });
    assert.equal(res.status, 403);
    assert.equal(workerRuns, before, 'the worker must not run for a forbidden caller');
  });

  test('an operator cannot trigger the follow-up worker', async () => {
    const before = workerRuns;
    const res = await api.post('/api/followings/run', { token: tokenFor(operator), body: {} });
    assert.equal(res.status, 403);
    assert.equal(workerRuns, before);
  });

  test('an admin CAN trigger it, and ignoreWindow defaults to false', async () => {
    const res = await api.post('/api/enrollments/run', {
      token: tokenFor(administrator),
      body: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ignoreWindow, false, 'the window bypass must be opt-in');
  });

  test('an admin may explicitly request the window bypass', async () => {
    const res = await api.post('/api/enrollments/run', {
      token: tokenFor(administrator),
      body: { ignoreWindow: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ignoreWindow, true);
  });
});
