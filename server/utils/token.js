// JWT helpers. Kept in one place so token shape and options stay consistent.
const jwt = require('jsonwebtoken');
const { config } = require('../config/env');

function signToken(user) {
  const payload = { id: user._id.toString(), role: user.role };
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret);
}

module.exports = { signToken, verifyToken };
