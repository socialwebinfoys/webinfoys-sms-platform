// Log routes: /api/logs. Protected (read-only; shared-team, consistent with
// analytics — no per-user isolation).
const express = require('express');
const { listLogs } = require('../controllers/logController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.get('/', listLogs);

module.exports = router;
