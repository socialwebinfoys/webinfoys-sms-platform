// Phase 10 — Stage 8: the preview -> confirm import flow over HTTP.
//
// Covers multer's limits, preview writing nothing, token ownership, replay,
// expiry, and the guarantee that confirm re-parses the STORED upload rather than
// trusting anything the client sends back.
'use strict';

require('../_support/env');

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule, fakeModel, fakeDoc, query } = require('../_support/stubs');
const f = require('../_support/factories');

const logged = [];
stubModule('services/logService', { logEvent: async (e) => void logged.push(e) });
stubModule('services/lookupService', { lookupNumber: async () => ({ valid: true, type: 'mobile' }) });
stubModule('jobs/automationWorker', {
  processDueEnrollments: async () => ({}),
  processDueFollowings: async () => ({}),
  start: () => {},
  stop: () => {},
});

const operator = f.user();
const otherOperator = f.user({ email: 'someone-else@test.invalid' });
const usersById = new Map([
  [String(operator._id), operator],
  [String(otherOperator._id), otherOperator],
]);
stubModule('models/User', fakeModel('User', { findById: (id) => query(usersById.get(String(id)) || null) }));

let existingPhones;
let insertedBatches;
let insertBehaviour;
const Contact = stubModule(
  'models/Contact',
  fakeModel('Contact', {
    find: () => query(existingPhones.map((phone) => ({ phone }))),
    insertMany: async (docs, options) => {
      insertedBatches.push({ docs, options });
      return insertBehaviour(docs);
    },
    countDocuments: async () => 0,
    aggregate: () => query([]),
  })
);

let importDocs;
const Import = stubModule(
  'models/Import',
  fakeModel('Import', {
    create: async (doc) => {
      const saved = fakeDoc({ ...doc, _id: f.oid() });
      importDocs.push(saved);
      return saved;
    },
    find: () => query([]),
  })
);

// The REAL ImportPreview model, so newToken / MAX_PREVIEW_BYTES / PREVIEW_TTL_MS
// and toJSON are the shipped implementations; only persistence is substituted.
const RealImportPreview = require('../../models/ImportPreview');
let previews;
stubModule(
  'models/ImportPreview',
  Object.assign(
    fakeModel('ImportPreview', {
      create: async (doc) => {
        const saved = fakeDoc({ ...doc });
        previews.set(doc.token, saved);
        return saved;
      },
      findOne: (filter) => query(previews.get(filter && filter.token) || null),
    }),
    {
      newToken: RealImportPreview.newToken.bind(RealImportPreview),
      MAX_PREVIEW_BYTES: RealImportPreview.MAX_PREVIEW_BYTES,
      PREVIEW_TTL_MS: RealImportPreview.PREVIEW_TTL_MS,
    }
  )
);

let campaignsById;
stubModule(
  'models/Campaign',
  fakeModel('Campaign', { findById: (id) => query(campaignsById.get(String(id)) || null) })
);

// enrollContactIds is exercised for real in the worker/API enrollment tests; here
// only the call and its arguments matter.
let enrollCalls;
const realEnrollmentController = require('../../controllers/enrollmentController');
stubModule('controllers/enrollmentController', {
  ...realEnrollmentController,
  enrollContactIds: async (args) => {
    enrollCalls.push(args);
    return {
      total: args.targetIds.length,
      enrolled: args.targetIds.length,
      skipped: 0,
      notFound: 0,
      notEligible: 0,
      failed: 0,
      created: [],
      errors: [],
    };
  },
});

const RealSettings = require('../../models/Settings');
stubModule(
  'models/Settings',
  fakeModel('Settings', {
    getSingleton: async () => fakeDoc(f.settings()),
    resolveAllowedLineTypes: RealSettings.resolveAllowedLineTypes,
    LINE_TYPES: RealSettings.LINE_TYPES,
  })
);
for (const m of [
  'models/Enrollment',
  'models/Following',
  'models/Conversation',
  'models/SMSMessage',
  'models/Template',
  'models/SystemLog',
]) {
  stubModule(m, fakeModel(m));
}

const { startApp, tokenFor } = require('../_support/http');

let api;
let token;
let otherToken;

// multipart upload helper: fetch sets the boundary, so content-type must not be
// supplied by hand.
async function upload(path, { filename, content, authToken, contentType = 'text/csv' } = {}) {
  const fd = new FormData();
  if (filename !== null) {
    fd.append('file', new Blob([content], { type: contentType }), filename);
  }
  const res = await fetch(api.base + path, {
    method: 'POST',
    body: fd,
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

before(async () => {
  api = await startApp();
  token = tokenFor(operator);
  otherToken = tokenFor(otherOperator);
});
after(async () => {
  await api.close();
});

beforeEach(() => {
  logged.length = 0;
  existingPhones = [];
  insertedBatches = [];
  importDocs = [];
  previews = new Map();
  campaignsById = new Map();
  enrollCalls = [];
  insertBehaviour = (docs) => ({
    insertedCount: docs.length,
    mongoose: { results: docs.map((d, i) => ({ _id: f.oid(), ...d })) },
  });
});

const GOOD_CSV = 'name,phone\nAda,4155552671\nGrace,4155552672\n';

describe('POST /api/contacts/import/preview', () => {
  test('a valid upload returns a token, a summary and balanced counts', async () => {
    const res = await upload('/api/contacts/import/preview', {
      filename: 'contacts.csv',
      content: GOOD_CSV,
      authToken: token,
    });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.body.previewToken);
    assert.equal(res.body.summary.totalRows, 2);
    assert.equal(res.body.summary.valid, 2);
    assert.equal(res.body.summary.countsBalance, true);
    assert.equal(res.body.validSample.length, 2);
  });

  test('preview WRITES NO CONTACTS and creates no Import record', async () => {
    await upload('/api/contacts/import/preview', {
      filename: 'contacts.csv',
      content: GOOD_CSV,
      authToken: token,
    });
    assert.equal(insertedBatches.length, 0, 'no contact may be inserted by a preview');
    assert.equal(importDocs.length, 0, 'no Import batch may be created by a preview');
  });

  test('the preview response never echoes the uploaded bytes', async () => {
    const res = await upload('/api/contacts/import/preview', {
      filename: 'contacts.csv',
      content: GOOD_CSV,
      authToken: token,
    });
    assert.equal(res.text.includes('fileBuffer'), false);
  });

  test('invalid rows are reported with row numbers and reasons', async () => {
    const res = await upload('/api/contacts/import/preview', {
      filename: 'mixed.csv',
      content: 'name,phone\nAda,4155552671\nBad,nope\n',
      authToken: token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.invalid, 1);
    assert.equal(res.body.invalid[0].row, 3);
    assert.ok(res.body.invalid[0].reason);
  });

  test('a missing file is 400', async () => {
    const res = await upload('/api/contacts/import/preview', { filename: null, authToken: token });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /No file uploaded/);
  });

  test('a disallowed extension is a clean 400, not a 500', async () => {
    const res = await upload('/api/contacts/import/preview', {
      filename: 'contacts.txt',
      content: GOOD_CSV,
      authToken: token,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Only \.csv and \.xlsx files are allowed/);
  });

  test('a file over the 5 MB multer limit is a clean 400', async () => {
    const big = `name,phone\n${'Ada,4155552671\n'.repeat(400_000)}`;
    assert.ok(big.length > 5 * 1024 * 1024, 'fixture must exceed the cap');
    const res = await upload('/api/contacts/import/preview', {
      filename: 'huge.csv',
      content: big,
      authToken: token,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /File too large|too large/i);
  });

  test('a file with no data rows is 400', async () => {
    const res = await upload('/api/contacts/import/preview', {
      filename: 'empty.csv',
      content: 'name,phone\n',
      authToken: token,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /no data rows/);
  });

  test('preview requires authentication', async () => {
    const res = await upload('/api/contacts/import/preview', {
      filename: 'contacts.csv',
      content: GOOD_CSV,
    });
    assert.equal(res.status, 401);
    assert.equal(previews.size, 0);
  });
});

describe('POST /api/contacts/import/confirm', () => {
  async function makePreview({ content = GOOD_CSV, authToken = token } = {}) {
    const res = await upload('/api/contacts/import/preview', {
      filename: 'contacts.csv',
      content,
      authToken,
    });
    assert.equal(res.status, 200, res.text);
    return res.body.previewToken;
  }

  test('confirm commits the previewed rows and returns balanced counts', async () => {
    const previewToken = await makePreview();
    const res = await api.post('/api/contacts/import/confirm', { token, body: { previewToken } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.summary.created, 2);
    assert.equal(res.body.summary.countsBalance, true);
    assert.equal(insertedBatches.length, 1);
    assert.equal(insertedBatches[0].docs.length, 2);
    assert.equal(importDocs.length, 1);
    assert.ok(logged.some((e) => e.eventType === 'import.confirmed'));
  });

  test('inserts use ordered:false and rawResult:true (so nothing vanishes silently)', async () => {
    const previewToken = await makePreview();
    await api.post('/api/contacts/import/confirm', { token, body: { previewToken } });
    assert.equal(insertedBatches[0].options.ordered, false);
    assert.equal(insertedBatches[0].options.rawResult, true);
  });

  test('a missing token is 400', async () => {
    const res = await api.post('/api/contacts/import/confirm', { token, body: {} });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /previewToken is required/);
  });

  test('an unknown token is 404', async () => {
    const res = await api.post('/api/contacts/import/confirm', {
      token,
      body: { previewToken: 'never-issued-token' },
    });
    assert.equal(res.status, 404);
    assert.equal(insertedBatches.length, 0);
  });

  test('ANOTHER USER cannot confirm a preview they did not upload', async () => {
    const previewToken = await makePreview({ authToken: token });
    const res = await api.post('/api/contacts/import/confirm', {
      token: otherToken,
      body: { previewToken },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /belongs to a different user/);
    assert.equal(insertedBatches.length, 0, 'nothing may be imported for the wrong user');
  });

  test('a token cannot be REPLAYED to import the same file twice', async () => {
    const previewToken = await makePreview();
    const first = await api.post('/api/contacts/import/confirm', { token, body: { previewToken } });
    assert.equal(first.status, 200);
    const second = await api.post('/api/contacts/import/confirm', { token, body: { previewToken } });
    assert.equal(second.status, 409);
    assert.match(second.body.message, /already been imported/);
    assert.equal(insertedBatches.length, 1, 'the second attempt must insert nothing');
  });

  test('an EXPIRED preview is refused with 410 even if the TTL has not swept it', async () => {
    const previewToken = await makePreview();
    previews.get(previewToken).expiresAt = new Date(Date.now() - 1000);
    const res = await api.post('/api/contacts/import/confirm', { token, body: { previewToken } });
    assert.equal(res.status, 410);
    assert.match(res.body.message, /expired/);
    assert.equal(insertedBatches.length, 0);
  });

  test('an object-shaped token is refused, not passed to the query', async () => {
    const res = await api.post('/api/contacts/import/confirm', {
      token,
      body: { previewToken: { $ne: '' } },
    });
    assert.equal(res.status, 400);
  });

  test('confirm re-parses the STORED file; rows posted by the client are ignored', async () => {
    const previewToken = await makePreview({ content: 'name,phone\nAda,4155552671\n' });
    const res = await api.post('/api/contacts/import/confirm', {
      token,
      body: {
        previewToken,
        // A hostile client trying to smuggle extra contacts in.
        rows: [{ name: 'Injected', phone: '+19995551234' }],
        valid: [{ name: 'Injected', phone: '+19995551234' }],
        summary: { totalRows: 999, valid: 999 },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.totalRows, 1, 'the stored file decides the totals');
    assert.equal(insertedBatches[0].docs.length, 1);
    const phones = insertedBatches[0].docs.map((d) => d.phone);
    assert.deepEqual(phones, ['+14155552671']);
    assert.equal(phones.includes('+19995551234'), false, 'client-supplied rows must be ignored');
  });

  test('a row the database REJECTS moves from created to invalid, with its row number', async () => {
    const previewToken = await makePreview();
    insertBehaviour = (docs) => ({
      insertedCount: 1,
      mongoose: {
        results: [
          { _id: f.oid(), ...docs[0] },
          new Error('Contact validation failed: email: invalid'),
        ],
      },
    });
    const res = await api.post('/api/contacts/import/confirm', { token, body: { previewToken } });
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.created, 1);
    assert.equal(res.body.summary.invalid, 1);
    assert.equal(res.body.summary.countsBalance, true, 'the buckets must still sum to totalRows');
    const failure = res.body.summary.errors.find((e) => /Rejected on insert/.test(e.reason));
    assert.ok(failure, 'the rejection must be reported');
    assert.equal(failure.row, 3, 'with its original row number, not null');
  });

  test('a thrown bulk write error still reports partial success honestly', async () => {
    const previewToken = await makePreview();
    insertBehaviour = () => {
      const err = new Error('E11000 duplicate key');
      err.insertedDocs = [{ _id: f.oid() }];
      err.writeErrors = [{ index: 1, err: { errmsg: 'E11000 duplicate key error' } }];
      throw err;
    };
    const res = await api.post('/api/contacts/import/confirm', { token, body: { previewToken } });
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.created, 1);
    assert.equal(res.body.summary.invalid, 1);
    assert.equal(res.body.summary.countsBalance, true);
  });

  test('duplicates already in the database are excluded and reported', async () => {
    existingPhones = ['+14155552671'];
    const previewToken = await makePreview();
    const res = await api.post('/api/contacts/import/confirm', { token, body: { previewToken } });
    assert.equal(res.body.summary.duplicatesInDb, 1);
    assert.equal(res.body.summary.created, 1);
    assert.equal(res.body.summary.countsBalance, true);
    assert.equal(insertedBatches[0].docs.length, 1);
  });

  test('confirm requires authentication', async () => {
    const previewToken = await makePreview();
    const res = await api.post('/api/contacts/import/confirm', { body: { previewToken } });
    assert.equal(res.status, 401);
    assert.equal(insertedBatches.length, 0);
  });
});

describe('enroll-after-import', () => {
  async function makePreview(content = GOOD_CSV) {
    const res = await upload('/api/contacts/import/preview', {
      filename: 'contacts.csv',
      content,
      authToken: token,
    });
    return res.body.previewToken;
  }

  test('the newly created contacts are enrolled, with the import-scope check waived', async () => {
    const campaign = f.campaign();
    campaignsById.set(String(campaign._id), campaign);
    const previewToken = await makePreview();
    const res = await api.post('/api/contacts/import/confirm', {
      token,
      body: { previewToken, enrollCampaignId: String(campaign._id) },
    });
    assert.equal(res.status, 200);
    assert.equal(enrollCalls.length, 1);
    assert.equal(enrollCalls[0].targetIds.length, 2);
    assert.equal(
      enrollCalls[0].ignoreImportScope,
      true,
      'the contacts belong to the import just created, so the scope heuristic is waived'
    );
    assert.equal(res.body.enrollment.enrolled, 2);
  });

  test('a BAD campaign id is refused BEFORE anything is imported', async () => {
    const previewToken = await makePreview();
    const res = await api.post('/api/contacts/import/confirm', {
      token,
      body: { previewToken, enrollCampaignId: f.oid(31337) },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /campaign for enrollment was not found/);
    assert.equal(insertedBatches.length, 0, 'no contact may be left imported with no enrollment');
    assert.ok(!previews.get(previewToken).consumedAt, 'the token must stay usable');
  });

  test('a campaign with NO steps is refused before importing', async () => {
    const campaign = f.campaign({ steps: [] });
    campaignsById.set(String(campaign._id), campaign);
    const previewToken = await makePreview();
    const res = await api.post('/api/contacts/import/confirm', {
      token,
      body: { previewToken, enrollCampaignId: String(campaign._id) },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /no steps/);
    assert.equal(insertedBatches.length, 0);
  });

  test('when nothing new is created, nothing is enrolled', async () => {
    const campaign = f.campaign();
    campaignsById.set(String(campaign._id), campaign);
    existingPhones = ['+14155552671', '+14155552672'];
    const previewToken = await makePreview();
    const res = await api.post('/api/contacts/import/confirm', {
      token,
      body: { previewToken, enrollCampaignId: String(campaign._id) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.created, 0);
    assert.equal(enrollCalls.length, 0);
    assert.match(res.body.enrollment.note, /No new contacts were created/);
  });

  test('without enrollCampaignId no enrollment happens at all', async () => {
    const previewToken = await makePreview();
    const res = await api.post('/api/contacts/import/confirm', { token, body: { previewToken } });
    assert.equal(res.status, 200);
    assert.equal(enrollCalls.length, 0);
    assert.equal(res.body.enrollment, null);
  });
});

describe('POST /api/contacts/import (legacy one-shot) uses the same engine', () => {
  test('it imports and reports the same balanced counts', async () => {
    const res = await upload('/api/contacts/import', {
      filename: 'contacts.csv',
      content: GOOD_CSV,
      authToken: token,
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.summary.totalRows, 2);
    assert.equal(res.body.summary.created, 2);
    assert.equal(res.body.summary.countsBalance, true);
    assert.equal(insertedBatches.length, 1);
  });

  test('it enforces the same file-type rule', async () => {
    const res = await upload('/api/contacts/import', {
      filename: 'notes.txt',
      content: GOOD_CSV,
      authToken: token,
    });
    assert.equal(res.status, 400);
  });

  test('it requires authentication', async () => {
    const res = await upload('/api/contacts/import', {
      filename: 'contacts.csv',
      content: GOOD_CSV,
    });
    assert.equal(res.status, 401);
    assert.equal(insertedBatches.length, 0);
  });
});
