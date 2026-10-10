// Rate limiting for public endpoints (Phase 10 security pass — the FINAL
// roadmap requires "rate limiting on public endpoints").
//
// Scope is intentionally narrow:
//   * The unauthenticated, brute-forceable POST /api/auth/login is limited.
//   * Authenticated internal APIs are NOT limited — they already require a
//     valid JWT, and limiting them could disrupt normal operator use.
//   * The Twilio inbound webhook is deliberately NOT limited here: it is already
//     gated by X-Twilio-Signature validation, and throttling it could drop
//     legitimate inbound SMS during a reply burst.
//
// NOTE (deployment / Phase 11): behind a reverse proxy, configure Express
// `trust proxy` so req.ip is the real client IP; otherwise all clients share
// one bucket. Not set here to avoid trusting X-Forwarded-For in local/dev.
const { rateLimit } = require('express-rate-limit');
const { config } = require('../config/env');

// Login limiter. `skipSuccessfulRequests` means only FAILED attempts (4xx/5xx)
// count toward the budget, so ordinary users who log in successfully are never
// throttled — only repeated failures (credential brute-forcing) are.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // max failed attempts per IP per window
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Clean JSON response — no stack trace, no secrets.
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      message: 'Too many login attempts. Please try again in a few minutes.',
    }),
});

// Phase 8.1: POST /api/ai/test only.
//
// WHY THIS ONE ENDPOINT. It is the single authenticated route that spends money
// per request — it calls a third-party model — so the usual reasoning above ("an
// authenticated internal API needs no limit") does not hold for it. Every other
// AI route is ordinary CRUD and is deliberately left unlimited.
//
// KEYED PER ADMIN, NOT PER IP. The route sits behind `protect` and
// `authorize('admin')`, so `req.user` is always populated by the time this runs.
// Keying on the user id means several admins in one office (one NAT address) get
// their own budgets, and it sidesteps IP-based keying entirely — no reverse-proxy
// or IPv6 handling to get wrong. The 'unauthenticated' fallback is unreachable in
// practice; it exists so the key is never undefined.
//
// ORDERING MATTERS: mounted AFTER authorize, so a rejected non-admin never
// consumes an admin's budget and cannot use this endpoint to exhaust it.
const aiTestLimiter = rateLimit({
  windowMs: config.ai.testRateLimitWindowMinutes * 60 * 1000,
  limit: config.ai.testRateLimitMax,
  keyGenerator: (req) => (req.user && String(req.user._id)) || 'unauthenticated',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Same shape as every other error this API returns. It names no provider, no
  // model and no configured value — only that the caller should wait.
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      message: 'Too many AI test requests. Please wait a few minutes and try again.',
    }),
});

module.exports = { loginLimiter, aiTestLimiter };
