// Shared error vocabulary for provider adapters (Phase 8).
//
// Every adapter maps whatever its vendor returns onto these kinds, so the
// retry policy is written once and does not care which provider failed.
'use strict';

const KINDS = {
  // Worth trying again shortly.
  TEMPORARY: 'temporary',
  RATE_LIMIT: 'rate_limit',
  TIMEOUT: 'timeout',
  // Never worth trying again with the same input/configuration.
  AUTH: 'auth',
  INVALID_REQUEST: 'invalid_request',
  PERMANENT: 'permanent',
};

// Which kinds a bounded retry should bother with. Credential and request-shape
// problems are excluded on purpose: retrying a bad API key just burns attempts
// and delays the operator finding out.
const RETRYABLE_KINDS = new Set([KINDS.TEMPORARY, KINDS.RATE_LIMIT, KINDS.TIMEOUT]);

class ProviderError extends Error {
  constructor(message, { kind = KINDS.TEMPORARY, provider = '', status } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.provider = provider;
    this.status = status;
    this.retryable = RETRYABLE_KINDS.has(kind);
  }
}

// Map an HTTP status onto a kind. Shared because all three vendors use
// conventional REST semantics for failures.
function kindForStatus(status) {
  if (status === 401 || status === 403) return KINDS.AUTH;
  if (status === 429) return KINDS.RATE_LIMIT;
  if (status === 400 || status === 404 || status === 422) return KINDS.INVALID_REQUEST;
  if (status >= 500) return KINDS.TEMPORARY;
  return KINDS.PERMANENT;
}

// Turn a fetch/abort failure into a ProviderError. Node reports an aborted
// request as an AbortError, which is how a timeout surfaces here.
function kindForNetworkError(err) {
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) return KINDS.TIMEOUT;
  return KINDS.TEMPORARY;
}

// Provider error bodies can quote the request — which contains the customer's
// message — and some vendors echo the offending credential straight back. Only a
// short, scrubbed summary is ever kept.
//
// Two passes, because neither alone is sufficient:
//   1. The exact secret, when the caller supplies it. Unconditional, so a key
//      shorter than the heuristic below is still removed.
//   2. Key-SHAPED tokens, which catches a credential the caller did not pass
//      (a project id, an org header, a token echoed from elsewhere).
const MAX_DETAIL = 200;

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeDetail(text, secret) {
  let out = String(text || '');
  if (secret && String(secret).length >= 4) {
    out = out.split(String(secret)).join('[redacted]');
  }
  return out
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]') // key-shaped tokens
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL);
}

module.exports = { KINDS, RETRYABLE_KINDS, ProviderError, kindForStatus, kindForNetworkError, safeDetail };
