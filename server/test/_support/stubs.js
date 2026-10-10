// Phase 10 test harness — module substitution.
//
// The application wires its dependencies with top-level `require`, e.g.
// `const Contact = require('../models/Contact')`, so a controller captures
// whatever that module exported at load time. Replacing the entry in
// require.cache BEFORE the controller is loaded therefore swaps the dependency
// for a test double with no change to production code.
//
// This is what lets the API tier exercise the real Express app, the real
// middleware chain, the real routers and the real controller logic while
// persistence is a plain in-memory object — no MongoDB, and no production code
// written "for testability".
//
// Each test file runs in its own process under `node --test`, so substitutions
// made in one file can never leak into another.
'use strict';

const path = require('path');
const SERVER_ROOT = path.join(__dirname, '..', '..');

function resolveAppModule(relative) {
  return require.resolve(path.join(SERVER_ROOT, relative));
}

// Replace (or pre-seed) a module's exports. Must be called before anything
// requires the module under test.
function stubModule(relative, exports) {
  const id = resolveAppModule(relative);
  require.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
  return exports;
}

// --- chainable query double -------------------------------------------------
// Mongoose queries are thenable AND chainable: `await Model.find(f).sort(s)
// .skip(n).limit(m).populate(p).lean()`. A promise carrying no-op chain methods
// satisfies every shape the controllers use.
const CHAIN_METHODS = [
  'select',
  'sort',
  'skip',
  'limit',
  'lean',
  'populate',
  'exec',
  'setOptions',
  'collation',
  'hint',
];

function query(result) {
  const promise = Promise.resolve(result);
  for (const method of CHAIN_METHODS) {
    promise[method] = () => promise;
  }
  // `.catch(() => null)` is used in a couple of controllers; Promise already
  // provides it, but chaining must keep returning a chainable thing.
  promise.then = Promise.prototype.then.bind(promise);
  return promise;
}

// A rejected query, for simulating a database error on a specific call.
function failingQuery(error) {
  const promise = Promise.reject(error);
  for (const method of CHAIN_METHODS) {
    promise[method] = () => promise;
  }
  return promise;
}

// --- model double -----------------------------------------------------------
// Every method records its calls so a test can assert both the result AND that
// the right filter was used (e.g. that a list query really scoped by import).
//
// `handlers` overrides any method; anything not overridden returns a benign
// empty result, so a controller touching an incidental model does not explode.
function fakeModel(name, handlers = {}) {
  const calls = [];

  function record(method, args) {
    calls.push({ method, args });
  }

  const defaults = {
    findById: () => query(null),
    findOne: () => query(null),
    find: () => query([]),
    countDocuments: () => Promise.resolve(0),
    aggregate: () => query([]),
    create: async (doc) => ({ _id: 'generated-id', ...doc }),
    insertMany: async (docs) => docs.map((d, i) => ({ _id: `generated-${i}`, ...d })),
    updateOne: async () => ({ modifiedCount: 0, matchedCount: 0 }),
    updateMany: async () => ({ modifiedCount: 0, matchedCount: 0 }),
    deleteOne: async () => ({ deletedCount: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
    findByIdAndDelete: () => query(null),
    findOneAndDelete: () => query(null),
    findByIdAndUpdate: () => query(null),
    findOneAndUpdate: () => query(null),
    distinct: () => query([]),
  };

  const model = { __name: name, __calls: calls };

  for (const method of Object.keys(defaults)) {
    model[method] = (...args) => {
      record(method, args);
      const impl = handlers[method] || defaults[method];
      return impl(...args);
    };
  }

  // Statics and extra properties (Settings.LINE_TYPES, Settings.getSingleton,
  // Conversation.findOrCreateForContact, ImportPreview.newToken, …).
  for (const [key, value] of Object.entries(handlers)) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) continue;
    model[key] = typeof value === 'function'
      ? (...args) => {
          record(key, args);
          return value(...args);
        }
      : value;
  }

  model.__callsTo = (method) => calls.filter((c) => c.method === method);
  model.__reset = () => {
    calls.length = 0;
  };
  return model;
}

// --- document double --------------------------------------------------------
// Controllers mutate loaded documents and call `.save()`. This records saves so
// a test can assert what was persisted, and keeps the object itself readable.
function fakeDoc(fields = {}) {
  const doc = {
    _id: fields._id || 'doc-id',
    ...fields,
    __saves: 0,
    async save() {
      this.__saves += 1;
      return this;
    },
    toJSON() {
      const { save, toJSON, populate, __saves, ...rest } = this;
      return rest;
    },
    async populate() {
      return this;
    },
  };
  return doc;
}

module.exports = {
  stubModule,
  resolveAppModule,
  query,
  failingQuery,
  fakeModel,
  fakeDoc,
  SERVER_ROOT,
};
