// Batch allocation UI: the Custom-count validation, the "N will be used and M
// will remain" line, the exact requests (through the real axios instance), and
// server renders of the panel. The queue itself is server-side; these tests also
// check the client never decides WHICH contacts a batch gets.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import axios from 'axios';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import api from '../src/services/api.js';
import {
  formatCount,
  validateCustomCount,
  batchSize,
  describeBatch,
  allocationPayload,
  allocationNotice,
  batchQueryParam,
  fetchAllocation,
  requestAllocation,
} from '../src/utils/importBatch.js';
import ImportBatchPanel from '../src/components/ImportBatchPanel.jsx';

const h = React.createElement;

let calls = [];
let responder = () => ({ status: 200, data: { success: true } });
api.defaults.adapter = async (config) => {
  calls.push({
    method: String(config.method || '').toLowerCase(),
    url: config.url,
    data: typeof config.data === 'string' && config.data ? JSON.parse(config.data) : config.data,
  });
  const { status, data } = responder(config);
  const response = { data, status, statusText: String(status), headers: {}, config };
  if (status >= 200 && status < 300) return response;
  throw new axios.AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', config, null, response);
};
beforeEach(() => {
  calls = [];
  responder = () => ({ status: 200, data: { success: true } });
});

// ---------------------------------------------------------------------------
describe('the Custom count', () => {
  test('300 of 10,000 is valid', () => {
    assert.deepEqual(validateCustomCount('300', 10000), { ok: true, value: 300 });
  });

  test('equal to Remaining is valid', () => {
    assert.deepEqual(validateCustomCount('9200', 9200), { ok: true, value: 9200 });
  });

  test('greater than Remaining is refused, naming what is left', () => {
    const r = validateCustomCount('9201', 9200);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Only 9,200 contacts remain in this list.');
  });

  const bad = [
    ['zero', '0', /greater than 0/],
    ['negative', '-5', /greater than 0/],
    ['decimal', '2.5', /no decimals/],
    ['decimal with comma', '2,5', /no decimals/],
    ['non-numeric', 'abc', /whole number/],
    ['mixed', '30a', /whole number/],
    ['exponent', '1e3', /whole number/],
    ['empty', '', /Enter how many/],
    ['whitespace', '   ', /Enter how many/],
  ];
  for (const [label, raw, message] of bad) {
    test(`${label} ("${raw}") is refused`, () => {
      const r = validateCustomCount(raw, 10000);
      assert.equal(r.ok, false);
      assert.match(r.error, message);
    });
  }

  test('an exhausted list refuses everything', () => {
    const r = validateCustomCount('1', 0);
    assert.equal(r.ok, false);
    assert.match(r.error, /already been allocated/);
  });
});

describe('what the operator is told before allocating', () => {
  test('the walk-through numbers', () => {
    assert.equal(describeBatch(300, 10000), '300 contacts will be used and 9,700 will remain.');
    assert.equal(describeBatch(500, 9700), '500 contacts will be used and 9,200 will remain.');
    assert.equal(describeBatch(500, 9200), '500 contacts will be used and 8,700 will remain.');
    assert.equal(describeBatch(9200, 9200), '9,200 contacts will be used and 0 will remain.');
  });

  test('one contact is singular', () => {
    assert.equal(describeBatch(1, 5), '1 contact will be used and 4 will remain.');
  });

  test('All Remaining takes everything; Custom takes the typed number; invalid is nothing', () => {
    assert.equal(batchSize('all', '', 9200), 9200);
    assert.equal(batchSize('custom', '500', 9200), 500);
    assert.equal(batchSize('custom', '0', 9200), null);
    assert.equal(batchSize('custom', '9999', 9200), null);
    assert.equal(batchSize('all', '', 0), null, 'nothing to take from an exhausted list');
  });

  test('after allocating: the batch and its persisted size, not row positions', () => {
    const msg = allocationNotice({ batch: { number: 1, size: 2, from: 1, to: 2 }, data: { remaining: 118 } });
    assert.equal(msg, 'Batch 1 allocated: 2 contacts. 118 remain.');
    assert.doesNotMatch(msg, /#/);
  });

  test('after allocating and enrolling: only this batch was enrolled', () => {
    const msg = allocationNotice({
      batch: { number: 2, size: 5 },
      data: { remaining: 113 },
      enrollment: { enrolled: 4, skipped: 0, notEligible: 1, failed: 0 },
    });
    assert.equal(msg, 'Batch 2 allocated: 5 contacts. 113 remain. Enrolled 4 from this batch only (1 not eligible).');
  });

  test('the table view maps to the server’s batch filter', () => {
    assert.equal(batchQueryParam('all'), undefined, 'All contacts = no batch filter');
    assert.equal(batchQueryParam('current'), 'current');
    assert.equal(batchQueryParam('remaining'), 'remaining');
    assert.equal(batchQueryParam('6a0000000000000000000001'), '6a0000000000000000000001');
  });

  test('counts are formatted with thousands separators', () => {
    assert.equal(formatCount(10000), '10,000');
    assert.equal(formatCount(undefined), '0');
  });
});

// ---------------------------------------------------------------------------
describe('the requests', () => {
  test('All Remaining sends only the mode — the server decides which contacts', () => {
    assert.deepEqual(allocationPayload('all', '', ''), { mode: 'all' });
  });

  test('Custom sends a NUMBER, never a list of contacts', () => {
    assert.deepEqual(allocationPayload('custom', ' 300 ', ''), { mode: 'custom', count: 300 });
  });

  test('a chosen campaign is included', () => {
    assert.deepEqual(allocationPayload('custom', '5', 'c1'), { mode: 'custom', count: 5, campaignId: 'c1' });
  });

  test('state is read from the import', async () => {
    responder = () => ({ status: 200, data: { success: true, data: { total: 10000, allocated: 800, remaining: 9200, batches: [] } } });
    const d = await fetchAllocation(api, 'imp1');
    assert.deepEqual([calls[0].method, calls[0].url], ['get', '/contact-imports/imp1/allocation']);
    assert.equal(d.remaining, 9200);
  });

  test('allocation is one POST to the import', async () => {
    responder = () => ({ status: 201, data: { success: true, data: { remaining: 9700 }, batch: { size: 300 } } });
    const d = await requestAllocation(api, 'imp1', { mode: 'custom', count: 300 });
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].method, calls[0].url], ['post', '/contact-imports/imp1/allocate']);
    assert.deepEqual(calls[0].data, { mode: 'custom', count: 300 });
    assert.equal(d.batch.size, 300);
  });

  test('a server refusal (e.g. exceeds remaining) surfaces its message', async () => {
    responder = () => ({ status: 400, data: { success: false, message: 'Only 200 contacts remain in this list — cannot use 500.' } });
    await assert.rejects(requestAllocation(api, 'imp1', { mode: 'custom', count: 500 }), (err) => {
      assert.match(err.response.data.message, /Only 200 contacts remain/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
describe('the panel', () => {
  const STATE = {
    importId: 'imp1',
    filename: 'customers.csv',
    total: 10000,
    allocated: 800,
    remaining: 9200,
    batches: [
      { _id: 'b1', number: 1, mode: 'custom', requested: 300, size: 300, from: 1, to: 300, status: 'complete', campaign: 'c1', campaignName: 'Spring', enrollment: { enrolled: 298 }, allocatedAt: '2026-10-01T10:00:00Z' },
      { _id: 'b2', number: 2, mode: 'custom', requested: 500, size: 500, from: 301, to: 800, status: 'complete', campaign: null, allocatedAt: '2026-10-02T10:00:00Z' },
    ],
    currentBatch: { _id: 'b2', number: 2, size: 500 },
  };
  const render = (props) => renderToStaticMarkup(h(ImportBatchPanel, { importId: 'imp1', ...props }));
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

  test('reopening a list shows the persisted Total / Allocated / Remaining', () => {
    const t = text(render({ initialData: STATE }));
    assert.match(t, /List customers\.csv/);
    assert.match(t, /Total contacts 10,000/);
    assert.match(t, /Allocated 800/);
    assert.match(t, /Remaining 9,200/);
  });

  test('offers All Remaining and Custom, defaulting to All Remaining with its outcome', () => {
    const html = render({ initialData: STATE });
    assert.match(text(html), /All Remaining \(9,200\)/);
    assert.match(text(html), /Custom/);
    assert.equal((html.match(/type="radio"/g) || []).length, 2);
    assert.match(text(html), /9,200 contacts will be used and 0 will remain\./);
  });

  test('shows the batch history by batch, size and where each batch went — not positions', () => {
    const t = text(render({ initialData: STATE }));
    assert.match(t, /Batch 1 300 Spring · 298 enrolled/);
    assert.match(t, /Batch 2 current 500 Allocated only/);
    assert.doesNotMatch(t, /#\d/, 'no row-position numbering');
  });

  test('the latest batch is marked current, earlier ones are not', () => {
    const html = render({ initialData: STATE });
    assert.equal((html.match(/>current</g) || []).length, 1);
  });

  test('each batch can be opened in the Contacts table', () => {
    const viewed = [];
    const html = render({ initialData: STATE, onViewBatch: (b) => viewed.push(b) });
    assert.equal((html.match(/>View<\/button>/g) || []).length, 2);
    assert.doesNotMatch(render({ initialData: STATE }), />View<\/button>/, 'only where a table can show it');
  });

  test('an exhausted list says so and offers no allocation', () => {
    const html = render({ initialData: { ...STATE, allocated: 10000, remaining: 0 } });
    assert.match(text(html), /Every contact in this list has been allocated/);
    assert.doesNotMatch(html, /type="radio"/);
    assert.doesNotMatch(html, /type="submit"/);
  });

  test('a campaign picker is offered when campaigns are given', () => {
    const html = render({ initialData: STATE, campaigns: [{ _id: 'c1', name: 'Spring' }] });
    assert.match(text(html), /Enroll this batch into \(optional\)/);
    assert.match(html, /<option value="c1">Spring<\/option>/);
  });

  test('on the Enrollments page the campaign is fixed', () => {
    const html = render({ initialData: STATE, fixedCampaign: { _id: 'c1', name: 'Spring' } });
    assert.match(text(html), /The batch will be enrolled into Spring/);
    assert.match(text(html), /Allocate & enroll 9,200/);
    assert.doesNotMatch(html, /<select/);
  });

  test('before its state loads it shows a spinner, not stale numbers', () => {
    assert.match(render({}), /Loading list/);
  });

  test('a double click sends one request: a lock guards submit', () => {
    const src = readFileSync(new URL('../src/components/ImportBatchPanel.jsx', import.meta.url), 'utf8');
    assert.match(src, /if \(lockRef\.current \|\| size === null\) return;\s*lockRef\.current = true;/);
    assert.match(src, /finally \{\s*lockRef\.current = false;/);
    assert.match(src, /disabled=\{submitting \|\| size === null\}/);
  });

  test('the panel never handles contact lists itself', () => {
    const src = readFileSync(new URL('../src/components/ImportBatchPanel.jsx', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /contactIds|\.slice\(/, 'no client-side slicing of contacts');
  });
});

describe('where the panel appears', () => {
  const contacts = readFileSync(new URL('../src/pages/Contacts.jsx', import.meta.url), 'utf8');
  const enrollments = readFileSync(new URL('../src/pages/Enrollments.jsx', import.meta.url), 'utf8');

  test('after an import, for the new list', () => {
    assert.match(contacts, /<ImportBatchPanel\s+importId=\{importSummary\.importId\}/);
  });

  test('from Imported lists, for any existing list (no re-upload)', () => {
    assert.match(contacts, /onClick=\{\(\) => setBatchImport\(imp\)\}/);
    assert.match(contacts, /<ImportBatchPanel\s+importId=\{batchImport\._id\}/);
    assert.match(contacts, /imp\.allocation\?\.remaining/);
  });

  test('on Enrollments, for the selected campaign’s list', () => {
    assert.match(enrollments, /fixedCampaign=\{\{ _id: selected\._id, name: selected\.name \}\}/);
  });

  test('Contacts offers All contacts / Current batch / Remaining contacts for a chosen list', () => {
    assert.match(contacts, /key: 'all', label: `All contacts/);
    assert.match(contacts, /key: 'current',/);
    assert.match(contacts, /Current batch — Batch \$\{current\.number\}/);
    assert.match(contacts, /key: 'remaining', label: `Remaining contacts/);
  });

  test('the table asks the SERVER for the view — no client-side slicing', () => {
    assert.match(contacts, /import: listFilter \|\| undefined,\s*batch: listFilter \? batchQueryParam\(batchView\) : undefined,/);
    assert.doesNotMatch(contacts, /contacts\.slice\(/);
  });

  test('each contact row shows its own persisted batch', () => {
    assert.match(contacts, /if \(!c\.importBatch\) return <span className="chip">Remaining<\/span>;/);
    assert.match(contacts, /String\(x\._id\) === String\(c\.importBatch\)/);
  });

  test('after an allocation the table switches to the new current batch', () => {
    assert.match(contacts, /showList\(res\.data\.importId, 'current'\);/);
    assert.match(contacts, /onAllocated=\{onBatchAllocated\}/);
  });

  test('Imported lists can open a list, and history can open one batch', () => {
    assert.match(contacts, /onClick=\{\(\) => showList\(imp\._id\)\}/);
    assert.match(contacts, /showList\(batchImport\._id, b\._id\);/);
  });

  test('the enroll-after-import option says it enrolls EVERY imported contact', () => {
    assert.match(contacts, /Enrolls <strong>every<\/strong> contact created by this import/);
  });

  test('the existing import confirm request is unchanged', () => {
    assert.match(contacts, /api\.post\('\/contacts\/import\/confirm', \{/);
    assert.match(contacts, /enrollCampaignId: enrollCampaignId \|\| undefined/);
  });
});
