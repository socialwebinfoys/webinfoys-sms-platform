// Authentication + authorization middleware.
const { verifyToken } = require('../utils/token');
const User = require('../models/User');

// Verifies the Bearer JWT, loads the user, and attaches it to req.user.
// Rejects with 401 when the token is missing, invalid, or the user is gone.
async function protect(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Not authorized: no token provided' });
    }

    const token = header.split(' ')[1];
    const decoded = verifyToken(token);

    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'Not authorized: user unavailable' });
    }

    req.user = user;
    return next();
  } catch (err) {
    // Invalid/expired tokens throw here; treat them all as unauthorized.
    return res.status(401).json({ success: false, message: 'Not authorized: invalid token' });
  }
}

// Restricts a route to specific roles. Use after `protect`.
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ success: false, message: 'Forbidden: insufficient permissions' });
    }
    return next();
  };
}

module.exports = { protect, authorize };
