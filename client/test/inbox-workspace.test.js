// Inbox workspace: the filter dropdown, the two collapsible panels and the
// full-height layout.
//
// The rules live in src/utils/inboxFilters.js and src/utils/inboxLayout.js and
// are tested directly. The list request goes through the REAL axios instance
// with a stub transport, so the exact query each filter sends is asserted (the
// filtering itself is the server's, tested in server/test/api/inbox-filters).
// Inbox.jsx is server-rendered (no effects) at each width, and how it wires the
// rest is checked against its source and the stylesheet.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import api from '../src/services/api.js';
import {
  INBOX_FILTERS,
  DEFAULT_INBOX_FILTER,
  inboxFilter,
  conversationListParams,
  emptyListMessage,
} from '../src/utils/inboxFilters.js';
import {
  NARROW_QUERY,
  COMPACT_QUERY,
  LAYOUT_STORAGE_KEY,
  toggleLabel,
  readStoredLayout,
  writeStoredLayout,
  layoutFor,
  togglePanel,
  afterSelect,
  overlaysOpen,
} from '../src/utils/inboxLayout.js';
import { mergeMessages } from '../src/utils/inboxRefresh.js';
import Inbox from '../src/pages/Inbox.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';

const h = React.createElement;
const source = readFileSync(new URL('../src/pages/Inbox.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const layoutSrc = readFileSync(new URL('../src/components/Layout.jsx', import.meta.url), 'utf8');

// The body of one CSS rule, by its exact selector.
function rule(selector, within = css) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = within.match(new RegExp(`(^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `rule ${selector} exists`);
  return m[2];
}
function mediaBlock(query) {
  const start = css.indexOf(`@media ${query} {\n  .`, css.indexOf('Inbox workspace'));
  assert.ok(start > 0, `media block ${query}`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unterminated');
}

// --- stub transport for the real axios instance ------------------------------
let calls = [];
api.defaults.adapter = async (config) => {
  calls.push({ method: config.method, url: config.url, params: config.params });
  return { data: { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } }, status: 200, statusText: 'OK', headers: {}, config };
};
beforeEach(() => { calls = []; });

// ---------------------------------------------------------------------------
describe('the filter dropdown', () => {
  test('offers exactly the seven filters, in order', () => {
    assert.deepEqual(INBOX_FILTERS.map((f) => f.label), [
      'All messages',
      'Undelivered',
      'STOP / Opted out',
      'Unread',
      'Needs reply',
      'Assigned to me',
      'Closed',
    ]);
    assert.equal(DEFAULT_INBOX_FILTER, 'all');
    assert.equal(new Set(INBOX_FILTERS.map((f) => f.key)).size, 7);
  });

  test('each filter maps to the query parameters the server understands', () => {
    const params = Object.fromEntries(INBOX_FILTERS.map((f) => [f.key, f.params]));
    assert.deepEqual(params, {
      all: {},
      undelivered: { delivery: 'undelivered' },
      optedOut: { optedOut: 'true' },
      unread: { unread: 'true' },
      // The three below are unchanged from the old filter buttons.
      needsReply: { needsReply: 'true' },
      mine: { assigned: 'me' },
      closed: { status: 'closed' },
    });
  });

  test('an unknown key falls back to All messages rather than an empty list', () => {
    assert.equal(inboxFilter('nope').key, 'all');
    assert.equal(inboxFilter(undefined).key, 'all');
  });

  test('search travels with every filter, trimmed, and is omitted when blank', async () => {
    for (const f of INBOX_FILTERS) {
      await api.get('/conversations', { params: conversationListParams({ filterKey: f.key, search: '  415 ', page: 2, limit: 20 }) });
    }
    assert.equal(calls.length, 7);
    calls.forEach((c, i) => {
      assert.equal(c.url, '/conversations');
      assert.deepEqual(c.params, { ...INBOX_FILTERS[i].params, search: '415', page: 2, limit: 20 });
    });
    assert.equal(conversationListParams({ filterKey: 'unread', search: '   ', page: 1, limit: 20 }).search, undefined);
  });

  test('the empty state says which filter or search found nothing', () => {
    assert.equal(emptyListMessage({ filterKey: 'all', search: '' }).title, 'No conversations yet');
    assert.equal(emptyListMessage({ filterKey: 'undelivered', search: '' }).title, 'No undelivered conversations');
    assert.equal(emptyListMessage({ filterKey: 'optedOut', search: '' }).title, 'No opted-out contacts');
    const searched = emptyListMessage({ filterKey: 'closed', search: 'ada' });
    assert.equal(searched.title, 'No matching conversations');
    assert.match(searched.hint, /“Closed” matches “ada”/);
    for (const f of INBOX_FILTERS) {
      const m = emptyListMessage({ filterKey: f.key, search: '' });
      assert.ok(m.title && m.hint, f.key);
    }
  });
});

// ---------------------------------------------------------------------------
describe('panel layout rules', () => {
  const wide = { narrow: false, compact: false };
  const compact = { narrow: false, compact: true };
  const narrow = { narrow: true, compact: true };

  test('the two toggles are independent', () => {
    const start = { listOpen: true, detailsOpen: true };
    assert.deepEqual(togglePanel(start, 'list'), { listOpen: false, detailsOpen: true });
    assert.deepEqual(togglePanel(start, 'details'), { listOpen: true, detailsOpen: false });
    const both = togglePanel(togglePanel(start, 'list'), 'details');
    assert.deepEqual(both, { listOpen: false, detailsOpen: false });
    assert.deepEqual(togglePanel(togglePanel(both, 'list'), 'details'), start);
  });

  test('labels say what the button will do', () => {
    assert.equal(toggleLabel('list', true), 'Collapse conversations');
    assert.equal(toggleLabel('list', false), 'Show conversations');
    assert.equal(toggleLabel('details', true), 'Hide contact details');
    assert.equal(toggleLabel('details', false), 'Show contact details');
  });

  test('a wide screen uses the remembered choice', () => {
    const stored = { listOpen: false, detailsOpen: true };
    assert.deepEqual(layoutFor({ ...wide, hasSelection: true, stored }), stored);
  });

  test('a compact screen starts with the details drawer closed', () => {
    assert.deepEqual(layoutFor({ ...compact, hasSelection: true, stored: { listOpen: true, detailsOpen: true } }), {
      listOpen: true,
      detailsOpen: false,
    });
  });

  test('a phone shows the list until a conversation is chosen, then the chat', () => {
    assert.deepEqual(layoutFor({ ...narrow, hasSelection: false }), { listOpen: true, detailsOpen: false });
    assert.deepEqual(layoutFor({ ...narrow, hasSelection: true }), { listOpen: false, detailsOpen: false });
    assert.deepEqual(afterSelect({ listOpen: true, detailsOpen: false }, narrow), { listOpen: false, detailsOpen: false });
  });

  test('choosing a conversation on a wide screen leaves the layout alone', () => {
    const l = { listOpen: true, detailsOpen: false };
    assert.equal(afterSelect(l, wide), l);
  });

  test('only drawers count as overlays (scrim + Escape)', () => {
    const open = { listOpen: true, detailsOpen: true };
    assert.deepEqual(overlaysOpen(open, wide), { list: false, details: false });
    assert.deepEqual(overlaysOpen(open, compact), { list: false, details: true });
    assert.deepEqual(overlaysOpen(open, narrow), { list: true, details: true });
  });

  test('the stored preference survives junk and blocked storage', () => {
    const map = new Map();
    const store = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
    assert.deepEqual(readStoredLayout(store), { listOpen: true, detailsOpen: true });
    writeStoredLayout({ listOpen: false, detailsOpen: true }, store);
    assert.deepEqual(JSON.parse(map.get(LAYOUT_STORAGE_KEY)), { listOpen: false, detailsOpen: true });
    assert.deepEqual(readStoredLayout(store), { listOpen: false, detailsOpen: true });
    map.set(LAYOUT_STORAGE_KEY, '{not json');
    assert.deepEqual(readStoredLayout(store), { listOpen: true, detailsOpen: true });
    map.set(LAYOUT_STORAGE_KEY, JSON.stringify({ listOpen: 'yes' }));
    assert.deepEqual(readStoredLayout(store), { listOpen: true, detailsOpen: true });
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.deepEqual(readStoredLayout(throwing), { listOpen: true, detailsOpen: true });
    assert.doesNotThrow(() => writeStoredLayout({ listOpen: true, detailsOpen: true }, throwing));
  });

  test('the media queries in JS and CSS are the same breakpoints', () => {
    assert.equal(NARROW_QUERY, '(max-width: 900px)');
    assert.equal(COMPACT_QUERY, '(max-width: 1280px)');
    assert.match(mediaBlock(NARROW_QUERY), /\.convo-list \{\s*position: absolute;/);
    assert.match(mediaBlock(COMPACT_QUERY), /\.contact-panel \{\s*position: absolute;/);
  });
});

// ---------------------------------------------------------------------------
describe('history merging keeps the server order', () => {
  test('messages sharing a timestamp are ordered by id and never duplicated', () => {
    const t = '2026-10-01T12:00:00.000Z';
    const merged = mergeMessages(
      [{ _id: 'b', createdAt: t }, { _id: 'd', createdAt: '2026-10-01T12:00:01.000Z' }],
      [{ _id: 'a', createdAt: t }, { _id: 'c', createdAt: t }, { _id: 'b', createdAt: t, status: 'delivered' }]
    );
    assert.deepEqual(merged.map((m) => m._id), ['a', 'b', 'c', 'd']);
    assert.equal(merged[1].status, 'delivered', 'an updated row replaces the old one');
  });
});

// ---------------------------------------------------------------------------
describe('Inbox render', () => {
  const renderAt = ({ narrow = false, compact = false, role = 'agent', stored } = {}) => {
    const original = globalThis.matchMedia;
    globalThis.matchMedia = (q) => ({
      matches: (q === NARROW_QUERY && narrow) || (q === COMPACT_QUERY && (compact || narrow)),
      addEventListener() {},
      removeEventListener() {},
    });
    localStorage.setItem('user', JSON.stringify({ _id: 'u1', name: 'Test', role }));
    localStorage.setItem('token', 'test-jwt');
    if (stored) localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(stored));
    try {
      return renderToStaticMarkup(h(AuthProvider, null, h(MemoryRouter, null, h(Inbox))));
    } finally {
      globalThis.matchMedia = original;
      localStorage.clear();
    }
  };

  test('one labelled dropdown replaces the old filter buttons', () => {
    const html = renderAt();
    const select = html.match(/<select id="inbox-filter"[^>]*>([\s\S]*?)<\/select>/);
    assert.ok(select, 'the dropdown is rendered');
    assert.match(html, /<label class="sr-only-label" for="inbox-filter">Show<\/label>/);
    const options = [...select[1].matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => m[2]);
    assert.deepEqual(options, INBOX_FILTERS.map((f) => f.label));
    for (const old of ['All', 'Unread', 'Needs reply', 'Assigned to me', 'Closed']) {
      assert.doesNotMatch(html, new RegExp(`<button[^>]*>${old}</button>`), `no "${old}" button`);
    }
  });

  test('search stays next to the filter, with an accessible name', () => {
    assert.match(renderAt(), /<input class="input" type="search" aria-label="Search conversations by contact name or phone"/);
  });

  test('both toggles render with labels, tooltips and aria-controls on a wide screen', () => {
    const html = renderAt();
    assert.match(html, /aria-label="Collapse conversations" title="Collapse conversations" aria-expanded="true" aria-controls="inbox-conversation-list"/);
    // No conversation is open yet, so there are no details to hide.
    assert.match(html, /aria-label="Show contact details" title="Select a conversation to see contact details" aria-expanded="false" aria-controls="inbox-contact-panel" disabled=""/);
    assert.match(html, /<aside id="inbox-conversation-list" class="convo-list" aria-label="Conversations">/);
  });

  test('a remembered collapsed list renders hidden (mounted, not removed)', () => {
    const html = renderAt({ stored: { listOpen: false, detailsOpen: true } });
    assert.match(html, /<aside id="inbox-conversation-list" class="convo-list" aria-label="Conversations" hidden="">/);
    assert.match(html, /aria-label="Show conversations"/);
    assert.match(html, /class="inbox-layout list-collapsed details-collapsed"/);
  });

  test('on a phone the list is an open drawer with its own close button and a scrim', () => {
    const html = renderAt({ narrow: true });
    assert.match(html, /class="inbox-layout list-open details-collapsed"/);
    assert.match(html, /<div class="inbox-scrim" aria-hidden="true"><\/div>/);
    assert.match(html, /class="icon-btn drawer-close" aria-label="Collapse conversations"/);
  });

  test('the chat panel always has its header and the empty state', () => {
    const html = renderAt();
    assert.match(html, /<section class="convo-detail" aria-label="Conversation"><div class="detail-head">/);
    assert.match(html, /No conversation selected/);
  });

  test('admins keep Delete All; non-admins do not', () => {
    assert.match(renderAt({ role: 'admin' }), />Delete All<\/button>/);
    assert.doesNotMatch(renderAt(), /Delete All/);
  });
});

// ---------------------------------------------------------------------------
describe('Inbox.jsx wiring', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const fetchList = code.match(/const fetchList = useCallback\(async \(\{ quiet = false \} = \{\}\) => \{([\s\S]*?)\n {2}\}, \[listParams\]\);/);
  const toggle = code.match(/const togglePanel = \(panel\) => \{([\s\S]*?)\n {2}\};/);

  test('only the newest list request may update the list (fast filter switches)', () => {
    assert.ok(fetchList);
    assert.match(fetchList[1], /const seq = \+\+listSeqRef\.current;/);
    assert.match(fetchList[1], /if \(seq !== listSeqRef\.current\) return;\s*setConversations\(data\.data\);/);
    assert.match(fetchList[1], /if \(seq === listSeqRef\.current\) setListLoading\(false\);/);
  });

  test('changing the filter goes back to page 1 and refetches through the list effect', () => {
    assert.match(code, /const changeFilter = \(key\) => \{\s*setFilterKey\(inboxFilter\(key\)\.key\);\s*setPage\(1\);\s*\};/);
    assert.match(code, /onChange=\{\(e\) => changeFilter\(e\.target\.value\)\}/);
    assert.match(code, /useEffect\(\(\) => \{ fetchList\(\); \}, \[fetchList\]\);/);
  });

  test('toggling a panel never touches the selected conversation or the composer', () => {
    assert.ok(toggle);
    assert.doesNotMatch(toggle[1], /setSelectedId|openConversation|setDetail|setMessages|setReplyText/);
    assert.match(toggle[1], /savedScroll\.current\[panel\] = el\.scrollTop;/);
  });

  test('load older sends the (createdAt, _id) cursor', () => {
    assert.match(code, /before: messages\[0\]\.createdAt, beforeId: messages\[0\]\._id/);
  });

  test('the thread stays pinned to the newest message when a panel toggles or it resizes', () => {
    assert.match(code, /useIsomorphicLayoutEffect\(\(\) => \{\s*const el = threadRef\.current;\s*if \(el && atBottomRef\.current\) el\.scrollTop = el\.scrollHeight;\s*\}, \[layout\.listOpen, layout\.detailsOpen\]\);/);
    assert.match(code, /new ResizeObserver\(/);
    assert.match(code, /typeof ResizeObserver === 'undefined'/);
  });

  test('the composer sits after the scrolling thread, inside the chat panel', () => {
    const thread = code.indexOf('<div className="msg-thread" ref={threadRef} onScroll={onThreadScroll}>');
    const form = code.indexOf('<form className="reply-box" onSubmit={sendReply}>');
    const end = code.indexOf('</section>');
    assert.ok(thread > 0 && form > thread && end > form);
  });

  test('Delete chat and Delete All are still behind the confirmation dialog', () => {
    assert.match(code, /onClick=\{\(\) => setConfirm\(\{ type: 'chat' \}\)\}/);
    assert.match(code, /onClick=\{\(\) => setConfirm\(\{ type: 'all' \}\)\}/);
  });

  test('only the Inbox route gets the full-height workspace', () => {
    assert.match(layoutSrc, /className=\{`content\$\{location\.pathname === '\/inbox' \? ' content-wide' : ''\}`\}/);
  });
});

// ---------------------------------------------------------------------------
describe('the stylesheet keeps the composer on screen', () => {
  test('the Inbox takes the viewport height, minus the mobile top bar', () => {
    assert.match(rule('.content.content-wide'), /height: 100dvh;/);
    assert.match(rule('.content.content-wide'), /max-width: none;/);
    // Without this, .content's flex: 1 lets it grow past the viewport.
    assert.match(rule('.content.content-wide'), /flex: none;\s*min-height: 0;/);
    assert.match(css, /\.content\.content-wide \{\s*height: calc\(100vh - var\(--topbar-h\)\);\s*height: calc\(100dvh - var\(--topbar-h\)\);/);
  });

  test('every flex child that holds a scroller can shrink (min-height: 0)', () => {
    for (const sel of ['.inbox-page', '.convo-list', '.convo-scroll', '.convo-detail', '.msg-thread-wrap', '.msg-thread', '.contact-panel']) {
      assert.match(rule(sel), /min-height: 0;/, sel);
    }
    assert.match(rule('.convo-detail'), /min-width: 0;/);
  });

  test('the list, the thread and the details each scroll on their own', () => {
    assert.match(rule('.convo-scroll'), /overflow-y: auto;/);
    assert.match(rule('.msg-thread'), /overflow-y: auto;/);
    assert.match(rule('.contact-panel'), /overflow-y: auto;/);
    assert.match(rule('.convo-list'), /overflow: hidden;/);
    assert.match(rule('.convo-detail'), /overflow: hidden;/);
  });

  test('the header and composer never shrink; the thread takes the rest', () => {
    assert.match(rule('.reply-box'), /flex: 0 0 auto;/);
    assert.match(rule('.detail-head'), /flex: 0 0 auto;/);
    assert.match(rule('.msg-thread'), /flex: 1 1 auto;/);
  });

  test('the old fixed height is gone', () => {
    assert.doesNotMatch(css, /calc\(100vh - 196px\)/);
  });

  test('collapsed panels are not displayed', () => {
    assert.match(css, /\.convo-list\[hidden\],\s*\.contact-panel\[hidden\] \{\s*display: none !important;/);
  });
});
