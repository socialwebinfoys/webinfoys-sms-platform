// One-off configuration repair: move the stored sending window off the legacy
// 09:00-18:00 UTC value (Bug #4).
//
// WHY THIS MATTERS
// The sending window is the quiet-hours guard. 09:00-18:00 UTC is 05:00-14:00
// US Eastern in summer and 04:00-13:00 in winter, so it OPENS BEFORE the 8 AM
// local floor that US quiet-hour rules expect, and closes in the early
// afternoon. The schema default for a new installation is 09:00-20:00 in
// America/New_York, which sits inside 8 AM - 9 PM local; an existing settings
// document never received it, because defaults only apply on creation.
//
// SAFETY
//   * DRY RUN IS THE DEFAULT. Without --apply nothing is written, ever.
//   * It touches exactly ONE field of ONE document: `sendingWindow` on the
//     settings singleton (key: 'twilio'). Nothing else in that document is read
//     back or rewritten, and no other collection is opened.
//   * It REFUSES to act unless the stored window is exactly the legacy value it
//     exists to replace, so it cannot silently stamp over a window an operator
//     has deliberately chosen.
//   * Idempotent: once applied, a re-run reports "already correct" and writes
//     nothing.
//   * No delete, no drop, no updateMany, no bulk write. Contacts, campaigns,
//     enrollments, follow-ups and message history are never touched.
//
// USAGE
//   node scripts/fixSendingWindow.js            # dry run (default) - reports only
//   node scripts/fixSendingWindow.js --apply    # write the change
//
// Optional overrides (both dry run and apply):
//   --start=9 --end=20 --tz=America/New_York
const mongoose = require('mongoose');

const { config, validateConfig } = require('../config/env');
const Settings = require('../models/Settings');

// The exact configuration this script exists to replace. Anything else is left
// alone — an operator who has chosen their own window keeps it.
const LEGACY_WINDOW = { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' };

// The target, taken from the Settings schema default rather than hardcoded, so
// this script and a fresh installation can never disagree.
function schemaDefaultWindow() {
  // `sendingWindow` is a nested object, so Mongoose registers its leaves as
  // dotted paths rather than as a subdocument schema.
  const leaf = (name) => Settings.schema.path(`sendingWindow.${name}`).defaultValue;
  return {
    enabled: leaf('enabled'),
    startHour: leaf('startHour'),
    endHour: leaf('endHour'),
    timezone: leaf('timezone'),
  };
}

function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    apply: argv.includes('--apply'),
    startHour: get('start') === undefined ? undefined : Number(get('start')),
    endHour: get('end') === undefined ? undefined : Number(get('end')),
    timezone: get('tz'),
  };
}

function sameWindow(a, b) {
  if (!a || !b) return false;
  return (
    !!a.enabled === !!b.enabled &&
    Number(a.startHour) === Number(b.startHour) &&
    Number(a.endHour) === Number(b.endHour) &&
    String(a.timezone) === String(b.timezone)
  );
}

const show = (w) =>
  w
    ? `enabled=${!!w.enabled} ${String(w.startHour).padStart(2, '0')}:00-${String(
        w.endHour
      ).padStart(2, '0')}:00 ${w.timezone}`
    : '(absent)';

// Validate the proposed window against the SAME rules the settings API enforces,
// so this script cannot write a value the UI would have refused.
function validateTarget(target) {
  const problems = [];
  if (!Number.isInteger(target.startHour) || target.startHour < 0 || target.startHour > 23) {
    problems.push('startHour must be an integer 0-23');
  }
  if (!Number.isInteger(target.endHour) || target.endHour < 1 || target.endHour > 24) {
    problems.push('endHour must be an integer 1-24');
  }
  if (target.startHour === target.endHour) {
    problems.push('startHour and endHour must differ (an equal pair never opens)');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: target.timezone });
  } catch (e) {
    problems.push(`timezone "${target.timezone}" is not a known IANA zone`);
  }
  return problems;
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const apply = args.apply;

  const fallback = schemaDefaultWindow();
  const target = {
    enabled: true,
    startHour: args.startHour === undefined ? fallback.startHour : args.startHour,
    endHour: args.endHour === undefined ? fallback.endHour : args.endHour,
    timezone: args.timezone === undefined ? fallback.timezone : args.timezone,
  };

  const problems = validateTarget(target);
  if (problems.length > 0) {
    console.error('Refusing to continue — the proposed window is invalid:');
    problems.forEach((p) => console.error(`  - ${p}`));
    return { status: 'invalid_target', problems, written: false };
  }

  validateConfig();
  await mongoose.connect(config.mongoUri);
  // Never print the URI (it contains the database password) — only the db name.
  console.log(`Connected to database: ${mongoose.connection.name}`);
  console.log(apply ? 'MODE: APPLY (a change will be written)' : 'MODE: DRY RUN (no changes)');
  console.log('');

  try {
    // Read the singleton WITHOUT creating it. getSingleton() would insert a
    // document when none exists, which a dry run must never do.
    const settings = await Settings.findOne({ key: 'twilio' });

    if (!settings) {
      console.log('No settings document exists yet.');
      console.log('Nothing to migrate — a fresh installation is created with the correct default:');
      console.log(`  ${show(target)}`);
      return { status: 'no_settings', written: false };
    }

    const current = settings.sendingWindow
      ? {
          enabled: settings.sendingWindow.enabled,
          startHour: settings.sendingWindow.startHour,
          endHour: settings.sendingWindow.endHour,
          timezone: settings.sendingWindow.timezone,
        }
      : null;

    console.log('Settings document:  _id', String(settings._id), `(key: ${settings.key})`);
    console.log('  current  sendingWindow:', show(current));
    console.log('  proposed sendingWindow:', show(target));
    console.log('');

    if (sameWindow(current, target)) {
      console.log('Already correct. Nothing to do (this script is idempotent).');
      return { status: 'already_correct', current, target, written: false };
    }

    if (!sameWindow(current, LEGACY_WINDOW)) {
      console.log('REFUSING TO CHANGE THIS SETTING.');
      console.log(`  Expected to find the legacy window: ${show(LEGACY_WINDOW)}`);
      console.log(`  Found instead:                      ${show(current)}`);
      console.log('');
      console.log('  This looks like a window somebody chose deliberately, so it is left as is.');
      console.log('  Change it in Settings -> Automation, or re-run with explicit');
      console.log('  --start / --end / --tz if you are certain.');
      return { status: 'refused_not_legacy', current, target, written: false };
    }

    console.log('EXACT CHANGES THAT WOULD BE MADE:');
    console.log(`  settings(key="twilio").sendingWindow.enabled   : ${current.enabled} -> ${target.enabled}`);
    console.log(`  settings(key="twilio").sendingWindow.startHour : ${current.startHour} -> ${target.startHour}`);
    console.log(`  settings(key="twilio").sendingWindow.endHour   : ${current.endHour} -> ${target.endHour}`);
    console.log(`  settings(key="twilio").sendingWindow.timezone  : ${current.timezone} -> ${target.timezone}`);
    console.log('');
    console.log('  Affected documents: 1 (the settings singleton)');
    console.log('  Affected collections: settings');
    console.log('  Contacts, campaigns, enrollments, follow-ups and messages: UNTOUCHED');
    console.log('');

    if (!apply) {
      console.log('Dry run only — nothing was written. Re-run with --apply to make the change.');
      return { status: 'would_change', current, target, written: false };
    }

    // Narrowest possible write: the four window fields of this one document.
    const res = await Settings.updateOne(
      { _id: settings._id, key: 'twilio' },
      {
        $set: {
          'sendingWindow.enabled': target.enabled,
          'sendingWindow.startHour': target.startHour,
          'sendingWindow.endHour': target.endHour,
          'sendingWindow.timezone': target.timezone,
        },
      }
    );
    console.log(`Applied. Documents matched: ${res.matchedCount}, modified: ${res.modifiedCount}.`);
    return { status: 'applied', current, target, written: true };
  } finally {
    await mongoose.disconnect();
  }
}

// Only run when executed directly, so the logic can be imported by a test.
if (require.main === module) {
  run().catch(async (err) => {
    console.error('Sending-window migration failed:', err.message);
    try {
      await mongoose.disconnect();
    } catch (e) {
      /* already closed */
    }
    process.exit(1);
  });
}

module.exports = {
  run,
  parseArgs,
  sameWindow,
  validateTarget,
  schemaDefaultWindow,
  LEGACY_WINDOW,
};
