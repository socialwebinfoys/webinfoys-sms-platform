// The Inbox filter dropdown. Each option maps to query parameters the server's
// GET /api/conversations already understands — the filtering itself happens in
// MongoDB (conversationController.buildConversationFilter), never here, so it
// works across every page of results and together with search.
//
//   all          -> nothing: every visible thread, open or closed, delivered,
//                   undelivered or opted out
//   delivered    -> delivery=delivered: the contact has an outbound message
//                   whose Twilio status is 'delivered' (a carrier receipt;
//                   'sent'/'queued'/'simulated' do not count)
//   undelivered  -> delivery=undelivered: the contact has an outbound message
//                   whose Twilio status is 'failed' or 'undelivered'
//                   A thread with both kinds is listed under both.
//   optedOut     -> optedOut=true: the contact's consent flag (Contact.optedOut)
//   unread       -> unread=true: unreadCount > 0
//   needsReply   -> needsReply=true: the last message was inbound
//   mine         -> assigned=me
//   closed       -> status=closed
export const INBOX_FILTERS = [
  {
    key: 'all',
    label: 'All messages',
    params: {},
    empty: 'No conversations yet',
    hint: 'Inbound replies and outbound messages will appear here as conversations.',
  },
  {
    key: 'delivered',
    label: 'Delivered',
    params: { delivery: 'delivered' },
    empty: 'No delivered conversations',
    hint: 'No conversation has an outbound message the carrier confirmed as delivered yet.',
  },
  {
    key: 'undelivered',
    label: 'Undelivered',
    params: { delivery: 'undelivered' },
    empty: 'No undelivered conversations',
    hint: 'No conversation has an outbound message that failed or was undelivered.',
  },
  {
    key: 'optedOut',
    label: 'STOP / Opted out',
    params: { optedOut: 'true' },
    empty: 'No opted-out contacts',
    hint: 'Contacts who reply STOP, or are opted out by an operator or their carrier, appear here.',
  },
  {
    key: 'unread',
    label: 'Unread',
    params: { unread: 'true' },
    empty: 'No unread conversations',
    hint: 'Every message has been read.',
  },
  {
    key: 'needsReply',
    label: 'Needs reply',
    params: { needsReply: 'true' },
    empty: 'Nothing needs a reply',
    hint: 'Conversations whose latest message came from the contact appear here.',
  },
  {
    key: 'mine',
    label: 'Assigned to me',
    params: { assigned: 'me' },
    empty: 'Nothing assigned to you',
    hint: 'Conversations assigned to you appear here.',
  },
  {
    key: 'closed',
    label: 'Closed',
    params: { status: 'closed' },
    empty: 'No closed conversations',
    hint: 'Conversations you close appear here.',
  },
];

export const DEFAULT_INBOX_FILTER = 'all';

export function inboxFilter(key) {
  return INBOX_FILTERS.find((f) => f.key === key) || INBOX_FILTERS[0];
}

// Query parameters for one list request: the filter, the search and the page.
export function conversationListParams({ filterKey, search, page, limit }) {
  const term = String(search || '').trim();
  return { ...inboxFilter(filterKey).params, search: term || undefined, page, limit };
}

// What the empty list says, so "nothing matched" is never mistaken for "the
// inbox is empty".
export function emptyListMessage({ filterKey, search }) {
  const f = inboxFilter(filterKey);
  const term = String(search || '').trim();
  if (term) {
    return {
      title: 'No matching conversations',
      hint: f.key === 'all'
        ? `Nothing matches “${term}”. Try a different name or number.`
        : `Nothing in “${f.label}” matches “${term}”. Try a different search or filter.`,
    };
  }
  return { title: f.empty, hint: f.hint };
}
