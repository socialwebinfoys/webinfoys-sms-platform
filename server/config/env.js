// Loads environment variables from .env and exposes a single, validated config
// object. Centralizing this here means the rest of the app never reads
// process.env directly, and missing critical secrets fail fast at startup.
require('dotenv').config({ quiet: true });

// Phase 0: CORS_ORIGIN accepts a comma-separated list, so one backend can serve
// the Hostinger site and a staging/preview origin without reopening to '*'.
// Entries are trimmed and blanks dropped; a bare '*' anywhere means "allow all"
// (rejected in production by validateConfig below).
function parseOrigins(raw) {
  const list = String(raw === undefined || raw === null ? '' : raw)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

const rawCorsOrigin = process.env.CORS_ORIGIN || '*';
const corsOrigins = parseOrigins(rawCorsOrigin);

// Read an integer setting where ZERO IS A REAL VALUE.
//
// The `parseInt(x, 10) || fallback` idiom used elsewhere in this file is fine
// for a port or a timeout, where zero is meaningless. It is wrong wherever zero
// is a legitimate instruction, because it silently replaces it with the default
// — an operator asking for "no retries" would get three.
//
// Unset, empty and unparseable all fall back; a parsed number, including 0, is
// honoured exactly.
function intFromEnv(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,
  mongoUri: process.env.MONGO_URI,
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  // Raw value kept for diagnostics; `corsOrigins` is the parsed allow-list and
  // `corsAllowAll` is the wildcard shortcut used in local development.
  corsOrigin: rawCorsOrigin,
  corsOrigins,
  corsAllowAll: corsOrigins.includes('*'),
  // Optional. When set (e.g. "+1"), phone numbers imported without a country
  // code are assumed to belong to this country. If unset, such numbers are
  // rejected and the user must provide full E.164 values.
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '',
  // Used only by the one-off admin seed script (utils/seedAdmin.js).
  seedAdmin: {
    name: process.env.ADMIN_NAME || 'Administrator',
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  },
  // Twilio credentials come exclusively from the environment — never stored in
  // the database or returned to clients.
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_PHONE_NUMBER || '',
  },
  sms: {
    // When true, sends are simulated (no real Twilio call). Useful for local
    // development/testing without real credentials.
    simulate: process.env.SMS_SIMULATE === 'true',
  },
  lookup: {
    // When true, Twilio Lookup calls are simulated (no real API call). Useful
    // for local development/testing without real credentials.
    simulate: process.env.LOOKUP_SIMULATE === 'true',
  },
  webhook: {
    // Validate the X-Twilio-Signature on inbound webhooks. Defaults to true;
    // set TWILIO_VALIDATE_WEBHOOK=false only for local testing.
    validate: process.env.TWILIO_VALIDATE_WEBHOOK !== 'false',
    // Optional explicit public base URL used when recomputing the signature
    // (helps when running behind a proxy/tunnel). Falls back to the request host.
    baseUrl: process.env.TWILIO_WEBHOOK_BASE_URL || '',
  },
  // Public base URL of this API (Phase 3). Used to build the delivery status
  // callback URL Twilio posts receipts to. When unset, no statusCallback is
  // sent and delivery receipts are simply not received — sending still works.
  publicApiUrl: process.env.PUBLIC_API_URL || '',
  // How long a graceful shutdown (SIGTERM/SIGINT) waits for a running worker
  // pass and open requests before exiting anyway. Must be SHORTER than the
  // host's own kill delay — Render's is 30 seconds unless raised — or the host
  // ends the process first.
  shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 20000,
  // Automation engine (Phase 5). The scheduled worker that advances campaign
  // enrollments. Sending-window details live in Settings (admin-configurable).
  automation: {
    // Whether the cron worker starts with the server.
    //   * In PRODUCTION it is opt-IN: it starts only when AUTOMATION_ENABLED is
    //     literally 'true'. A first deployment therefore sends nothing on a
    //     schedule until someone deliberately switches it on.
    //   * Elsewhere it keeps its original opt-OUT behaviour (only 'false' stops
    //     it), so local development is unchanged.
    // This is the scheduler only — it is not a sending kill switch (an admin can
    // still trigger a pass by hand); `smsEnabled` in Settings is.
    enabled:
      process.env.NODE_ENV === 'production'
        ? process.env.AUTOMATION_ENABLED === 'true'
        : process.env.AUTOMATION_ENABLED !== 'false',
    // Cron schedule for the worker tick (default: every minute).
    cronSchedule: process.env.AUTOMATION_CRON || '* * * * *',
    // Throttle: max enrollments processed per worker run.
    maxSendsPerRun: parseInt(process.env.AUTOMATION_MAX_SENDS_PER_RUN, 10) || 20,
    // Retry: max attempts for a single step before the enrollment is failed.
    maxRetries: parseInt(process.env.AUTOMATION_MAX_RETRIES, 10) || 3,
    // Base backoff (minutes) between retries; grows exponentially per attempt.
    retryBackoffMinutes: parseInt(process.env.AUTOMATION_RETRY_BACKOFF_MINUTES, 10) || 5,
  },
  // AI reply system (Phase 8). Everything here is operational wiring only — the
  // provider, model, persona and the master on/off switch live in Settings, so
  // they can be changed by an admin without a redeploy.
  ai: {
    // Encrypts provider API keys before they are stored (utils/secretBox.js).
    // Without it the API refuses to accept a key at all; it is never logged.
    encryptionKey: process.env.AI_ENCRYPTION_KEY || '',
    // Opt-IN, like SMS_SIMULATE and unlike AUTOMATION_ENABLED: the AI worker
    // starts only when this is literally 'true'. Deliberately independent of
    // AUTOMATION_ENABLED so campaign automation and AI replies can be operated
    // separately. Note this only controls the SCHEDULER — Settings.ai.enabled is
    // the master switch, and it is false by default.
    workerEnabled: process.env.AI_WORKER_ENABLED === 'true',
    cronSchedule: process.env.AI_WORKER_CRON || '* * * * *',
    // Throttle: max AI jobs processed per worker run.
    maxJobsPerRun: parseInt(process.env.AI_MAX_JOBS_PER_RUN, 10) || 10,
    // Retry: max attempts per job before it is failed.
    //
    // Fix 3: read with an explicit finite check rather than `parseInt(...) || 3`.
    // Zero is a MEANINGFUL value here — "never retry an AI job" — and `||` turns
    // it into 3, silently giving an operator who asked for no retries the exact
    // opposite. Unset and unparseable still fall back to 3, as before.
    maxRetries: intFromEnv(process.env.AI_MAX_RETRIES, 3),
    // Base backoff (minutes) between retries; grows exponentially per attempt.
    retryBackoffMinutes: parseInt(process.env.AI_RETRY_BACKOFF_MINUTES, 10) || 2,
    // How long a single provider call may take before it is abandoned. Keeps a
    // hung provider from holding a job claim for its whole lease.
    requestTimeoutMs: parseInt(process.env.AI_REQUEST_TIMEOUT_MS, 10) || 20000,
    // Phase 8.1: the budget for POST /api/ai/test, which is admin-only but
    // spends real provider credit on every call. Limited per ADMIN rather than
    // per IP (see middleware/rateLimiter.js).
    //
    // Production defaults to a deliberately tight 10 per 15 minutes: the
    // endpoint exists for an operator to sanity-check a persona, which does not
    // need more. Development and test get 30, so neither manual iteration nor
    // the automated suite trips it by accident. Both are overridable, because a
    // limit that cannot be tuned per installation ends up disabled instead.
    testRateLimitWindowMinutes:
      parseInt(process.env.AI_TEST_RATE_LIMIT_WINDOW_MINUTES, 10) || 15,
    testRateLimitMax:
      parseInt(process.env.AI_TEST_RATE_LIMIT_MAX, 10) ||
      (process.env.NODE_ENV === 'production' ? 10 : 30),
  },
};

// Phase 0: minimum signing-key strength. A short JWT secret is brute-forceable
// offline, which would let anyone mint admin tokens.
const MIN_JWT_SECRET_LENGTH = 32;

// Phase 8: the same floor for the key that encrypts stored provider credentials.
const MIN_AI_ENCRYPTION_KEY_LENGTH = 32;

// Render exposes these to every service it runs. Used only to warn when a
// production host is started with a non-production NODE_ENV.
function isRenderEnvironment() {
  return !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
}

// Trailing slashes are not significant in a base URL.
function trimSlash(value) {
  return String(value || '').trim().replace(/[/]+$/, '');
}

// Is `value` an absolute https:// URL? Only the answer is used — the value is
// never echoed into an error message.
function isHttpsUrl(value) {
  try {
    return new URL(String(value || '').trim()).protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// A CORS origin is scheme://host[:port] and nothing else. A browser sends
// exactly that, so an entry with a path or a trailing slash can never match.
function isBareOrigin(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch (e) {
    return false;
  }
}

// Fail fast if the essentials are missing, rather than crashing later with a
// confusing error deep inside a request.
//
// Error messages deliberately name only the VARIABLE, never its value, so a
// misconfiguration can never leak a secret into logs or a crash report.
function validateConfig() {
  const isProduction = config.nodeEnv === 'production';
  const missing = [];
  if (!config.mongoUri) missing.push('MONGO_URI');
  if (!config.jwt.secret) missing.push('JWT_SECRET');

  // Phase 0: variables that are optional in development but required in
  // production — without them the deployed frontend cannot reach the API, and
  // Twilio signature validation / delivery receipts silently stop working.
  if (isProduction) {
    if (!process.env.CORS_ORIGIN) missing.push('CORS_ORIGIN');
    if (!process.env.TWILIO_WEBHOOK_BASE_URL) missing.push('TWILIO_WEBHOOK_BASE_URL');
    if (!process.env.PUBLIC_API_URL) missing.push('PUBLIC_API_URL');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill in the values.'
    );
  }

  if (config.jwt.secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is too short (${config.jwt.secret.length} characters). ` +
        `Use at least ${MIN_JWT_SECRET_LENGTH} random characters.`
    );
  }

  // Phase 0: never serve a wildcard CORS policy in production — it would let any
  // website call this API with a logged-in operator's browser.
  if (isProduction && config.corsAllowAll) {
    throw new Error(
      'CORS_ORIGIN must not be "*" in production. Set it to the exact client ' +
        'origin(s), comma-separated (e.g. "https://app.webinfoys.com").'
    );
  }

  if (isProduction && config.corsOrigins.length === 0) {
    throw new Error('CORS_ORIGIN is set but contains no usable origin.');
  }

  if (isProduction) {
    // An origin the browser can never send would lock the frontend out with
    // nothing in the logs to say why.
    const badOrigins = config.corsOrigins.filter((o) => !isBareOrigin(o)).length;
    if (badOrigins > 0) {
      throw new Error(
        `CORS_ORIGIN contains ${badOrigins} entr${badOrigins === 1 ? 'y that is' : 'ies that are'} not a bare origin. ` +
          'Use scheme://host with no path and no trailing slash (e.g. "https://app.example.com").'
      );
    }

    // Twilio only posts webhooks to, and signs, a public HTTPS address.
    for (const name of ['PUBLIC_API_URL', 'TWILIO_WEBHOOK_BASE_URL']) {
      if (!isHttpsUrl(process.env[name])) {
        throw new Error(`${name} must be an absolute https:// URL in production.`);
      }
    }

    // Delivery receipts are requested at PUBLIC_API_URL and their signature is
    // checked against TWILIO_WEBHOOK_BASE_URL. If the two differ, every receipt
    // fails validation and is rejected.
    if (trimSlash(process.env.PUBLIC_API_URL) !== trimSlash(process.env.TWILIO_WEBHOOK_BASE_URL)) {
      throw new Error(
        'PUBLIC_API_URL and TWILIO_WEBHOOK_BASE_URL must be the same URL in production: ' +
          'both are the public base URL of this API.'
      );
    }

    // The webhooks are the only unauthenticated write endpoints. Signature
    // validation is what stops anyone on the internet forging an inbound
    // message, an opt-in or a delivery receipt, so it cannot be turned off here.
    if (!config.webhook.validate) {
      throw new Error(
        'TWILIO_VALIDATE_WEBHOOK must not be "false" in production. Remove it or set it to "true".'
      );
    }
  }

  // Phase 8: the AI worker cannot run without somewhere to read provider
  // credentials from, so refuse to start in that state rather than failing every
  // job at runtime. Only the LENGTH is ever reported, never the value.
  if (config.ai.workerEnabled) {
    const keyLength = config.ai.encryptionKey.length;
    if (keyLength < MIN_AI_ENCRYPTION_KEY_LENGTH) {
      throw new Error(
        `AI_WORKER_ENABLED is true but AI_ENCRYPTION_KEY is ${
          keyLength === 0 ? 'not set' : `too short (${keyLength} characters)`
        }. ` + `Use at least ${MIN_AI_ENCRYPTION_KEY_LENGTH} random characters, or set AI_WORKER_ENABLED=false.`
      );
    }
  }

  // A production host running with any other NODE_ENV would skip every check
  // above and serve wildcard CORS and stack traces. Render sets
  // NODE_ENV=production itself, so this only fires if it has been overridden —
  // and then refusing to start is the safe answer.
  if (!isProduction && isRenderEnvironment()) {
    throw new Error(
      `NODE_ENV is "${config.nodeEnv}" on Render. It must be "production": production ` +
        'hardening (strict CORS, trust proxy, required URLs, webhook validation) is not ' +
        'active otherwise. Remove the NODE_ENV override on this service.'
    );
  }
}

module.exports = {
  config,
  validateConfig,
  isRenderEnvironment,
  MIN_JWT_SECRET_LENGTH,
  MIN_AI_ENCRYPTION_KEY_LENGTH,
};
