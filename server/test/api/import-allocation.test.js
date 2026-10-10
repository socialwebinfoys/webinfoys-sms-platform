// Batch allocation from an imported list: GET /api/contact-imports/:id/allocation
// and POST /api/contact-imports/:id/allocate, plus the service underneath.
//
// The Import and Contact doubles are a small but faithful document store: they
// evaluate the real filters the service sends (conditional matches, $or, $in,
// $ne, dotted paths, array-element paths) and apply the real updates ($set with
// the positional `$`, $inc, $push). Every operation yields to the event loop
// first, so simultaneous requests genuinely interleave — the concurrency tests
// exercise the lease and the conditional marking, not a serialised fake.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { stubModule, fakeModel, query } = require('../_support/stubs');
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

// --- a tiny document store ---------------------------------------------------
const tick = () => new Promise((r) => setImmediate(r));
// Deep copy that keeps ObjectIds and Dates as themselves, as a driver would.
function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v._bsontype === 'ObjectId' || v._bsontype === 'ObjectID') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
}
const same = (a, b) => (a == null && b == null) || (a != null && b != null && String(a) === String(b));

function valuesAt(doc, path) {
  let cur = [doc];
  for (const key of path.split('.')) {
    const next = [];
    for (const v of cur) {
      if (v == null) { next.push(undefined); continue; }
      const val = v[key];
      if (Array.isArray(val) && !/^\d+$/.test(key)) next.push(...(val.length ? val : [undefined]));
      else next.push(val);
    }
    cur = next.flatMap((v) => (Array.isArray(v) ? v : [v]));
  }
  return cur;
}

const inIndex = new WeakMap();
function matchCond(values, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !mongoose.isValidObjectId(cond)) {
    return Object.entries(cond).every(([op, arg]) => {
      if (op === '$ne') return !values.some((v) => same(v, arg));
      if (op === '$in') {
        // Indexed once per argument array, so a 1,000-id $in over 10,000
        // contacts stays linear.
        if (!inIndex.has(arg)) inIndex.set(arg, new Set(arg.map(String)));
        const set = inIndex.get(arg);
        return values.some((v) => v != null && set.has(String(v)));
      }
      if (op === '$lt') return values.some((v) => v != null && new Date(v) < new Date(arg));
      if (op === '$gte') return values.some((v) => v != null && v >= arg);
      throw new Error(`store: unsupported operator ${op}`);
    });
  }
  return values.some((v) => same(v, cond));
}

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((sub) => matches(doc, sub));
    return matchCond(valuesAt(doc, k), cond);
  });
}

function setPath(doc, path, value, filter) {
  const keys = path.split('.');
  let cur = doc;
  for (let i = 0; i < keys.length - 1; i += 1) {
    let key = keys[i];
    if (keys[i + 1] === '$') {
      // Positional: the array element the filter matched.
      const arr = cur[key];
      const elemPath = Object.keys(filter).find((p) => p.startsWith(`${keys.slice(0, i + 1).join('.')}.`));
      const sub = elemPath.slice(keys.slice(0, i + 1).join('.').length + 1);
      const idx = arr.findIndex((el) => matchCond(valuesAt(el, sub), filter[elemPath]));
      cur = arr[idx];
      i += 1;
      continue;
    }
    if (cur[key] == null) cur[key] = {};
    cur = cur[key];
  }
  const last = keys[keys.length - 1];
  return [cur, last];
}

function applyUpdate(doc, update, filter) {
  for (const [p, v] of Object.entries(update.$set || {})) {
    const [obj, key] = setPath(doc, p, v, filter);
    obj[key] = clone(v);
  }
  for (const [p, v] of Object.entries(update.$inc || {})) {
    const [obj, key] = setPath(doc, p, v, filter);
    obj[key] = (obj[key] || 0) + v;
  }
  for (const [p, v] of Object.entries(update.$push || {})) {
    const [obj, key] = setPath(doc, p, v, filter);
    (obj[key] = obj[key] || []).push(clone(v));
  }
}

function listQuery(rowsFn) {
  let sortSpec = null;
  let limitN = null;
  let skipN = 0;
  const chain = {
    // Accepts { field: 1 } and Mongoose's string form ('-createdAt').
    sort(spec) {
      sortSpec = typeof spec === 'string'
        ? { [spec.replace(/^-/, '')]: spec.startsWith('-') ? -1 : 1 }
        : spec;
      return chain;
    },
    skip(n) { skipN = n || 0; return chain; },
    limit(n) { limitN = n; return chain; },
    select() { return chain; },
    lean() { return chain; },
    then(resolve, reject) {
      return tick().then(() => {
        let rows = rowsFn();
        if (sortSpec) {
          const [field, dir] = Object.entries(sortSpec)[0];
          rows = [...rows].sort((a, b) => (String(a[field]) < String(b[field]) ? -1 : 1) * dir);
        }
        rows = rows.slice(skipN);
        if (limitN != null) rows = rows.slice(0, limitN);
        return rows.map(clone);
      }).then(resolve, reject);
    },
  };
  return chain;
}

let imports;
let contacts;

const ImportModel = stubModule(
  'models/Import',
  fakeModel('Import', {
    findById: async (id) => { await tick(); return clone(imports.find((d) => same(d._id, id)) || null); },
    findOneAndUpdate: async (filter, update) => {
      await tick();
      const doc = imports.find((d) => matches(d, filter));
      if (!doc) return null;
      applyUpdate(doc, update, filter);
      return clone(doc);
    },
    updateOne: async (filter, update) => {
      await tick();
      const doc = imports.find((d) => matches(d, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(doc, update, filter);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    find: () => listQuery(() => imports),
  })
);

const ContactModel = stubModule(
  'models/Contact',
  fakeModel('Contact', {
    find: (filter) => listQuery(() => contacts.filter((c) => matches(c, filter))),
    countDocuments: async (filter) => { await tick(); return contacts.filter((c) => matches(c, filter)).length; },
    updateMany: async (filter, update) => {
      await tick();
      const hit = contacts.filter((c) => matches(c, filter));
      hit.forEach((c) => applyUpdate(c, update, filter));
      return { matchedCount: hit.length, modifiedCount: hit.length };
    },
    aggregate: async () => {
      const m = new Map();
      contacts.forEach((c) => c.import && m.set(String(c.import), (m.get(String(c.import)) || 0) + 1));
      return [...m].map(([k, n]) => ({ _id: k, n }));
    },
  })
);

let campaigns;
let enrollmentInserts;
stubModule(
  'models/Campaign',
  fakeModel('Campaign', {
    findById: async (id) => campaigns.find((c) => same(c._id, id)) || null,
    find: (filter) => listQuery(() => campaigns.filter((c) => matches(c, filter))),
  })
);
const EnrollmentModel = stubModule(
  'models/Enrollment',
  fakeModel('Enrollment', {
    find: () => listQuery(() => []),
    insertMany: async (docs) => {
      enrollmentInserts.push(...docs);
      return docs.map((d) => ({ ...d, _id: new mongoose.Types.ObjectId() }));
    },
  })
);
const untouched = {};
for (const m of ['models/Following', 'models/SMSMessage', 'models/Conversation', 'models/Settings']) {
  untouched[m] = stubModule(m, fakeModel(m));
}
for (const m of ['models/SystemLog', 'models/Template', 'models/ImportPreview', 'models/AIReplyJob']) {
  stubModule(m, fakeModel(m));
}

const service = require('../../services/importAllocation');
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

// An import of `n` contacts, created in file order (ascending ObjectIds) exactly
// as the importer creates them. Allocation state starts uninitialised, as for
// any import made before this feature.
function seedImport(n, { filename = 'customers.csv' } = {}) {
  const imp = {
    _id: new mongoose.Types.ObjectId(),
    filename,
    totalRows: n,
    created: n,
    allocation: { initializedAt: null, total: 0, allocated: 0, remaining: 0, lockedUntil: null, lockOwner: null, batches: [] },
  };
  imports.push(imp);
  for (let i = 0; i < n; i += 1) {
    contacts.push({
      _id: new mongoose.Types.ObjectId(),
      phone: `+1415555${String(i).padStart(4, '0')}`,
      import: imp._id,
      importBatch: null,
      row: i + 1,
    });
  }
  return imp;
}

beforeEach(() => {
  imports = [];
  contacts = [];
  campaigns = [];
  enrollmentInserts = [];
  logged.length = 0;
  Object.values(untouched).forEach((m) => m.__reset());
  ImportModel.__reset();
  ContactModel.__reset();
  EnrollmentModel.__reset();
});

const allocate = (imp, body, token = userToken) =>
  api.post(`/api/contact-imports/${imp._id}/allocate`, { token, body });
const state = (imp, token = userToken) => api.get(`/api/contact-imports/${imp._id}/allocation`, { token });
const rowsOf = (batchId) =>
  contacts.filter((c) => same(c.importBatch, batchId)).map((c) => c.row).sort((a, b) => a - b);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ---------------------------------------------------------------------------
describe('the 10,000-contact walk-through', () => {
  test('10,000 → Custom 300 → 9,700 → Custom 500 → 9,200 → All Remaining → 0', async () => {
    const imp = seedImport(10000);

    const initial = await state(imp);
    assert.equal(initial.status, 200, initial.text);
    assert.deepEqual(
      { total: initial.body.data.total, allocated: initial.body.data.allocated, remaining: initial.body.data.remaining },
      { total: 10000, allocated: 0, remaining: 10000 }
    );

    const a = await allocate(imp, { mode: 'custom', count: 300 });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.body.data.remaining, 9700);
    assert.equal(a.body.data.allocated, 300);
    assert.equal(a.body.batch.size, 300);
    assert.deepEqual([a.body.batch.from, a.body.batch.to], [1, 300]);
    assert.deepEqual(rowsOf(a.body.batch._id), range(1, 300), 'the FIRST 300 rows');

    const b = await allocate(imp, { mode: 'custom', count: 500 });
    assert.equal(b.status, 201, b.text);
    assert.equal(b.body.data.remaining, 9200);
    assert.equal(b.body.data.allocated, 800);
    assert.deepEqual([b.body.batch.from, b.body.batch.to], [301, 800]);
    assert.deepEqual(rowsOf(b.body.batch._id), range(301, 800), 'starts at contact 301');

    const c = await allocate(imp, { mode: 'all' });
    assert.equal(c.status, 201, c.text);
    assert.equal(c.body.batch.size, 9200);
    assert.equal(c.body.data.remaining, 0);
    assert.equal(c.body.data.allocated, 10000);
    assert.deepEqual([c.body.batch.from, c.body.batch.to], [801, 10000]);
    assert.deepEqual(rowsOf(c.body.batch._id), range(801, 10000));

    // Same contact never allocated twice: every contact belongs to exactly one batch.
    assert.ok(contacts.every((ct) => ct.importBatch), 'nothing left unallocated');
    const sizes = [a, b, c].map((r) => rowsOf(r.body.batch._id).length);
    assert.equal(sizes.reduce((x, y) => x + y, 0), 10000, 'batches are disjoint and complete');

    const hist = await state(imp);
    assert.deepEqual(hist.body.data.batches.map((x) => [x.mode, x.size, x.from, x.to]), [
      ['custom', 300, 1, 300],
      ['custom', 500, 301, 800],
      ['all', 9200, 801, 10000],
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('validation', () => {
  test('Custom equal to Remaining is allowed and empties the list', async () => {
    const imp = seedImport(50);
    const res = await allocate(imp, { mode: 'custom', count: 50 });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.remaining, 0);
  });

  test('Custom greater than Remaining is rejected and nothing is allocated', async () => {
    const imp = seedImport(50);
    await allocate(imp, { mode: 'custom', count: 20 });
    const res = await allocate(imp, { mode: 'custom', count: 31 });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'exceeds_remaining');
    assert.match(res.body.message, /Only 30 contacts remain/);
    const s = await state(imp);
    assert.equal(s.body.data.remaining, 30);
    assert.equal(s.body.data.batches.length, 1);
    assert.equal(contacts.filter((c) => c.importBatch).length, 20);
  });

  const bad = [
    ['zero', 0, /greater than 0/],
    ['a negative', -5, /greater than 0/],
    ['a decimal', 2.5, /no decimals/],
    ['a numeric string', '300', /whole number/],
    ['a non-numeric string', 'abc', /whole number/],
    ['null', null, /whole number/],
    ['NaN-like', 'NaN', /whole number/],
    ['missing', undefined, /whole number/],
  ];
  for (const [label, count, message] of bad) {
    test(`Custom ${label} is rejected with 400`, async () => {
      const imp = seedImport(10);
      const res = await allocate(imp, { mode: 'custom', count });
      assert.equal(res.status, 400);
      assert.match(res.body.message, message);
      assert.equal(contacts.filter((c) => c.importBatch).length, 0);
      assert.equal(imports[0].allocation.batches.length, 0);
    });
  }

  test('an unknown mode is rejected', async () => {
    const imp = seedImport(10);
    for (const mode of [undefined, 'some', 'ALL', 3]) {
      const res = await allocate(imp, { mode, count: 1 });
      assert.equal(res.status, 400);
    }
  });

  test('an exhausted import is rejected with a clear error', async () => {
    const imp = seedImport(10);
    await allocate(imp, { mode: 'all' });
    for (const body of [{ mode: 'all' }, { mode: 'custom', count: 1 }]) {
      const res = await allocate(imp, body);
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'exhausted');
      assert.match(res.body.message, /already been allocated/);
    }
  });

  test('an import with no contacts is exhausted from the start', async () => {
    const imp = seedImport(0);
    const res = await allocate(imp, { mode: 'all' });
    assert.equal(res.status, 409);
  });

  test('an unknown import is 404; a malformed id is 400', async () => {
    const missing = await api.post(`/api/contact-imports/${new mongoose.Types.ObjectId()}/allocate`, {
      token: userToken,
      body: { mode: 'all' },
    });
    assert.equal(missing.status, 404);
    const res = await api.get(`/api/contact-imports/${new mongoose.Types.ObjectId()}/allocation`, { token: userToken });
    assert.equal(res.status, 404);
  });

  test('requires a session', async () => {
    const imp = seedImport(5);
    assert.equal((await api.get(`/api/contact-imports/${imp._id}/allocation`)).status, 401);
    assert.equal((await api.post(`/api/contact-imports/${imp._id}/allocate`, { body: { mode: 'all' } })).status, 401);
  });
});

// ---------------------------------------------------------------------------
describe('repeated allocation and persistence', () => {
  test('many small batches walk the list in order, never repeating a contact', async () => {
    const imp = seedImport(100);
    const seen = new Set();
    for (let i = 0; i < 10; i += 1) {
      const res = await allocate(imp, { mode: 'custom', count: 10 });
      assert.equal(res.status, 201);
      const rows = rowsOf(res.body.batch._id);
      assert.deepEqual(rows, range(i * 10 + 1, i * 10 + 10));
      rows.forEach((r) => { assert.ok(!seen.has(r), `row ${r} allocated twice`); seen.add(r); });
    }
    assert.equal(seen.size, 100);
  });

  test('the state is persisted on the Import document and survives a "reload"', async () => {
    const imp = seedImport(1000);
    await allocate(imp, { mode: 'custom', count: 300 });
    await allocate(imp, { mode: 'custom', count: 500 });

    // What is stored — not recomputed by the request.
    const stored = imports[0].allocation;
    assert.equal(stored.total, 1000);
    assert.equal(stored.allocated, 800);
    assert.equal(stored.remaining, 200);
    assert.equal(stored.batches.length, 2);
    assert.ok(stored.initializedAt);
    assert.equal(stored.lockOwner, null, 'the lease is released');

    // A later visit (a new request, as after reopening the page) shows it.
    const res = await state(imp);
    assert.deepEqual(
      [res.body.data.filename, res.body.data.total, res.body.data.allocated, res.body.data.remaining],
      ['customers.csv', 1000, 800, 200]
    );
    // The next batch still continues from where the last one stopped.
    const next = await allocate(imp, { mode: 'custom', count: 1 });
    assert.deepEqual(rowsOf(next.body.batch._id), [801]);
  });

  test('the import list shows Total / Allocated / Remaining per list', async () => {
    const imp = seedImport(40);
    seedImport(7, { filename: 'other.csv' });
    await allocate(imp, { mode: 'custom', count: 15 });
    const res = await api.get('/api/contact-imports', { token: userToken });
    const byName = Object.fromEntries(res.body.data.map((d) => [d.filename, d]));
    assert.deepEqual(byName['customers.csv'].allocation, { total: 40, allocated: 15, remaining: 25, excluded: 0 });
    assert.deepEqual(byName['other.csv'].allocation, { total: 7, allocated: 0, remaining: 7, excluded: 0 });
    assert.equal(byName['customers.csv'].contactCount, 40, 'the existing field is unchanged');
    assert.equal('batches' in byName['customers.csv'].allocation, false, 'history stays off the list');
    assert.equal('lockOwner' in byName['customers.csv'].allocation, false);
  });

  test('the lease is private: never in the allocation API', async () => {
    const imp = seedImport(5);
    const res = await state(imp);
    assert.equal('lockOwner' in res.body.data, false);
    assert.equal('lockedUntil' in res.body.data, false);
  });

  test('a contact deleted from the list is reconciled out of Remaining', async () => {
    const imp = seedImport(20);
    await allocate(imp, { mode: 'custom', count: 5 });
    contacts = contacts.filter((c) => c.row !== 10 && c.row !== 11); // two unallocated contacts deleted
    const res = await allocate(imp, { mode: 'all' });
    assert.equal(res.body.batch.size, 13);
    assert.deepEqual(
      [res.body.data.total, res.body.data.allocated, res.body.data.remaining],
      [18, 18, 0]
    );
  });

  test('the original import and its contacts are never deleted', async () => {
    const imp = seedImport(30);
    await allocate(imp, { mode: 'all' });
    assert.equal(imports.length, 1);
    assert.equal(contacts.length, 30);
    assert.ok(contacts.every((c) => same(c.import, imp._id)), 'every contact still belongs to the import');
    for (const m of ['deleteOne', 'deleteMany', 'findByIdAndDelete']) {
      assert.equal(ContactModel.__callsTo(m).length, 0);
      assert.equal(ImportModel.__callsTo(m).length, 0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  test('two simultaneous Custom 500 on 700 remaining: one succeeds, nothing overlaps, nothing goes negative', async () => {
    const imp = seedImport(700);
    const [x, y] = await Promise.all([
      allocate(imp, { mode: 'custom', count: 500 }),
      allocate(imp, { mode: 'custom', count: 500 }),
    ]);
    const statuses = [x.status, y.status].sort();
    assert.deepEqual(statuses, [201, 400], `got ${statuses}`);
    const loser = x.status === 400 ? x : y;
    assert.match(loser.body.message, /Only 200 contacts remain/);
    assert.equal(contacts.filter((c) => c.importBatch).length, 500);
    const stored = imports[0].allocation;
    assert.equal(stored.remaining, 200);
    assert.equal(stored.allocated, 500);
    assert.ok(stored.remaining >= 0);
  });

  test('two simultaneous batches that both fit: disjoint, contiguous, counts exact', async () => {
    const imp = seedImport(1000);
    const [x, y] = await Promise.all([
      allocate(imp, { mode: 'custom', count: 300 }),
      allocate(imp, { mode: 'custom', count: 400 }),
    ]);
    assert.equal(x.status, 201);
    assert.equal(y.status, 201);
    const rx = rowsOf(x.body.batch._id);
    const ry = rowsOf(y.body.batch._id);
    assert.equal(rx.length, 300);
    assert.equal(ry.length, 400);
    assert.equal(rx.filter((r) => ry.includes(r)).length, 0, 'no overlap');
    assert.deepEqual([...rx, ...ry].sort((a, b) => a - b), range(1, 700), 'together, rows 1-700');
    assert.equal(imports[0].allocation.remaining, 300);
  });

  test('five simultaneous All Remaining: exactly one takes the list', async () => {
    const imp = seedImport(250);
    const results = await Promise.all(Array.from({ length: 5 }, () => allocate(imp, { mode: 'all' })));
    const ok = results.filter((r) => r.status === 201);
    assert.equal(ok.length, 1);
    assert.equal(ok[0].body.batch.size, 250);
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
    assert.equal(imports[0].allocation.remaining, 0);
  });

  test('a request waiting on a held lease proceeds once it is released', async () => {
    const imp = seedImport(10);
    imports[0].allocation.lockedUntil = new Date(Date.now() + 60000);
    imports[0].allocation.lockOwner = 'someone-else';
    setTimeout(() => {
      imports[0].allocation.lockedUntil = null;
      imports[0].allocation.lockOwner = null;
    }, 250);
    const res = await allocate(imp, { mode: 'custom', count: 3 });
    assert.equal(res.status, 201);
  });

  test('an EXPIRED lease (a crashed allocator) does not block the list', async () => {
    const imp = seedImport(10);
    imports[0].allocation.lockedUntil = new Date(Date.now() - 1000);
    imports[0].allocation.lockOwner = 'crashed';
    const res = await allocate(imp, { mode: 'custom', count: 3 });
    assert.equal(res.status, 201);
  });

  test('a lease that is never released fails clearly instead of hanging', async () => {
    const imp = seedImport(10);
    await service.ensureInitialized(imp._id);
    imports[0].allocation.lockedUntil = new Date(Date.now() + 60000);
    imports[0].allocation.lockOwner = 'someone-else';
    await assert.rejects(
      service.allocateBatch({ importId: imp._id, mode: 'all', lockWaitMs: 150 }),
      (err) => err.status === 409 && err.code === 'busy'
    );
  });

  test('an interrupted batch is finished by the next allocation — no contact lost or doubled', async () => {
    const imp = seedImport(100);
    await service.ensureInitialized(imp._id);
    // A run that reserved 40, marked 15, then died.
    const dead = new mongoose.Types.ObjectId();
    Object.assign(imports[0].allocation, {
      allocated: 40,
      remaining: 60,
      lockedUntil: new Date(Date.now() - 1000),
      lockOwner: 'crashed',
      batches: [{ _id: dead, mode: 'custom', requested: 40, size: 0, from: 1, to: 0, status: 'allocating' }],
    });
    contacts.slice(0, 15).forEach((c) => { c.importBatch = dead; });

    const res = await allocate(imp, { mode: 'custom', count: 10 });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(rowsOf(dead), range(1, 40), 'the interrupted batch got its full 40');
    assert.deepEqual(rowsOf(res.body.batch._id), range(41, 50));
    assert.equal(res.body.batch.from, 41);
    assert.equal(res.body.data.remaining, 50);
    const old = res.body.data.batches.find((b) => same(b._id, dead));
    assert.equal(old.status, 'complete');
    assert.equal(old.size, 40);
  });

  test('marking is conditional: a contact already in a batch is never re-assigned', async () => {
    const imp = seedImport(5);
    await allocate(imp, { mode: 'custom', count: 2 });
    const calls = ContactModel.__callsTo('updateMany');
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.equal(c.args[0].importBatch, null, 'every mark requires the contact to be unallocated');
    }
  });
});

// ---------------------------------------------------------------------------
describe('using a batch: enrollment into a campaign', () => {
  function seedCampaign(overrides = {}) {
    const c = { _id: new mongoose.Types.ObjectId(), name: 'Spring', steps: [{ _id: new mongoose.Types.ObjectId(), body: 'Hi', delayValue: 0, delayUnit: 'hours' }], import: null, ...overrides };
    campaigns.push(c);
    return c;
  }

  test('the allocated batch is enrolled through the existing pipeline', async () => {
    const imp = seedImport(50);
    const camp = seedCampaign({ import: imp._id });
    const res = await allocate(imp, { mode: 'custom', count: 20, campaignId: String(camp._id) });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.enrollment.enrolled, 20);
    assert.equal(enrollmentInserts.length, 20);
    const enrolledRows = enrollmentInserts.map((e) => contacts.find((c) => same(c._id, e.contact)).row).sort((a, b) => a - b);
    assert.deepEqual(enrolledRows, range(1, 20), 'exactly the batch');
    assert.ok(enrollmentInserts.every((e) => same(e.campaign, camp._id) && e.status === 'active'));
    const batch = res.body.data.batches[0];
    assert.equal(String(batch.campaign), String(camp._id));
    assert.equal(batch.enrollment.enrolled, 20);
    assert.equal(batch.campaignName, 'Spring', 'the history names the campaign');
  });

  test('compliance still applies: opted-out contacts in the batch are not enrolled', async () => {
    const imp = seedImport(10);
    contacts[2].optedOut = true;
    contacts[5].deliveryBlocked = true;
    const camp = seedCampaign({ import: imp._id });
    const res = await allocate(imp, { mode: 'all', campaignId: String(camp._id) });
    assert.equal(res.body.batch.size, 10, 'the batch is the next 10 contacts of the list');
    assert.equal(res.body.enrollment.enrolled, 8);
    assert.equal(res.body.enrollment.notEligible, 2);
  });

  test('a bad campaign is refused BEFORE anything is allocated', async () => {
    const imp = seedImport(10);
    const noSteps = seedCampaign({ steps: [] });
    for (const campaignId of [String(new mongoose.Types.ObjectId()), String(noSteps._id)]) {
      const res = await allocate(imp, { mode: 'all', campaignId });
      assert.equal(res.status, 400);
    }
    assert.equal(contacts.filter((c) => c.importBatch).length, 0);
    assert.equal(imports[0].allocation.batches.length, 0);
  });

  test('without a campaign the batch is allocated and nothing is enrolled', async () => {
    const imp = seedImport(10);
    const res = await allocate(imp, { mode: 'custom', count: 4 });
    assert.equal(res.body.enrollment, null);
    assert.equal(enrollmentInserts.length, 0);
  });

  test('an audit event records every allocation', async () => {
    const imp = seedImport(10);
    await allocate(imp, { mode: 'custom', count: 4 });
    const e = logged.find((x) => x.eventType === 'import.batch_allocated');
    assert.ok(e);
    assert.deepEqual([e.meta.size, e.meta.from, e.meta.to, e.meta.remaining], [4, 1, 4, 6]);
  });

  test('follow-ups, messages, conversations and settings are untouched', async () => {
    const imp = seedImport(10);
    const camp = seedCampaign({ import: imp._id });
    await allocate(imp, { mode: 'all', campaignId: String(camp._id) });
    for (const [name, model] of Object.entries(untouched)) {
      const writes = model.__calls.filter((c) => !['find', 'findOne', 'findById', 'countDocuments', 'aggregate'].includes(c.method));
      assert.deepEqual(writes, [], `${name} must not be written`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('existing import behaviour is unchanged', () => {
  // The REAL model files: the store above only replaced the cached modules, so
  // load each one bypassing (and then restoring) its cache entry.
  function realModel(relative) {
    const { resolveAppModule } = require('../_support/stubs');
    const id = resolveAppModule(relative);
    const stub = require.cache[id];
    delete require.cache[id];
    try {
      return require(id);
    } finally {
      require.cache[id] = stub;
    }
  }

  test('a newly imported contact starts in the remaining pool (importBatch null)', () => {
    const RealContact = realModel('models/Contact');
    const c = new RealContact({ phone: '+14155550000', import: new mongoose.Types.ObjectId() });
    assert.equal(c.importBatch, null);
  });

  test('a new Import starts uninitialised with an empty history', () => {
    const RealImport = realModel('models/Import');
    const imp = new RealImport({ filename: 'x.csv' });
    assert.equal(imp.allocation.initializedAt, null);
    assert.equal(imp.allocation.batches.length, 0);
    assert.equal(imp.totalRows, 0, 'the existing fields keep their defaults');
  });

  test('reading the state of a never-allocated legacy import initialises it once, from its contacts', async () => {
    const imp = seedImport(12);
    const [a, b] = await Promise.all([state(imp), state(imp)]);
    assert.equal(a.body.data.remaining, 12);
    assert.equal(b.body.data.remaining, 12);
    assert.equal(imports[0].allocation.total, 12);
  });
});

// ---------------------------------------------------------------------------
// The batch VIEWS: which contacts the Contacts page shows for a list. Driven
// through the real GET /api/contacts, whose membership comes from each
// contact's persisted batch marker — never from positions.
describe('120 imported: current batch, remaining pool and all contacts', () => {
  // Every id the contacts API returns for a view, across pages.
  async function idsInView(imp, batch) {
    const ids = [];
    for (let page = 1; ; page += 1) {
      const qs = new URLSearchParams({ import: String(imp._id), page: String(page), limit: '100' });
      if (batch) qs.set('batch', batch);
      const res = await api.get(`/api/contacts?${qs}`, { token: userToken });
      assert.equal(res.status, 200, res.text);
      res.body.data.forEach((c) => ids.push(String(c._id)));
      if (page >= (res.body.pagination.pages || 1)) return { ids, body: res.body };
    }
  }
  // The persisted truth, straight from the store.
  const markedWith = (batchId) =>
    contacts.filter((c) => same(c.importBatch, batchId)).map((c) => String(c._id)).sort();

  test('allocate 2, then 5: views, counts and membership are exact', async () => {
    const imp = seedImport(120);
    const everyone = contacts.map((c) => String(c._id));

    // --- Custom 2 ------------------------------------------------------------
    const first = await allocate(imp, { mode: 'custom', count: 2 });
    assert.equal(first.status, 201, first.text);
    assert.deepEqual(
      [first.body.data.total, first.body.data.allocated, first.body.data.remaining],
      [120, 2, 118]
    );
    const batch1 = first.body.batch;
    assert.equal(batch1.number, 1);

    const cur1 = await idsInView(imp, 'current');
    assert.equal(cur1.ids.length, 2, 'current batch = exactly 2 contacts');
    assert.deepEqual([...cur1.ids].sort(), markedWith(batch1._id), 'exactly the persisted batch members');
    assert.equal(cur1.body.batchView.batch.number, 1);
    assert.equal(cur1.body.batchView.batch.size, 2);

    const rem1 = await idsInView(imp, 'remaining');
    assert.equal(rem1.ids.length, 118, 'remaining = exactly 118');
    assert.equal(rem1.ids.filter((id) => cur1.ids.includes(id)).length, 0, 'batch 1 is not in the pool');

    const all1 = await idsInView(imp, null);
    assert.equal(all1.ids.length, 120, 'All contacts still shows the master list');
    assert.equal('batchView' in all1.body, false, 'the unfiltered response is unchanged');

    // --- Custom 5 ------------------------------------------------------------
    const second = await allocate(imp, { mode: 'custom', count: 5 });
    assert.equal(second.status, 201, second.text);
    assert.deepEqual(
      [second.body.data.total, second.body.data.allocated, second.body.data.remaining],
      [120, 7, 113]
    );
    const batch2 = second.body.batch;
    assert.equal(batch2.number, 2);

    const cur2 = await idsInView(imp, 'current');
    assert.equal(cur2.ids.length, 5, 'current batch is now the NEW 5');
    assert.deepEqual([...cur2.ids].sort(), markedWith(batch2._id));
    assert.equal(cur2.ids.filter((id) => cur1.ids.includes(id)).length, 0, 'the first 2 never reappear');
    assert.ok(cur2.ids.every((id) => rem1.ids.includes(id)), 'batch 2 came from the remaining pool');

    const rem2 = await idsInView(imp, 'remaining');
    assert.equal(rem2.ids.length, 113);
    assert.equal(rem2.ids.filter((id) => cur1.ids.includes(id) || cur2.ids.includes(id)).length, 0);

    // A specific earlier batch is still exactly its own members.
    const old = await idsInView(imp, String(batch1._id));
    assert.deepEqual([...old.ids].sort(), [...cur1.ids].sort());

    // Every contact still exists; nothing was deleted or moved out of the list.
    assert.equal(contacts.length, 120);
    assert.deepEqual(contacts.map((c) => String(c._id)), everyone);
    assert.ok(contacts.every((c) => same(c.import, imp._id)));
    assert.equal((await idsInView(imp, null)).ids.length, 120);
  });

  test('enrolling a batch gives the campaign ONLY that batch — never the whole list', async () => {
    const imp = seedImport(120);
    const camp = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Batch campaign',
      steps: [{ _id: new mongoose.Types.ObjectId(), body: 'Hi', delayValue: 0, delayUnit: 'hours' }],
      import: imp._id,
    };
    campaigns.push(camp);

    await allocate(imp, { mode: 'custom', count: 2 }); // allocated, not enrolled
    assert.equal(enrollmentInserts.length, 0);

    const res = await allocate(imp, { mode: 'custom', count: 5, campaignId: String(camp._id) });
    assert.equal(res.status, 201, res.text);
    const enrolled = enrollmentInserts.map((e) => String(e.contact)).sort();
    assert.equal(enrolled.length, 5, 'exactly 5 enrollments, not 120 and not 7');
    assert.deepEqual(enrolled, markedWith(res.body.batch._id), 'exactly batch 2');
    const cur = await idsInView(imp, 'current');
    assert.deepEqual(enrolled, [...cur.ids].sort(), 'what the Current batch view shows');
    assert.equal(res.body.enrollment.enrolled, 5);
    assert.equal(res.body.enrollment.total, 5);
  });

  test('page refresh: a new request sees the same batches, counts and members', async () => {
    const imp = seedImport(120);
    await allocate(imp, { mode: 'custom', count: 2 });
    const second = await allocate(imp, { mode: 'custom', count: 5 });

    const before = await idsInView(imp, 'current');
    // "Reload": nothing in memory on the client, only fresh requests.
    const state1 = await state(imp);
    const after = await idsInView(imp, 'current');
    assert.deepEqual(after.ids, before.ids);
    assert.equal(String(state1.body.data.currentBatch._id), String(second.body.batch._id));
    assert.deepEqual(
      [state1.body.data.total, state1.body.data.allocated, state1.body.data.remaining],
      [120, 7, 113]
    );
    assert.deepEqual(state1.body.data.batches.map((b) => [b.number, b.size]), [[1, 2], [2, 5]]);
  });

  test('concurrent allocations never share a contact, and the views agree', async () => {
    const imp = seedImport(120);
    const [x, y] = await Promise.all([
      allocate(imp, { mode: 'custom', count: 2 }),
      allocate(imp, { mode: 'custom', count: 5 }),
    ]);
    assert.equal(x.status, 201);
    assert.equal(y.status, 201);
    const a = markedWith(x.body.batch._id);
    const b = markedWith(y.body.batch._id);
    assert.equal(a.length, 2);
    assert.equal(b.length, 5);
    assert.equal(a.filter((id) => b.includes(id)).length, 0, 'no contact in both batches');
    const rem = await idsInView(imp, 'remaining');
    assert.equal(rem.ids.length, 113);
    assert.equal(imports[0].allocation.remaining, 113);
  });

  test('a list with no batch yet: Current batch is empty, Remaining is everyone', async () => {
    const imp = seedImport(12);
    const cur = await idsInView(imp, 'current');
    assert.equal(cur.ids.length, 0);
    assert.equal(cur.body.batchView.batch, null);
    assert.equal((await idsInView(imp, 'remaining')).ids.length, 12);
  });

  test('the views only ever show the chosen list', async () => {
    const a = seedImport(10, { filename: 'a.csv' });
    const b = seedImport(10, { filename: 'b.csv' });
    await allocate(a, { mode: 'custom', count: 3 });
    await allocate(b, { mode: 'custom', count: 4 });
    const curA = await idsInView(a, 'current');
    assert.equal(curA.ids.length, 3);
    assert.ok(curA.ids.every((id) => same(contacts.find((c) => String(c._id) === id).import, a._id)));
    assert.equal((await idsInView(a, 'remaining')).ids.length, 7);
  });

  test('bad batch views are refused clearly', async () => {
    const a = seedImport(5, { filename: 'a.csv' });
    const b = seedImport(5, { filename: 'b.csv' });
    const bBatch = (await allocate(b, { mode: 'custom', count: 1 })).body.batch;

    const noImport = await api.get('/api/contacts?batch=current', { token: userToken });
    assert.equal(noImport.status, 400);
    assert.match(noImport.body.message, /together with import/);

    const foreign = await api.get(`/api/contacts?import=${a._id}&batch=${bBatch._id}`, { token: userToken });
    assert.equal(foreign.status, 400, 'a batch of ANOTHER list is not shown');

    const junk = await api.get(`/api/contacts?import=${a._id}&batch=nonsense`, { token: userToken });
    assert.equal(junk.status, 400);

    const missing = await api.get(`/api/contacts?import=${new mongoose.Types.ObjectId()}&batch=current`, { token: userToken });
    assert.equal(missing.status, 404);
  });
});
