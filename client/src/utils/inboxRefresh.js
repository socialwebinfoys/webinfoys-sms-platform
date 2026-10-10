// Inbox auto-refresh: the interval setting and the Inbox's one polling loop.
//
// Kept free of React so the timing rules can be tested directly: one timer per
// Inbox, no overlapping requests, nothing while the tab is hidden, and nothing
// at all when auto-refresh is off. Inbox.jsx wires this into a single effect.

// Mirrors Settings.INBOX_REFRESH_OPTIONS on the server. 0 = off.
export const INBOX_REFRESH_OPTIONS = [0, 5, 10, 15, 30, 60];
export const DEFAULT_INBOX_REFRESH_SECONDS = 10;

// A missing or unrecognised value means the default — never "off", which an
// accidental Number(null) === 0 would otherwise produce.
export function normalizeRefreshSeconds(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_INBOX_REFRESH_SECONDS;
  const n = Number(value);
  return INBOX_REFRESH_OPTIONS.includes(n) ? n : DEFAULT_INBOX_REFRESH_SECONDS;
}

export function refreshOptionLabel(seconds) {
  return seconds === 0 ? 'Off' : `${seconds} seconds`;
}

// Merge incoming messages into the loaded set: updates existing rows (a status
// change), adds new ones, and never duplicates. Always chronological.
export function mergeMessages(prev, incoming) {
  const map = new Map(prev.map((m) => [m._id, m]));
  incoming.forEach((m) => map.set(m._id, m));
  return [...map.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

// One Inbox refresh, single-flight: while a refresh is running, further calls
// (the timer, the tab becoming visible, the Refresh button) share it instead of
// starting a second set of requests.
//
// Each refresh first asks the cheap /changes endpoint whether anything moved.
// Only then is the (filtered) list refetched along with the open thread, so an
// idle inbox costs one small indexed query per interval. `force` skips that
// check — used by the manual Refresh button.
//
// Every effect goes through a callback, so this never touches anything it was
// not handed — in particular not the reply being typed.
export function createInboxRefresher({
  api,
  pageSize,
  getSelectedId,
  refreshList,
  onMessages,
  onActivity,
  onUnread,
}) {
  let since = null;
  let inFlight = null;

  async function run(force) {
    const sinceParam = since;
    const { data: changes } = await api.get('/conversations/changes', {
      params: { since: sinceParam || undefined, limit: 50 },
    });
    since = changes.now;
    if (onUnread && typeof changes.unreadConversations === 'number') {
      onUnread(changes.unreadConversations);
    }

    // The first refresh has no baseline, so it always resyncs. A thread deleted
    // elsewhere is not in `data` (it is hidden) but is counted in `removed`, so
    // it still leaves this Inbox's list.
    const changed = (changes.data && changes.data.length > 0) || changes.removed > 0;
    if (!force && sinceParam && !changed) return false;

    await refreshList();
    const id = getSelectedId();
    if (id) {
      const { data } = await api.get(`/conversations/${id}/messages`, {
        params: { limit: pageSize },
      });
      // The operator may have opened another thread while this was in flight;
      // these messages belong to the old one and must not be merged into it.
      if (getSelectedId() === id) onMessages(data.data);
    }
    if (onActivity) onActivity();
    return true;
  }

  function refresh({ force = false } = {}) {
    if (inFlight) return inFlight;
    inFlight = run(force)
      // A failed poll is not worth surfacing; the next one retries.
      .catch(() => false)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  refresh.isRunning = () => inFlight !== null;
  return refresh;
}

// Start the polling timer. Returns a stop function (idempotent), which is what
// the Inbox effect returns as its cleanup. Off (0) starts nothing at all.
export function startInboxPolling({
  seconds,
  refresh,
  timers = globalThis,
  doc = globalThis.document,
}) {
  const s = normalizeRefreshSeconds(seconds);
  if (s === 0) return () => {};

  const hidden = () => !!doc && doc.visibilityState === 'hidden';
  const id = timers.setInterval(() => {
    if (!hidden()) refresh();
  }, s * 1000);
  // Catch up immediately when the operator comes back to the tab.
  const onVisible = () => {
    if (!hidden()) refresh();
  };
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisible);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(id);
    if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisible);
  };
}
