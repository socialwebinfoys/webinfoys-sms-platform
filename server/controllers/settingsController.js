// Twilio operational settings. Credentials are NOT managed here (they live in
// environment variables); this exposes only non-secret config + status.
const Settings = require('../models/Settings');
const twilioService = require('../services/twilioService');
const { config } = require('../config/env');

// GET /api/settings/twilio
async function getTwilioSettings(req, res, next) {
  try {
    const settings = await Settings.getSingleton();
    return res.json({
      success: true,
      settings: {
        smsEnabled: settings.smsEnabled,
        // Legacy flag, still reported so a client can see what it was.
        mobileOnly: settings.mobileOnly,
        // Phase 7: the EFFECTIVE policy. When allowedLineTypes has never been
        // saved this is derived from mobileOnly, so the UI always shows what
        // the send guard will actually do rather than an empty field.
        allowedLineTypes: Settings.resolveAllowedLineTypes(settings),
        allowedLineTypesConfigured: Array.isArray(settings.allowedLineTypes) && settings.allowedLineTypes.length > 0,
        lineTypeOptions: Settings.LINE_TYPES,
        lookupMaxAgeDays: settings.lookupMaxAgeDays,
        defaultFrom: settings.defaultFrom,
        deliveryFailureThreshold: settings.deliveryFailureThreshold,
      },
      // Non-secret Twilio status derived from environment configuration.
      twilio: twilioService.status(),
    });
  } catch (err) {
    return next(err);
  }
}

// PUT /api/settings/twilio  (admin only)
// Accepts only non-secret operational settings. Ignores any credential fields.
async function updateTwilioSettings(req, res, next) {
  try {
    const settings = await Settings.getSingleton();
    const { smsEnabled, mobileOnly, defaultFrom, deliveryFailureThreshold, allowedLineTypes, lookupMaxAgeDays } =
      req.body || {};

    if (smsEnabled !== undefined) settings.smsEnabled = !!smsEnabled;
    if (mobileOnly !== undefined) settings.mobileOnly = !!mobileOnly;
    if (defaultFrom !== undefined) settings.defaultFrom = String(defaultFrom).trim();

    // Phase 7: which Lookup line types may be messaged.
    if (allowedLineTypes !== undefined) {
      if (!Array.isArray(allowedLineTypes)) {
        return res
          .status(400)
          .json({ success: false, message: 'allowedLineTypes must be an array' });
      }
      const cleaned = [...new Set(allowedLineTypes.map((t) => String(t).trim()))].filter(Boolean);
      // An empty list would block every outbound message while looking like a
      // valid configuration. Refuse it rather than silently disable sending.
      if (cleaned.length === 0) {
        return res.status(400).json({
          success: false,
          message:
            'Select at least one allowed line type — an empty list would block every message.',
        });
      }
      const unknown = cleaned.filter((t) => !Settings.LINE_TYPES.includes(t));
      if (unknown.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Unknown line type(s): ${unknown.join(', ')}. Allowed: ${Settings.LINE_TYPES.join(', ')}`,
        });
      }
      settings.allowedLineTypes = cleaned;
      // Keep the legacy flag consistent for anything still reading it, without
      // letting it override the explicit list (resolveAllowedLineTypes prefers
      // the list whenever it is set).
      settings.mobileOnly = cleaned.length === 1 && cleaned[0] === 'mobile';
    }

    if (lookupMaxAgeDays !== undefined) {
      const n = Number(lookupMaxAgeDays);
      if (!Number.isInteger(n) || n < 1 || n > 3650) {
        return res.status(400).json({
          success: false,
          message: 'lookupMaxAgeDays must be a whole number between 1 and 3650',
        });
      }
      settings.lookupMaxAgeDays = n;
    }

    // Phase 3: how many consecutive temporary delivery failures block a contact.
    if (deliveryFailureThreshold !== undefined) {
      const n = Number(deliveryFailureThreshold);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        return res.status(400).json({
          success: false,
          message: 'deliveryFailureThreshold must be a whole number between 1 and 20',
        });
      }
      settings.deliveryFailureThreshold = n;
    }

    await settings.save();

    return res.json({
      success: true,
      settings: {
        smsEnabled: settings.smsEnabled,
        mobileOnly: settings.mobileOnly,
        allowedLineTypes: Settings.resolveAllowedLineTypes(settings),
        allowedLineTypesConfigured:
          Array.isArray(settings.allowedLineTypes) && settings.allowedLineTypes.length > 0,
        lineTypeOptions: Settings.LINE_TYPES,
        lookupMaxAgeDays: settings.lookupMaxAgeDays,
        defaultFrom: settings.defaultFrom,
        deliveryFailureThreshold: settings.deliveryFailureThreshold,
      },
      twilio: twilioService.status(),
    });
  } catch (err) {
    return next(err);
  }
}

// Hour validation matches the schema exactly (Phase 2): a window starts at an
// hour of the day (0-23) and ends at an hour boundary (1-24, where 24 = midnight).
const VALID_START_HOUR = (h) => Number.isInteger(h) && h >= 0 && h <= 23;
const VALID_END_HOUR = (h) => Number.isInteger(h) && h >= 1 && h <= 24;

// GET /api/settings/automation
async function getAutomationSettings(req, res, next) {
  try {
    const settings = await Settings.getSingleton();
    return res.json({
      success: true,
      sendingWindow: settings.sendingWindow,
      sendDays: settings.sendDays,
      maxSendsPerRun: settings.maxSendsPerRun,
      // What the worker actually uses when maxSendsPerRun is not set.
      envMaxSendsPerRun: config.automation.maxSendsPerRun,
    });
  } catch (err) {
    return next(err);
  }
}

// PUT /api/settings/automation  (admin only) — sending window, timezone,
// allowed send days and the per-run send cap.
async function updateAutomationSettings(req, res, next) {
  try {
    const settings = await Settings.getSingleton();
    const body = req.body || {};
    const windowBody = body.sendingWindow || body;
    const { enabled, startHour, endHour, timezone } = windowBody;

    if (enabled !== undefined) settings.sendingWindow.enabled = !!enabled;
    if (startHour !== undefined) {
      if (!VALID_START_HOUR(startHour)) {
        return res.status(400).json({ success: false, message: 'startHour must be 0-23' });
      }
      settings.sendingWindow.startHour = startHour;
    }
    if (endHour !== undefined) {
      if (!VALID_END_HOUR(endHour)) {
        return res.status(400).json({ success: false, message: 'endHour must be 1-24' });
      }
      settings.sendingWindow.endHour = endHour;
    }
    if (timezone !== undefined) {
      // Validate the IANA timezone via Intl; reject unknown zones.
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      } catch (e) {
        return res.status(400).json({ success: false, message: `Invalid timezone: ${timezone}` });
      }
      settings.sendingWindow.timezone = timezone;
    }

    // A window whose start and end are the same hour matches no time at all,
    // which would silently stop automation entirely. Reject it rather than let
    // an admin halt sending by accident (use 0-24 for "all day").
    if (settings.sendingWindow.startHour === settings.sendingWindow.endHour) {
      return res.status(400).json({
        success: false,
        message:
          'Start and end hour cannot be the same — that window never opens. Use 12 AM to 12 AM (midnight) for all day.',
      });
    }

    // Allowed send days as JS day numbers (0 = Sunday … 6 = Saturday).
    if (body.sendDays !== undefined) {
      if (!Array.isArray(body.sendDays)) {
        return res.status(400).json({ success: false, message: 'sendDays must be an array' });
      }
      const days = [...new Set(body.sendDays.map(Number))];
      if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return res
          .status(400)
          .json({ success: false, message: 'sendDays must contain day numbers 0-6 (0 = Sunday)' });
      }
      if (days.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: 'Select at least one sending day' });
      }
      settings.sendDays = days.sort((a, b) => a - b);
    }

    // Per-run cap. null clears the override so the environment value is used
    // again. Compared against null/'' explicitly so 0 is rejected rather than
    // silently treated as "unset".
    if (body.maxSendsPerRun !== undefined) {
      const raw = body.maxSendsPerRun;
      if (raw === null || raw === '') {
        settings.maxSendsPerRun = null;
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
          return res.status(400).json({
            success: false,
            message: 'maxSendsPerRun must be a whole number between 1 and 1000, or null to use the server default',
          });
        }
        settings.maxSendsPerRun = n;
      }
    }

    await settings.save();
    return res.json({
      success: true,
      sendingWindow: settings.sendingWindow,
      sendDays: settings.sendDays,
      maxSendsPerRun: settings.maxSendsPerRun,
      envMaxSendsPerRun: config.automation.maxSendsPerRun,
    });
  } catch (err) {
    return next(err);
  }
}

// The schema default, used when a stubbed or legacy document has no value.
const DEFAULT_INBOX_REFRESH_SECONDS = 10;

function presentInboxSettings(settings) {
  const value = settings.inboxRefreshSeconds;
  return {
    inboxRefreshSeconds: Settings.INBOX_REFRESH_OPTIONS.includes(value)
      ? value
      : DEFAULT_INBOX_REFRESH_SECONDS,
    inboxRefreshOptions: Settings.INBOX_REFRESH_OPTIONS,
  };
}

// GET /api/settings/inbox — readable by every signed-in user, because every
// operator's Inbox needs the interval to poll at.
async function getInboxSettings(req, res, next) {
  try {
    const settings = await Settings.getSingleton();
    return res.json({ success: true, settings: presentInboxSettings(settings) });
  } catch (err) {
    return next(err);
  }
}

// PUT /api/settings/inbox  (admin only)
async function updateInboxSettings(req, res, next) {
  try {
    const { inboxRefreshSeconds } = req.body || {};
    if (inboxRefreshSeconds === undefined) {
      return res
        .status(400)
        .json({ success: false, message: 'inboxRefreshSeconds is required' });
    }
    // Strict: only the listed choices, as numbers. A string, a fraction or an
    // out-of-range value is refused rather than coerced.
    if (
      typeof inboxRefreshSeconds !== 'number' ||
      !Settings.INBOX_REFRESH_OPTIONS.includes(inboxRefreshSeconds)
    ) {
      return res.status(400).json({
        success: false,
        message: `inboxRefreshSeconds must be one of ${Settings.INBOX_REFRESH_OPTIONS.join(', ')} (0 = off)`,
      });
    }

    const settings = await Settings.getSingleton();
    settings.inboxRefreshSeconds = inboxRefreshSeconds;
    await settings.save();
    return res.json({ success: true, settings: presentInboxSettings(settings) });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getTwilioSettings,
  updateTwilioSettings,
  getAutomationSettings,
  updateAutomationSettings,
  getInboxSettings,
  updateInboxSettings,
};
