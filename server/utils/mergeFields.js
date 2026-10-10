// Merge-field support — the ONE resolver for every message path: campaign
// steps, follow-ups, inbox replies, manual sends and the preview endpoint. A
// preview and the SMS that is actually sent are produced by the same two
// functions below, so they cannot differ.
//
// A merge field looks like {{ first_name }}. Matching is forgiving about how the
// token is written — {{Name}}, {{First_Name}}, {{firstName}} and {{First Name}}
// all resolve — because a token that fails to match must never reach a customer.
//
// MISSING VALUES. A field with no value is replaced with nothing and reported in
// `unresolved`; the literal "{{...}}" is never sent. The whitespace left behind
// is tidied ("Hi {{first_name}}, …" -> "Hi, …"), and ONLY there: text that
// contains no merge fields is returned exactly as it was given.

// Anything between double braces on one line. Deliberately broad: a narrower
// pattern is what used to let "{{First Name}}" through as literal text.
const MERGE_FIELD_RE = /\{\{[ \t]*([^{}\n]{0,80}?)[ \t]*\}\}/g;

// Marks an empty replacement while the surrounding whitespace is tidied.
const EMPTY = '';

// Canonical form of a token or data key: case, spaces, underscores, dashes and
// dots are ignored, so "First Name" === "first_name" === "firstName".
function canon(key) {
  return String(key === undefined || key === null ? '' : key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Other spellings of the built-in contact fields. The phone/email/name lists
// mirror the column aliases the importer already accepts (utils/fileParser.js).
const ALIASES = {
  name: ['name', 'fullname', 'contactname'],
  first_name: ['firstname', 'fname', 'givenname', 'first'],
  last_name: ['lastname', 'lname', 'surname', 'familyname', 'last'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'cell', 'number', 'tel', 'telephone'],
  email: ['email', 'emailaddress', 'mail'],
};
const ALIAS_TO_FIELD = new Map(
  Object.entries(ALIASES).flatMap(([field, list]) => list.map((a) => [a, field]))
);

const hasValue = (v) => v !== undefined && v !== null && v !== '';

// Return the unique list of merge-field names used in a body, as written.
function extractMergeFields(text) {
  if (!text) return [];
  const found = new Set();
  let match;
  MERGE_FIELD_RE.lastIndex = 0;
  while ((match = MERGE_FIELD_RE.exec(text)) !== null) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

// The value for one token, or undefined. Order:
//   1. the exact key (so existing templates and explicit data behave as before)
//   2. a data key with the same canonical form ({{City}} -> custom field "city")
//   3. a built-in alias ({{full_name}} -> name)
// Only THIS contact's data is ever consulted.
function resolveField(token, data, canonIndex) {
  if (hasValue(data[token])) return data[token];
  const c = canon(token);
  if (!c) return undefined;
  if (canonIndex.has(c)) return canonIndex.get(c);
  const field = ALIAS_TO_FIELD.get(c);
  if (field && hasValue(data[field])) return data[field];
  return undefined;
}

// Replace merge fields in `text` using values from `data`. Missing fields are
// replaced with an empty string and reported in `unresolved`.
function renderTemplate(text, data = {}) {
  const source = String(text === undefined || text === null ? '' : text);
  // No merge fields: the message is returned untouched.
  if (!source.includes('{{')) return { rendered: source, unresolved: [] };

  const safeData = data && typeof data === 'object' ? data : {};
  const canonIndex = new Map();
  Object.keys(safeData).forEach((k) => {
    const c = canon(k);
    if (c && hasValue(safeData[k]) && !canonIndex.has(c)) canonIndex.set(c, safeData[k]);
  });

  const unresolved = new Set();
  let rendered = source.replace(MERGE_FIELD_RE, (_, key) => {
    const value = resolveField(key, safeData, canonIndex);
    if (!hasValue(value)) {
      unresolved.add(key);
      return EMPTY;
    }
    return String(value);
  });

  if (rendered.includes(EMPTY)) {
    rendered = rendered
      // Several empty fields in a row count as one.
      .replace(new RegExp(`${EMPTY}(?:[ \\t]*${EMPTY})+`, 'g'), EMPTY)
      // "{{x}}, hello" at the start of a line -> "hello"
      .replace(new RegExp(`(^|\\n)[ \\t]*${EMPTY}[ \\t]*[,;:]?[ \\t]*`, 'g'), '$1')
      // "Hi {{x}}, …" -> "Hi, …"
      .replace(new RegExp(`[ \\t]*${EMPTY}[ \\t]*(?=[,.!?;:])`, 'g'), '')
      // "Thanks {{x}}" at the end of a line -> "Thanks"
      .replace(new RegExp(`[ \\t]+${EMPTY}[ \\t]*(?=\\n|$)`, 'g'), '')
      // "call {{x}} today" -> "call today"
      .replace(new RegExp(`[ \\t]+${EMPTY}[ \\t]+`, 'g'), ' ')
      .split(EMPTY)
      .join('');
  }
  return { rendered, unresolved: [...unresolved] };
}

// Flatten a Contact document into a merge-data object.
//
// NAMES. `name` is the contact's name exactly as stored — a full business name
// stays whole. `first_name` is a separate first-name field when the contact has
// one (an imported "First Name" column); otherwise it is the FULL contact name,
// so "Hi {{first_name}}" greets "Austin City Dental", not "Austin". `last_name`
// comes only from a separate last-name field — it is never carved out of the
// name, which would repeat part of it next to {{first_name}}.
function contactToMergeData(contact) {
  if (!contact) return {};

  // customFields may be a Mongoose Map or a plain object.
  const cf =
    contact.customFields instanceof Map
      ? Object.fromEntries(contact.customFields)
      : contact.customFields || {};
  const customByAlias = (field) => {
    const key = Object.keys(cf).find((k) => ALIASES[field].includes(canon(k)) && hasValue(cf[k]));
    return key ? String(cf[key]).trim() : '';
  };

  const storedName = String(contact.name || '').trim();
  const first = customByAlias('first_name');
  const last = customByAlias('last_name');

  const data = {};
  // With no stored name, separate first/last fields still make a usable name.
  data.name = storedName || [first, last].filter(Boolean).join(' ');
  data.first_name = first || data.name;
  data.last_name = last;
  data.phone = contact.phone || '';
  data.email = contact.email || '';

  // Custom fields keep their own keys, exactly as before. An empty one never
  // blanks a built-in value.
  Object.keys(cf).forEach((k) => {
    if (hasValue(cf[k])) data[k] = cf[k];
  });

  return data;
}

// Render a message for one contact — what every send path and the preview use.
function renderForContact(text, contact) {
  return renderTemplate(text, contactToMergeData(contact));
}

module.exports = {
  extractMergeFields,
  renderTemplate,
  contactToMergeData,
  renderForContact,
  canon,
  ALIASES,
};
