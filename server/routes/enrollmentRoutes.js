// Enrollment routes: /api/enrollments/*. All protected; manual run is admin-only.
const express = require('express');
const {
  createEnrollment,
  listEnrollments,
  getEnrollment,
  updateEnrollmentStatus,
  runNow,
  deleteEnrollment,
  deleteAllEnrollments,
  getEnrollmentsByContact,
} = require('../controllers/enrollmentController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.post('/run', authorize('admin'), runNow);
// Phase 4: inbox side panel. Declared before '/:id' for clarity.
router.get('/by-contact/:contactId', getEnrollmentsByContact);
// Phase 0: DELETE / wipes EVERY enrollment — admin only.
router.route('/').get(listEnrollments).post(createEnrollment).delete(authorize('admin'), deleteAllEnrollments);
router.route('/:id').get(getEnrollment).patch(updateEnrollmentStatus).delete(deleteEnrollment);

module.exports = router;
