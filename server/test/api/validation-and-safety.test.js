// Phase 10 — Stage 2D/2E/2F: input validation, query safety, secret hygiene.
//
// The query-safety tests assert on the FILTER the controller actually handed to
// the model, not just on the HTTP status, because "it returned 200" would not
// prove that a Mongo operator was neutralised.
'use strict';

require('../_support/env');

const { test, before, after, describe } = require('node:test');
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

// Mongoose rejects a malformed ObjectId with a CastError; emulate that so the
// central error handler's mapping is genuinely exercised.
function castError(path, value) {
  const err = new Error(`Cast to ObjectId failed for value "${value}" at path "${path}"`);
  err.name = 'CastError';
  err.path = path;
  err.value = value;
  return err;
}
const isObjectId = (v) => /^[0-9a-fA-F]{24}$/.test(String(v));

const Contact = stubModule(
  'models/Contact',
  fakeModel('Contact', {
    findById: (id) => {
      if (!isObjectId(id)) return Promise.reject(castError('_id', id));
      return query(null);
    },
    find: () => query([]),
    countDocuments: async () => 0,
    create: async (doc) => fakeDoc({ ...doc, _id: f.oid() }),
  })
);

const settingsDoc = fakeDoc(f.settings());
const RealSettings = require('../../models/Settings');
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    getSingleton: async () => settingsDoc,
    resolveAllowedLineTypes: RealSettings.resolveAllowedLineTypes,
    LINE_TYPES: RealSettings.LINE_TYPES,
  })
);

const Log = stubModule('models/SystemLog', fakeModel('SystemLog'));
for (const m of [
  'models/Campaign',
  'models/Enrollment',
  'models/Following',
  'models/Import',
  'models/Conversation',
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

describe('malformed ObjectIds map to 400, never 500', () => {
  test('GET /api/contacts/:id with a non-ObjectId is 400', async () => {
    const res = await api.get('/api/contacts/not-an-object-id', { token: userToken });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Invalid value for _id/);
  });

  test('the 400 body carries no stack trace', async () => {
    const res = await api.get('/api/contacts/not-an-object-id', { token: userToken });
    assert.equal('stack' in res.body, false);
    assert.equal(res.text.includes('node_modules'), false);
    assert.equal(res.text.includes('at Object.'), false);
  });
});

describe('pagination is clamped, never trusted', () => {
  const cases = [
    ['?page=0', 1, 20],
    ['?page=-5', 1, 20],
    ['?page=abc', 1, 20],
    // 0 is falsy, so it is read as "not supplied" and the default applies.
    ['?limit=0', 1, 20],
    ['?limit=-10', 1, 1],
    ['?limit=99999', 1, 100],
    ['?limit=abc', 1, 20],
    ['?page=3&limit=50', 3, 50],
    ['?page=1.9&limit=10.9', 1, 10],
  ];
  for (const [qs, expectedPage, expectedLimit] of cases) {
    test(`GET /api/contacts${qs} -> page ${expectedPage}, limit ${expectedLimit}`, async () => {
      const res = await api.get(`/api/contacts${qs}`, { token: userToken });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.pagination.page, expectedPage);
      assert.equal(res.body.pagination.limit, expectedLimit);
    });
  }

  test('an array-shaped page parameter does not crash the handler', async () => {
    const res = await api.get('/api/contacts?page=1&page=2', { token: userToken });
    assert.equal(res.status, 200);
  });
});

describe('sort is allow-listed (unindexed-field and injection defence)', () => {
  test('an allowed field is accepted', async () => {
    const res = await api.get('/api/contacts?sort=-createdAt', { token: userToken });
    assert.equal(res.status, 200);
  });

  const rejected = ['password', 'lookup.carrier', '__proto__', 'constructor', '{"$where":"1"}'];
  for (const value of rejected) {
    test(`sort=${value} is refused with 400 and the allow-list is disclosed`, async () => {
      const res = await api.get(`/api/contacts?sort=${encodeURIComponent(value)}`, {
        token: userToken,
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /Allowed fields: createdAt, name, phone/);
    });
  }

  test('an array-shaped sort degrades instead of crashing', async () => {
    const res = await api.get('/api/contacts?sort=name&sort=phone', { token: userToken });
    assert.equal(res.status, 200);
  });
});

describe('regex injection: a search term is escaped, not interpreted', () => {
  function lastFilter() {
    const calls = Contact.__callsTo('find');
    return calls[calls.length - 1].args[0];
  }

  test('"." is matched literally, not as "any character"', async () => {
    Contact.__reset();
    await api.get('/api/contacts?search=.', { token: userToken });
    const re = lastFilter().$or[0].name;
    assert.ok(re instanceof RegExp);
    assert.equal(re.source, '\\.');
    assert.equal(re.test('Ada'), false, 'an unescaped "." would match any name');
  });

  test('".*" cannot become a match-everything pattern', async () => {
    Contact.__reset();
    await api.get('/api/contacts?search=.*', { token: userToken });
    const re = lastFilter().$or[0].name;
    assert.equal(re.source, '\\.\\*');
    assert.equal(re.test('anything'), false);
  });

  const metacharacters = ['(', ')', '[', ']', '{', '}', '+', '?', '^', '$', '|', '\\'];
  for (const ch of metacharacters) {
    test(`the metacharacter ${JSON.stringify(ch)} is escaped and does not throw`, async () => {
      Contact.__reset();
      const res = await api.get(`/api/contacts?search=${encodeURIComponent(ch)}`, {
        token: userToken,
      });
      assert.equal(res.status, 200, res.text);
      const re = lastFilter().$or[0].name;
      assert.ok(re instanceof RegExp);
      assert.equal(re.test(ch), true, 'the literal character should still match itself');
    });
  }

  test('a catastrophic-backtracking pattern is inert once escaped', async () => {
    Contact.__reset();
    const evil = '(a+)+$';
    const res = await api.get(`/api/contacts?search=${encodeURIComponent(evil)}`, {
      token: userToken,
    });
    assert.equal(res.status, 200);
    const re = lastFilter().$or[0].name;
    // Escaped, so this is a literal string match and cannot backtrack.
    assert.equal(re.source, '\\(a\\+\\)\\+\\$');
  });
});

describe('Mongo operator injection is neutralised before the filter', () => {
  function lastFilter() {
    const calls = Contact.__callsTo('find');
    return calls[calls.length - 1].args[0];
  }

  test('search[$ne] does not reach the filter as an operator', async () => {
    Contact.__reset();
    const res = await api.get('/api/contacts?search[$ne]=', { token: userToken });
    assert.equal(res.status, 200, res.text);
    const filter = lastFilter();
    assert.equal('$or' in filter, false, 'an object-shaped search must produce no $or clause');
  });

  test('tag[$ne] does not reach the filter', async () => {
    Contact.__reset();
    await api.get('/api/contacts?tag[$ne]=x', { token: userToken });
    assert.equal('tags' in lastFilter(), false);
  });

  test('import[$ne] does not reach the filter', async () => {
    Contact.__reset();
    await api.get('/api/contacts?import[$ne]=x', { token: userToken });
    assert.equal('import' in lastFilter(), false);
  });

  test('a repeated search parameter collapses to the first scalar', async () => {
    Contact.__reset();
    await api.get('/api/contacts?search=ada&search=grace', { token: userToken });
    assert.equal(lastFilter().$or[0].name.source, 'ada');
  });

  test('optedOut=false uses $ne:true so legacy contacts are included', async () => {
    Contact.__reset();
    await api.get('/api/contacts?optedOut=false', { token: userToken });
    assert.deepEqual(lastFilter().optedOut, { $ne: true });
  });

  test('deliveryBlocked=false uses $ne:true for the same reason', async () => {
    Contact.__reset();
    await api.get('/api/contacts?deliveryBlocked=false', { token: userToken });
    assert.deepEqual(lastFilter().deliveryBlocked, { $ne: true });
  });

  test('an unrecognised boolean value leaves the filter untouched', async () => {
    Contact.__reset();
    await api.get('/api/contacts?optedOut=maybe', { token: userToken });
    assert.equal('optedOut' in lastFilter(), false);
  });
});

describe('GET /api/logs — contact id and search are validated', () => {
  test('a malformed contact id is refused with 400 before any query', async () => {
    const res = await api.get('/api/logs?contact=not-an-id', { token: userToken });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Invalid contact id/);
  });

  test('a contact id of the right shape is accepted', async () => {
    const res = await api.get(`/api/logs?contact=${f.oid(7)}`, { token: userToken });
    assert.equal(res.status, 200);
  });

  test('an object-shaped contact id is DROPPED, never passed through as an operator', async () => {
    // queryString collapses the object to '', which is falsy, so no contact
    // filter is applied at all. The request succeeds unfiltered rather than
    // reaching Mongo with { contact: { $ne: '' } }.
    Log.__reset();
    const res = await api.get('/api/logs?contact[$ne]=', { token: userToken });
    assert.equal(res.status, 200);
    assert.equal('contact' in Log.__callsTo('find')[0].args[0], false);
  });

  test('the log search term is escaped', async () => {
    Log.__reset();
    await api.get('/api/logs?search=.*', { token: userToken });
    const filter = Log.__callsTo('find')[0].args[0];
    assert.equal(filter.$or[0].message.source, '\\.\\*');
  });

  test('an unknown severity is ignored rather than injected', async () => {
    Log.__reset();
    await api.get('/api/logs?severity=critical', { token: userToken });
    assert.equal('severity' in Log.__callsTo('find')[0].args[0], false);
  });

  test('a known severity is applied', async () => {
    Log.__reset();
    await api.get('/api/logs?severity=error', { token: userToken });
    assert.equal(Log.__callsTo('find')[0].args[0].severity, 'error');
  });
});

describe('enum validation', () => {
  test('DELETE /api/enrollments rejects an unknown status filter', async () => {
    const res = await api.delete('/api/enrollments?status=bogus', { token: adminToken });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Invalid status filter/);
  });

  test('DELETE /api/enrollments accepts a known status filter', async () => {
    const res = await api.delete('/api/enrollments?status=failed', { token: adminToken });
    assert.equal(res.status, 200);
  });

  test('POST /api/contacts rejects a malformed phone with 400', async () => {
    const res = await api.post('/api/contacts', {
      token: userToken,
      body: { name: 'Ada', phone: 'definitely-not-a-phone' },
    });
    assert.equal(res.status, 400);
  });

  test('PATCH /api/contacts/:id/opt-out requires a boolean', async () => {
    const res = await api.patch(`/api/contacts/${f.oid(8)}/opt-out`, {
      token: userToken,
      body: { optedOut: 'yes' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /must be true or false/);
  });
});

describe('PUT /api/settings/twilio validation', () => {
  const bad = [
    [{ allowedLineTypes: [] }, /at least one allowed line type/, 'empty list would block everything'],
    [{ allowedLineTypes: 'mobile' }, /must be an array/, 'non-array'],
    [{ allowedLineTypes: ['mobile', 'satellite'] }, /Unknown line type/, 'unknown type'],
    [{ allowedLineTypes: ['MOBILE'] }, /Unknown line type/, 'case must match exactly'],
    [{ lookupMaxAgeDays: 0 }, /between 1 and 3650/, 'below range'],
    [{ lookupMaxAgeDays: 4000 }, /between 1 and 3650/, 'above range'],
    [{ lookupMaxAgeDays: 1.5 }, /whole number/, 'not an integer'],
    [{ deliveryFailureThreshold: 0 }, /between 1 and 20/, 'below range'],
    [{ deliveryFailureThreshold: 21 }, /between 1 and 20/, 'above range'],
  ];
  for (const [body, pattern, why] of bad) {
    test(`${JSON.stringify(body)} is refused (${why})`, async () => {
      const res = await api.put('/api/settings/twilio', { token: adminToken, body });
      assert.equal(res.status, 400, res.text);
      assert.match(res.body.message, pattern);
    });
  }

  test('a valid line-type list is accepted and echoed back as the effective policy', async () => {
    const res = await api.put('/api/settings/twilio', {
      token: adminToken,
      body: { allowedLineTypes: ['mobile'] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.settings.allowedLineTypes, ['mobile']);
    assert.equal(res.body.settings.allowedLineTypesConfigured, true);
  });

  test('credential fields in the body are ignored, never stored', async () => {
    const res = await api.put('/api/settings/twilio', {
      token: adminToken,
      body: {
        smsEnabled: true,
        accountSid: 'ACdeadbeefdeadbeefdeadbeefdeadbee',
        authToken: 'super-secret-token',
        twilioAuthToken: 'super-secret-token',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(settingsDoc.authToken, undefined);
    assert.equal(settingsDoc.accountSid, undefined);
    assert.equal(res.text.includes('super-secret-token'), false);
  });
});

describe('PUT /api/settings/automation validation', () => {
  const bad = [
    [{ sendingWindow: { startHour: -1 } }, /startHour must be 0-23/],
    [{ sendingWindow: { startHour: 24 } }, /startHour must be 0-23/],
    [{ sendingWindow: { endHour: 0 } }, /endHour must be 1-24/],
    [{ sendingWindow: { endHour: 25 } }, /endHour must be 1-24/],
    [{ sendingWindow: { timezone: 'Mars/Olympus' } }, /Invalid timezone/],
    [{ sendDays: 'monday' }, /must be an array/],
    [{ sendDays: [] }, /at least one sending day/],
    [{ sendDays: [7] }, /day numbers 0-6/],
    [{ sendDays: [-1] }, /day numbers 0-6/],
    [{ maxSendsPerRun: 0 }, /between 1 and 1000/],
    [{ maxSendsPerRun: 1001 }, /between 1 and 1000/],
    [{ maxSendsPerRun: 2.5 }, /between 1 and 1000/],
  ];
  for (const [body, pattern] of bad) {
    test(`${JSON.stringify(body)} is refused`, async () => {
      const res = await api.put('/api/settings/automation', { token: adminToken, body });
      assert.equal(res.status, 400, res.text);
      assert.match(res.body.message, pattern);
    });
  }

  test('a window whose start equals its end is refused (it would silently halt sending)', async () => {
    const res = await api.put('/api/settings/automation', {
      token: adminToken,
      body: { sendingWindow: { startHour: 9, endHour: 9 } },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /never opens/);
  });

  test('0-24 is accepted as the explicit all-day window', async () => {
    const res = await api.put('/api/settings/automation', {
      token: adminToken,
      body: { sendingWindow: { startHour: 0, endHour: 24 } },
    });
    assert.equal(res.status, 200);
  });

  test('maxSendsPerRun: null clears the override', async () => {
    const res = await api.put('/api/settings/automation', {
      token: adminToken,
      body: { maxSendsPerRun: null },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.maxSendsPerRun, null);
  });
});

describe('body limits and malformed payloads', () => {
  test('malformed JSON is a clean 400, not a 500', async () => {
    const res = await api.post('/api/auth/login', { raw: '{"email": "a@b.c", ' });
    assert.equal(res.status, 400);
    assert.equal(res.body === null || res.body.success === false, true);
  });

  test('a JSON body over the 1 MB cap is refused with 413', async () => {
    const huge = JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(1_200_000) });
    const res = await api.post('/api/auth/login', { raw: huge });
    assert.equal(res.status, 413);
  });

  test('a body just under the cap is accepted by the parser (and then fails auth, not parsing)', async () => {
    const body = JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(500_000) });
    const res = await api.post('/api/auth/login', { raw: body });
    assert.notEqual(res.status, 413);
  });

  test('an oversized urlencoded body is also refused', async () => {
    const res = await api.post('/api/auth/login', {
      raw: `email=a@b.c&password=${'x'.repeat(1_200_000)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 413);
  });

  test('an unknown route returns a JSON 404, not an HTML error page', async () => {
    const res = await api.get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /Route not found/);
  });
});

describe('Stage 2F — secret hygiene across responses', () => {
  const SECRETS = () => [
    process.env.JWT_SECRET,
    process.env.MONGO_URI,
    process.env.ADMIN_PASSWORD,
  ];

  const ENDPOINTS = [
    ['GET', '/api/health', false],
    ['GET', '/api/settings/twilio', true],
    ['GET', '/api/settings/automation', true],
    ['GET', '/api/contacts', true],
    ['GET', '/api/users', true],
    ['GET', '/api/logs', true],
    ['GET', '/api/analytics/overview', true],
    ['GET', '/api/delivery/report', true],
  ];

  for (const [method, path, needsAuth] of ENDPOINTS) {
    test(`${method} ${path} leaks no secret value`, async () => {
      const res = await api.request(method, path, needsAuth ? { token: adminToken } : {});
      for (const secret of SECRETS()) {
        if (!secret) continue;
        assert.equal(res.text.includes(secret), false, `${path} leaked a secret value`);
      }
      for (const name of ['authToken', 'JWT_SECRET', 'MONGO_URI', 'mongodb://', 'mongodb+srv']) {
        assert.equal(res.text.includes(name), false, `${path} mentioned ${name}`);
      }
    });
  }

  test('GET /api/settings/twilio reports Twilio status without the token', async () => {
    const res = await api.get('/api/settings/twilio', { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok('twilio' in res.body);
    assert.equal('authToken' in res.body.twilio, false);
    assert.deepEqual(Object.keys(res.body.twilio).sort(), [
      'accountSid',
      'configured',
      'from',
      'simulate',
    ]);
  });

  test('/api/health discloses only the environment name, no configuration', async () => {
    const res = await api.get('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'environment',
      'service',
      'status',
      'success',
      'timestamp',
    ]);
  });

  test('a 500 response outside development carries no stack trace', async () => {
    // Force an unexpected failure inside a handler.
    const Contacts = require('../../models/Contact');
    const original = Contacts.countDocuments;
    Contacts.countDocuments = async () => {
      throw new Error('boom: /secret/path/to/file.js');
    };
    try {
      const res = await api.get('/api/contacts', { token: userToken });
      assert.equal(res.status, 500);
      assert.equal('stack' in res.body, false);
      assert.equal(res.text.includes('at '), false);
    } finally {
      Contacts.countDocuments = original;
    }
  });

  test('security headers from helmet are present', async () => {
    const res = await api.get('/api/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(res.headers.get('x-dns-prefetch-control'));
    assert.equal(res.headers.get('x-powered-by'), null, 'Express should not advertise itself');
  });
});

describe('CORS allow-list', () => {
  test('a permitted origin is reflected', async () => {
    const res = await api.get('/api/health', { headers: { origin: 'http://localhost:5173' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  test('a disallowed origin receives NO CORS header (the browser then blocks it)', async () => {
    const res = await api.get('/api/health', { headers: { origin: 'https://evil.example.com' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.status, 200, 'it must not 500 — the browser enforces the block');
  });

  test('a request with no Origin header is allowed (server-to-server, Twilio)', async () => {
    const res = await api.get('/api/health');
    assert.equal(res.status, 200);
  });
});
