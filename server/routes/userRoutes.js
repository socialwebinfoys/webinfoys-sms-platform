// User routes: /api/users. Protected. Read-only listing for assignment display.
const express = require('express');
const { listUsers, updateUser } = require('../controllers/userController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.get('/', listUsers);
// Phase 7: admin-only account management (role, active state, password reset).
router.patch('/:id', authorize('admin'), updateUser);

module.exports = router;
