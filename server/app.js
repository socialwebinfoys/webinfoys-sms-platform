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
function buildCorsOptions() {
  if (config.corsAllowAll) return { origin: '*' };
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      return cb(null, config.corsOrigins.includes(origin));
    },
  };
}

function createApp() {
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
