// Minimal request logger: one line per request with method, path, status, and
// duration. Kept dependency-free intentionally (no morgan) for Phase 1.
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const timestamp = new Date().toISOString();
    console.log(
      `${timestamp} ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`
    );
  });

  next();
}

module.exports = requestLogger;
