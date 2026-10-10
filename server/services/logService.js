// System event logging helper (Phase 8). Persists a SystemLog document for a
// platform event. Designed to NEVER throw — a logging failure must not break the
// operation that triggered it. Never pass secrets here.
const SystemLog = require('../models/SystemLog');

async function logEvent(event) {
  try {
    await SystemLog.create({
      eventType: event.eventType,
      severity: event.severity || 'info',
      message: event.message || '',
      status: event.status || '',
      contact: event.contact,
      campaign: event.campaign,
      enrollment: event.enrollment,
      conversation: event.conversation,
      twilioSid: event.twilioSid || '',
      error: event.error || '',
      meta: event.meta,
    });
  } catch (e) {
    // Log-write failures are swallowed (with a console note) so they can never
    // affect the caller's flow.
    console.error('SystemLog write failed:', e.message);
  }
}

module.exports = { logEvent };
