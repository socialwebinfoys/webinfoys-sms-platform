// Provider registry (Phase 8).
//
// The one place that knows which providers exist. Everything downstream asks
// this module for an adapter by name, so adding a fourth provider means writing
// one adapter file and adding one line here — no change to the prompt builder,
// the parser, the guardrails, the worker or the API.
//
// A test can swap an adapter with __setAdapter() to exercise the full pipeline
// without a network call or a paid key.
'use strict';

const openai = require('./openai');
const groq = require('./groq');
const gemini = require('./gemini');

const ADAPTERS = new Map([
  [openai.name, openai],
  [groq.name, groq],
  [gemini.name, gemini],
]);

// Mirrors the enum on Settings.ai.provider. Kept in registry order so the API
// and the eventual UI list them consistently.
const PROVIDER_NAMES = [...ADAPTERS.keys()];

function isSupported(name) {
  return ADAPTERS.has(String(name || ''));
}

function getAdapter(name) {
  const adapter = ADAPTERS.get(String(name || ''));
  if (!adapter) {
    const err = new Error(
      `Unknown AI provider "${name}". Supported: ${PROVIDER_NAMES.join(', ')}.`
    );
    err.code = 'UNKNOWN_PROVIDER';
    err.statusCode = 400;
    throw err;
  }
  return adapter;
}

// The model used when an admin has chosen a provider but left the model blank.
function defaultModelFor(name) {
  return getAdapter(name).defaultModel;
}

// --- test seam -------------------------------------------------------------
const originals = new Map(ADAPTERS);
function __setAdapter(name, adapter) {
  ADAPTERS.set(name, adapter);
}
function __reset() {
  ADAPTERS.clear();
  for (const [key, value] of originals) ADAPTERS.set(key, value);
}

module.exports = {
  PROVIDER_NAMES,
  isSupported,
  getAdapter,
  defaultModelFor,
  __setAdapter,
  __reset,
};
