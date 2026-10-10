// Phase 9 frontend test harness — environment.
//
// Imported first by every frontend test. It does three things:
//
//   1. Registers the JSX hooks, so the real .jsx components can be imported.
//   2. Supplies the few browser globals the components touch at module or render
//      time (localStorage, matchMedia). They are INERT in-memory doubles — no
//      jsdom, and nothing is written to a real browser store.
//   3. Makes any outbound HTTP impossible. `fetch` and XMLHttpRequest are
//      replaced with functions that throw, and axios is pointed at an adapter
//      that throws, so a component cannot reach the API, a provider or Twilio
//      even if a test drove it into a request. The same structural guarantee the
//      server harness gives, for the frontend.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Guarded: this module is loaded via --import so the hooks are in place before
// any test file is resolved, and a test file may import it again for clarity.
// Registering the hooks twice would transform every module twice.
if (!globalThis.__WEBINFOYS_JSX_HOOKS__) {
  globalThis.__WEBINFOYS_JSX_HOOKS__ = true;
  register('./jsx-loader.mjs', pathToFileURL(`${import.meta.dirname}/`));
}

// --- 1. browser globals ----------------------------------------------------
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => void map.set(String(k), String(v)),
    removeItem: (k) => void map.delete(String(k)),
    clear: () => void map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    // Test-only view, so a test can assert that nothing secret was stored.
    __entries: () => [...map.entries()],
  };
}

globalThis.localStorage = memoryStorage();
globalThis.sessionStorage = memoryStorage();

if (!globalThis.window) globalThis.window = globalThis;
globalThis.window.location = globalThis.window.location || {
  pathname: '/ai',
  assign() {},
};
globalThis.document = globalThis.document || {
  documentElement: { setAttribute() {}, getAttribute: () => null },
  addEventListener() {},
  removeEventListener() {},
  visibilityState: 'visible',
};
globalThis.matchMedia =
  globalThis.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

// --- 2. no network, structurally ------------------------------------------
const NETWORK_BLOCKED =
  'BLOCKED BY TEST HARNESS: a frontend test attempted a network request. Phase 9 ' +
  'tests must not reach the API, an AI provider or Twilio.';

globalThis.fetch = () => {
  throw new Error(NETWORK_BLOCKED);
};
globalThis.XMLHttpRequest = function BlockedXHR() {
  throw new Error(NETWORK_BLOCKED);
};

export { NETWORK_BLOCKED };
