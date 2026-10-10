// Campaign routes: /api/campaigns/*. All protected.
const express = require('express');
const {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  deleteAllCampaigns,
  getEligibleContacts,
  cloneCampaign,
  getCampaignStats,
} = require('../controllers/campaignController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Phase 5: literal paths must come before '/:id', or Express would read
// "stats" as a campaign id.
router.get('/stats', getCampaignStats);

// Phase 0: DELETE / wipes EVERY campaign (and cascades to enrollments) — admin only.
router.route('/').get(listCampaigns).post(createCampaign).delete(authorize('admin'), deleteAllCampaigns);
router.get('/:id/eligible-contacts', getEligibleContacts);
// Phase 5: duplicate a campaign definition as an inactive copy.
router.post('/:id/clone', cloneCampaign);
// DELETE /:id is force-gated in the controller: deleting a campaign that has
// enrollments needs ?force=true AND an admin (see deleteCampaign).
router.route('/:id').get(getCampaign).put(updateCampaign).delete(deleteCampaign);

module.exports = router;
