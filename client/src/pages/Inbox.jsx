// Shared team inbox (Phase 4): conversation list with search + filters, a thread
// that opens on the NEWEST messages and loads older on demand, live polling, a
// composer with segment counting and templates, retry for failed sends, admin
// soft delete, and a contact/automation side panel.
//
// Layout: a full-height workspace. The conversation list (left) and the contact
// details (right) collapse independently — see utils/inboxLayout.js — and only
// the list, the thread and the details scroll, never the page.
import { Fragment, useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import ConfirmDialog from '../components/ConfirmDialog';
import SmsCounter from '../components/SmsCounter';
// Phase 9: AI state, takeover, per-conversation mode and draft review.
import AiConversationPanel from '../components/AiConversationPanel';
import aiApi from '../services/aiApi';
import { messageBadge, conversationAiChips } from '../utils/aiPresentation';
import { contactIdentity } from '../utils/contactIdentity';
import {
  mergeMessages,
  createInboxRefresher,
  startInboxPolling,
  normalizeRefreshSeconds,
  DEFAULT_INBOX_REFRESH_SECONDS,
} from '../utils/inboxRefresh';
import {
  DELETE_SELECTED_CONFIRM,
  DELETE_ALL_CONFIRM,
  DELETE_PRESERVED_NOTE,
  DELETE_ALL_PHRASE,
  deleteAllPhraseMatches,
  deleteSelectedTitle,
  deleteAllTitle,
  selectionSummary,
  requestInboxTotal,
  runBulkDelete,
  toggleSelected,
  selectAllState,
  toggleSelectAll,
  pruneSelection,
} from '../utils/inboxSelection';
import {
  INBOX_FILTERS,
  DEFAULT_INBOX_FILTER,
  inboxFilter,
  conversationListParams,
  emptyListMessage,
} from '../utils/inboxFilters';
import {
  NARROW_QUERY,
  COMPACT_QUERY,
  toggleLabel,
  readStoredLayout,
  writeStoredLayout,
  layoutFor,
  afterSelect,
  overlaysOpen,
  togglePanel as flipPanel,
} from '../utils/inboxLayout';

const InboxIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

// Mirrors the server's keyword rules (server/utils/optOut.js) so the thread can
// label STOP/START messages and hide the delete action on them. Display only —
// the server remains authoritative and refuses to delete them regardless.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke']);
const START_WORDS = new Set(['start', 'unstop', 'optin']);
function keywordOf(body) {
  const k = String(body || '').trim().toLowerCase().replace(/[.!?,;:]+$/, '').trim();
  if (STOP_WORDS.has(k)) return 'stop';
  if (START_WORDS.has(k)) return 'start';
  return null;
}

// Phase 3: colour a delivery status so a failure is obvious at a glance.
function statusChipClass(status) {
  if (status === 'delivered') return 'chip chip-on';
  if (status === 'undelivered' || status === 'failed') return 'chip chip-invalid';
  return 'chip';
}
const RETRYABLE = new Set(['failed', 'undelivered']);

function timeAgo(d) {
  if (!d) return '';
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(d).toLocaleDateString();
}

// Day separator label for a message, in the viewer's own timezone.
function dayLabel(d) {
  const date = new Date(d);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(date, today)) return 'Today';
  if (same(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// Panel toggles: a frame with its left or right column marked, like the
// sidebar icons in most editors.
const PanelLeftIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
);
const PanelRightIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </svg>
);
const CloseIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const PAGE_SIZE = 50;
const LIST_LIMIT = 20;

// useLayoutEffect in the browser (scroll is restored before paint, so nothing
// jumps); plain useEffect where there is no DOM, e.g. a server render.
const useIsomorphicLayoutEffect =
  typeof document !== 'undefined' && typeof document.createElement === 'function' ? useLayoutEffect : useEffect;

// matchMedia, tolerating environments without it (server render, tests).
function mediaList(query) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;
}
function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => !!mediaList(query)?.matches);
  useEffect(() => {
    const list = mediaList(query);
    if (!list || !list.addEventListener) return undefined;
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export default function Inbox() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [conversations, setConversations] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, pages: 0 });
  const [page, setPage] = useState(1);
  const [filterKey, setFilterKey] = useState(DEFAULT_INBOX_FILTER);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');

  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [messages, setMessages] = useState([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState('');
  const [notice, setNotice] = useState('');

  const [users, setUsers] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // When the composer still holds an unedited rendered template, the id is sent
  // so the SERVER re-renders it authoritatively.
  const [templateId, setTemplateId] = useState('');
  const [templateRendered, setTemplateRendered] = useState('');
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');

  const [enrollments, setEnrollments] = useState([]);

  // Which side panels are open (see utils/inboxLayout.js). Independent of the
  // selected conversation: toggling never opens, closes or reloads a thread.
  const narrow = useMediaQuery(NARROW_QUERY);
  const compact = useMediaQuery(COMPACT_QUERY);
  const widthClass = narrow ? 'narrow' : compact ? 'compact' : 'wide';
  const [layout, setLayout] = useState(() =>
    layoutFor({
      narrow: !!mediaList(NARROW_QUERY)?.matches,
      compact: !!mediaList(COMPACT_QUERY)?.matches,
      hasSelection: false,
      stored: readStoredLayout(),
    })
  );
  // { type:'message'|'chat'|'bulk'|'all', message?, ids? (bulk), total? (all) }
  const [confirm, setConfirm] = useState(null);
  // What the operator typed in the Delete All dialog.
  const [deleteAllTyped, setDeleteAllTyped] = useState('');
  // A failed bulk delete, shown above the panels so it is visible even with the
  // conversation list collapsed — and never next to a success message.
  const [bulkError, setBulkError] = useState('');
  // Bulk selection (admin only — deletion is admin-only). Visible rows only.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const bulkLockRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [retryingId, setRetryingId] = useState(null);
  const [atBottom, setAtBottom] = useState(true);

  // Phase 9 (AI). Settings are fetched once — they are platform-wide and change
  // rarely, so there is no reason to poll them. `aiRefreshToken` is bumped by the
  // EXISTING poll when it sees activity, which is how the AI panel stays current
  // without starting a second timer for the same screen.
  const [aiSettings, setAiSettings] = useState(null);
  const [aiRefreshToken, setAiRefreshToken] = useState(0);

  // Inbox auto-refresh interval from Settings, in seconds (0 = off). Null until
  // it has loaded, so polling never starts at a value the admin did not choose.
  const [refreshSeconds, setRefreshSeconds] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const threadRef = useRef(null);
  const atBottomRef = useRef(true);
  // Scroll height/position just before an older page is added (load older).
  const olderAnchorRef = useRef(null);
  atBottomRef.current = atBottom;
  // The two side panels' scrollers, so collapsing and re-opening one returns it
  // to where the operator was.
  const listScrollRef = useRef(null);
  const panelRef = useRef(null);
  const savedScroll = useRef({ list: 0, details: 0 });
  // Only the newest list request may update the list: switching filters
  // quickly, or a poll landing mid-switch, can never show stale results.
  const listSeqRef = useRef(0);
  const selectedIdRef = useRef(null);
  // The latest list loader, read by the refresher so the polling timer does not
  // have to be rebuilt every time the search, filter or page changes.
  const fetchListRef = useRef(null);
  const refresherRef = useRef(null);
  const templatesRef = useRef(null);
  selectedIdRef.current = selectedId;

  // ---- conversation list -------------------------------------------------
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const listParams = useCallback(
    () => conversationListParams({ filterKey, search: debouncedSearch, page, limit: LIST_LIMIT }),
    [filterKey, debouncedSearch, page]
  );

  const fetchList = useCallback(async ({ quiet = false } = {}) => {
    const seq = ++listSeqRef.current;
    if (!quiet) setListLoading(true);
    setListError('');
    try {
      const { data } = await api.get('/conversations', { params: listParams() });
      if (seq !== listSeqRef.current) return;
      setConversations(data.data);
      setPagination(data.pagination);
      // The page no longer exists (its rows were deleted, here or elsewhere):
      // go to the last page that does. The page effect then refetches.
      const lastPage = Math.max(1, data.pagination?.pages || 1);
      if (data.data.length === 0 && page > lastPage) setPage(lastPage);
    } catch (err) {
      if (seq !== listSeqRef.current) return;
      setListError(err.response?.data?.message || 'Failed to load conversations');
    } finally {
      // Whichever request is newest ends the loading state, quiet or not.
      if (seq === listSeqRef.current) setListLoading(false);
    }
  }, [listParams, page]);

  const changeFilter = (key) => {
    setFilterKey(inboxFilter(key).key);
    setPage(1);
  };

  useEffect(() => { fetchList(); }, [fetchList]);
  fetchListRef.current = fetchList;

  // The selection never outlives the rows it refers to: a refresh, a page
  // change or a new filter drops anything no longer on screen.
  useEffect(() => {
    setSelectedIds((prev) => pruneSelection(prev, conversations.map((c) => c._id)));
  }, [conversations]);

  useEffect(() => {
    api.get('/users').then(({ data }) => setUsers(data.data)).catch(() => {});
  }, []);

  // Phase 9: AI configuration, read once. A failure is not surfaced — the inbox
  // must keep working exactly as before if the AI settings cannot be read, and
  // the AI panel renders its own "AI off" state from a null value.
  useEffect(() => {
    aiApi.getSettings().then(setAiSettings).catch(() => setAiSettings(null));
  }, []);

  // ---- open a conversation ----------------------------------------------
  const loadEnrollments = useCallback(async (contactId) => {
    if (!contactId) { setEnrollments([]); return; }
    try {
      const { data } = await api.get(`/enrollments/by-contact/${contactId}`);
      setEnrollments(data.data);
    } catch { setEnrollments([]); }
  }, []);

  const openConversation = async (id) => {
    setSelectedId(id);
    // Where the list is a drawer over the chat, picking a thread closes it.
    setLayout((prev) => afterSelect(prev, { narrow }));
    setDetailLoading(true);
    setDetailError('');
    setReplyError('');
    setNotice('');
    setMessages([]);
    setHasOlder(false);
    clearTemplate();
    try {
      const [{ data: d }, { data: m }] = await Promise.all([
        api.get(`/conversations/${id}`),
        // Newest page first — a long thread must open at the bottom.
        api.get(`/conversations/${id}/messages`, { params: { limit: PAGE_SIZE } }),
      ]);
      setDetail(d.data);
      setMessages(m.data);
      setHasOlder(!!m.hasMore);
      setAtBottom(true);
      loadEnrollments(d.data.contact?._id || d.data.contact);
      await api.post(`/conversations/${id}/read`);
      fetchList({ quiet: true });
    } catch (err) {
      setDetailError(err.response?.data?.message || 'Failed to load conversation');
    } finally {
      setDetailLoading(false);
    }
  };

  // Phase 9: the AI draft queue links here with ?conversation=<id>. The thread is
  // opened directly (no dependency on it being on the current list page) and the
  // parameter is then removed, so a later refresh does not fight the operator's
  // own navigation.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const target = searchParams.get('conversation');
    if (!target) return;
    if (selectedIdRef.current !== target) openConversation(target);
    const next = new URLSearchParams(searchParams);
    next.delete('conversation');
    setSearchParams(next, { replace: true });
    // openConversation is stable enough for this one-shot deep link; re-running on
    // every render would reopen the thread and fight the operator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const loadOlder = async () => {
    if (!selectedId || !messages.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const { data } = await api.get(`/conversations/${selectedId}/messages`, {
        // (createdAt, _id) cursor: messages sharing the boundary timestamp are
        // neither skipped nor repeated.
        params: { limit: PAGE_SIZE, before: messages[0].createdAt, beforeId: messages[0]._id },
      });
      // Keep the reading position steady instead of jumping to the top: the
      // layout effect below re-applies it as soon as the older page renders.
      const el = threadRef.current;
      if (el) olderAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
      setMessages((prev) => mergeMessages(prev, data.data));
      setHasOlder(!!data.hasMore);
    } catch (err) {
      setDetailError(err.response?.data?.message || 'Failed to load older messages');
    } finally {
      setLoadingOlder(false);
    }
  };

  // ---- polling -----------------------------------------------------------
  // One refresher for the life of the page (single-flight, so the timer, the
  // tab regaining focus and the Refresh button can never overlap), and one
  // timer at the configured interval. See utils/inboxRefresh.js.
  //
  // It only ever updates the list, the open thread's messages and the AI panel
  // token — never the composer, so a reply being typed is left alone.
  if (!refresherRef.current) {
    refresherRef.current = createInboxRefresher({
      api,
      pageSize: PAGE_SIZE,
      getSelectedId: () => selectedIdRef.current,
      refreshList: () => fetchListRef.current({ quiet: true }),
      onMessages: (incoming) => setMessages((prev) => mergeMessages(prev, incoming)),
      // Phase 9: tell the AI panel to resync off the SAME refresh rather than
      // running an interval of its own.
      onActivity: () => setAiRefreshToken((t) => t + 1),
      // Keep the sidebar's unread badge in step without a request of its own.
      onUnread: (count) => {
        try {
          window.dispatchEvent(new CustomEvent('inbox:unread', { detail: count }));
        } catch {
          /* the badge's own slower poll still covers it */
        }
      },
    });
  }

  // The interval is read once. If it cannot be read, the default applies.
  useEffect(() => {
    let cancelled = false;
    api
      .get('/settings/inbox')
      .then(({ data }) => {
        if (!cancelled) setRefreshSeconds(normalizeRefreshSeconds(data.settings?.inboxRefreshSeconds));
      })
      .catch(() => {
        if (!cancelled) setRefreshSeconds(DEFAULT_INBOX_REFRESH_SECONDS);
      });
    return () => { cancelled = true; };
  }, []);

  // Depends on the interval ONLY: searching, filtering, paging or typing never
  // rebuilds the timer, and the cleanup stops it on unmount or a new interval.
  useEffect(() => {
    if (refreshSeconds === null) return undefined;
    return startInboxPolling({ seconds: refreshSeconds, refresh: refresherRef.current });
  }, [refreshSeconds]);

  // Manual refresh works whatever the setting, including Off.
  const refreshNow = async () => {
    setRefreshing(true);
    try {
      await refresherRef.current({ force: true });
    } finally {
      setRefreshing(false);
    }
  };

  // Stay pinned to the newest message only when already at the bottom, so
  // polling never yanks someone away from history they are reading. Also runs
  // when the thread first mounts: a conversation's messages arrive while it is
  // still loading, before the thread element exists, and it must still open on
  // the newest message.
  const threadMounted = !!(selectedId && detail && !detailLoading);
  // After an older page is prepended, keep the same message under the
  // operator's eyes — applied before paint, so nothing visibly jumps.
  useIsomorphicLayoutEffect(() => {
    const anchor = olderAnchorRef.current;
    const el = threadRef.current;
    if (!anchor || !el) return;
    olderAnchorRef.current = null;
    el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
  }, [messages]);
  useEffect(() => {
    const el = threadRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [messages, atBottom, threadMounted]);

  const onThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  // ---- side panels -------------------------------------------------------
  // A new width class (rotating a tablet, resizing the window) re-derives the
  // layout; a wide screen gets the operator's remembered choice back.
  const firstWidthRef = useRef(true);
  useEffect(() => {
    if (firstWidthRef.current) { firstWidthRef.current = false; return; }
    setLayout(layoutFor({ narrow, compact, hasSelection: !!selectedIdRef.current, stored: readStoredLayout() }));
    // Keyed on the width class only; narrow/compact are what it is derived from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthClass]);

  const togglePanel = (panel) => {
    const key = panel === 'list' ? 'listOpen' : 'detailsOpen';
    if (layout[key]) {
      const el = panel === 'list' ? listScrollRef.current : panelRef.current;
      if (el) savedScroll.current[panel] = el.scrollTop;
    }
    const next = flipPanel(layout, panel);
    setLayout(next);
    // Remember only choices made where the panel sits beside the chat; opening
    // a drawer on a phone says nothing about the desktop layout.
    if (widthClass === 'wide') writeStoredLayout(next);
    else if (widthClass === 'compact' && panel === 'list') {
      writeStoredLayout({ ...readStoredLayout(), listOpen: next.listOpen });
    }
  };

  const overlays = overlaysOpen(layout, { narrow, compact });
  const closeOverlays = () =>
    setLayout((prev) => ({
      listOpen: overlays.list ? false : prev.listOpen,
      detailsOpen: overlays.details ? false : prev.detailsOpen,
    }));

  // Escape closes an open drawer.
  const anyOverlay = overlays.list || overlays.details;
  useEffect(() => {
    if (!anyOverlay) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setLayout((prev) => ({ ...prev, ...(narrow ? { listOpen: false } : {}), detailsOpen: false }));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [anyOverlay, narrow]);

  // A re-opened panel returns to its earlier scroll position, and the thread —
  // which has just changed width — stays on the newest message if it was there.
  useIsomorphicLayoutEffect(() => {
    if (layout.listOpen && listScrollRef.current) listScrollRef.current.scrollTop = savedScroll.current.list;
  }, [layout.listOpen]);
  useIsomorphicLayoutEffect(() => {
    if (layout.detailsOpen && panelRef.current) panelRef.current.scrollTop = savedScroll.current.details;
  }, [layout.detailsOpen]);
  useIsomorphicLayoutEffect(() => {
    const el = threadRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [layout.listOpen, layout.detailsOpen]);

  // Any other resize of the thread (window, composer growing) keeps it pinned
  // to the newest message in the same way.
  useEffect(() => {
    const el = threadRef.current;
    if (!threadMounted || !el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [threadMounted, selectedId]);

  const jumpToLatest = () => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  // ---- composer ----------------------------------------------------------
  const clearTemplate = () => { setTemplateId(''); setTemplateRendered(''); };

  const onReplyChange = (value) => {
    setReplyText(value);
    // Once the operator edits a rendered template, send the text as typed.
    if (templateId && value !== templateRendered) clearTemplate();
  };

  const openTemplates = async () => {
    setTemplatesOpen((v) => !v);
    if (templates.length === 0) {
      try {
        const { data } = await api.get('/templates', { params: { limit: 100 } });
        setTemplates(data.data);
      } catch { setTemplates([]); }
    }
  };

  // Preview is rendered by the SERVER via the existing /templates/preview
  // endpoint, so what the operator sees matches what will be sent.
  const insertTemplate = async (t) => {
    setTemplatesOpen(false);
    setReplyError('');
    try {
      const { data } = await api.post('/templates/preview', {
        templateId: t._id,
        contactId: detail?.contact?._id,
      });
      setReplyText(data.rendered);
      setTemplateRendered(data.rendered);
      setTemplateId(t._id);
    } catch (err) {
      setReplyError(err.response?.data?.message || 'Failed to load the template');
    }
  };

  useEffect(() => {
    if (!templatesOpen) return undefined;
    const onDown = (e) => {
      if (templatesRef.current && !templatesRef.current.contains(e.target)) setTemplatesOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [templatesOpen]);

  const sendReply = async (e) => {
    if (e) e.preventDefault();
    if (!replyText.trim() || !selectedId || sending) return;
    setSending(true);
    setReplyError('');
    try {
      // An untouched rendered template is sent by id so the server renders the
      // merge fields itself; anything edited is sent as typed.
      const payload =
        templateId && replyText === templateRendered ? { templateId } : { body: replyText };
      await api.post(`/conversations/${selectedId}/reply`, payload);
      setReplyText('');
      clearTemplate();
      const { data: m } = await api.get(`/conversations/${selectedId}/messages`, {
        params: { limit: PAGE_SIZE },
      });
      setMessages((prev) => mergeMessages(prev, m.data));
      setAtBottom(true);
      fetchList({ quiet: true });
    } catch (err) {
      setReplyError(err.response?.data?.message || 'Failed to send reply');
    } finally {
      setSending(false);
    }
  };

  const onComposerKeyDown = (e) => {
    // Enter sends, Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  };

  const saveAsTemplate = async () => {
    if (!newTemplateName.trim() || !replyText.trim()) return;
    setBusy(true);
    try {
      await api.post('/templates', { name: newTemplateName.trim(), body: replyText });
      setNotice('Saved as a template.');
      setSaveTemplateOpen(false);
      setNewTemplateName('');
      setTemplates([]); // refetch next time the popover opens
    } catch (err) {
      setReplyError(err.response?.data?.message || 'Failed to save the template');
    } finally {
      setBusy(false);
    }
  };

  // ---- message actions ---------------------------------------------------
  const retryMessage = async (m) => {
    setRetryingId(m._id);
    setDetailError('');
    setNotice('');
    try {
      const { data } = await api.post(`/sms/${m._id}/retry`);
      setNotice(`Message resent (${data.result.simulated ? 'simulated' : data.result.status}).`);
      setMessages((prev) => mergeMessages(prev, [data.message]));
      fetchList({ quiet: true });
    } catch (err) {
      setDetailError(err.response?.data?.message || 'Retry failed');
    } finally {
      setRetryingId(null);
    }
  };

  const performDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    setDetailError('');
    setNotice('');
    try {
      if (confirm.type === 'message') {
        await api.delete(`/conversations/messages/${confirm.message._id}`);
        setMessages((prev) => prev.filter((m) => m._id !== confirm.message._id));
        setNotice('Message deleted.');
      } else {
        await api.delete(`/conversations/${selectedId}`);
        setNotice('Conversation deleted. Its message history was preserved.');
        setSelectedId(null);
        setDetail(null);
        setMessages([]);
      }
      setConfirm(null);
      fetchList({ quiet: true });
    } catch (err) {
      setDetailError(err.response?.data?.message || 'Delete failed');
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  // Delete Selected: the ids are captured when the dialog OPENS, so exactly the
  // conversations counted in the dialog are the ones sent — a poll that
  // reshuffles the page while it is open cannot change what gets deleted.
  const openDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    setBulkError('');
    setConfirm({ type: 'bulk', ids: [...selectedIds] });
  };

  // Delete All: its own dialog, the whole Inbox's size, and a typed phrase.
  const openDeleteAll = () => {
    setBulkError('');
    setDeleteAllTyped('');
    setConfirm({ type: 'all', total: null });
    requestInboxTotal(api)
      .then((total) => setConfirm((c) => (c && c.type === 'all' ? { ...c, total } : c)))
      .catch(() => { /* the dialog still works; it just cannot show the number */ });
  };

  // Delete Selected / Delete All — the same soft delete as the single delete.
  // The lock (with the dialog's busy state) guarantees one request per click.
  const performBulkDelete = async () => {
    if (!confirm || bulkLockRef.current) return;
    bulkLockRef.current = true;
    setBusy(true);
    setListError('');
    setBulkError('');
    // A success message from an earlier action must not sit beside this one's
    // outcome.
    setNotice('');
    try {
      // The request and its outcome are decided in utils/inboxSelection.js
      // (runBulkDelete), which is tested against the real axios client.
      const result = await runBulkDelete({
        api,
        confirm,
        typedPhrase: deleteAllTyped,
        conversations,
        selected: selectedIds,
        openId: selectedId,
        page,
      });
      if (result.skipped) return;
      if (!result.ok) {
        // Nothing is reported as deleted. The selection is kept so the
        // operator can retry, and the list is reloaded so it shows what the
        // server really holds (a request that failed part-way may still have
        // deleted some).
        setBulkError(result.error);
        setConfirm(null);
        fetchList({ quiet: true });
        return;
      }
      const { data, next } = result;
      setConversations(next.conversations);
      setSelectedIds(next.selected);
      if (next.closeOpen) {
        setSelectedId(null);
        setDetail(null);
        setMessages([]);
      }
      try {
        window.dispatchEvent(new CustomEvent('inbox:unread', { detail: data.unreadConversations }));
      } catch {
        /* the badge's own poll still catches up */
      }
      setNotice(result.notice);
      setConfirm(null);
      // A changed page refetches through its own effect; otherwise refetch here.
      if (next.page !== page) setPage(next.page);
      else fetchList({ quiet: true });
    } finally {
      bulkLockRef.current = false;
      setBusy(false);
    }
  };

  const changeStatus = async (status) => {
    try {
      const { data } = await api.patch(`/conversations/${selectedId}`, { status });
      setDetail(data.data);
      fetchList({ quiet: true });
    } catch (err) {
      setDetailError(err.response?.data?.message || 'Failed to update status');
    }
  };

  const changeAssignee = async (userId) => {
    try {
      const { data } = await api.patch(`/conversations/${selectedId}`, { assignedTo: userId || null });
      setDetail(data.data);
      fetchList({ quiet: true });
    } catch (err) {
      setDetailError(err.response?.data?.message || 'Failed to assign');
    }
  };

  const changeEnrollmentStatus = async (enrollmentId, status) => {
    setDetailError('');
    try {
      await api.patch(`/enrollments/${enrollmentId}`, { status });
      setNotice(`Enrollment ${status}.`);
      loadEnrollments(detail?.contact?._id);
    } catch (err) {
      setDetailError(err.response?.data?.message || 'Failed to update the enrollment');
    }
  };

  const contact = detail?.contact;
  // Name with phone fallback for the open conversation (header + panel). Falls
  // back to the thread's own copy when the contact record is gone.
  const who = contactIdentity(contact, detail);
  const optedOut = !!contact?.optedOut;
  const deliveryBlocked = !!contact?.deliveryBlocked;
  const composerDisabled = optedOut || deliveryBlocked;

  const empty = emptyListMessage({ filterKey, search: debouncedSearch });
  const activeFilter = inboxFilter(filterKey);
  const layoutClass = [
    'inbox-layout',
    layout.listOpen ? 'list-open' : 'list-collapsed',
    detail && layout.detailsOpen ? 'details-open' : 'details-collapsed',
  ].join(' ');

  return (
    <div className="page inbox-page">
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <div className="page-sub">Shared two-way SMS conversations with your contacts.</div>
        </div>
        <div className="row-actions">
          {refreshSeconds === 0 && <span className="muted small">Auto-refresh off</span>}
          <button type="button" className="btn btn-sm" onClick={refreshNow} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {isAdmin && (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={openDeleteAll}
              disabled={busy}
            >
              Delete All
            </button>
          )}
        </div>
      </div>

      {notice && <div className="alert alert-info"><div>{notice}</div></div>}
      {bulkError && <div className="alert alert-error" role="alert"><div>{bulkError}</div></div>}

      <div className={layoutClass}>
        {/* Drawers (narrow screens) sit over the chat; this closes them. */}
        {(overlays.list || (overlays.details && detail)) && (
          <div className="inbox-scrim" onClick={closeOverlays} aria-hidden="true" />
        )}

        {/* LEFT: conversation list. Kept mounted while collapsed, so the
            selection, the loaded page and the scroll position all survive. */}
        <aside
          id="inbox-conversation-list"
          className="convo-list"
          aria-label="Conversations"
          hidden={!layout.listOpen}
        >
          <div className="convo-list-head">
            <div className="convo-list-search">
              <input
                className="input"
                type="search"
                aria-label="Search conversations by contact name or phone"
                placeholder="Search name or phone…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button
                type="button"
                className="icon-btn drawer-close"
                onClick={() => togglePanel('list')}
                aria-label={toggleLabel('list', true)}
                title={toggleLabel('list', true)}
              >
                {CloseIcon}
              </button>
            </div>
            <div className="convo-filter-row">
              <label className="sr-only-label" htmlFor="inbox-filter">Show</label>
              <select
                id="inbox-filter"
                className="input convo-filter"
                value={filterKey}
                onChange={(e) => changeFilter(e.target.value)}
              >
                {INBOX_FILTERS.map((f) => (
                  <option key={f.key} value={f.key}>{f.label}</option>
                ))}
              </select>
              {/* The server's total for this filter + search: exact, not an
                  estimate, because it comes from the same query as the rows. */}
              <span className="muted small convo-count" aria-live="polite">
                {listLoading ? '…' : `${pagination.total} ${pagination.total === 1 ? 'conversation' : 'conversations'}`}
              </span>
            </div>
            {isAdmin && conversations.length > 0 && !listLoading && (() => {
              const visibleIds = conversations.map((c) => c._id);
              const state = selectAllState(selectedIds, visibleIds);
              // Page-scoped, and labelled as such: see selectionSummary.
              const summary = selectionSummary({
                selectedCount: selectedIds.size,
                pageCount: visibleIds.length,
                total: pagination.total,
                pages: pagination.pages,
              });
              return (
                <div className="convo-bulk">
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      aria-label={`Select all ${visibleIds.length} conversations on this page`}
                      checked={state === 'all'}
                      ref={(el) => { if (el) el.indeterminate = state === 'some'; }}
                      onChange={() => setSelectedIds((prev) => toggleSelectAll(prev, visibleIds))}
                      disabled={busy}
                    />
                    <span>{summary.label}</span>
                  </label>
                  {summary.hint && <div className="muted small convo-bulk-hint">{summary.hint}</div>}
                  {selectedIds.size > 0 && (
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={openDeleteSelected}
                        disabled={busy}
                      >
                        Delete Selected
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setSelectedIds(new Set())}
                        disabled={busy}
                      >
                        Clear Selection
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="convo-scroll" ref={listScrollRef}>
            {listError && <div className="alert alert-error"><div>{listError}</div></div>}
            {listLoading ? (
              <Spinner label="Loading conversations…" />
            ) : conversations.length === 0 ? (
              <EmptyState icon={InboxIcon} title={empty.title} hint={empty.hint} />
            ) : (
              conversations.map((c) => {
                // Name, or the phone when there is no name — never a blank row.
                const id = contactIdentity(c.contact, c);
                return (
                <div key={c._id} className={`convo-row${isAdmin ? ' selectable' : ''}`}>
                {isAdmin && (
                  <input
                    type="checkbox"
                    className="convo-select"
                    aria-label={`Select conversation with ${id.title || 'contact'}`}
                    checked={selectedIds.has(c._id)}
                    onChange={() => setSelectedIds((prev) => toggleSelected(prev, c._id))}
                    disabled={busy}
                  />
                )}
                <button
                  className={`convo-item ${selectedId === c._id ? 'active' : ''}`}
                  onClick={() => openConversation(c._id)}
                >
                  <div className="convo-item-top">
                    <span className="convo-name">{id.title || 'Unknown contact'}</span>
                    <span className="convo-time muted">{timeAgo(c.lastMessageAt)}</span>
                  </div>
                  {/* The phone is secondary — shown only when a name is the title. */}
                  {id.subtitle && <div className="convo-item-mid muted small">{id.subtitle}</div>}
                  <div className="convo-preview small">
                    {c.lastMessageDirection === 'outbound' ? '↩ ' : ''}
                    {c.lastMessagePreview || <span className="muted">No messages</span>}
                  </div>
                  <div className="convo-item-bot">
                    <span className={`chip ${c.status === 'open' ? 'chip-on' : ''}`}>{c.status}</span>
                    {c.assignedTo && <span className="chip">{c.assignedTo.name || c.assignedTo.email}</span>}
                    {c.contact?.optedOut && <span className="chip chip-invalid">opted out</span>}
                    {c.contact?.deliveryBlocked && <span className="chip chip-warn">blocked</span>}
                    {c.unreadCount > 0 && <span className="badge-unread">{c.unreadCount}</span>}
                  </div>
                </button>
                </div>
                );
              })
            )}
          </div>
          <div className="pagination convo-pager">
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
            <span className="muted small">Page {pagination.page}/{pagination.pages || 1} ({pagination.total})</span>
            <button className="btn btn-sm" disabled={page >= (pagination.pages || 1)} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </aside>

        {/* MIDDLE: conversation detail. The header is always there, so both
            panel toggles are reachable even before a thread is chosen. */}
        <section className="convo-detail" aria-label="Conversation">
          <div className="detail-head">
            <button
              type="button"
              className="icon-btn panel-toggle"
              onClick={() => togglePanel('list')}
              aria-label={toggleLabel('list', layout.listOpen)}
              title={toggleLabel('list', layout.listOpen)}
              aria-expanded={layout.listOpen}
              aria-controls="inbox-conversation-list"
            >
              {PanelLeftIcon}
            </button>
            <div className="detail-who">
              {detail && !detailLoading ? (
                <>
                  <strong>{who.title || 'Unknown contact'}</strong>
                  {who.subtitle && <div className="muted small">{who.subtitle}</div>}
                  {/* Phase 9: the AI state that changes what an operator should
                      do, visible without opening the side panel. */}
                  {detail.ai && (
                    <div className="chip-row" style={{ marginTop: 4 }}>
                      {conversationAiChips(aiSettings, detail).map((c) => (
                        <span key={c.key} className={c.chipClass} title={c.title}>
                          {c.label}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <span className="muted small">{activeFilter.label}</span>
              )}
            </div>
            {detail && !detailLoading && (
              <div className="detail-controls">
                <select
                  className="input input-narrow"
                  aria-label="Assign conversation"
                  value={detail.assignedTo?._id || detail.assignedTo || ''}
                  onChange={(e) => changeAssignee(e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {users.map((u) => (
                    <option key={u._id} value={u._id}>{u.name || u.email}</option>
                  ))}
                </select>
                {detail.status === 'open' ? (
                  <button className="btn btn-sm" onClick={() => changeStatus('closed')}>Close</button>
                ) : (
                  <button className="btn btn-sm" onClick={() => changeStatus('open')}>Reopen</button>
                )}
                {isAdmin && (
                  <button className="btn btn-sm btn-danger" onClick={() => setConfirm({ type: 'chat' })}>
                    Delete chat
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              className="icon-btn panel-toggle"
              onClick={() => togglePanel('details')}
              aria-label={toggleLabel('details', !!detail && layout.detailsOpen)}
              title={detail ? toggleLabel('details', layout.detailsOpen) : 'Select a conversation to see contact details'}
              aria-expanded={!!detail && layout.detailsOpen}
              aria-controls="inbox-contact-panel"
              disabled={!detail}
            >
              {PanelRightIcon}
            </button>
          </div>

          {!selectedId ? (
            <EmptyState
              icon={InboxIcon}
              title="No conversation selected"
              hint="Select a conversation from the list to view its messages and reply."
            />
          ) : detailLoading ? (
            <Spinner label="Loading conversation…" />
          ) : detailError && !detail ? (
            <div className="alert alert-error"><div>{detailError}</div></div>
          ) : detail ? (
            <>
              {detailError && <div className="alert alert-error"><div>{detailError}</div></div>}

              <div className="msg-thread-wrap">
                <div className="msg-thread" ref={threadRef} onScroll={onThreadScroll}>
                  {hasOlder && (
                    <div style={{ textAlign: 'center' }}>
                      <button className="btn btn-sm" onClick={loadOlder} disabled={loadingOlder}>
                        {loadingOlder ? 'Loading…' : 'Load older messages'}
                      </button>
                    </div>
                  )}
                  {messages.length === 0 ? (
                    <div className="state"><div className="state-hint">No messages in this conversation yet.</div></div>
                  ) : (
                    messages.map((m, i) => {
                      const kw = m.direction === 'inbound' ? keywordOf(m.body) : null;
                      const prev = i > 0 ? messages[i - 1] : null;
                      const showDay =
                        !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
                      const canRetry = m.direction === 'outbound' && RETRYABLE.has(String(m.status || '').toLowerCase());
                      return (
                        <Fragment key={m._id}>
                          {showDay && (
                            <div className="day-sep">
                              <span>{dayLabel(m.createdAt)}</span>
                            </div>
                          )}
                          <div className={`bubble-row ${m.direction}`}>
                            <div className={`bubble ${m.direction}`}>
                              <div className="bubble-body">{m.body}</div>
                              <div className="bubble-meta">
                                {/* Phase 9: a message the assistant sent, from the
                                    existing `source` field. Subtle and only where
                                    it applies — a human reply carries no badge. */}
                                {(() => {
                                  const badge = messageBadge(m);
                                  return badge ? (
                                    <>
                                      <span className={badge.chipClass} title={badge.title}>
                                        {badge.label}
                                      </span>
                                      {' · '}
                                    </>
                                  ) : null;
                                })()}
                                {m.direction} · {new Date(m.createdAt).toLocaleString()}
                                {m.direction === 'outbound' && m.status ? (
                                  <>
                                    {' · '}
                                    <span
                                      className={statusChipClass(m.status)}
                                      title={m.errorCode ? `Twilio error ${m.errorCode}${m.error ? `: ${m.error}` : ''}` : m.error || m.status}
                                    >
                                      {m.status}{m.errorCode ? ` (${m.errorCode})` : ''}
                                    </span>
                                  </>
                                ) : m.status ? ` · ${m.status}` : ''}
                                {canRetry && (
                                  <>
                                    {' '}
                                    <button
                                      className="btn btn-sm"
                                      onClick={() => retryMessage(m)}
                                      disabled={retryingId === m._id}
                                    >
                                      {retryingId === m._id ? 'Retrying…' : 'Retry'}
                                    </button>
                                  </>
                                )}
                                {isAdmin && !kw && (
                                  <>
                                    {' '}
                                    <button
                                      className="btn btn-sm btn-ghost"
                                      title="Delete this message"
                                      onClick={() => setConfirm({ type: 'message', message: m })}
                                    >
                                      ×
                                    </button>
                                  </>
                                )}
                                {isAdmin && kw && (
                                  <span className="muted" title="Opt-out records cannot be deleted"> · kept for compliance</span>
                                )}
                              </div>
                            </div>
                          </div>
                          {kw && (
                            <div className="bubble-row" style={{ justifyContent: 'center' }}>
                              <span className={kw === 'stop' ? 'chip chip-invalid' : 'chip chip-on'}>
                                {kw === 'stop' ? 'Contact opted out (STOP) — sending disabled' : 'Contact opted back in (START)'}
                              </span>
                            </div>
                          )}
                        </Fragment>
                      );
                    })
                  )}
                </div>

                {!atBottom && (
                  <div className="jump-latest">
                    <button className="btn btn-sm" onClick={jumpToLatest}>↓ Jump to latest</button>
                  </div>
                )}
              </div>

              <form className="reply-box" onSubmit={sendReply}>
                {replyError && <div className="alert alert-error"><div>{replyError}</div></div>}
                {optedOut && (
                  <div className="alert alert-error">
                    <div>
                      This contact opted out — sending disabled.
                      {contact.optedOutAt && (
                        <div className="muted small">
                          Opted out {new Date(contact.optedOutAt).toLocaleString()}
                          {contact.optOutSource ? ` · via ${contact.optOutSource}` : ''}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {!optedOut && deliveryBlocked && (
                  <div className="alert alert-error">
                    <div>
                      Delivery blocked — messages to this number keep failing. An admin can clear
                      this on the SMS Delivery page.
                    </div>
                  </div>
                )}
                <div className="reply-row">
                  <textarea
                    rows={2}
                    placeholder={
                      optedOut ? 'This contact has opted out'
                        : deliveryBlocked ? 'This number is delivery blocked'
                        : 'Type a reply…  (Enter to send, Shift+Enter for a new line)'
                    }
                    value={replyText}
                    onChange={(e) => onReplyChange(e.target.value)}
                    onKeyDown={onComposerKeyDown}
                    disabled={composerDisabled}
                  />
                  <button className="btn btn-primary" type="submit" disabled={sending || !replyText.trim() || composerDisabled}>
                    {sending ? 'Sending…' : 'Send'}
                  </button>
                </div>
                <div className="composer-bar">
                  <SmsCounter text={replyText} />
                  <div className="composer-actions" ref={templatesRef}>
                    <button type="button" className="btn btn-sm" onClick={openTemplates} disabled={composerDisabled}>
                      Templates
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!replyText.trim()}
                      onClick={() => setSaveTemplateOpen(true)}
                    >
                      Save as template
                    </button>
                    {templatesOpen && (
                      <div className="ms-panel ms-panel-up" role="listbox">
                        <div className="ms-list">
                          {templates.length === 0 ? (
                            <div className="ms-empty muted small">No templates yet.</div>
                          ) : (
                            templates.map((t) => (
                              <button
                                type="button"
                                className="ms-opt"
                                key={t._id}
                                onClick={() => insertTemplate(t)}
                                style={{ width: '100%', textAlign: 'left' }}
                              >
                                <span className="ms-name">{t.name}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                {templateId && (
                  <div className="muted small">
                    Using a template — merge fields are filled in by the server when it is sent.
                  </div>
                )}
              </form>
            </>
          ) : null}
        </section>

        {/* RIGHT: contact + automation panel. Also kept mounted while hidden. */}
        {selectedId && detail && (
          <aside
            id="inbox-contact-panel"
            className="contact-panel"
            aria-label="Contact details"
            hidden={!layout.detailsOpen}
            ref={panelRef}
          >
            <button
              type="button"
              className="icon-btn drawer-close panel-close"
              onClick={() => togglePanel('details')}
              aria-label={toggleLabel('details', true)}
              title={toggleLabel('details', true)}
            >
              {CloseIcon}
            </button>
            <h3>Contact</h3>
            <table className="kv">
              <tbody>
                {who.name && <tr><td className="muted">Name</td><td>{who.name}</td></tr>}
                {who.phone && <tr><td className="muted">Phone</td><td className="mono small">{who.phone}</td></tr>}
                {contact?.email && <tr><td className="muted">Email</td><td className="small">{contact.email}</td></tr>}
                {contact?.timezone && <tr><td className="muted">Timezone</td><td className="small">{contact.timezone}</td></tr>}
                <tr>
                  <td className="muted">Line type</td>
                  <td className="small">
                    {contact?.lookup?.status && contact.lookup.status !== 'unknown' ? (
                      contact.lookup.status === 'invalid'
                        ? <span className="chip chip-invalid">invalid</span>
                        : <span className="chip chip-on">{contact.lookup.type || 'valid'}</span>
                    ) : <span className="muted">not looked up</span>}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Consent</td>
                  <td className="small">
                    {optedOut
                      ? <span className="chip chip-invalid">opted out</span>
                      : <span className="chip chip-on">can receive</span>}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Delivery</td>
                  <td className="small">
                    {deliveryBlocked
                      ? <span className="chip chip-warn">blocked ({contact.deliveryFailureCount || 0} failures)</span>
                      : <span className="chip">ok</span>}
                  </td>
                </tr>
              </tbody>
            </table>

            {contact?.tags?.length > 0 && (
              <>
                <h3>Tags</h3>
                <div>{contact.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div>
              </>
            )}

            {/* Phase 9: AI state, takeover, this conversation's mode and any
                draft waiting on it. Refetches off the inbox's existing poll. */}
            <AiConversationPanel
              conversationId={selectedId}
              aiSettings={aiSettings}
              refreshToken={aiRefreshToken}
              onConversationChanged={() => {
                // The thread's own AI fields live on the conversation document, so
                // reload it rather than guessing at the new state.
                api
                  .get(`/conversations/${selectedId}`)
                  .then(({ data }) => setDetail(data.data))
                  .catch(() => {});
                fetchList({ quiet: true });
              }}
            />

            <h3>Campaigns</h3>
            {enrollments.length === 0 ? (
              <p className="muted small">This contact is not enrolled in any campaign.</p>
            ) : (
              enrollments.map((e) => (
                <div className="panel-row" key={e._id}>
                  <div>
                    <strong className="small">{e.campaignName || 'Campaign'}</strong>
                    <div className="muted small">
                      <span className={e.status === 'active' ? 'chip chip-on' : e.status === 'replied' ? 'chip chip-warn' : 'chip'}>
                        {e.status}
                      </span>
                      {e.totalSteps > 0 && <> step {Math.min(e.currentStepIndex + 1, e.totalSteps)} of {e.totalSteps}</>}
                    </div>
                    {e.status === 'active' && e.nextRunAt && (
                      <div className="muted small">next {new Date(e.nextRunAt).toLocaleString()}</div>
                    )}
                    {e.stopReason && <div className="muted small">{e.stopReason}</div>}
                  </div>
                  <div className="row-actions">
                    {e.status === 'active' && (
                      <button className="btn btn-sm" onClick={() => changeEnrollmentStatus(e._id, 'paused')}>Pause</button>
                    )}
                    {e.status === 'paused' && (
                      <button className="btn btn-sm" onClick={() => changeEnrollmentStatus(e._id, 'active')}>Resume</button>
                    )}
                    {['active', 'paused'].includes(e.status) && (
                      <button className="btn btn-sm btn-danger" onClick={() => changeEnrollmentStatus(e._id, 'cancelled')}>Cancel</button>
                    )}
                  </div>
                </div>
              ))
            )}
          </aside>
        )}
      </div>

      {saveTemplateOpen && (
        <Modal title="Save as template" onClose={() => setSaveTemplateOpen(false)}>
          <label className="field">
            <span>Template name *</span>
            <input
              value={newTemplateName}
              onChange={(e) => setNewTemplateName(e.target.value)}
              placeholder="Follow-up reply"
              autoFocus
            />
          </label>
          <div className="field">
            <span>Body</span>
            <div className="alert alert-info"><div style={{ whiteSpace: 'pre-wrap' }}>{replyText}</div></div>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setSaveTemplateOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={saveAsTemplate} disabled={busy || !newTemplateName.trim()}>
              {busy ? 'Saving…' : 'Save template'}
            </button>
          </div>
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title={
            confirm.type === 'message' ? 'Delete this message?'
              : confirm.type === 'bulk' ? deleteSelectedTitle(confirm.ids.length)
              : confirm.type === 'all' ? deleteAllTitle(confirm.total)
              : 'Delete this conversation?'
          }
          confirmLabel={confirm.type === 'all' ? 'Delete All' : confirm.type === 'bulk' ? 'Delete Selected' : 'Delete'}
          busy={busy}
          confirmDisabled={confirm.type === 'all' && !deleteAllPhraseMatches(deleteAllTyped)}
          onConfirm={confirm.type === 'bulk' || confirm.type === 'all' ? performBulkDelete : performDelete}
          onClose={() => { if (!busy) setConfirm(null); }}
          message={
            confirm.type === 'bulk' || confirm.type === 'all' ? (
              <>
                <p>{confirm.type === 'all' ? DELETE_ALL_CONFIRM : DELETE_SELECTED_CONFIRM}</p>
                <p className="muted small">{DELETE_PRESERVED_NOTE}</p>
                {confirm.type === 'all' && (
                  <label className="field">
                    <span>Type {DELETE_ALL_PHRASE} to confirm</span>
                    <input
                      value={deleteAllTyped}
                      onChange={(e) => setDeleteAllTyped(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                      autoFocus
                    />
                  </label>
                )}
              </>
            ) : confirm.type === 'message' ? (
              <p>
                Hide this message from the inbox. The record is kept in the database for audit, and
                opt-out (STOP/START) messages can never be deleted.
              </p>
            ) : (
              <p>
                Hide this conversation from the inbox. <strong>No messages are deleted</strong> — the
                full history, including any opt-out records, is preserved.
              </p>
            )
          }
        />
      )}
    </div>
  );
}
