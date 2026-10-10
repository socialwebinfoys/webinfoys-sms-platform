// Inbox auto-refresh.
//
// The timing rules live in src/utils/inboxRefresh.js and are driven here with a
// fake timer registry and a fake document, so "exactly one timer", "cleared on
// unmount" and "nothing when Off" are counted rather than inferred. The API is a
// scripted double — the harness blocks real network access regardless.
//
// The harness renders with react-dom/server, which does not run effects, so the
// way Inbox.jsx WIRES the utility (one effect, keyed on the interval only) is
// checked against its source, alongside a render of the Refresh control.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import {
  INBOX_REFRESH_OPTIONS,
  DEFAULT_INBOX_REFRESH_SECONDS,
  normalizeRefreshSeconds,
  refreshOptionLabel,
  mergeMessages,
  createInboxRefresher,
  startInboxPolling,
} from '../src/utils/inboxRefresh.js';
import Inbox from '../src/pages/Inbox.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';

// --- doubles ----------------------------------------------------------------
function fakeTimers() {
  const active = new Map();
  let nextId = 1;
  return {
    active,
    created: 0,
    setInterval(fn, ms) {
      const id = nextId++;
      this.created += 1;
      active.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      active.delete(id);
    },
    fireAll() {
      for (const t of [...active.values()]) t.fn();
    },
  };
}

function fakeDocument() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    count: (type) => (listeners.get(type) ? listeners.get(type).size : 0),
    dispatch(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn();
    },
  };
}

// A scripted API: /changes answers from `changesQueue`, a thread's messages from
// `threads`. Every call is recorded. `gate` holds /changes open until released,
// which is how overlapping refreshes are produced deterministically.
function fakeApi() {
  const state = {
    calls: [],
    clock: 1000,
    changesQueue: [],
    threads: new Map(),
    unread: 0,
    gate: null,
    messagesGate: null,
    fail: false,
  };
  state.get = async (url, { params } = {}) => {
    state.calls.push({ url, params });
    if (url === '/conversations/changes') {
      if (state.gate) await state.gate;
      if (state.fail) throw new Error('network down');
      state.clock += 1000;
      const data = state.changesQueue.length ? state.changesQueue.shift() : [];
      return {
        data: { data, now: new Date(state.clock).toISOString(), unreadConversations: state.unread },
      };
    }
    const m = url.match(/^\/conversations\/([^/]+)\/messages$/);
    if (m) {
      if (state.messagesGate) await state.messagesGate;
      return { data: { data: [...(state.threads.get(m[1]) || [])] } };
    }
    throw new Error(`unexpected request ${url}`);
  };
  state.callsTo = (url) => state.calls.filter((c) => c.url === url);
  return state;
}

const msg = (id, direction, body, at) => ({
  _id: id,
  direction,
  body,
  createdAt: new Date(at).toISOString(),
  status: direction === 'inbound' ? 'received' : 'queued',
});

// The Inbox's state, reduced to what the refresher is allowed to touch, plus
// the composer it must never touch.
function inboxModel({ api, selectedId = 'c1' } = {}) {
  const model = {
    selectedId,
    messages: [],
    listRefreshes: 0,
    aiToken: 0,
    unreadBadge: null,
    replyText: '',
  };
  model.refresh = createInboxRefresher({
    api,
    pageSize: 50,
    getSelectedId: () => model.selectedId,
    refreshList: async () => {
      model.listRefreshes += 1;
    },
    onMessages: (incoming) => {
      model.messages = mergeMessages(model.messages, incoming);
    },
    onActivity: () => {
      model.aiToken += 1;
    },
    onUnread: (n) => {
      model.unreadBadge = n;
    },
  });
  return model;
}

// ---------------------------------------------------------------------------
describe('the interval setting', () => {
  test('the default is 10 seconds', () => {
    assert.equal(DEFAULT_INBOX_REFRESH_SECONDS, 10);
  });

  test('the choices are Off, 5, 10, 15, 30 and 60 seconds', () => {
    assert.deepEqual(INBOX_REFRESH_OPTIONS, [0, 5, 10, 15, 30, 60]);
    assert.deepEqual(INBOX_REFRESH_OPTIONS.map(refreshOptionLabel), [
      'Off', '5 seconds', '10 seconds', '15 seconds', '30 seconds', '60 seconds',
    ]);
  });

  test('a missing value means the default — NOT Off', () => {
    // Number(null) is 0, which would silently turn polling off.
    for (const missing of [undefined, null, '']) {
      assert.equal(normalizeRefreshSeconds(missing), 10, `${String(missing)} -> 10`);
    }
  });

  test('an unrecognised value means the default', () => {
    for (const bad of [7, -5, 'abc', 10.5, NaN, {}]) {
      assert.equal(normalizeRefreshSeconds(bad), 10);
    }
  });

  test('every listed choice is kept as-is, including 0 (Off)', () => {
    for (const s of INBOX_REFRESH_OPTIONS) assert.equal(normalizeRefreshSeconds(s), s);
    assert.equal(normalizeRefreshSeconds('30'), 30, 'a select value arrives as a string');
  });
});

// ---------------------------------------------------------------------------
describe('the polling timer', () => {
  for (const seconds of [5, 10, 15, 30, 60]) {
    test(`${seconds} seconds -> one timer every ${seconds * 1000} ms`, () => {
      const timers = fakeTimers();
      const doc = fakeDocument();
      startInboxPolling({ seconds, refresh: () => {}, timers, doc });
      assert.equal(timers.active.size, 1);
      assert.equal([...timers.active.values()][0].ms, seconds * 1000);
    });
  }

  test('with no saved setting the timer runs at the 10-second default', () => {
    const timers = fakeTimers();
    startInboxPolling({ seconds: undefined, refresh: () => {}, timers, doc: fakeDocument() });
    assert.equal([...timers.active.values()][0].ms, 10000);
  });

  test('Off starts no timer and no listener at all', () => {
    const timers = fakeTimers();
    const doc = fakeDocument();
    let calls = 0;
    const stop = startInboxPolling({ seconds: 0, refresh: () => { calls += 1; }, timers, doc });
    assert.equal(timers.created, 0);
    assert.equal(doc.count('visibilitychange'), 0);
    doc.dispatch('visibilitychange');
    assert.equal(calls, 0, 'nothing refreshes automatically');
    stop(); // still safe to call
  });

  test('each tick refreshes', () => {
    const timers = fakeTimers();
    let calls = 0;
    startInboxPolling({ seconds: 10, refresh: () => { calls += 1; }, timers, doc: fakeDocument() });
    timers.fireAll();
    timers.fireAll();
    assert.equal(calls, 2);
  });

  test('a hidden tab does not poll, and catches up when it becomes visible', () => {
    const timers = fakeTimers();
    const doc = fakeDocument();
    let calls = 0;
    startInboxPolling({ seconds: 10, refresh: () => { calls += 1; }, timers, doc });
    doc.visibilityState = 'hidden';
    timers.fireAll();
    doc.dispatch('visibilitychange');
    assert.equal(calls, 0);
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    assert.equal(calls, 1);
  });

  test('cleanup (unmount) clears the timer and the listener', () => {
    const timers = fakeTimers();
    const doc = fakeDocument();
    let calls = 0;
    const stop = startInboxPolling({ seconds: 5, refresh: () => { calls += 1; }, timers, doc });
    stop();
    assert.equal(timers.active.size, 0, 'no timer left behind');
    assert.equal(doc.count('visibilitychange'), 0, 'no listener left behind');
    doc.dispatch('visibilitychange');
    assert.equal(calls, 0);
  });

  test('cleanup is idempotent', () => {
    const timers = fakeTimers();
    const stop = startInboxPolling({ seconds: 5, refresh: () => {}, timers, doc: fakeDocument() });
    stop();
    stop();
    assert.equal(timers.active.size, 0);
  });

  test('changing the interval replaces the timer — never two at once', () => {
    // The effect lifecycle: cleanup of the old interval, then start of the new.
    const timers = fakeTimers();
    const doc = fakeDocument();
    let stop = startInboxPolling({ seconds: 10, refresh: () => {}, timers, doc });
    for (const next of [5, 30, 0, 60]) {
      stop();
      stop = startInboxPolling({ seconds: next, refresh: () => {}, timers, doc });
      assert.equal(timers.active.size, next === 0 ? 0 : 1);
      assert.ok(doc.count('visibilitychange') <= 1);
    }
    stop();
    assert.equal(timers.active.size, 0);
  });

  test('repeated mount/unmount (navigation) never accumulates timers', () => {
    const timers = fakeTimers();
    const doc = fakeDocument();
    for (let i = 0; i < 20; i += 1) {
      const stop = startInboxPolling({ seconds: 10, refresh: () => {}, timers, doc });
      assert.equal(timers.active.size, 1);
      stop();
    }
    assert.equal(timers.active.size, 0);
    assert.equal(doc.count('visibilitychange'), 0);
  });
});

// ---------------------------------------------------------------------------
describe('a refresh', () => {
  test('the first refresh syncs the list, the open thread and the AI panel', async () => {
    const api = fakeApi();
    api.threads.set('c1', [msg('m1', 'outbound', 'Hi', 1)]);
    api.unread = 2;
    const inbox = inboxModel({ api });

    await inbox.refresh();

    assert.equal(api.callsTo('/conversations/changes')[0].params.since, undefined);
    assert.equal(inbox.listRefreshes, 1);
    assert.deepEqual(inbox.messages.map((m) => m._id), ['m1']);
    assert.equal(inbox.aiToken, 1);
    assert.equal(inbox.unreadBadge, 2, 'the unread count is refreshed too');
  });

  test('an idle inbox costs one /changes request and nothing else', async () => {
    const api = fakeApi();
    const inbox = inboxModel({ api });
    await inbox.refresh();
    const before = api.calls.length;

    await inbox.refresh();

    assert.equal(api.calls.length, before + 1);
    assert.equal(api.calls.at(-1).url, '/conversations/changes');
    assert.ok(api.calls.at(-1).params.since, 'the previous server clock is sent back');
    assert.equal(inbox.listRefreshes, 1, 'the list is not refetched for nothing');
  });

  test('a NEW INBOUND message becomes visible after the next poll — once', async () => {
    const api = fakeApi();
    api.threads.set('c1', [msg('m1', 'outbound', 'Your order shipped', 1)]);
    const inbox = inboxModel({ api });
    await inbox.refresh();
    assert.equal(inbox.messages.length, 1);

    // The customer replies: the webhook stores it and touches the thread.
    api.threads.set('c1', [msg('m1', 'outbound', 'Your order shipped', 1), msg('m2', 'inbound', 'Thanks!', 2)]);
    api.changesQueue.push([{ _id: 'c1' }]);
    api.unread = 1;
    await inbox.refresh();

    assert.deepEqual(inbox.messages.map((m) => m._id), ['m1', 'm2']);
    assert.equal(inbox.messages[1].body, 'Thanks!');
    assert.equal(inbox.listRefreshes, 2, 'the list (preview, order, unread) is refreshed');
    assert.equal(inbox.unreadBadge, 1);

    // Polling again with the same data must not duplicate it.
    api.changesQueue.push([{ _id: 'c1' }]);
    await inbox.refresh();
    assert.deepEqual(inbox.messages.map((m) => m._id), ['m1', 'm2']);
  });

  test('overlapping refreshes share one request — no duplicate API calls', async () => {
    const api = fakeApi();
    let release;
    api.gate = new Promise((r) => { release = r; });
    const inbox = inboxModel({ api });

    const a = inbox.refresh();
    const b = inbox.refresh();
    const c = inbox.refresh({ force: true });
    assert.equal(a, b, 'the same in-flight refresh is returned');
    assert.equal(a, c);
    assert.equal(inbox.refresh.isRunning(), true);
    release();
    await a;

    assert.equal(api.callsTo('/conversations/changes').length, 1);
    assert.equal(api.callsTo('/conversations/c1/messages').length, 1);
    assert.equal(inbox.refresh.isRunning(), false);
  });

  test('a failed refresh is swallowed and does not wedge the lock', async () => {
    const api = fakeApi();
    api.fail = true;
    const inbox = inboxModel({ api });
    assert.equal(await inbox.refresh(), false);
    api.fail = false;
    assert.equal(await inbox.refresh(), true, 'the next refresh runs');
  });

  test('messages for a thread the operator has since left are NOT merged into the new one', async () => {
    const api = fakeApi();
    let release;
    api.threads.set('c1', [msg('old', 'inbound', 'from thread one', 1)]);
    const inbox = inboxModel({ api });
    api.messagesGate = new Promise((r) => { release = r; });
    const pending = inbox.refresh();
    // Wait until c1's messages have actually been requested…
    while (api.callsTo('/conversations/c1/messages').length === 0) await new Promise((r) => setImmediate(r));
    inbox.selectedId = 'c2'; // …then the operator switches threads mid-flight.
    release();
    await pending;
    assert.ok(!inbox.messages.some((m) => m._id === 'old'), 'c1 messages leaked into c2');
  });

  test('with no thread open, no message request is made', async () => {
    const api = fakeApi();
    const inbox = inboxModel({ api, selectedId: null });
    await inbox.refresh();
    assert.equal(api.calls.filter((c) => c.url.endsWith('/messages')).length, 0);
    assert.equal(inbox.listRefreshes, 1);
  });

  test('a manual (forced) refresh resyncs even when nothing reported a change', async () => {
    const api = fakeApi();
    const inbox = inboxModel({ api });
    await inbox.refresh();
    await inbox.refresh({ force: true });
    assert.equal(inbox.listRefreshes, 2);
  });

  test('refreshing never touches the reply being typed', async () => {
    const api = fakeApi();
    api.threads.set('c1', [msg('m1', 'inbound', 'Question?', 1)]);
    const inbox = inboxModel({ api });
    inbox.replyText = 'Half-written ans';
    await inbox.refresh();
    api.changesQueue.push([{ _id: 'c1' }]);
    api.threads.set('c1', [msg('m1', 'inbound', 'Question?', 1), msg('m2', 'inbound', 'Hello?', 2)]);
    await inbox.refresh();
    assert.equal(inbox.replyText, 'Half-written ans');
    assert.equal(inbox.messages.length, 2, 'while the thread itself did update');
  });
});

describe('mergeMessages', () => {
  test('updates an existing row in place (a delivery status change)', () => {
    const prev = [msg('m1', 'outbound', 'Hi', 1)];
    const merged = mergeMessages(prev, [{ ...prev[0], status: 'delivered' }]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, 'delivered');
  });

  test('keeps chronological order and never duplicates', () => {
    const merged = mergeMessages(
      [msg('m2', 'inbound', 'b', 2)],
      [msg('m1', 'outbound', 'a', 1), msg('m2', 'inbound', 'b', 2), msg('m3', 'inbound', 'c', 3)]
    );
    assert.deepEqual(merged.map((m) => m._id), ['m1', 'm2', 'm3']);
  });
});

// ---------------------------------------------------------------------------
describe('Inbox.jsx wiring', () => {
  const source = readFileSync(new URL('../src/pages/Inbox.jsx', import.meta.url), 'utf8')
    // Comments may mention timers; only code counts.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('there is exactly ONE polling mechanism — no stray setInterval', () => {
    assert.equal((source.match(/setInterval\(/g) || []).length, 0);
    assert.equal((source.match(/startInboxPolling\(/g) || []).length, 1);
  });

  test('the timer effect depends on the interval ONLY (search, filter, page and typing never rebuild it)', () => {
    const effect = source.match(/return startInboxPolling\([^)]*\);\s*\},\s*\[([^\]]*)\]\)/);
    assert.ok(effect, 'the polling effect returns the stop function as its cleanup');
    assert.equal(effect[1].trim(), 'refreshSeconds');
  });

  test('the refresher is created once per Inbox, not on every render', () => {
    assert.match(source, /if \(!refresherRef\.current\)\s*\{\s*refresherRef\.current = createInboxRefresher\(/);
  });

  test('the refresher is never handed the composer', () => {
    const config = source.match(/createInboxRefresher\(\{([\s\S]*?)\n {4}\}\);/);
    assert.ok(config);
    assert.doesNotMatch(config[1], /replyText|setReplyText|sending|templateId/);
  });

  test('polling does not start until the setting has loaded', () => {
    assert.match(source, /if \(refreshSeconds === null\) return undefined;/);
  });

  test('the Refresh button forces a refresh through the same single-flight refresher', () => {
    assert.match(source, /refresherRef\.current\(\{ force: true \}\)/);
  });

  test('renders a Refresh button', () => {
    localStorage.setItem('user', JSON.stringify({ _id: 'u1', name: 'Test', role: 'agent' }));
    localStorage.setItem('token', 'test-jwt');
    try {
      const html = renderToStaticMarkup(
        React.createElement(AuthProvider, null, React.createElement(MemoryRouter, null, React.createElement(Inbox)))
      );
      assert.match(html, /<button type="button" class="btn btn-sm"[^>]*>Refresh<\/button>/);
    } finally {
      localStorage.clear();
    }
  });
});

describe('Settings page', () => {
  const source = readFileSync(new URL('../src/pages/Settings.jsx', import.meta.url), 'utf8');

  test('saves through the existing settings API', () => {
    assert.match(source, /api\.put\('\/settings\/inbox', \{ inboxRefreshSeconds: seconds \}\)/);
    assert.match(source, /api\s*\.get\('\/settings\/inbox'\)/);
  });

  test('offers every choice from the shared list, admin-only', () => {
    assert.match(source, /INBOX_REFRESH_OPTIONS\.map/);
    assert.match(source, /disabled=\{!isAdmin \|\| savingInbox/);
  });
});
