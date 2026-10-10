// Contacts: lookup-status filter, Lookup All progress, bulk selection and the
// two bulk deletes. The selection rules are tested directly, the requests go
// through the real axios instance, and the page wiring is checked against the
// source and a server render (the harness does not run effects).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import axios from 'axios';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import api from '../src/services/api.js';
import {
  LOOKUP_OPTIONS,
  lookupOptionLabel,
  lookupCountsLine,
  emptySelection,
  selectAllMatching,
  isChecked,
  toggleContact,
  selectedCount,
  bulkDeletePayload,
  deleteInvalidPayload,
  deleteSelectedMessage,
  deleteInvalidMessage,
  lookupProgress,
  fetchLookupSummary,
  requestLookupAll,
  fetchLookupAllStatus,
  requestBulkDelete,
  requestDeleteInvalid,
} from '../src/utils/contactLookup.js';
import Contacts from '../src/pages/Contacts.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';

const h = React.createElement;

let calls = [];
let responder = () => ({ status: 200, data: { success: true } });
api.defaults.adapter = async (config) => {
  calls.push({
    method: String(config.method || '').toLowerCase(),
    url: config.url,
    params: config.params,
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

const SUMMARY = {
  total: 120,
  counts: { mobile: 87, landline: 8, voip: 5, tollFree: 0, invalid: 17, unknown: 3, not_checked: 0 },
  needsLookup: 0,
};

// ---------------------------------------------------------------------------
describe('the lookup-status filter', () => {
  test('offers All, Mobile, Landline, VoIP, Toll-free, Invalid, Unknown and Not checked', () => {
    assert.deepEqual(LOOKUP_OPTIONS.map((o) => o.label), ['All', 'Mobile', 'Landline', 'VoIP', 'Toll-free', 'Invalid', 'Unknown', 'Not checked']);
  });

  test('its values are exactly the ones the server accepts — no invented states', () => {
    const server = readFileSync(new URL('../../server/services/contactLookup.js', import.meta.url), 'utf8');
    const list = server.match(/const LOOKUP_FILTERS = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
    assert.deepEqual(LOOKUP_OPTIONS.slice(1).map((o) => o.value), list);
    assert.equal(LOOKUP_OPTIONS[0].value, '', 'All sends no lookup filter');
  });

  test('labels carry the real counts from the server', () => {
    assert.equal(lookupOptionLabel(LOOKUP_OPTIONS[0], SUMMARY), 'All (120)');
    assert.equal(lookupOptionLabel(LOOKUP_OPTIONS[5], SUMMARY), 'Invalid (17)');
    assert.equal(lookupOptionLabel(LOOKUP_OPTIONS[1], null), 'Mobile', 'no counts yet: just the name');
  });

  test('the counts line', () => {
    assert.equal(
      lookupCountsLine(SUMMARY),
      'Total: 120 · Mobile: 87 · Landline: 8 · VoIP: 5 · Toll-free: 0 · Invalid: 17 · Unknown: 3 · Not checked: 0'
    );
  });
});

// ---------------------------------------------------------------------------
describe('selection', () => {
  test('ticking contacts one by one, and the selected count', () => {
    let s = emptySelection();
    s = toggleContact(s, 'a');
    s = toggleContact(s, 'b');
    assert.equal(selectedCount(s, 120), 2);
    assert.ok(isChecked(s, 'a'));
    s = toggleContact(s, 'a');
    assert.equal(selectedCount(s, 120), 1);
    assert.ok(!isChecked(s, 'a'));
  });

  test('ticked contacts are kept across pages (ids, not page positions)', () => {
    let s = emptySelection();
    s = toggleContact(s, 'page1-row');
    // …the operator moves to page 2 and ticks another…
    s = toggleContact(s, 'page2-row');
    assert.deepEqual([...s.ids].sort(), ['page1-row', 'page2-row']);
  });

  test('Select All selects the contacts matching the CURRENT filters — all of them, not one page', () => {
    const s = selectAllMatching();
    assert.equal(selectedCount(s, 17), 17, 'Invalid filter: 17 matching -> 17 selected');
    assert.ok(isChecked(s, 'any-visible-row'));
  });

  test('unticking under Select All leaves the rest selected', () => {
    let s = selectAllMatching();
    s = toggleContact(s, 'x');
    assert.equal(selectedCount(s, 17), 16);
    assert.ok(!isChecked(s, 'x'));
    s = toggleContact(s, 'x');
    assert.equal(selectedCount(s, 17), 17);
  });

  test('Clear Selection empties it', () => {
    const s = emptySelection();
    assert.equal(selectedCount(s, 120), 0);
    assert.equal(selectedCount(selectAllMatching(), 0), 0);
  });
});

// ---------------------------------------------------------------------------
describe('confirmation wording', () => {
  test('Delete Selected says how many', () => {
    assert.equal(deleteSelectedMessage(17), 'Delete 17 contacts? This cannot be undone.');
    assert.equal(deleteSelectedMessage(1), 'Delete 1 contact? This cannot be undone.');
  });

  test('Delete All Invalid says how many invalid contacts', () => {
    assert.equal(deleteInvalidMessage(17), 'Delete 17 invalid contacts? This cannot be undone.');
    assert.equal(deleteInvalidMessage(1), 'Delete 1 invalid contact? This cannot be undone.');
  });
});

describe('the delete requests', () => {
  const filters = { import: 'imp1', lookup: 'invalid' };

  test('ticked contacts are sent as ids', () => {
    let s = emptySelection();
    s = toggleContact(s, 'a');
    assert.deepEqual(bulkDeletePayload(s, filters, 17), { ids: ['a'] });
  });

  test('Select All sends the filters and the confirmed count, never a client-built list', () => {
    let s = selectAllMatching();
    s = toggleContact(s, 'kept');
    assert.deepEqual(bulkDeletePayload(s, filters, 17), {
      selectAll: true,
      filters,
      excludeIds: ['kept'],
      expectedCount: 16,
    });
  });

  test('Delete All Invalid always asks for lookup=invalid with the confirmed count', () => {
    assert.deepEqual(deleteInvalidPayload({ import: 'imp1', lookup: 'unknown' }, 17), {
      filters: { import: 'imp1', lookup: 'invalid' },
      expectedCount: 17,
    });
  });

  test('exact endpoints and bodies', async () => {
    responder = () => ({ status: 200, data: { success: true, deleted: 2 } });
    await requestBulkDelete(api, { ids: ['a', 'b'] });
    await requestDeleteInvalid(api, { filters: {}, expectedCount: 3 });
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [
      ['post', '/contacts/bulk-delete'],
      ['post', '/contacts/delete-invalid'],
    ]);
    assert.deepEqual(calls[0].data, { ids: ['a', 'b'] });
    assert.deepEqual(calls[1].data, { filters: {}, expectedCount: 3 });
  });

  test('a changed set (409) surfaces the server message', async () => {
    responder = () => ({ status: 409, data: { success: false, message: 'The invalid contacts changed: 18 now match, not 17.' } });
    await assert.rejects(requestDeleteInvalid(api, { filters: {}, expectedCount: 17 }), (err) => {
      assert.match(err.response.data.message, /18 now match/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
describe('Lookup All', () => {
  test('starts over the chosen list, or every contact', async () => {
    responder = () => ({ status: 202, data: { success: true, job: { status: 'running', total: 5 } } });
    await requestLookupAll(api, 'imp1');
    await requestLookupAll(api, undefined);
    assert.deepEqual(calls.map((c) => [c.method, c.url, c.data]), [
      ['post', '/contacts/lookup-all', { import: 'imp1' }],
      ['post', '/contacts/lookup-all', {}],
    ]);
  });

  test('status and counts are read from the server', async () => {
    responder = (cfg) => ({ status: 200, data: cfg.url.endsWith('status') ? { job: { status: 'idle' } } : SUMMARY });
    assert.deepEqual(await fetchLookupAllStatus(api), { status: 'idle' });
    const s = await fetchLookupSummary(api, { import: 'imp1' });
    assert.equal(s.counts.invalid, 17);
    assert.deepEqual([calls[1].url, calls[1].params], ['/contacts/lookup-summary', { import: 'imp1' }]);
  });

  test('progress while running', () => {
    const p = lookupProgress({ status: 'running', scope: 'leads.csv', total: 120, processed: 30, results: { invalid: 4 }, failed: 1 });
    assert.equal(p.running, true);
    assert.equal(p.percent, 25);
    assert.equal(p.text, 'Looking up leads.csv… 30 of 120 checked · 4 invalid · 1 could not be checked');
  });

  test('finished and stopped runs show the server’s message', () => {
    assert.equal(lookupProgress({ status: 'done', total: 3, processed: 3, message: 'Looked up 3 of 3 contacts.' }).text, 'Looked up 3 of 3 contacts.');
    const stopped = lookupProgress({ status: 'stopped', total: 9, processed: 5, message: 'Twilio Lookup is rate-limiting requests.' });
    assert.equal(stopped.tone, 'error');
    assert.equal(lookupProgress({ status: 'idle' }), null);
    assert.equal(lookupProgress(null), null);
  });
});

// ---------------------------------------------------------------------------
describe('Contacts page wiring', () => {
  const src = readFileSync(new URL('../src/pages/Contacts.jsx', import.meta.url), 'utf8');

  test('ONE filter object drives the list, the counts and the deletes', () => {
    assert.match(src, /params: \{ \.\.\.filterParams, page, limit: 20 \}/);
    assert.match(src, /fetchLookupSummary\(api, \{ \.\.\.filterParams, lookup: undefined \}\)/);
    assert.match(src, /Object\.fromEntries\(Object\.entries\(filterParams\)/);
    assert.match(src, /lookup: lookupFilter \|\| undefined,/);
  });

  test('changing any filter clears the selection', () => {
    assert.match(src, /useEffect\(\(\) => \{ setSelection\(emptySelection\(\)\); \}, \[filterKey\]\);/);
  });

  test('Select All selects the matching set, not the visible page', () => {
    assert.match(src, /onClick=\{\(\) => setSelection\(selectAllMatching\(\)\)\}/);
    assert.match(src, /Select All \(\{formatCount\(matchingTotal\)\}\)/);
    assert.match(src, /const matchingTotal = pagination\.total;/);
  });

  test('Delete All Invalid appears only under the Invalid filter, with the real invalid count', () => {
    assert.match(src, /\{lookupFilter === 'invalid' && invalidCount > 0 && \(/);
    assert.match(src, /setBulkConfirm\(\{ type: 'invalid', count: invalidCount \}\)/);
  });

  test('one delete request per confirmation, and the dialog stays while it runs', () => {
    assert.match(src, /if \(!bulkConfirm \|\| bulkLock\.current\) return;\s*bulkLock\.current = true;/);
    assert.match(src, /onClose=\{\(\) => \{ if \(!bulkBusy\) setBulkConfirm\(null\); \}\}/);
  });

  test('Lookup All polls only while running, and its timer is cleaned up', () => {
    assert.match(src, /if \(!lookupRunning\) return undefined;\s*const id = setInterval\(/);
    assert.match(src, /return \(\) => clearInterval\(id\);/);
    assert.match(src, /disabled=\{lookupRunning \|\| !lookupSummaryData \|\| lookupSummaryData\.needsLookup === 0\}/);
  });

  test('after a delete the list, counts and imported lists refresh; the page stays if it still exists', () => {
    assert.match(src, /if \(page > lastPage\) setPage\(lastPage\);\s*setContactsVersion\(\(v\) => v \+ 1\);\s*loadImports\(\);/);
  });
});

describe('Contacts page render', () => {
  const renderAs = (role) => {
    localStorage.setItem('user', JSON.stringify({ _id: 'u1', name: 'Test', role }));
    localStorage.setItem('token', 'test-jwt');
    try {
      return renderToStaticMarkup(h(AuthProvider, null, h(MemoryRouter, null, h(Contacts))));
    } finally {
      localStorage.clear();
    }
  };

  test('everyone gets the lookup-status filter with all eight options', () => {
    const html = renderAs('agent');
    assert.match(html, /aria-label="Lookup status"/);
    for (const v of ['mobile', 'landline', 'voip', 'tollFree', 'invalid', 'unknown', 'not_checked']) {
      assert.match(html, new RegExp(`<option value="${v}">`));
    }
  });

  test('admins get Lookup All and the selection tools; operators do not', () => {
    const admin = renderAs('admin');
    assert.match(admin, />Lookup All<\/button>/);
    assert.match(admin, />Select All \(0\)<\/button>/);
    assert.match(admin, />Clear Selection<\/button>/);
    const agent = renderAs('agent');
    assert.doesNotMatch(agent, /Lookup All/);
    assert.doesNotMatch(agent, /Select All/);
  });

  test('nothing destructive shows until something is selected', () => {
    const admin = renderAs('admin');
    assert.doesNotMatch(admin, /Delete Selected/);
    assert.doesNotMatch(admin, /Delete All Invalid/);
  });
});
