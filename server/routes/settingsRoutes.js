// Settings routes: /api/settings/*. Protected; updates are admin-only.
const express = require('express');
const {
  getTwilioSettings,
  updateTwilioSettings,
  getAutomationSettings,
  updateAutomationSettings,
  getInboxSettings,
  updateInboxSettings,
} = require('../controllers/settingsController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router
  .route('/twilio')
  .get(getTwilioSettings)
  .put(authorize('admin'), updateTwilioSettings);

router
  .route('/automation')
  .get(getAutomationSettings)
  .put(authorize('admin'), updateAutomationSettings);

router
  .route('/inbox')
  .get(getInboxSettings)
  .put(authorize('admin'), updateInboxSettings);

module.exports = router;
