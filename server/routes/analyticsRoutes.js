// Analytics routes: /api/analytics/*. Protected (any authenticated operator —
// analytics are read-only aggregate counts, consistent with the shared-team
// model; no per-user isolation and no admin-only rule exists for viewing data).
const express = require('express');
const {
  getOverview,
  getCampaignAnalytics,
  getAiAnalytics,
} = require('../controllers/analyticsController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.get('/overview', getOverview);
router.get('/campaigns', getCampaignAnalytics);
// Phase 10: AI metrics. Same authorization as the rest of analytics — read-only
// aggregate counts for any authenticated operator. It returns no message bodies,
// no contact details and nothing from the AI configuration except the confidence
// threshold the numbers are measured against.
router.get('/ai', getAiAnalytics);

module.exports = router;
