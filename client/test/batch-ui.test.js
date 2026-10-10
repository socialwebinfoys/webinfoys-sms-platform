// CSV -> Batch across the app: the batch selectors on Contacts, Campaigns and
// Enrollments, batch-scoped Lookup All, and deleting a finished batch.
// The backend enforces every boundary (server/test/api/batch-scope.test.js);
// these tests check the UI asks for exactly the right scope.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import axios from 'axios';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import api from '../src/services/api.js';
import {
  selectableBatches,
  batchOptionLabel,
  deleteBatchMessage,
  requestDeleteBatch,
  NO_BATCHES_MESSAGE,
} from '../src/utils/importBatch.js';
import { requestLookupAll } from '../src/utils/contactLookup.js';
import ImportBatchPanel from '../src/components/ImportBatchPanel.jsx';

const h = React.createElement;
let calls = [];
api.defaults.adapter = async (config) => {
  calls.push({
    method: String(config.method || '').toLowerCase(),
    url: config.url,
    data: typeof config.data === 'string' && config.data ? JSON.parse(config.data) : config.data,
  });
  return { data: { success: true, job: { status: 'running' }, data: {} }, status: 200, statusText: '200', headers: {}, config };
};
beforeEach(() => { calls = []; });

const ALLOCATION = {
  importId: 'imp1',
  filename: 'Dentists_in_Austin_Texas.csv',
  total: 120,
  allocated: 120,
  remaining: 0,
  batches: [
    { _id: 'b1', number: 1, size: 20, contacts: 20, status: 'deleted', allocatedAt: '2026-10-01T10:00:00Z' },
    { _id: 'b2', number: 2, size: 100, contacts: 93, status: 'complete', allocatedAt: '2026-10-02T10:00:00Z' },
    { _id: 'b3', number: 3, size: 0, status: 'allocating', allocatedAt: '2026-10-03T10:00:00Z' },
  ],
  currentBatch: { _id: 'b2', number: 2, size: 100, contacts: 93 },
};

// ---------------------------------------------------------------------------
describe('batch options', () => {
  test('only allocated, not-deleted batches can be chosen', () => {
    assert.deepEqual(selectableBatches(ALLOCATION).map((b) => b._id), ['b2']);
    assert.deepEqual(selectableBatches(null), []);
  });

  test('labels use the LIVE member count: "Batch 2 — 93 contacts"', () => {
    assert.equal(batchOptionLabel(ALLOCATION.batches[1]), 'Batch 2 — 93 contacts');
    assert.equal(batchOptionLabel({ number: 1, size: 1 }), 'Batch 1 — 1 contact');
  });

  test('the no-batches message', () => {
    assert.equal(NO_BATCHES_MESSAGE, 'No batches available. Create a batch from Contacts first.');
  });
});

describe('batch-scoped Lookup All', () => {
  test('sends the list AND the batch; the server resolves the members', async () => {
    await requestLookupAll(api, 'imp1', 'b2');
    await requestLookupAll(api, 'imp1', 'current');
    await requestLookupAll(api, 'imp1', undefined);
    await requestLookupAll(api, undefined, 'b2');
    assert.deepEqual(calls.map((c) => c.data), [
      { import: 'imp1', batch: 'b2' },
      { import: 'imp1', batch: 'current' },
      { import: 'imp1' },
      {},
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('deleting a batch', () => {
  test('the exact confirmation', () => {
    assert.equal(
      deleteBatchMessage(1),
      'Delete Batch 1? This will remove the batch allocation/grouping. This action cannot be undone.'
    );
  });

  test('one DELETE to the batch of the list', async () => {
    await requestDeleteBatch(api, 'imp1', 'b2');
    assert.deepEqual([calls[0].method, calls[0].url], ['delete', '/contact-imports/imp1/batches/b2']);
  });

  const render = (props) => renderToStaticMarkup(h(ImportBatchPanel, { importId: 'imp1', initialData: ALLOCATION, ...props }));
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  test('admins get Delete on live batches only; deleted ones are marked, not deletable or viewable', () => {
    const html = render({ canDeleteBatches: true, onViewBatch: () => {} });
    assert.equal((html.match(/>Delete<\/button>/g) || []).length, 1, 'only Batch 2');
    assert.equal((html.match(/>View<\/button>/g) || []).length, 1);
    assert.match(text(html), /Batch 1 deleted/);
  });

  test('operators get no Delete', () => {
    assert.doesNotMatch(render({ onViewBatch: () => {} }), />Delete<\/button>/);
  });

  test('Total contacts is the LIVE count, noting contacts deleted since', () => {
    const t = text(render({ initialData: { ...ALLOCATION, contacts: 113 } }));
    assert.match(t, /Total contacts 113 \(7 since deleted\)/);
  });

  test('the history shows original size and how many still exist', () => {
    assert.match(text(render({})), /100 \(93 still exist\)/);
  });

  test('the dialog says the contacts are kept and never re-allocated', () => {
    const src = readFileSync(new URL('../src/components/ImportBatchPanel.jsx', import.meta.url), 'utf8');
    assert.match(src, /<p><strong>\{deleteBatchMessage\(batchToDelete\.number\)\}<\/strong><\/p>/);
    assert.match(src, /do not return to the remaining pool, so they are never allocated again/);
    assert.match(src, /onClose=\{\(\) => \{ if \(!deletingBatch\) setBatchToDelete\(null\); \}\}/);
  });
});

// ---------------------------------------------------------------------------
describe('Contacts: CSV -> Batch -> Lookup', () => {
  const src = readFileSync(new URL('../src/pages/Contacts.jsx', import.meta.url), 'utf8');

  test('a Batch selector follows the CSV selector, listing that CSV’s real batches', () => {
    assert.match(src, /aria-label="Batch"/);
    assert.match(src, /selectableBatches\(listAllocation\)\.map\(\(b\) => \(\s*<option key=\{b\._id\} value=\{String\(b\._id\)\}>\{batchOptionLabel\(b\)\}<\/option>/);
    assert.match(src, /<option value="remaining">Remaining/);
  });

  test('Lookup All sends the chosen batch', () => {
    assert.match(src, /requestLookupAll\(api, listFilter \|\| undefined, listFilter \? batchQueryParam\(batchView\) : undefined\)/);
  });

  test('"Delete 7 invalid contacts"', () => {
    assert.match(src, /Delete \{formatCount\(invalidCount\)\} invalid contact\{invalidCount === 1 \? '' : 's'\}/);
  });

  test('the page always says what it shows: count, list, batch, lookup', () => {
    assert.match(src, /Showing \{formatCount\(pagination\.total\)\} contact/);
    assert.match(src, /Batch: <strong>\{scopeName \|\| 'All contacts in this list'\}<\/strong>/);
    assert.match(src, /Lookup: <strong>/);
  });

  test('admins can delete a batch from the Batches dialog; a deleted batch stops being the scope', () => {
    assert.match(src, /canDeleteBatches=\{isAdmin\}/);
    assert.match(src, /showList\(batchImport\._id, 'all'\);/);
  });
});

describe('Campaigns: CSV -> Batch -> Audience', () => {
  const src = readFileSync(new URL('../src/pages/Campaigns.jsx', import.meta.url), 'utf8');

  test('the chosen CSV’s batches are loaded, and a new CSV resets the batch', () => {
    assert.match(src, /fetchAllocation\(api, form\.import\)/);
    assert.match(src, /setForm\(\{ \.\.\.form, import: e\.target\.value, batch: '' \}\)/);
  });

  test('the batch is required on create and sent to the server', () => {
    assert.match(src, /<span>Batch \*<\/span>/);
    assert.match(src, /required=\{modal\.mode === 'create' \|\| !!form\.batch\}/);
    assert.match(src, /batch: form\.import \? \(form\.batch \|\| null\) : undefined,/);
  });

  test('the audience is spelled out: N contacts — Batch 2 of the CSV only', () => {
    assert.match(src, /<strong>Audience: \{formatCount\(chosen\.contacts \?\? chosen\.size\)\} contact/);
    assert.match(src, /— Batch \{chosen\.number\} of \{list\?\.filename \|\| 'this list'\} only\./);
  });

  test('a CSV without batches says so', () => {
    assert.match(src, /\{NO_BATCHES_MESSAGE\}/);
  });

  test('the campaign list shows each campaign’s batch', () => {
    assert.match(src, /c\.batchInfo\.number \? `Batch \$\{c\.batchInfo\.number\}`/);
  });
});

describe('Enrollments: Campaign -> CSV -> Batch -> Contacts', () => {
  const src = readFileSync(new URL('../src/pages/Enrollments.jsx', import.meta.url), 'utf8');

  test('the picker asks the server for the chosen batch only', () => {
    assert.match(src, /params: \{ search: search \|\| undefined, limit: LIST_LIMIT, batch: batch \|\| undefined \}/);
  });

  test('a batch-less choice disables the picker — the whole CSV is never offered', () => {
    assert.match(src, /const selectorDisabled = !campaignId \|\| noImport \|\| requiresBatch;/);
    assert.match(src, /if \(requiresBatch\) return 'Select a batch first';/);
  });

  test('Select All and the enroll request carry the batch', () => {
    assert.match(src, /const batchPart = !scope\?\.fixed && enrollBatch \? \{ batchId: enrollBatch \} : \{\};/);
    assert.match(src, /\{ campaignId, selectAll: true, excludeContactIds: \[\.\.\.excludedIds\], \.\.\.batchPart \}/);
    assert.match(src, /Select all\{eligibleTotal/);
    assert.match(src, /\{batchName \? ` from \$\{batchName\}` : ''\}/);
  });

  test('"Showing 100 contacts from Batch 2", not "100 of 120"', () => {
    assert.match(src, /` · showing \$\{eligibleTotal\.toLocaleString\(\)\} contacts from \$\{batchName\}`/);
  });

  test('a batch-bound campaign shows its batch fixed; changing batch clears the selection', () => {
    assert.match(src, /scope\.fixed \? \(/);
    assert.match(src, /const onBatchChange = \(bid\) => \{\s*setEnrollBatch\(bid\);\s*clearSelection\(\);/);
  });

  test('the "enroll the next batch" shortcut is offered only for campaigns not tied to a batch', () => {
    assert.match(src, /if \(!selected \|\| !listId \|\| selected\.batch\) return null;/);
  });
});
