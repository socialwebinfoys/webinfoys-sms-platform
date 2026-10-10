// Bug #3 — GET /api/users must not hand the whole staff directory to every
// operator.
//
// The only reason a non-admin fetches this list is the inbox assignment
// dropdown, which renders a name against an id. It has never needed anyone's
// email address, account state or timestamps. Admins keep the fuller set the
// Team page genuinely uses.
//
// The User double honours .select(), so these tests assert on the RESPONSE BODY
// the client actually receives rather than on which projection string was passed.
'use strict';

require('../_support/env');

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, query } = require('../_support/stubs');
const f = require('../_support/factories');

stubModule('services/logService', { logEvent: async () => {} });
stubModule('jobs/automationWorker', {
  processDueEnrollments: async () => ({}),
  processDueFollowings: async () => ({}),
  start: () => {},
  stop: () => {},
});

// Full stored rows, including fields that must never leave the server.
const STORED = [
  {
    _id: f.oid(5001),
    name: 'Ada Admin',
    email: 'ada.admin@internal.invalid',
    role: 'admin',
    isActive: true,
    password: '$2b$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-02-01T00:00:00Z'),
    __v: 0,
  },
  {
    _id: f.oid(5002),
    name: 'Ben Operator',
    email: 'ben.operator@internal.invalid',
    role: 'user',
    isActive: true,
    password: '$2b$10$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    createdAt: new Date('2026-01-02T00:00:00Z'),
    updatedAt: new Date('2026-02-02T00:00:00Z'),
    __v: 0,
  },
  {
    _id: f.oid(5003),
    name: 'Cleo Deactivated',
    email: 'cleo.gone@internal.invalid',
    role: 'user',
    isActive: false,
    password: '$2b$10$cccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    createdAt: new Date('2026-01-03T00:00:00Z'),
    updatedAt: new Date('2026-02-03T00:00:00Z'),
    __v: 0,
  },
];

const admin = { _id: STORED[0]._id, name: STORED[0].name, role: 'admin', isActive: true };
const operator = { _id: STORED[1]._id, name: STORED[1].name, role: 'user', isActive: true };

// Applies a Mongoose-style inclusion projection: '_id' is always present unless
// explicitly excluded, which this controller never does.
function project(doc, selectSpec) {
  if (!selectSpec) return { ...doc };
  const fields = String(selectSpec).split(/\s+/).filter(Boolean);
  const out = { _id: doc._id };
  for (const field of fields) {
    if (field.startsWith('+') || field.startsWith('-')) continue;
    if (doc[field] !== undefined) out[field] = doc[field];
  }
  return out;
}

function listQuery(rows) {
  let selectSpec = null;
  const chain = {
    select(spec) {
      selectSpec = spec;
      return chain;
    },
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    lean: () => chain,
    populate: () => chain,
    then: (resolve, reject) =>
      Promise.resolve(rows.map((r) => project(r, selectSpec))).then(resolve, reject),
    catch: (fn) => Promise.resolve(rows.map((r) => project(r, selectSpec))).catch(fn),
  };
  return chain;
}

const User = stubModule(
  'models/User',
  fakeModel('User', {
    // `protect` loads the caller; it must see a role and isActive.
    findById: (id) => {
      const found = [admin, operator].find((u) => String(u._id) === String(id));
      return query(found || null);
    },
    find: (filter) => {
      let rows = STORED;
      if (filter && filter.isActive === true) rows = rows.filter((r) => r.isActive);
      return listQuery(rows);
    },
  })
);

const RealSettings = require('../../models/Settings');
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    getSingleton: async () => f.settings(),
    resolveAllowedLineTypes: RealSettings.resolveAllowedLineTypes,
    LINE_TYPES: RealSettings.LINE_TYPES,
  })
);
for (const m of [
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
  stubModule(m, fakeModel(m));
}

const { startApp, tokenFor } = require('../_support/http');
const { PUBLIC_FIELDS, NON_ADMIN_FIELDS } = require('../../controllers/userController');

let api;
let adminToken;
let operatorToken;

before(async () => {
  api = await startApp();
  adminToken = tokenFor(admin);
  operatorToken = tokenFor(operator);
});
after(async () => {
  await api.close();
});

const SECRET_FIELDS = ['password', 'passwordHash', 'hash', 'salt', 'token', 'jwt', '__v'];

describe('non-admin operator', () => {
  test('receives ONLY _id, name and role', async () => {
    const res = await api.get('/api/users', { token: operatorToken });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length > 0);

    for (const u of res.body.data) {
      assert.deepEqual(
        Object.keys(u).sort(),
        ['_id', 'name', 'role'],
        `unexpected shape: ${JSON.stringify(u)}`
      );
    }
  });

  test('never receives an email address', async () => {
    const res = await api.get('/api/users', { token: operatorToken });
    for (const u of res.body.data) assert.equal('email' in u, false);
    // Belt and braces: no stored address appears anywhere in the payload.
    for (const stored of STORED) {
      assert.equal(res.text.includes(stored.email), false, `leaked ${stored.email}`);
    }
  });

  test('never receives isActive or account timestamps', async () => {
    const res = await api.get('/api/users', { token: operatorToken });
    for (const u of res.body.data) {
      assert.equal('isActive' in u, false);
      assert.equal('createdAt' in u, false);
      assert.equal('updatedAt' in u, false);
    }
  });

  test('cannot see DEACTIVATED accounts even when asking for them', async () => {
    const res = await api.get('/api/users?includeInactive=true', { token: operatorToken });
    assert.equal(res.status, 200);
    const names = res.body.data.map((u) => u.name);
    assert.equal(
      names.includes('Cleo Deactivated'),
      false,
      'includeInactive must be ignored for a non-admin'
    );
    assert.equal(res.body.data.length, 2);
  });

  test('still gets what the inbox assignment dropdown renders (_id and name)', async () => {
    const res = await api.get('/api/users', { token: operatorToken });
    for (const u of res.body.data) {
      assert.ok(u._id, 'the dropdown uses _id as the option value');
      assert.ok(u.name && u.name.length > 0, 'and name as the label');
    }
  });
});

describe('admin', () => {
  test('still receives the fields the Team page uses', async () => {
    const res = await api.get('/api/users', { token: adminToken });
    assert.equal(res.status, 200);
    for (const u of res.body.data) {
      for (const field of ['_id', 'name', 'email', 'role', 'isActive']) {
        assert.ok(field in u, `admin list is missing ${field}, which the Users page renders`);
      }
    }
  });

  test('can see deactivated accounts with includeInactive=true', async () => {
    const res = await api.get('/api/users?includeInactive=true', { token: adminToken });
    const names = res.body.data.map((u) => u.name);
    assert.ok(names.includes('Cleo Deactivated'));
    assert.equal(res.body.data.length, 3);
  });

  test('defaults to active accounts only', async () => {
    const res = await api.get('/api/users', { token: adminToken });
    assert.equal(res.body.data.length, 2);
    assert.equal(res.body.data.some((u) => u.name === 'Cleo Deactivated'), false);
  });
});

describe('no response, for any role, exposes a secret', () => {
  for (const [label, getToken] of [
    ['admin', () => adminToken],
    ['non-admin', () => operatorToken],
  ]) {
    test(`${label}: no password or secret-shaped field`, async () => {
      const res = await api.get('/api/users?includeInactive=true', { token: getToken() });
      for (const u of res.body.data) {
        for (const field of SECRET_FIELDS) {
          assert.equal(field in u, false, `${label} response exposed ${field}`);
        }
      }
    });

    test(`${label}: no bcrypt hash appears in the raw body`, async () => {
      const res = await api.get('/api/users?includeInactive=true', { token: getToken() });
      assert.equal(res.text.includes('$2b$'), false);
      assert.equal(res.text.includes('$2a$'), false);
      for (const stored of STORED) {
        assert.equal(res.text.includes(stored.password), false);
      }
    });
  }
});

describe('unauthorized access', () => {
  test('no token is 401', async () => {
    const res = await api.get('/api/users');
    assert.equal(res.status, 401);
    assert.equal(res.body.data, undefined);
  });

  test('a malformed token is 401', async () => {
    const res = await api.get('/api/users', { token: 'not.a.jwt' });
    assert.equal(res.status, 401);
  });

  test('a token signed with the wrong key is 401', async () => {
    const { tokenSignedWith } = require('../_support/http');
    const res = await api.get('/api/users', {
      token: tokenSignedWith(operator, 'a-completely-different-signing-key-01'),
    });
    assert.equal(res.status, 401);
  });
});

describe('the projections themselves', () => {
  test('NON_ADMIN_FIELDS names only name and role', () => {
    assert.deepEqual(NON_ADMIN_FIELDS.split(/\s+/).filter(Boolean).sort(), ['name', 'role']);
  });

  test('neither projection ever selects a password', () => {
    for (const spec of [PUBLIC_FIELDS, NON_ADMIN_FIELDS]) {
      assert.equal(/password/.test(spec), false, `projection "${spec}" mentions password`);
    }
  });

  test('the non-admin projection is a strict subset of the admin one', () => {
    const adminFields = new Set(PUBLIC_FIELDS.split(/\s+/).filter(Boolean));
    for (const field of NON_ADMIN_FIELDS.split(/\s+/).filter(Boolean)) {
      assert.ok(adminFields.has(field), `${field} is not part of the admin projection`);
    }
  });
});
