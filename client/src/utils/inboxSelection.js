// Inbox bulk selection and bulk deletion.
//
// Pure state rules, kept out of Inbox.jsx so they can be tested directly. The
// selection is a Set of conversation ids and only ever covers what is VISIBLE —
// nothing off-screen can be deleted by "Delete Selected".

export const DELETE_SELECTED_CONFIRM =
  'Delete the selected conversations and their messages? This cannot be undone.';
export const DELETE_ALL_CONFIRM =
  'Delete all Inbox conversations and their messages? This cannot be undone.';

export function toggleSelected(selected, id) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// 'none' | 'some' | 'all' for the visible rows — drives the Select All box.
export function selectAllState(selected, visibleIds) {
  if (!visibleIds.length) return 'none';
  const count = visibleIds.filter((id) => selected.has(id)).length;
  if (count === 0) return 'none';
  return count === visibleIds.length ? 'all' : 'some';
}

// Select All selects every visible row; when they are all selected already it
// clears them instead, like any list checkbox.
export function toggleSelectAll(selected, visibleIds) {
  if (selectAllState(selected, visibleIds) === 'all') return new Set();
  return new Set(visibleIds);
}

// Drop ids that are no longer on screen (a refresh, a page change, a filter).
// Returns the SAME set when nothing changed so React skips the re-render.
export function pruneSelection(selected, visibleIds) {
  const visible = new Set(visibleIds);
  const kept = [...selected].filter((id) => visible.has(id));
  return kept.length === selected.size ? selected : new Set(kept);
}

// The Inbox after a successful bulk delete. `deletedIds` null means Delete All.
//   * deleted rows leave the list at once (before the refetch lands)
//   * their selection is cleared
//   * an open thread that was deleted is closed
//   * a page left empty steps back to the previous page
export function afterBulkDelete({ conversations, selected, openId, page, deletedIds }) {
  const all = deletedIds === null;
  const gone = new Set(all ? conversations.map((c) => c._id) : deletedIds);
  const remaining = all ? [] : conversations.filter((c) => !gone.has(c._id));
  const nextSelected = new Set([...selected].filter((id) => !all && !gone.has(id)));
  return {
    conversations: remaining,
    selected: nextSelected,
    closeOpen: !!openId && (all || gone.has(openId)),
    page: all ? 1 : remaining.length === 0 && page > 1 ? page - 1 : page,
  };
}

// The two requests. Kept here so their exact shape is tested against the real
// axios client.
export async function requestDeleteSelected(api, ids) {
  const { data } = await api.post('/conversations/bulk-delete', { ids });
  return data;
}

export async function requestDeleteAll(api) {
  const { data } = await api.post('/conversations/delete-all', { confirm: 'DELETE_ALL' });
  return data;
}
