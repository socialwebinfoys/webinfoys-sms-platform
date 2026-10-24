// Audit of Inbox bulk selection and deletion.
//
// The whole flow is driven through utils/inboxSelection.js with the REAL axios
// instance and a stub transport (the harness blocks real network access), so
// each test asserts the exact request that would reach the server — method,
// path and body — and what the Inbox would show afterwards. Nothing here, or
// anywhere in this suite, can reach a real backend or real data.
//
// Answers, as tested:
//   * Select All selects the conversations on the CURRENT PAGE of the current
//     filter and search — never other pages — and says so.
//   * Delete Selected sends exactly the ids the dialog counted to
//     POST /conversations/bulk-delete, and never calls Delete All.
//   * Delete All is a separate endpoint, a separate dialog, and needs a typed
//     phrase; without it nothing is sent.
//   * A failed request is never reported as a success.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import axios from 'axios';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import api from '../src/services/api.js';
import ConfirmDialog from '../src/components/ConfirmDialog.jsx';
import {
  DELETE_SELECTED_CONFIRM,
  DELETE_ALL_CONFIRM,
  DELETE_PRESERVED_NOTE,
  DELETE_ALL_PHRASE,
  deleteAllPhraseMatches,
  deleteSelectedTitle,
  deleteAllTitle,
  selectionSummary,
  selectAllState,
  toggleSelectAll,
  toggleSelected,
  pruneSelection,
  runBulkDelete,
  requestInboxTotal,
} from '../src/utils/inboxSelection.js';

const h = React.createElement;
const source = readFileSync(new URL('../src/pages/Inbox.jsx', import.meta.url), 'utf8');

// --- stub transport ------------------------------------------------------------
let calls = [];
let responder = () => ({ status: 200, data: { success: true } });
api.defaults.adapter = async (config) => {
  calls.push({
    method: String(config.method || '').toLowerCase(),
    url: config.url,
    params: config.params,
    data: typeof config.data === 'string' && config.data ? JSON.parse(config.data) : config.data,
  });
  const r = responder(config);
  if (r.networkError) throw new axios.AxiosError('Network Error', 'ERR_NETWORK', config, {});
  const response = { data: r.data, status: r.status, statusText: String(r.status), headers: {}, config };
  if (r.status >= 200 && r.status < 300) return response;
  throw new axios.AxiosError(`Request failed with status code ${r.status}`, 'ERR_BAD_RESPONSE', config, null, response);
};
beforeEach(() => {
  calls = [];
  responder = () => ({ status: 200, data: { success: true } });
});

// 65 conversations, 20 per page: page 1 shows c00..c19.
const ALL = Array.from({ length: 65 }, (_, i) => ({ _id: `c${String(i).padStart(2, '0')}` }));
const PAGE1 = ALL.slice(0, 20);
const ids = (rows) => rows.map((r) => r._id);
const okBulk = (deletedIds) => ({
  status: 200,
  data: { success: true, deleted: deletedIds.length, skipped: 0, deletedIds, unreadConversations: 3, message: `${deletedIds.length} conversations deleted.` },
});

// ---------------------------------------------------------------------------
describe('Select All is page-scoped', () => {
  test('selects exactly the visible page — 20 of 65 — and nothing from other pages', () => {
    const selected = toggleSelectAll(new Set(), ids(PAGE1));
    assert.deepEqual([...selected].sort(), ids(PAGE1).sort());
    assert.equal(selected.size, 20);
    for (const other of ids(ALL.slice(20))) assert.equal(selected.has(other), false, other);
  });

  test('the label says "on this page" and that other pages are not selected', () => {
    const before = selectionSummary({ selectedCount: 0, pageCount: 20, total: 65, pages: 4 });
    assert.equal(before.label, 'Select all 20 on this page');
    const after = selectionSummary({ selectedCount: 20, pageCount: 20, total: 65, pages: 4 });
    assert.equal(after.label, '20 of 20 on this page selected');
    assert.equal(after.hint, 'Other pages are not selected (65 in this view).');
    assert.doesNotMatch(after.label, /all conversations|everything/i);
  });

  test('with a single page there is nothing else to select, and no hint', () => {
    assert.deepEqual(selectionSummary({ selectedCount: 0, pageCount: 5, total: 5, pages: 1 }), { label: 'Select all 5', hint: '' });
    assert.deepEqual(selectionSummary({ selectedCount: 2, pageCount: 5, total: 5, pages: 1 }), { label: '2 conversations selected', hint: '' });
  });

  test('the displayed count is the number of selected ids, after every change', () => {
    let selected = toggleSelectAll(new Set(), ids(PAGE1));
    selected = toggleSelected(selected, 'c03');
    assert.equal(selectionSummary({ selectedCount: selected.size, pageCount: 20, total: 65, pages: 4 }).label, '19 of 20 on this page selected');
    assert.equal(selectAllState(selected, ids(PAGE1)), 'some');
    // Moving to page 2 drops page-1 ids from the selection, so the count can
    // never include rows that are not on screen.
    selected = pruneSelection(selected, ids(ALL.slice(20, 40)));
    assert.equal(selected.size, 0);
  });
});

// ---------------------------------------------------------------------------
describe('Delete Selected', () => {
  test('sends exactly the ids the dialog counted, to bulk-delete — never delete-all', async () => {
    const chosen = ['c01', 'c05', 'c07'];
    responder = () => okBulk(chosen);
    const res = await runBulkDelete({
      api,
      confirm: { type: 'bulk', ids: chosen },
      conversations: PAGE1,
      selected: new Set(chosen),
      openId: null,
      page: 1,
    });
    assert.equal(res.ok, true);
    assert.deepEqual(calls, [{ method: 'post', url: '/conversations/bulk-delete', params: undefined, data: { ids: chosen } }]);
    assert.equal(calls.some((c) => c.url.includes('delete-all')), false);
  });

  test('uses the snapshot taken when the dialog opened, not a selection that changed since', async () => {
    responder = () => okBulk(['c01']);
    await runBulkDelete({
      api,
      confirm: { type: 'bulk', ids: ['c01'] },
      conversations: PAGE1,
      // A poll changed the live selection after the dialog opened.
      selected: new Set(['c01', 'c02', 'c03']),
      openId: null,
      page: 1,
    });
    assert.deepEqual(calls[0].data, { ids: ['c01'] });
  });

  test('unselected conversations stay in the list, untouched', async () => {
    const chosen = ['c00', 'c19'];
    responder = () => okBulk(chosen);
    const res = await runBulkDelete({ api, confirm: { type: 'bulk', ids: chosen }, conversations: PAGE1, selected: new Set(chosen), openId: 'c04', page: 1 });
    assert.deepEqual(ids(res.next.conversations), ids(PAGE1).filter((id) => !chosen.includes(id)));
    // Same objects: nothing about the remaining rows was changed.
    res.next.conversations.forEach((row) => assert.equal(row, PAGE1.find((p) => p._id === row._id)));
    assert.equal(res.next.selected.size, 0);
    assert.equal(res.next.closeOpen, false, 'an open, unselected conversation stays open');
    assert.equal(res.next.page, 1);
  });

  test('an empty selection sends nothing', async () => {
    const res = await runBulkDelete({ api, confirm: { type: 'bulk', ids: [] }, conversations: PAGE1, selected: new Set(), openId: null, page: 1 });
    assert.equal(res.skipped, true);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('Delete All is separate and explicitly confirmed', () => {
  test('without the typed phrase nothing is sent', async () => {
    for (const typed of ['', 'delete all', 'DELETE', 'DELETE  ALL', undefined]) {
      const res = await runBulkDelete({ api, confirm: { type: 'all' }, typedPhrase: typed, conversations: PAGE1, selected: new Set(), openId: null, page: 3 });
      assert.equal(res.skipped, true, String(typed));
    }
    assert.equal(calls.length, 0);
    assert.equal(deleteAllPhraseMatches(` ${DELETE_ALL_PHRASE} `), true, 'surrounding spaces are forgiven');
  });

  test('with it, ONLY the delete-all endpoint is called, with its confirm token and no ids', async () => {
    responder = () => ({ status: 200, data: { success: true, deleted: 65, unreadConversations: 0, message: '65 conversations deleted.' } });
    const res = await runBulkDelete({ api, confirm: { type: 'all' }, typedPhrase: DELETE_ALL_PHRASE, conversations: PAGE1, selected: new Set(['c01']), openId: 'c02', page: 3 });
    assert.equal(res.ok, true);
    assert.deepEqual(calls, [{ method: 'post', url: '/conversations/delete-all', params: undefined, data: { confirm: 'DELETE_ALL' } }]);
    assert.deepEqual(res.next.conversations, []);
    assert.equal(res.next.selected.size, 0);
    assert.equal(res.next.closeOpen, true);
    assert.equal(res.next.page, 1);
  });

  test('the dialog shows the whole Inbox size, read without any filter or search', async () => {
    responder = () => ({ status: 200, data: { success: true, data: [{}], pagination: { page: 1, limit: 1, total: 65, pages: 65 } } });
    assert.equal(await requestInboxTotal(api), 65);
    assert.deepEqual(calls[0], { method: 'get', url: '/conversations', params: { page: 1, limit: 1 }, data: undefined });
    assert.equal(deleteAllTitle(65), 'Delete all 65 conversations in the Inbox?');
    assert.equal(deleteAllTitle(null), 'Delete every conversation in the Inbox?');
    assert.equal(deleteSelectedTitle(1), 'Delete 1 selected conversation?');
    assert.equal(deleteSelectedTitle(20), 'Delete 20 selected conversations?');
  });

  test('the two dialogs say which conversations are affected, and that messages are kept', () => {
    assert.match(DELETE_SELECTED_CONFIRM, /on this page/);
    assert.match(DELETE_SELECTED_CONFIRM, /Other pages are not affected/);
    assert.match(DELETE_ALL_CONFIRM, /every page and in every filter/);
    assert.match(DELETE_PRESERVED_NOTE, /STOP\/START/);
    assert.match(DELETE_PRESERVED_NOTE, /delivery records/);
  });

  test('the confirm button stays disabled until the phrase is typed', () => {
    const render = (confirmDisabled) => renderToStaticMarkup(
      h(ConfirmDialog, { title: 't', message: 'm', confirmLabel: 'Delete All', confirmDisabled, onConfirm() {}, onClose() {} })
    );
    assert.match(render(true), /<button[^>]*disabled=""[^>]*>Delete All<\/button>/);
    assert.doesNotMatch(render(false), /<button[^>]*disabled=""[^>]*>Delete All<\/button>/);
  });
});

// ---------------------------------------------------------------------------
describe('a failed request is never shown as a success', () => {
  const run = (confirm, typedPhrase) =>
    runBulkDelete({ api, confirm, typedPhrase, conversations: PAGE1, selected: new Set(['c01']), openId: 'c01', page: 2 });
  const cases = {
    'a 500': () => ({ status: 500, data: { success: false, message: 'Internal error' } }),
    'a 403 (not an admin)': () => ({ status: 403, data: { success: false, message: 'Not authorized' } }),
    'a 400 (bad ids)': () => ({ status: 400, data: { success: false, message: 'Every id must be a valid conversation id' } }),
    'a network failure': () => ({ networkError: true }),
    'a 200 that does not say success': () => ({ status: 200, data: '<html>proxy error page</html>' }),
  };
  for (const [label, respond] of Object.entries(cases)) {
    test(`${label}: an error, no success message, and the list/selection left as they were`, async () => {
      responder = respond;
      for (const [confirm, typed] of [[{ type: 'bulk', ids: ['c01'] }], [{ type: 'all' }, DELETE_ALL_PHRASE]]) {
        const res = await run(confirm, typed);
        assert.equal(res.ok, false);
        assert.equal(res.notice, undefined, 'no success notice');
        assert.equal(res.next, undefined, 'no list or selection change is produced');
        assert.match(res.error, /^(Delete Selected|Delete All) failed: /);
        assert.doesNotMatch(res.error, /deleted\./);
      }
    });
  }

  test('the server message is passed on when there is one', async () => {
    responder = cases['a 403 (not an admin)'];
    const res = await run({ type: 'bulk', ids: ['c01'] });
    assert.equal(res.error, 'Delete Selected failed: Not authorized. Check the list before trying again.');
  });
});

// ---------------------------------------------------------------------------
describe('pagination and selection after a successful delete', () => {
  test('deleting every row on page 3 goes back to page 2', async () => {
    const page3 = ALL.slice(40, 60);
    responder = () => okBulk(ids(page3));
    const res = await runBulkDelete({ api, confirm: { type: 'bulk', ids: ids(page3) }, conversations: page3, selected: new Set(ids(page3)), openId: null, page: 3 });
    assert.equal(res.next.page, 2);
    assert.deepEqual(res.next.conversations, []);
  });

  test('a page that still has rows stays where it is (the list then refetches it)', async () => {
    responder = () => okBulk(['c00']);
    const res = await runBulkDelete({ api, confirm: { type: 'bulk', ids: ['c00'] }, conversations: PAGE1, selected: new Set(['c00', 'c01']), openId: null, page: 1 });
    assert.equal(res.next.page, 1);
    assert.deepEqual([...res.next.selected], ['c01'], 'an unrelated selection survives');
  });
});

// ---------------------------------------------------------------------------
describe('Inbox.jsx wiring', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const bulkFn = code.match(/const performBulkDelete = async \(\) => \{([\s\S]*?)\n {2}\};/)[1];

  test('the outcome comes from runBulkDelete; success is only announced after result.ok', () => {
    assert.match(bulkFn, /const result = await runBulkDelete\(\{/);
    const failure = bulkFn.indexOf('if (!result.ok)');
    const success = bulkFn.indexOf('setNotice(result.notice)');
    assert.ok(failure > 0 && success > failure);
    const failBranch = bulkFn.slice(failure, bulkFn.indexOf('return;', failure));
    assert.match(failBranch, /setBulkError\(result\.error\);/);
    assert.match(failBranch, /fetchList\(\{ quiet: true \}\);/, 'the list is reloaded to show what the server holds');
    assert.doesNotMatch(failBranch, /setNotice|setSelectedIds|setConversations/);
  });

  test('an earlier success message is cleared before the request is made', () => {
    assert.ok(bulkFn.indexOf("setNotice('');") < bulkFn.indexOf('await runBulkDelete'));
  });

  test('the dialog is handed the snapshot, and the typed phrase gates Delete All', () => {
    assert.match(code, /confirm\.type === 'bulk' \? deleteSelectedTitle\(confirm\.ids\.length\)/);
    assert.match(code, /confirmDisabled=\{confirm\.type === 'all' && !deleteAllPhraseMatches\(deleteAllTyped\)\}/);
    assert.match(code, /typedPhrase: deleteAllTyped,/);
  });

  test('a failure is shown above the panels as an alert, visible with the list collapsed', () => {
    assert.match(code, /\{bulkError && <div className="alert alert-error" role="alert"><div>\{bulkError\}<\/div><\/div>\}/);
  });

  test('a page emptied by deletions elsewhere is clamped to the last real page', () => {
    assert.match(code, /if \(data\.data\.length === 0 && page > lastPage\) setPage\(lastPage\);/);
  });

  test('the Select All row uses the page-scoped summary', () => {
    assert.match(code, /aria-label=\{`Select all \$\{visibleIds\.length\} conversations on this page`\}/);
    assert.match(code, /<span>\{summary\.label\}<\/span>/);
  });
});
