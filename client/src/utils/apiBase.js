// Works out the API base URL from the build-time VITE_API_URL setting.
//
// Every backend route lives under /api (POST /api/auth/login, …). The setting is
// easy to get subtly wrong, and a wrong value fails in a confusing way — the
// browser reports a "CORS error" or a 404 for /auth/login — so the common
// mistakes are corrected here instead of shipping a build that cannot log in:
//
//   (unset)                              -> /api          (dev: Vite proxies it)
//   https://api.example.com              -> https://api.example.com/api
//   https://api.example.com/             -> https://api.example.com/api
//   https://api.example.com/api          -> unchanged
//   https://api.example.com/api/         -> https://api.example.com/api
//   /api                                 -> unchanged
//
// A value that already has a path is trusted as written (minus a trailing
// slash), so an API mounted somewhere else can still be pointed at.
export function resolveApiBase(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw)
    .trim()
    .replace(/\/+$/, '');
  if (!value) return '/api';
  try {
    const url = new URL(value);
    // Only the host was given: add the /api prefix every route needs.
    if (url.pathname === '/' || url.pathname === '') return `${url.origin}/api`;
  } catch (e) {
    // Not an absolute URL (e.g. "/api"): used as written.
  }
  return value;
}
