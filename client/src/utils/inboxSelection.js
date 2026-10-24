// Inbox bulk selection and bulk deletion.
//
// Pure state rules, kept out of Inbox.jsx so they can be tested directly. The
// selection is a Set of conversation ids and only ever covers what is VISIBLE —
// the current page of the current filter and search. Nothing off-screen can be
// deleted by "Delete Selected"; "Delete All" is a separate action.
//
// Both deletions are the SAME soft delete as the single "Delete chat": the
// conversations are hidden from the Inbox and every message — including STOP /
// START and delivery records — is kept. The wording below says exactly that;
// it must never claim messages are removed.

export const DELETE_SELECTED_CONFIRM =
  'Only the conversations you ticked on this page are removed from the Inbox. Other pages are not affected.';
export const DELETE_ALL_CONFIRM =
  'Every conversation in the Inbox is removed — on every page and in every filter, not just the ones you can see.';
export const DELETE_PRESERVED_NOTE =
  'Message history is kept for compliance, including opt-out (STOP/START) and delivery records. Contacts, campaigns, enrollments and follow-ups are not affected. There is no undo in the Inbox.';

// Delete All must be typed, not just clicked: it is the one action here that
// reaches beyond what is on screen.
export const DELETE_ALL_PHRASE = 'DELETE ALL';
export function deleteAllPhraseMatches(typed) {
  return String(typed || '').trim() === DELETE_ALL_PHRASE;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The dialog titles, from the ids/total captured when the dialog opened.
export function deleteSelectedTitle(count) {
  return `Delete ${plural(count, 'selected conversation', 'selected conversations')}?`;
}
export function deleteAllTitle(total) {
  return typeof total === 'number'
    ? `Delete all ${plural(total, 'conversation', 'conversations')} in the Inbox?`
    : 'Delete every conversation in the Inbox?';
}

// What the Select All row says. Selection is PAGE-scoped, and the label says
// so whenever there is more than one page, so "all" is never mistaken for
// "everything in the Inbox".
export function selectionSummary({ selectedCount, pageCount, total, pages }) {
  const multiPage = (pages || 0) > 1 || (total || 0) > pageCount;
  if (selectedCount === 0) {
    return {
      label: multiPage ? `Select all ${pageCount} on this page` : `Select all ${pageCount}`,
      hint: '',
    };
  }
  return {
    label: multiPage
      ? `${selectedCount} of ${pageCount} on this page selected`
      : `${plural(selectedCount, 'conversation', 'conversations')} selected`,
    hint: multiPage ? `Other pages are not selected (${total} in this view).` : '',
  };
}

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

// One confirmed bulk deletion, start to finish, without touching React state:
// Inbox.jsx applies what this returns. `confirm` is the dialog's snapshot —
// { type: 'bulk', ids } or { type: 'all' } — so the ids sent are exactly the
// ones the dialog counted.
//
//   { ok: true,  data, next, notice }   the server confirmed the deletion
//   { ok: false, error }                nothing may be reported as deleted
//   { ok: false, skipped: true }        nothing was sent at all
//
// A 2xx whose body does not say success:true is treated as a failure, so a
// proxy page or an unexpected body can never be shown as "deleted".
export async function runBulkDelete({ api, confirm, typedPhrase, conversations, selected, openId, page }) {
  const all = confirm && confirm.type === 'all';
  if (all && !deleteAllPhraseMatches(typedPhrase)) return { ok: false, skipped: true };
  const ids = all ? null : [...((confirm && confirm.ids) || [])];
  if (!all && ids.length === 0) return { ok: false, skipped: true };
  const action = all ? 'Delete All' : 'Delete Selected';
  try {
    const data = all ? await requestDeleteAll(api) : await requestDeleteSelected(api, ids);
    if (!data || data.success !== true) throw new Error('the server did not confirm the deletion');
    // Every requested id leaves the list, including any the server skipped
    // because someone else had already deleted it.
    const next = afterBulkDelete({ conversations, selected, openId, page, deletedIds: ids });
    return { ok: true, data, next, notice: `${data.message} Message history was preserved for compliance.` };
  } catch (err) {
    const reason = (err && err.response && err.response.data && err.response.data.message)
      || (err && err.message)
      || 'the server did not respond';
    return { ok: false, error: `${action} failed: ${reason}. Check the list before trying again.` };
  }
}

// The whole Inbox's size (no filter, no search), shown in the Delete All
// dialog so the operator sees exactly how much it covers.
export async function requestInboxTotal(api) {
  const { data } = await api.get('/conversations', { params: { page: 1, limit: 1 } });
  return data && data.pagination ? data.pagination.total : null;
}

export async function requestDeleteAll(api) {
  const { data } = await api.post('/conversations/delete-all', { confirm: 'DELETE_ALL' });
  return data;
}
