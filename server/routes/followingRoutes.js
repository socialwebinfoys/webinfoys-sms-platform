// Following routes: /api/followings/*. All protected; manual run is admin-only
// (mirrors the enrollment worker-trigger convention).
const express = require('express');
const {
  createFollowing,
  listFollowings,
  getFollowing,
  updateFollowing,
  updateFollowingStatus,
  deleteFollowing,
  deleteAllFollowings,
  runNow,
} = require('../controllers/followingController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.post('/run', authorize('admin'), runNow);
// Phase 0: DELETE / wipes EVERY follow-up — admin only.
router.route('/').get(listFollowings).post(createFollowing).delete(authorize('admin'), deleteAllFollowings);
router
  .route('/:id')
  .get(getFollowing)
  .put(updateFollowing)
  .patch(updateFollowingStatus)
  .delete(deleteFollowing);

module.exports = router;
