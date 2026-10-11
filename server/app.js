// Builds and configures the Express application (middleware, routes, error
// handling). Kept separate from index.js so the app can be created without
// immediately binding to a port or connecting to the database.
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { config } = require('./config/env');
const requestLogger = require('./middleware/requestLogger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/authRoutes');
const contactRoutes = require('./routes/contactRoutes');
const templateRoutes = require('./routes/templateRoutes');
const campaignRoutes = require('./routes/campaignRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const smsRoutes = require('./routes/smsRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const enrollmentRoutes = require('./routes/enrollmentRoutes');
const followingRoutes = require('./routes/followingRoutes');
const conversationRoutes = require('./routes/conversationRoutes');
const userRoutes = require('./routes/userRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const logRoutes = require('./routes/logRoutes');
const importRoutes = require('./routes/importRoutes');
const deliveryRoutes = require('./routes/deliveryRoutes');
const aiRoutes = require('./routes/aiRoutes');

// Phase 0: build the CORS options from the parsed allow-list. In development the
// list is usually just '*'; in production validateConfig() has already refused a
// wildcard, so this is always an explicit list of origins.
//
// Requests with NO Origin header (curl, server-to-server, Twilio webhooks) are
// allowed through: CORS is a browser mechanism, and refusing them here would
// break the Twilio webhooks, which are protected by signature validation.
// A disallowed browser origin gets `cb(null, false)` — the response simply
// carries no CORS headers, so the browser blocks it. We deliberately do not
// throw, which would surface as a confusing 500.
//
// PREFLIGHT. The frontend is on a different origin from the API and sends JSON
// with an Authorization header, so the browser asks permission first with an
// OPTIONS request. The cors middleware answers that itself (204) for every
// path, before any route, authentication or rate limiter runs — a preflight
// carries no token and must never be counted as a login attempt. The methods
// and headers below are exactly what the client uses.
//
// CREDENTIALS are deliberately NOT enabled: the session is a bearer token in the
// Authorization header, not a cookie, so `Access-Control-Allow-Credentials` is
// never sent — and therefore never combined with a wildcard origin.
const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const CORS_ALLOWED_HEADERS = ['Content-Type', 'Authorization'];
// How long a browser may reuse a preflight answer, in seconds.
const CORS_PREFLIGHT_MAX_AGE = 600;
// Refused origins are logged once each (bounded), so a misconfigured
// CORS_ORIGIN shows up in the server log instead of only in a browser console.
const MAX_REFUSED_ORIGINS_LOGGED = 20;

function buildCorsOptions() {
  const shared = {
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    maxAge: CORS_PREFLIGHT_MAX_AGE,
    optionsSuccessStatus: 204,
  };
  if (config.corsAllowAll) return { ...shared, origin: '*' };

  const refusedLogged = new Set();
  return {
    ...shared,
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const allowed = config.corsAllowedOrigins.includes(origin);
      if (!allowed && !refusedLogged.has(origin) && refusedLogged.size < MAX_REFUSED_ORIGINS_LOGGED) {
        refusedLogged.add(origin);
        console.warn(
          `CORS: refused browser origin ${JSON.stringify(String(origin).slice(0, 200))}. ` +
            `Allowed origins: ${config.corsAllowedOrigins.join(', ')}. ` +
            'Set CORS_ORIGIN to the exact frontend origin (scheme://host, no path).'
        );
      }
      return cb(null, allowed);
    },
  };
}

// `ready` (optional) is a promise that resolves when startup has finished —
// database connected, admin verified, workers started. index.js listens BEFORE
// that work so a managed host sees listen() immediately; see the startup gate
// below. Tests and tools that build the app without it get no gate.
function createApp({ ready } = {}) {
  const app = express();

  // Phase 0: in production this API sits behind exactly one proxy (Render's
  // load balancer). Without this, req.ip is the proxy's address for every
  // request — so the login rate limiter shares a single bucket across all
  // clients (one attacker locks out everyone) — and req.protocol reads 'http',
  // which would break any URL built from it. Deliberately NOT enabled outside
  // production: trusting X-Forwarded-For locally would let a client spoof its
  // own IP and bypass the limiter.
  if (config.nodeEnv === 'production') {
    app.set('trust proxy', 1);
  }

  // Security headers.
  app.use(helmet());

  // Cross-origin access for the React client.
  app.use(cors(buildCorsOptions()));

  // Body parsing. Phase 0: an explicit 1mb cap so a single huge JSON body cannot
  // exhaust memory. This does NOT affect CSV/XLSX uploads — those are
  // multipart/form-data handled by multer, which keeps its own 5 MB limit.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Request logging.
  app.use(requestLogger);

  // Health check — no auth, no DB dependency beyond reporting.
  app.get('/api/health', (req, res) => {
    res.json({
      success: true,
      status: 'ok',
      service: 'webinfoys-sms-platform-api',
      environment: config.nodeEnv,
      timestamp: new Date().toISOString(),
    });
  });

  // Startup gate. The port is bound before the database is connected, so a
  // request can arrive during those first seconds. It is HELD here, not
  // refused, and continues the moment startup completes — a Twilio webhook
  // that lands mid-start is processed normally rather than lost. Every route
  // below (auth, rate limiting, webhook signature checks) is unchanged and
  // only ever runs against a fully started app. The health check above is
  // deliberately not gated. If startup fails the process exits; the 503 is
  // only for a request that was already waiting at that moment.
  if (ready && typeof ready.then === 'function') {
    let started = false;
    ready.then(
      () => {
        started = true;
      },
      () => {}
    );
    app.use((req, res, next) => {
      if (started) return next();
      return ready.then(
        () => next(),
        () =>
          res
            .status(503)
            .json({ success: false, message: 'The server is starting up. Please try again shortly.' })
      );
    });
  }

  // Feature routes.
  app.use('/api/auth', authRoutes);
  app.use('/api/contacts', contactRoutes);
  app.use('/api/templates', templateRoutes);
  app.use('/api/campaigns', campaignRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/sms', smsRoutes);
  app.use('/api/webhooks', webhookRoutes);
  app.use('/api/enrollments', enrollmentRoutes);
  app.use('/api/followings', followingRoutes);
  app.use('/api/conversations', conversationRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/logs', logRoutes);
  app.use('/api/contact-imports', importRoutes);
  app.use('/api/delivery', deliveryRoutes);
  app.use('/api/ai', aiRoutes);

  // 404 + centralized error handling (must be last).
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
