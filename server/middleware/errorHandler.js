// Central error handling. Keeps controllers free of repetitive error plumbing
// and ensures clients always receive a consistent, safe JSON shape.
const { config } = require('../config/env');

// 404 handler for unmatched routes. Registered after all real routes.
function notFound(req, res, next) {
  res.status(404).json({ success: false, message: `Route not found: ${req.originalUrl}` });
}

// Final error-handling middleware. Express identifies it by its four arguments.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';

  // Mongoose validation -> 400 with a readable message.
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(', ');
  }

  // Duplicate key (e.g. email already registered) -> 409.
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `A record with that ${field} already exists`;
  }

  // Malformed ObjectId in a route param -> 400.
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for ${err.path}`;
  }

  // Log server-side details, but never leak stack traces to clients.
  if (statusCode >= 500) {
    console.error(`Error on ${req.method} ${req.originalUrl}:`, err);
  }

  const body = { success: false, message };
  if (config.nodeEnv === 'development' && err.stack) {
    body.stack = err.stack;
  }

  res.status(statusCode).json(body);
}

module.exports = { notFound, errorHandler };
