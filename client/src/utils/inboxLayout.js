// Inbox panel layout: whether the conversation list (left) and the contact
// details (right) are shown. Kept free of React so the rules can be tested.
//
// Three widths, matching the media queries in styles.css:
//   wide     both panels sit beside the chat; collapsing one gives the chat its
//            space. The operator's choice is remembered in this browser.
//   compact  (<= COMPACT_QUERY) the details panel becomes an overlay drawer, so
//            it starts closed; the list still sits beside the chat.
//   narrow   (<= NARROW_QUERY) both panels are overlay drawers. The list is open
//            until a conversation is chosen, then gets out of the way.
//
// Toggling a panel never touches the selected conversation — that state lives
// in Inbox.jsx and none of these functions receive it except as a boolean.

export const NARROW_QUERY = '(max-width: 900px)';
export const COMPACT_QUERY = '(max-width: 1280px)';
export const LAYOUT_STORAGE_KEY = 'inbox.layout';

export const PANEL_LABELS = {
  list: { open: 'Collapse conversations', closed: 'Show conversations' },
  details: { open: 'Hide contact details', closed: 'Show contact details' },
};

export function toggleLabel(panel, open) {
  return PANEL_LABELS[panel][open ? 'open' : 'closed'];
}

// The remembered wide-screen preference. Storage can be missing, blocked or
// hold junk (private windows, cleared data); every case means "both open".
export function readStoredLayout(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(LAYOUT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      listOpen: parsed && typeof parsed.listOpen === 'boolean' ? parsed.listOpen : true,
      detailsOpen: parsed && typeof parsed.detailsOpen === 'boolean' ? parsed.detailsOpen : true,
    };
  } catch {
    return { listOpen: true, detailsOpen: true };
  }
}

export function writeStoredLayout(layout, storage = globalThis.localStorage) {
  try {
    if (storage) {
      storage.setItem(
        LAYOUT_STORAGE_KEY,
        JSON.stringify({ listOpen: !!layout.listOpen, detailsOpen: !!layout.detailsOpen })
      );
    }
  } catch {
    /* a convenience only — the layout still works for this visit */
  }
}

// The layout for the current width. Only a wide screen uses the remembered
// preference; drawers start closed so they never cover the chat by surprise.
export function layoutFor({ narrow, compact, hasSelection, stored }) {
  const pref = stored || { listOpen: true, detailsOpen: true };
  if (narrow) return { listOpen: !hasSelection, detailsOpen: false };
  if (compact) return { listOpen: pref.listOpen, detailsOpen: false };
  return { listOpen: pref.listOpen, detailsOpen: pref.detailsOpen };
}

// Flip one panel. The other is left exactly as it was: the toggles are
// independent.
export function togglePanel(layout, panel) {
  const key = panel === 'list' ? 'listOpen' : 'detailsOpen';
  return { ...layout, [key]: !layout[key] };
}

// Choosing a conversation closes the list only where it is a drawer over the
// chat; on wider screens the layout is left exactly as the operator set it.
export function afterSelect(layout, { narrow }) {
  return narrow ? { ...layout, listOpen: false } : layout;
}

// Which open panels are overlays (and so need a scrim and Escape to close).
export function overlaysOpen(layout, { narrow, compact }) {
  return {
    list: !!(narrow && layout.listOpen),
    details: !!((narrow || compact) && layout.detailsOpen),
  };
}
