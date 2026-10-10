// Auth routes: maps /api/auth/* URLs to controller functions.
const express = require('express');
const { login, getMe, register } = require('../controllers/authController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { loginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.post('/login', loginLimiter, login);
router.get('/me', protect, getMe);
router.post('/register', protect, authorize('admin'), register);

module.exports = router;
