// Query-parameter guards (Phase 0, item H).
//
// Two classes of problem this fixes:
//
//   1. REPEATED PARAMETERS. Express parses `?search=a&search=b` into an ARRAY,
//      and `?search[$ne]=` into an OBJECT. Handlers that called
//      `req.query.search.trim()` threw a TypeError and returned 500, and an
//      object reaching a Mongo filter is operator injection. `queryString()`
//      reduces any shape to a single plain string.
//
//   2. UNVALIDATED SORT. Passing `req.query.sort` straight to Mongoose lets a
//      caller sort by any field (including ones with no index, which is a cheap
//      way to make the database do expensive work) and crashes outright when the
//      parameter arrives as an array. `pickSort()` accepts only known fields.
//
// Both helpers are total: they never throw, whatever the caller sends.

// Reduce any query value to a single trimmed string.
//   'abc'          -> 'abc'
//   ['a','b']      -> 'a'        (first wins; repeats are a client mistake)
//   { $ne: '' }    -> ''         (objects carry no usable scalar)
//   undefined/null -> ''
function queryString(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.length > 0 ? queryString(value[0]) : '';
  if (typeof value === 'object') return '';
  return String(value).trim();
}

// True only for the literal strings 'true'/'false' — so an absent or malformed
// flag leaves the filter untouched rather than silently meaning "false".
function queryBool(value) {
  const s = queryString(value).toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return undefined;
}

// Validate a Mongoose sort expression against an allow-list of field names.
// Accepts 'field' (ascending) and '-field' (descending) only; anything else
// falls back to `fallback`, so a bad value degrades instead of 500-ing.
// Returns { sort, invalid }: `invalid` is the rejected value, for handlers that
// prefer to answer 400 rather than silently substitute the default.
function pickSort(raw, allowedFields, fallback = '-createdAt') {
  const value = queryString(raw);
  if (!value) return { sort: fallback, invalid: null };
  const field = value.startsWith('-') ? value.slice(1) : value;
  if (!allowedFields.includes(field)) {
    return { sort: fallback, invalid: value };
  }
  return { sort: value, invalid: null };
}

module.exports = { queryString, queryBool, pickSort };
