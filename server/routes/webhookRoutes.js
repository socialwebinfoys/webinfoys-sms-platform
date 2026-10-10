// Webhook routes: /api/webhooks/*. PUBLIC (no JWT — Twilio cannot send one),
// but protected by Twilio signature validation instead.
const express = require('express');
const { inboundSms, statusCallback } = require('../controllers/webhookController');
const { validateTwilioSignature } = require('../middleware/twilioSignature');

const router = express.Router();

router.post('/twilio/inbound', validateTwilioSignature, inboundSms);
// Phase 3: delivery receipts. Same signature validation as the inbound route —
// an unsigned request must never be able to change delivery state.
router.post('/twilio/status', validateTwilioSignature, statusCallback);

module.exports = router;
