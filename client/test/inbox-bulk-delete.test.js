// Inbox bulk selection and bulk deletion.
//
// The selection and post-delete rules live in src/utils/inboxSelection.js and
// are tested directly. The two requests go through the REAL axios instance with
// a stub transport, so the exact method, path and body are asserted. The harness
// renders with react-dom/server (no effects), so how Inbox.jsx wires all this is
// checked against its source alongside server renders of the controls.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import axios from 'axios';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import api from '../src/services/api.js';
import {
  DELETE_SELECTED_CONFIRM,
  DELETE_ALL_CONFIRM,
  toggleSelected,
  selectAllState,
  toggleSelectAll,
  pruneSelection,
  afterBulkDelete,
  requestDeleteSelected,
  requestDeleteAll,
} from '../src/utils/inboxSelection.js';
import { createInboxRefresher } from '../src/utils/inboxRefresh.js';
import ConfirmDialog from '../src/components/ConfirmDialog.jsx';
import Inbox from '../src/pages/Inbox.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';

const h = React.createElement;
const rows = (...ids) => ids.map((_id) => ({ _id }));

// --- stub transport for the real axios instance ------------------------------
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
describe('selection', () => {
  test('selecting one conversation', () => {
    const s = toggleSelected(new Set(), 'a');
    assert.deepEqual([...s], ['a']);
  });

  test('selecting several, and unselecting one of them', () => {
    let s = new Set();
    s = toggleSelected(s, 'a');
    s = toggleSelected(s, 'b');
    s = toggleSelected(s, 'c');
    assert.deepEqual([...s].sort(), ['a', 'b', 'c']);
    s = toggleSelected(s, 'b');
    assert.deepEqual([...s].sort(), ['a', 'c']);
  });

  test('toggling never mutates the previous set (React state)', () => {
    const before = new Set(['a']);
    toggleSelected(before, 'b');
    assert.deepEqual([...before], ['a']);
  });

  test('Select All selects every visible row', () => {
    const s = toggleSelectAll(new Set(), ['a', 'b', 'c']);
    assert.deepEqual([...s].sort(), ['a', 'b', 'c']);
  });

  test('Select All from a partial selection completes it', () => {
    const s = toggleSelectAll(new Set(['a']), ['a', 'b', 'c']);
    assert.equal(s.size, 3);
  });

  test('Select All when everything is selected clears it', () => {
    const s = toggleSelectAll(new Set(['a', 'b']), ['a', 'b']);
    assert.equal(s.size, 0);
  });

  test('the Select All box shows none / some / all', () => {
    const visible = ['a', 'b', 'c'];
    assert.equal(selectAllState(new Set(), visible), 'none');
    assert.equal(selectAllState(new Set(['a']), visible), 'some');
    assert.equal(selectAllState(new Set(visible), visible), 'all');
    assert.equal(selectAllState(new Set(['a']), []), 'none', 'an empty list is never "all"');
  });

  test('Clear Selection is an empty set', () => {
    // Inbox.jsx clears with `setSelectedIds(new Set())`; see the wiring checks.
    assert.equal(selectAllState(new Set(), ['a']), 'none');
  });

  test('a refresh or page change drops rows that are no longer visible', () => {
    const s = pruneSelection(new Set(['a', 'b', 'x']), ['a', 'b', 'c']);
    assert.deepEqual([...s].sort(), ['a', 'b']);
  });

  test('pruning with nothing to drop returns the same set (no re-render loop)', () => {
    const s = new Set(['a']);
    assert.equal(pruneSelection(s, ['a', 'b']), s);
  });
});

// ---------------------------------------------------------------------------
describe('confirmation', () => {
  test('the exact wording: which conversations, and that messages are KEPT', () => {
    assert.equal(
      DELETE_SELECTED_CONFIRM,
      'Only the conversations you ticked on this page are removed from the Inbox. Other pages are not affected.'
    );
    assert.equal(
      DELETE_ALL_CONFIRM,
      'Every conversation in the Inbox is removed — on every page and in every filter, not just the ones you can see.'
    );
    // The old wording said "and their messages", which was false: both actions
    // are soft deletes and every message (STOP/START included) is preserved.
    for (const text of [DELETE_SELECTED_CONFIRM, DELETE_ALL_CONFIRM]) {
      assert.doesNotMatch(text, /their messages/);
    }
  });

  test('while the request runs, both dialog buttons are disabled', () => {
    const html = renderToStaticMarkup(
      h(ConfirmDialog, { title: 't', message: DELETE_ALL_CONFIRM, busy: true, onConfirm() {}, onClose() {} })
    );
    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g).filter((b) => /Cancel|Working/.test(b));
    assert.equal(buttons.length, 2);
    for (const b of buttons) assert.match(b, /disabled=""/);
    assert.match(html, /Working…/);
  });
});

// ---------------------------------------------------------------------------
describe('the requests', () => {
  test('Delete Selected posts the ids in the body', async () => {
    responder = () => ({ status: 200, data: { success: true, deleted: 2, deletedIds: ['a', 'b'] } });
    const data = await requestDeleteSelected(api, ['a', 'b']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'post');
    assert.equal(calls[0].url, '/conversations/bulk-delete');
    assert.deepEqual(calls[0].data, { ids: ['a', 'b'] });
    assert.equal(data.deleted, 2);
  });

  test('Delete All is its own endpoint with an explicit confirm token — no id list', async () => {
    await requestDeleteAll(api);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'post');
    assert.equal(calls[0].url, '/conversations/delete-all');
    assert.deepEqual(calls[0].data, { confirm: 'DELETE_ALL' });
  });

  test('a server rejection (e.g. 403 for a non-admin) surfaces as an error', async () => {
    responder = () => ({ status: 403, data: { success: false, message: 'Forbidden' } });
    await assert.rejects(requestDeleteSelected(api, ['a']), (err) => {
      assert.equal(err.response.status, 403);
      return true;
    });
  });

  test('a 400 for invalid ids surfaces its message', async () => {
    responder = () => ({ status: 400, data: { success: false, message: 'Every id must be a valid conversation id' } });
    await assert.rejects(requestDeleteSelected(api, ['bad']), (err) => {
      assert.match(err.response.data.message, /valid conversation id/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
describe('the Inbox after a successful delete', () => {
  test('deleted rows leave the list at once and their selection is cleared', () => {
    const next = afterBulkDelete({
      conversations: rows('a', 'b', 'c'),
      selected: new Set(['a', 'b']),
      openId: null,
      page: 1,
      deletedIds: ['a', 'b'],
    });
    assert.deepEqual(next.conversations.map((c) => c._id), ['c']);
    assert.equal(next.selected.size, 0);
  });

  test('an unrelated selection survives', () => {
    const next = afterBulkDelete({
      conversations: rows('a', 'b', 'c'),
      selected: new Set(['a', 'c']),
      openId: null,
      page: 1,
      deletedIds: ['a'],
    });
    assert.deepEqual([...next.selected], ['c']);
  });

  test('the OPEN conversation, if deleted, is closed', () => {
    const next = afterBulkDelete({
      conversations: rows('a', 'b'),
      selected: new Set(['a']),
      openId: 'a',
      page: 1,
      deletedIds: ['a'],
    });
    assert.equal(next.closeOpen, true);
  });

  test('an open conversation that was NOT deleted stays open', () => {
    const next = afterBulkDelete({
      conversations: rows('a', 'b'),
      selected: new Set(['a']),
      openId: 'b',
      page: 1,
      deletedIds: ['a'],
    });
    assert.equal(next.closeOpen, false);
  });

  test('Delete All closes any open conversation, clears everything and returns to page 1', () => {
    const next = afterBulkDelete({
      conversations: rows('a', 'b'),
      selected: new Set(['a']),
      openId: 'b',
      page: 4,
      deletedIds: null,
    });
    assert.deepEqual(next.conversations, []);
    assert.equal(next.selected.size, 0);
    assert.equal(next.closeOpen, true);
    assert.equal(next.page, 1);
  });

  test('a page left empty steps back to the previous page', () => {
    const next = afterBulkDelete({
      conversations: rows('a', 'b'),
      selected: new Set(['a', 'b']),
      openId: null,
      page: 3,
      deletedIds: ['a', 'b'],
    });
    assert.equal(next.page, 2);
  });

  test('a page that still has rows keeps its page (and the current filter/search)', () => {
    const next = afterBulkDelete({
      conversations: rows('a', 'b'),
      selected: new Set(['a']),
      openId: null,
      page: 3,
      deletedIds: ['a'],
    });
    assert.equal(next.page, 3);
  });

  test('page 1 never goes below 1', () => {
    const next = afterBulkDelete({
      conversations: rows('a'),
      selected: new Set(['a']),
      openId: null,
      page: 1,
      deletedIds: ['a'],
    });
    assert.equal(next.page, 1);
  });
});

// ---------------------------------------------------------------------------
describe('auto-refresh after a delete', () => {
  test('a deletion made elsewhere ("removed") makes the next poll refetch the list', async () => {
    let listRefreshes = 0;
    let clock = 1000;
    const queue = [{ data: [], removed: 0 }, { data: [], removed: 2 }, { data: [], removed: 0 }];
    const fakeApi = {
      get: async (url) => {
        if (url !== '/conversations/changes') return { data: { data: [] } };
        clock += 1000;
        const next = queue.shift();
        return { data: { ...next, now: new Date(clock).toISOString(), unreadConversations: 0 } };
      },
    };
    const refresh = createInboxRefresher({
      api: fakeApi,
      pageSize: 50,
      getSelectedId: () => null,
      refreshList: async () => { listRefreshes += 1; },
      onMessages() {},
    });
    await refresh(); // baseline
    await refresh(); // two threads were deleted by another admin
    assert.equal(listRefreshes, 2);
    await refresh(); // quiet again
    assert.equal(listRefreshes, 2, 'and an idle poll still costs nothing extra');
  });
});

// ---------------------------------------------------------------------------
describe('Inbox.jsx wiring', () => {
  const source = readFileSync(new URL('../src/pages/Inbox.jsx', import.meta.url), 'utf8');
  const bulkFn = source.match(/const performBulkDelete = async \(\) => \{([\s\S]*?)\n {2}\};/)[1];

  test('a lock plus the busy state make one request per confirmation', () => {
    assert.match(bulkFn, /if \(!confirm \|\| bulkLockRef\.current\) return;/);
    assert.match(bulkFn, /bulkLockRef\.current = true;/);
    assert.match(bulkFn, /finally \{\s*bulkLockRef\.current = false;\s*setBusy\(false\);/);
    assert.match(source, /busy=\{busy\}[\s\S]{0,140}onConfirm=\{confirm\.type === 'bulk' \|\| confirm\.type === 'all' \? performBulkDelete : performDelete\}/);
  });

  test('the dialog cannot be dismissed mid-request', () => {
    assert.match(source, /onClose=\{\(\) => \{ if \(!busy\) setConfirm\(null\); \}\}/);
  });

  test('both bulk actions only ever run from the confirmation dialog', () => {
    assert.match(source, /onClick=\{openDeleteSelected\}/);
    assert.match(source, /onClick=\{openDeleteAll\}/);
    assert.match(source, /setConfirm\(\{ type: 'bulk', ids: \[\.\.\.selectedIds\] \}\);/);
    assert.match(source, /setConfirm\(\{ type: 'all', total: null \}\);/);
    // performBulkDelete is referenced once — as the dialog's onConfirm.
    assert.equal((source.match(/performBulkDelete/g) || []).length, 2, 'declaration + onConfirm only');
  });

  test('the dialog shows the exact confirmation text', () => {
    assert.match(source, /confirm\.type === 'all' \? DELETE_ALL_CONFIRM : DELETE_SELECTED_CONFIRM/);
  });

  test('a deleted open conversation is cleared, showing "No conversation selected"', () => {
    assert.match(bulkFn, /if \(next\.closeOpen\) \{\s*setSelectedId\(null\);\s*setDetail\(null\);\s*setMessages\(\[\]\);/);
    assert.match(source, /title="No conversation selected"/);
  });

  test('the reply being typed is never touched by a bulk delete', () => {
    assert.doesNotMatch(bulkFn, /setReplyText|replyText/);
  });

  test('the sidebar badge gets the new unread count straight away', () => {
    assert.match(bulkFn, /new CustomEvent\('inbox:unread', \{ detail: data\.unreadConversations \}\)/);
  });

  test('an emptied page steps back; otherwise the list refetches in place', () => {
    assert.match(bulkFn, /if \(next\.page !== page\) setPage\(next\.page\);\s*else fetchList\(\{ quiet: true \}\);/);
  });

  test('auto-refresh is unaffected: its timer still depends on the interval only', () => {
    assert.match(source, /return startInboxPolling\([^)]*\);\s*\},\s*\[refreshSeconds\]\)/);
  });

  test('selection is pruned whenever the visible list changes', () => {
    assert.match(source, /setSelectedIds\(\(prev\) => pruneSelection\(prev, conversations\.map\(\(c\) => c\._id\)\)\);\s*\}, \[conversations\]\);/);
  });

  test('Clear Selection empties the selection', () => {
    assert.match(source, /onClick=\{\(\) => setSelectedIds\(new Set\(\)\)\}/);
  });
});

describe('Inbox render', () => {
  const renderAs = (role) => {
    localStorage.setItem('user', JSON.stringify({ _id: 'u1', name: 'Test', role }));
    localStorage.setItem('token', 'test-jwt');
    try {
      return renderToStaticMarkup(h(AuthProvider, null, h(MemoryRouter, null, h(Inbox))));
    } finally {
      localStorage.clear();
    }
  };

  test('an admin sees Delete All', () => {
    assert.match(renderAs('admin'), />Delete All<\/button>/);
  });

  test('a non-admin sees no Delete All (and the server would refuse it anyway)', () => {
    const html = renderAs('agent');
    assert.doesNotMatch(html, /Delete All/);
    assert.doesNotMatch(html, /Delete Selected/);
  });

  test('Delete Selected and Clear Selection are hidden until something is selected', () => {
    const html = renderAs('admin');
    assert.doesNotMatch(html, /Delete Selected/);
    assert.doesNotMatch(html, /Clear Selection/);
  });
});
