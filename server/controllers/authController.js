// Authentication logic: login, current-user lookup, and admin-only user creation.
const User = require('../models/User');
const { signToken } = require('../utils/token');
const { logEvent } = require('../services/logService');

// Phase 0: minimum password length for any account created through the API.
// Mirrored by `minlength` on the User schema, so a direct model write cannot
// bypass it either.
const MIN_PASSWORD_LENGTH = 12;

// Phase 0 (item I): auth events go through the existing logService.
//
// WHAT IS LOGGED: the email that was attempted, the outcome, and the client IP
// (now accurate in production because Phase 0 item B enables `trust proxy`).
// WHAT IS NEVER LOGGED: the password — right or wrong, in any form — the issued
// JWT, the signing secret, or any connection string. The password is simply
// never passed to this function, so it cannot leak through it by accident.
function logAuthEvent({ eventType, severity, message, email, reason, req, user }) {
  return logEvent({
    eventType,
    severity,
    message,
    status: reason || '',
    meta: {
      // Lowercased for consistency with how accounts are stored/looked up.
      email: String(email || '').toLowerCase().slice(0, 254),
      ip: (req && req.ip) || '',
      ...(user ? { userId: String(user._id), role: user.role } : {}),
      ...(reason ? { reason } : {}),
    },
  });
}

// POST /api/auth/login  (public)
// Validates credentials and returns a JWT plus the user profile.
async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};

    // Require string credentials. This both validates input and prevents a
    // query-operator object (e.g. {$gt:''}) from being passed through to the
    // database — returning a clean 400 instead of a 500.
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res
        .status(400)
        .json({ success: false, message: 'Email and password are required' });
    }

    // Password is select:false on the schema, so request it explicitly.
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

    // Use the same message for "no user" and "wrong password" to avoid
    // revealing which emails are registered. The LOG keeps the distinction,
    // because that is useful for spotting a brute-force run.
    if (!user || !(await user.comparePassword(password))) {
      await logAuthEvent({
        eventType: 'auth.login_failed',
        severity: 'warning',
        message: 'Login failed: invalid credentials',
        email,
        reason: user ? 'wrong_password' : 'unknown_email',
        req,
      });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (!user.isActive) {
      await logAuthEvent({
        eventType: 'auth.login_failed',
        severity: 'warning',
        message: 'Login failed: account is disabled',
        email,
        reason: 'account_disabled',
        req,
        user,
      });
      return res.status(403).json({ success: false, message: 'Account is disabled' });
    }

    const token = signToken(user);
    // Logged AFTER the token is minted but the token itself is never passed in.
    await logAuthEvent({
      eventType: 'auth.login',
      severity: 'info',
      message: 'Login succeeded',
      email,
      reason: 'success',
      req,
      user,
    });
    return res.json({ success: true, token, user });
  } catch (err) {
    return next(err);
  }
}

// GET /api/auth/me  (protected)
// Returns the currently authenticated user (set by the protect middleware).
async function getMe(req, res, next) {
  try {
    return res.json({ success: true, user: req.user });
  } catch (err) {
    return next(err);
  }
}

// POST /api/auth/register  (protected, admin only)
// Creates a new operator account. No public self-registration by design.
async function register(req, res, next) {
  try {
    const { name, email, password, role } = req.body || {};

    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'Name, email and password are required' });
    }

    // Reject non-string credentials before any length check, so a JSON object
    // cannot reach the model as a password value.
    if (typeof password !== 'string' || typeof email !== 'string') {
      return res
        .status(400)
        .json({ success: false, message: 'Email and password must be text values' });
    }

    // Phase 0: enforce the 12-character minimum here, so the caller gets a clear
    // message instead of a Mongoose validation error.
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }

    const allowedRoles = ['admin', 'user'];
    const safeRole = allowedRoles.includes(role) ? role : 'user';

    const user = await User.create({ name, email, password, role: safeRole });

    return res.status(201).json({ success: true, user });
  } catch (err) {
    return next(err);
  }
}

module.exports = { login, getMe, register, MIN_PASSWORD_LENGTH };
