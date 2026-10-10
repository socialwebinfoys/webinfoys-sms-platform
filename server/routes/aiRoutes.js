// AI routes: /api/ai/*. All protected; configuration and test generation are
// admin-only, matching how settings and the manual worker triggers are gated.
//
// Takeover is deliberately NOT admin-only: standing the assistant down is part
// of working the inbox, and any operator who can reply to a thread must be able
// to stop the AI replying to it too.
const express = require('express');
const {
  getAiSettings,
  updateAiSettings,
  testAiReply,
  getConversationAiState,
  enableTakeover,
  releaseTakeover,
  listAiJobs,
  approveAiDraft,
  rejectAiDraft,
  setConversationAiMode,
} = require('../controllers/aiController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { aiTestLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.use(protect);

// Configuration. The GET returns a MASKED key only; updates are admin-only.
router.route('/settings').get(getAiSettings).put(authorize('admin'), updateAiSettings);

// Generate a reply without sending it. Admin-only because it spends provider
// credit and reveals how the persona behaves.
//
// Phase 8.1: and rate-limited, because "admin-only" caps WHO may spend provider
// credit, not how much. The limiter is mounted after authorize so a rejected
// non-admin never consumes an admin's budget, and it is the only AI route that
// carries one — see middleware/rateLimiter.js.
router.post('/test', authorize('admin'), aiTestLimiter, testAiReply);

// Jobs / drafts. Literal path before '/conversations/:id' is not required here,
// but the ordering keeps the file readable.
router.get('/jobs', listAiJobs);

// Phase 8.1: human review of a draft. Both are operator-level for the same
// reason takeover is — whoever works the inbox must be able to answer, or decline
// to answer, a customer. Rejection is a DELETE on the job, but nothing is
// deleted: the job moves to the terminal 'rejected' status and is kept for audit.
router.post('/jobs/:id/approve', approveAiDraft);
router.delete('/jobs/:id', rejectAiDraft);

router.get('/conversations/:id', getConversationAiState);
// Phase 8.1: set the per-thread draft/auto override the guardrails already read.
router.patch('/conversations/:id', setConversationAiMode);
router
  .route('/conversations/:id/takeover')
  .post(enableTakeover)
  .delete(releaseTakeover);

module.exports = router;
