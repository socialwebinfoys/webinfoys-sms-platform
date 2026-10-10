// Validates the X-Twilio-Signature header on inbound webhook requests so that
// only genuine Twilio requests are processed. Uses the Twilio SDK's HMAC-SHA1
// validation (auth token + full URL + POST params).
const twilio = require('twilio');
const { config } = require('../config/env');

function validateTwilioSignature(req, res, next) {
  // Allow explicitly disabling validation for local testing.
  if (!config.webhook.validate) return next();

  const authToken = config.twilio.authToken;
  if (!authToken) {
    return res
      .status(503)
      .json({ success: false, message: 'Webhook validation is not configured' });
  }

  const signature = req.headers['x-twilio-signature'];

  // Reconstruct the exact URL Twilio signed. Prefer an explicit base URL when
  // configured (proxies/tunnels can otherwise change host/proto).
  const base = config.webhook.baseUrl
    ? config.webhook.baseUrl.replace(/\/$/, '')
    : `${req.protocol}://${req.get('host')}`;
  const url = base + req.originalUrl;

  const isValid = twilio.validateRequest(authToken, signature, url, req.body || {});
  if (!isValid) {
    return res.status(403).json({ success: false, message: 'Invalid Twilio signature' });
  }

  return next();
}

module.exports = { validateTwilioSignature };
