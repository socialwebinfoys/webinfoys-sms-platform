// How a contact is shown: the name when there is one, otherwise the phone.
//
// One rule for the Inbox list, the open conversation's header, the contact
// panel and the AI draft cards, so none of them can show a blank title,
// "undefined", or the phone twice.
//
//   name "Austin City Dental", phone "+15121234567"
//     -> title "Austin City Dental", subtitle "+15121234567"
//   name blank, phone "+15121234567"
//     -> title "+15121234567", no subtitle
//
// `conversation` supplies the denormalised contactName / contactPhone the
// conversation list carries, used when the contact record itself is missing
// (e.g. it was deleted) so the thread still shows who it is with.

// A usable string, or ''. Whitespace-only values — and the literal text a bad
// import can leave behind — count as missing.
function clean(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).trim();
  return /^(undefined|null)$/i.test(text) ? '' : text;
}

export function contactIdentity(contact, conversation) {
  const c = contact && typeof contact === 'object' ? contact : null;
  const convo = conversation && typeof conversation === 'object' ? conversation : null;
  const name = clean(c?.name) || clean(convo?.contactName);
  const phone = clean(c?.phone) || clean(convo?.contactPhone);
  return {
    name,
    phone,
    // What to show as the heading: never blank while a phone is known.
    title: name || phone,
    // The phone as secondary information — only when it is not already the title.
    subtitle: name && phone ? phone : '',
    hasName: !!name,
  };
}
