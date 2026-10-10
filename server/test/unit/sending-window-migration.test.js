// Bug #4 — the sending-window migration helper.
//
// These cover the decision logic without opening a connection: the harness
// blocks every MongoDB connection, so run() itself is not exercised here. What
// matters is that the helper cannot be talked into writing the wrong thing:
// it must refuse anything that is not the specific legacy value, it must reject
// an invalid target, and it must agree with the schema default.
'use strict';

require('../_support/env');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const Settings = require('../../models/Settings');
const migration = require('../../scripts/fixSendingWindow');
const { parseArgs, sameWindow, validateTarget, schemaDefaultWindow, LEGACY_WINDOW } = migration;

describe('the legacy window it exists to replace', () => {
  test('is exactly 09:00-18:00 UTC', () => {
    assert.deepEqual(LEGACY_WINDOW, {
      enabled: true,
      startHour: 9,
      endHour: 18,
      timezone: 'UTC',
    });
  });
});

describe('the target comes from the schema, not a hardcoded guess', () => {
  test('schemaDefaultWindow matches the Settings model defaults', () => {
    const fromSchema = schemaDefaultWindow();
    assert.equal(fromSchema.startHour, Settings.schema.path('sendingWindow.startHour').defaultValue);
    assert.equal(fromSchema.endHour, Settings.schema.path('sendingWindow.endHour').defaultValue);
    assert.equal(fromSchema.timezone, Settings.schema.path('sendingWindow.timezone').defaultValue);
  });

  test('the default is a window a US quiet-hours rule would accept', () => {
    const { startHour, endHour, timezone } = schemaDefaultWindow();
    assert.ok(startHour >= 8, 'must not open before 8am local');
    assert.ok(endHour <= 21, 'must not run past 9pm local');
    assert.notEqual(timezone, 'UTC', 'a US window must be expressed in a US zone, not UTC');
  });

  test('the default is a real change from the legacy value', () => {
    assert.equal(sameWindow(LEGACY_WINDOW, schemaDefaultWindow()), false);
  });
});

describe('dry run is the default', () => {
  test('no flags means no apply', () => {
    assert.equal(parseArgs([]).apply, false);
  });
  test('--apply is required to write', () => {
    assert.equal(parseArgs(['--apply']).apply, true);
  });
  test('an unrelated flag does not enable apply', () => {
    assert.equal(parseArgs(['--start=9', '--tz=UTC', '--verbose']).apply, false);
  });
  test('overrides are parsed', () => {
    const args = parseArgs(['--start=10', '--end=19', '--tz=Europe/London']);
    assert.equal(args.startHour, 10);
    assert.equal(args.endHour, 19);
    assert.equal(args.timezone, 'Europe/London');
  });
  test('absent overrides stay undefined so the schema default wins', () => {
    const args = parseArgs([]);
    assert.equal(args.startHour, undefined);
    assert.equal(args.endHour, undefined);
    assert.equal(args.timezone, undefined);
  });
});

describe('sameWindow — the idempotency and refusal test', () => {
  const base = { enabled: true, startHour: 9, endHour: 20, timezone: 'America/New_York' };

  test('identical windows match', () => {
    assert.equal(sameWindow(base, { ...base }), true);
  });
  test('a different hour does not match', () => {
    assert.equal(sameWindow(base, { ...base, endHour: 18 }), false);
  });
  test('a different timezone does not match', () => {
    assert.equal(sameWindow(base, { ...base, timezone: 'UTC' }), false);
  });
  test('a different enabled flag does not match', () => {
    assert.equal(sameWindow(base, { ...base, enabled: false }), false);
  });
  test('string and number hours compare equal (stored values vary)', () => {
    assert.equal(sameWindow(base, { ...base, startHour: '9', endHour: '20' }), true);
  });
  test('a missing window never matches', () => {
    assert.equal(sameWindow(null, base), false);
    assert.equal(sameWindow(base, null), false);
    assert.equal(sameWindow(undefined, undefined), false);
  });
});

describe('validateTarget mirrors the settings API rules', () => {
  const ok = { enabled: true, startHour: 9, endHour: 20, timezone: 'America/New_York' };

  test('a valid window has no problems', () => {
    assert.deepEqual(validateTarget(ok), []);
  });

  const bad = [
    [{ ...ok, startHour: -1 }, /startHour/],
    [{ ...ok, startHour: 24 }, /startHour/],
    [{ ...ok, startHour: 9.5 }, /startHour/],
    [{ ...ok, endHour: 0 }, /endHour/],
    [{ ...ok, endHour: 25 }, /endHour/],
    [{ ...ok, startHour: 9, endHour: 9 }, /never opens/],
    [{ ...ok, timezone: 'Mars/Olympus_Mons' }, /not a known IANA zone/],
  ];
  for (const [target, pattern] of bad) {
    test(`${JSON.stringify(target)} is refused`, () => {
      const problems = validateTarget(target);
      assert.ok(problems.length > 0, 'expected a problem');
      assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern}, got ${problems}`);
    });
  }

  test('a 0-24 all-day window is permitted', () => {
    assert.deepEqual(validateTarget({ ...ok, startHour: 0, endHour: 24 }), []);
  });
});

describe('the script is narrowly scoped by construction', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'scripts', 'fixSendingWindow.js'),
    'utf8'
  );

  test('it contains no destructive operation', () => {
    for (const forbidden of [
      'deleteMany',
      'deleteOne',
      'drop(',
      'dropDatabase',
      'dropCollection',
      'findOneAndDelete',
      'findByIdAndDelete',
      'bulkWrite',
      'insertMany',
    ]) {
      assert.equal(source.includes(forbidden), false, `script references ${forbidden}`);
    }
  });

  test('it touches no collection other than settings', () => {
    for (const model of [
      'Contact',
      'Campaign',
      'Enrollment',
      'Following',
      'SMSMessage',
      'Conversation',
      'Import',
      'Template',
      'User',
    ]) {
      assert.equal(
        new RegExp(`require\\(['"]\\.\\./models/${model}['"]\\)`).test(source),
        false,
        `script imports the ${model} model`
      );
    }
    assert.ok(/require\(['"]\.\.\/models\/Settings['"]\)/.test(source));
  });

  test('its only write is a $set of the four window fields', () => {
    const writes = source.match(/Settings\.(updateOne|updateMany|create|insertMany|deleteOne)/g) || [];
    assert.deepEqual(writes, ['Settings.updateOne'], `unexpected writes: ${writes}`);
    for (const field of ['sendingWindow.enabled', 'sendingWindow.startHour', 'sendingWindow.endHour', 'sendingWindow.timezone']) {
      assert.ok(source.includes(`'${field}'`), `the update should set ${field}`);
    }
  });

  test('it reads the singleton with findOne, never getSingleton (which would create one)', () => {
    assert.ok(source.includes("Settings.findOne({ key: 'twilio' })"));
    // The name appears in a comment explaining why it is avoided; what must not
    // exist is an actual CALL, which would insert a document on a dry run.
    assert.equal(
      /Settings\.getSingleton\s*\(/.test(source),
      false,
      'calling getSingleton would insert a settings document during a dry run'
    );
  });

  test('the write is unreachable without --apply', () => {
    // The early return guarding the write must appear before it in the source.
    const guardAt = source.indexOf('if (!apply)');
    const writeAt = source.indexOf('Settings.updateOne');
    assert.ok(guardAt > -1, 'expected a dry-run guard');
    assert.ok(writeAt > guardAt, 'the write must sit after the dry-run guard');
  });

  test('it never prints the connection string', () => {
    assert.equal(/console\.log\([^)]*mongoUri/.test(source), false);
    assert.ok(source.includes('mongoose.connection.name'), 'it should report only the db name');
  });
});
