// SMS routes: /api/sms/*. Protected (requires a valid JWT).
const express = require('express');
const { sendSms, retryMessage } = require('../controllers/smsController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.post('/send', sendSms);
// Phase 4: re-send one failed outbound message, re-running every send policy.
router.post('/:id/retry', retryMessage);

module.exports = router;
