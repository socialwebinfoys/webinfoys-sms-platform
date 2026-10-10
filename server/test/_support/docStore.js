// A tiny in-memory document store for tests that need REAL query semantics.
//
// The model doubles in stubs.js return canned results; some features cannot be
// tested that way — batch allocation, lookup filters, bulk deletes — because
// what matters is which documents a filter actually selects and what an update
// actually changes. This evaluates the real filters the code sends ($or, $and,
// $in, $nin, $ne, $gt, $lt, regex, dotted paths, array-element paths) and
// applies the real updates ($set with the positional `$`, $inc, $push).
//
// Every operation yields to the event loop first, so simultaneous requests
// genuinely interleave — concurrency tests exercise the code's locks and
// conditional writes, not a serialised fake.
'use strict';

const mongoose = require('mongoose');
const { fakeModel } = require('./stubs');

const tick = () => new Promise((r) => setImmediate(r));

// Deep copy that keeps ObjectIds and Dates as themselves, as a driver would.
function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v._bsontype === 'ObjectId' || v._bsontype === 'ObjectID') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof RegExp) return v;
  if (Array.isArray(v)) return v.map(clone);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
}

const same = (a, b) => (a == null && b == null) || (a != null && b != null && String(a) === String(b));

function valuesAt(doc, path) {
  let cur = [doc];
  for (const key of path.split('.')) {
    const next = [];
    for (const v of cur) {
      if (v == null) { next.push(undefined); continue; }
      const val = v[key];
      if (Array.isArray(val) && !/^\d+$/.test(key)) next.push(...(val.length ? val : [undefined]));
      else next.push(val);
    }
    cur = next.flatMap((v) => (Array.isArray(v) ? v : [v]));
  }
  return cur;
}

const inIndex = new WeakMap();
function inSet(arg, v) {
  if (v == null) return arg.some((a) => a == null);
  // Indexed once per argument array, so a 1,000-id $in stays linear.
  if (!inIndex.has(arg)) inIndex.set(arg, new Set(arg.filter((a) => a != null).map(String)));
  return inIndex.get(arg).has(String(v));
}

function compare(a, b) {
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() - new Date(b).getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function isOperatorObject(cond) {
  return cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof RegExp)
    && !mongoose.isValidObjectId(cond) && Object.keys(cond).every((k) => k.startsWith('$'));
}

function matchCond(values, cond) {
  if (cond instanceof RegExp) return values.some((v) => typeof v === 'string' && cond.test(v));
  if (isOperatorObject(cond)) {
    return Object.entries(cond).every(([op, arg]) => {
      switch (op) {
        case '$ne': return !values.some((v) => same(v, arg));
        case '$in': return values.some((v) => inSet(arg, v));
        case '$nin': return !values.some((v) => inSet(arg, v));
        case '$lt': return values.some((v) => v != null && compare(v, arg) < 0);
        case '$lte': return values.some((v) => v != null && compare(v, arg) <= 0);
        case '$gt': return values.some((v) => v != null && compare(v, arg) > 0);
        case '$gte': return values.some((v) => v != null && compare(v, arg) >= 0);
        // `values` are the array's elements (valuesAt flattens arrays).
        case '$elemMatch': return values.some((v) => v != null && typeof v === 'object' && matches(v, arg));
        // Negates an operator expression; like MongoDB, it also matches a
        // document where the field is absent.
        case '$not': return !matchCond(values, arg);
        default: throw new Error(`docStore: unsupported operator ${op}`);
      }
    });
  }
  return values.some((v) => same(v, cond));
}

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((sub) => matches(doc, sub));
    if (k === '$and') return cond.every((sub) => matches(doc, sub));
    return matchCond(valuesAt(doc, k), cond);
  });
}

function target(doc, path, filter, positional = new Map()) {
  const keys = path.split('.');
  let cur = doc;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (keys[i + 1] === '$') {
      // Positional: the array element the filter matched — via $elemMatch on
      // the array itself, or a condition on one of its element paths. Like
      // MongoDB, it is chosen ONCE per update, not re-evaluated after an
      // earlier field of the same update has changed it.
      const prefix = keys.slice(0, i + 1).join('.');
      if (positional.has(prefix)) {
        cur = positional.get(prefix);
      } else if (filter[prefix] && filter[prefix].$elemMatch) {
        cur = cur[key].find((el) => matches(el, filter[prefix].$elemMatch));
      } else {
        const elemPath = Object.keys(filter).find((p) => p.startsWith(`${prefix}.`));
        const sub = elemPath.slice(prefix.length + 1);
        cur = cur[key].find((el) => matchCond(valuesAt(el, sub), filter[elemPath]));
      }
      positional.set(prefix, cur);
      i += 1;
      continue;
    }
    if (cur[key] == null) cur[key] = {};
    cur = cur[key];
  }
  return [cur, keys[keys.length - 1]];
}

function applyUpdate(doc, update, filter) {
  const positional = new Map();
  for (const [p, v] of Object.entries(update.$set || {})) {
    const [obj, key] = target(doc, p, filter, positional);
    obj[key] = clone(v);
  }
  for (const [p, v] of Object.entries(update.$inc || {})) {
    const [obj, key] = target(doc, p, filter, positional);
    obj[key] = (obj[key] || 0) + v;
  }
  for (const [p, v] of Object.entries(update.$push || {})) {
    const [obj, key] = target(doc, p, filter, positional);
    (obj[key] = obj[key] || []).push(clone(v));
  }
}

// A chainable, thenable query honouring sort / skip / limit.
function listQuery(rowsFn) {
  let sortSpec = null;
  let limitN = null;
  let skipN = 0;
  const chain = {
    // Accepts { field: 1 } and Mongoose's string form ('-createdAt').
    sort(spec) {
      sortSpec = typeof spec === 'string'
        ? { [spec.replace(/^-/, '')]: spec.startsWith('-') ? -1 : 1 }
        : spec;
      return chain;
    },
    skip(n) { skipN = n || 0; return chain; },
    limit(n) { limitN = n; return chain; },
    select() { return chain; },
    lean() { return chain; },
    populate() { return chain; },
    then(resolve, reject) {
      return tick().then(() => {
        let rows = rowsFn();
        if (sortSpec) {
          const [field, dir] = Object.entries(sortSpec)[0];
          rows = [...rows].sort((a, b) => compare(a[field] ?? '', b[field] ?? '') * dir);
        }
        rows = rows.slice(skipN);
        if (limitN != null) rows = rows.slice(0, limitN);
        return rows.map(clone);
      }).then(resolve, reject);
    },
  };
  return chain;
}

// A copy of a stored document with a working save(): like a Mongoose document,
// edits made by the code are persisted only when it calls save().
function liveDoc(getRows, doc) {
  if (!doc) return null;
  const copy = clone(doc);
  Object.defineProperty(copy, 'save', {
    enumerable: false,
    value: async () => {
      await tick();
      const rows = getRows();
      const i = rows.findIndex((d) => same(d._id, copy._id));
      const plain = clone(copy);
      if (i >= 0) rows[i] = plain; else rows.push(plain);
      return copy;
    },
  });
  return copy;
}

// One document, as a thenable query (so .populate()/.select()/.lean() chain).
function oneQuery(fn) {
  const chain = {
    populate() { return chain; },
    select() { return chain; },
    lean() { return chain; },
    then(resolve, reject) { return tick().then(fn).then(resolve, reject); },
    catch(fail) { return chain.then(undefined, fail); },
  };
  return chain;
}

// A fakeModel backed by `getRows()` (a function, so a test can swap the array).
function storeModel(name, getRows, setRows, extra = {}) {
  return fakeModel(name, {
    find: (filter) => listQuery(() => getRows().filter((d) => matches(d, filter))),
    findOne: (filter) => oneQuery(() => liveDoc(getRows, getRows().find((d) => matches(d, filter)))),
    findById: (id) => oneQuery(() => liveDoc(getRows, getRows().find((d) => same(d._id, id)))),
    create: async (doc) => {
      await tick();
      const made = { _id: new mongoose.Types.ObjectId(), ...clone(doc) };
      getRows().push(made);
      return liveDoc(getRows, made);
    },
    countDocuments: async (filter) => { await tick(); return getRows().filter((d) => matches(d, filter)).length; },
    findOneAndUpdate: async (filter, update) => {
      await tick();
      const doc = getRows().find((d) => matches(d, filter));
      if (!doc) return null;
      applyUpdate(doc, update, filter);
      return clone(doc);
    },
    updateOne: async (filter, update) => {
      await tick();
      const doc = getRows().find((d) => matches(d, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(doc, update, filter);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    updateMany: async (filter, update) => {
      await tick();
      const hit = getRows().filter((d) => matches(d, filter));
      hit.forEach((d) => applyUpdate(d, update, filter));
      return { matchedCount: hit.length, modifiedCount: hit.length };
    },
    deleteMany: async (filter) => {
      await tick();
      const before = getRows();
      const keep = before.filter((d) => !matches(d, filter));
      setRows(keep);
      return { deletedCount: before.length - keep.length };
    },
    findByIdAndDelete: async (id) => {
      await tick();
      const before = getRows();
      const doc = before.find((d) => same(d._id, id)) || null;
      if (doc) setRows(before.filter((d) => d !== doc));
      return doc ? clone(doc) : null;
    },
    ...extra,
  });
}

module.exports = { tick, clone, same, matches, applyUpdate, listQuery, storeModel };
