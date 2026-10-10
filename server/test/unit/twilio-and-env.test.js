// Phase 10 — twilioService contract, merge fields, and environment validation
// (Stage 2F secret hygiene at the config layer, Stage 11 production gates).
'use strict';

require('../_support/env');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const twilioService = require('../../services/twilioService');
const { renderTemplate, extractMergeFields, contactToMergeData } = require('../../utils/mergeFields');
const f = require('../_support/factories');

describe('twilioService — permanent vs retryable error codes', () => {
  test('the permanent set is exactly the four documented codes', () => {
    assert.deepEqual([...twilioService.PERMANENT_CODES].sort(), [21211, 21408, 21610, 21614]);
  });

  test('21610 (unsubscribed) is permanent, so no send path can back off and retry it', () => {
    assert.equal(twilioService.PERMANENT_CODES.has(21610), true);
  });

  test('a transient carrier code is not in the permanent set', () => {
    for (const code of [30001, 30003, 30007, 20429]) {
      assert.equal(twilioService.PERMANENT_CODES.has(code), false);
    }
  });
});

describe('twilioService.status — never leaks a credential', () => {
  test('the auth token is not present in the status payload at all', () => {
    const status = twilioService.status();
    assert.equal('authToken' in status, false);
    assert.equal(JSON.stringify(status).includes('authToken'), false);
  });

  test('the account SID is masked when present', () => {
    const { config } = require('../../config/env');
    const original = config.twilio.accountSid;
    config.twilio.accountSid = 'AC0123456789abcdef0123456789abcd';
    try {
      const status = twilioService.status();
      assert.equal(status.accountSid, 'AC****abcd');
      assert.equal(status.accountSid.includes('0123456789'), false);
    } finally {
      config.twilio.accountSid = original;
    }
  });

  test('an absent SID reports as an empty string, not "undefined"', () => {
    assert.equal(twilioService.status().accountSid, '');
  });
});

describe('twilioService.sendSms — validation and simulation', () => {
  test('a missing "to" is a 400 before anything else happens', async () => {
    await assert.rejects(() => twilioService.sendSms({ body: 'hi' }), (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    });
  });

  test('a missing body is a 400', async () => {
    await assert.rejects(() => twilioService.sendSms({ to: '+14155552671' }), (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    });
  });

  test('simulation returns a SIMULATED sid and never a real one', async () => {
    const result = await twilioService.sendSms({ to: '+14155552671', body: 'hi' });
    assert.match(result.sid, /^SIMULATED-/);
    assert.equal(result.simulated, true);
    assert.equal(result.status, 'simulated');
  });

  test('with simulation OFF and no credentials, a send fails 503 rather than reaching the network', async () => {
    const { config } = require('../../config/env');
    config.sms.simulate = false;
    try {
      await assert.rejects(
        () => twilioService.sendSms({ to: '+14155552671', body: 'hi' }),
        (err) => {
          assert.equal(err.statusCode, 503);
          assert.match(err.message, /not configured/);
          return true;
        }
      );
    } finally {
      config.sms.simulate = true;
    }
  });
});

describe('mergeFields', () => {
  test('extracts unique field names', () => {
    assert.deepEqual(
      extractMergeFields('Hi {{first_name}}, {{first_name}} your code is {{code}}'),
      ['first_name', 'code']
    );
  });

  test('renders known fields and reports unresolved ones', () => {
    const { rendered, unresolved } = renderTemplate('Hi {{first_name}} {{missing}}', {
      first_name: 'Ada',
    });
    // The missing field leaves nothing behind — not its literal text, and not
    // a dangling space.
    assert.equal(rendered, 'Hi Ada');
    assert.deepEqual(unresolved, ['missing']);
  });

  test('tolerates whitespace inside the braces', () => {
    assert.equal(renderTemplate('Hi {{  first_name  }}', { first_name: 'Ada' }).rendered, 'Hi Ada');
  });

  test('a null or empty body renders to an empty string', () => {
    assert.equal(renderTemplate(null, {}).rendered, '');
    assert.equal(renderTemplate(undefined, {}).rendered, '');
  });

  // With no separate first-name field, first_name is the FULL contact name (a
  // business name must not be cut to its first word) and last_name is empty.
  test('first_name falls back to the full contact name; last_name is never carved out of it', () => {
    const data = contactToMergeData(f.contact({ name: 'Ada King Lovelace' }));
    assert.equal(data.first_name, 'Ada King Lovelace');
    assert.equal(data.last_name, '');
    assert.equal(data.name, 'Ada King Lovelace');
  });

  test('a single-word name yields an empty last_name', () => {
    const data = contactToMergeData(f.contact({ name: 'Ada' }));
    assert.equal(data.first_name, 'Ada');
    assert.equal(data.last_name, '');
  });

  test('an empty name yields empty parts rather than throwing', () => {
    const data = contactToMergeData(f.contact({ name: '' }));
    assert.equal(data.first_name, '');
    assert.equal(data.last_name, '');
  });

  test('custom fields are available as merge data', () => {
    const data = contactToMergeData(f.contact({ customFields: { city: 'Leeds' } }));
    assert.equal(data.city, 'Leeds');
  });

  test('a customFields Map is flattened', () => {
    const data = contactToMergeData(f.contact({ customFields: new Map([['city', 'Leeds']]) }));
    assert.equal(data.city, 'Leeds');
  });

  test('merge-field syntax in DATA is not re-expanded (no recursive substitution)', () => {
    const { rendered } = renderTemplate('Hi {{first_name}}', { first_name: '{{secret}}' });
    assert.equal(rendered, 'Hi {{secret}}');
  });

  test('a contact with no name at all does not throw', () => {
    assert.doesNotThrow(() => contactToMergeData({}));
    assert.deepEqual(contactToMergeData(null), {});
  });
});

// config is built once at require time, but validateConfig ALSO reads
// process.env directly at call time. So the overrides must stay in place for the
// duration of the assertion — hence the callback form rather than a getter.
function withEnv(overrides, fn) {
  const envId = require.resolve('../../config/env');
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  Object.assign(process.env, overrides);
  delete require.cache[envId];
  try {
    return fn(require('../../config/env'));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[envId];
    require('../../config/env'); // leave a consistent module in the cache
  }
}

describe('validateConfig — production gates (Stage 11)', () => {
  test('development passes with only MONGO_URI and JWT_SECRET', () => {
    withEnv({ NODE_ENV: 'development' }, ({ validateConfig }) => {
      assert.doesNotThrow(() => validateConfig());
    });
  });

  test('a missing MONGO_URI throws and names only the variable', () => {
    withEnv({ NODE_ENV: 'development', MONGO_URI: '' }, ({ validateConfig }) => {
      assert.throws(() => validateConfig(), (err) => {
        assert.match(err.message, /MONGO_URI/);
        return true;
      });
    });
  });

  test('a short JWT_SECRET throws, reporting the LENGTH but never the value', () => {
    const secret = 'too-short-secret';
    withEnv({ NODE_ENV: 'development', JWT_SECRET: secret }, ({ validateConfig }) => {
      assert.throws(() => validateConfig(), (err) => {
        assert.match(err.message, /JWT_SECRET is too short/);
        assert.match(err.message, /16 characters/);
        assert.equal(err.message.includes(secret), false, 'the secret value must never appear');
        return true;
      });
    });
  });

  test('a 32-character JWT_SECRET is exactly at the boundary and passes', () => {
    withEnv({ NODE_ENV: 'development', JWT_SECRET: 'x'.repeat(32) }, ({ validateConfig }) => {
      assert.doesNotThrow(() => validateConfig());
    });
  });

  test('production REFUSES a wildcard CORS origin', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        CORS_ORIGIN: '*',
        TWILIO_WEBHOOK_BASE_URL: 'https://api.example.com',
        PUBLIC_API_URL: 'https://api.example.com',
      },
      ({ validateConfig }) => {
        assert.throws(() => validateConfig(), /must not be "\*" in production/);
      }
    );
  });

  test('production requires CORS_ORIGIN, TWILIO_WEBHOOK_BASE_URL and PUBLIC_API_URL', () => {
    withEnv(
      { NODE_ENV: 'production', CORS_ORIGIN: '', TWILIO_WEBHOOK_BASE_URL: '', PUBLIC_API_URL: '' },
      ({ validateConfig }) => {
        assert.throws(() => validateConfig(), (err) => {
          assert.match(err.message, /CORS_ORIGIN/);
          assert.match(err.message, /TWILIO_WEBHOOK_BASE_URL/);
          assert.match(err.message, /PUBLIC_API_URL/);
          return true;
        });
      }
    );
  });

  test('a fully specified production config passes', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com',
        TWILIO_WEBHOOK_BASE_URL: 'https://api.example.com',
        PUBLIC_API_URL: 'https://api.example.com',
        JWT_SECRET: 'y'.repeat(48),
      },
      ({ validateConfig }) => {
        assert.doesNotThrow(() => validateConfig());
      }
    );
  });

  test('a comma-separated CORS list is parsed, trimmed and de-duplicated', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        CORS_ORIGIN: ' https://a.example.com , https://b.example.com ,https://a.example.com, ',
        TWILIO_WEBHOOK_BASE_URL: 'https://api.example.com',
        PUBLIC_API_URL: 'https://api.example.com',
      },
      ({ config }) => {
        assert.deepEqual(config.corsOrigins, ['https://a.example.com', 'https://b.example.com']);
        assert.equal(config.corsAllowAll, false);
      }
    );
  });

  test('outside production AUTOMATION_ENABLED is opt-OUT: only the literal "false" disables it', () => {
    const read = (v) =>
      withEnv({ NODE_ENV: 'development', AUTOMATION_ENABLED: v }, ({ config }) => config.automation.enabled);
    assert.equal(read('false'), false);
    assert.equal(read('true'), true);
    assert.equal(read('0'), true);
    assert.equal(read('no'), true);
  });

  test('in PRODUCTION automation is opt-IN: it stays off unless AUTOMATION_ENABLED is exactly "true"', () => {
    const read = (v) =>
      withEnv({ NODE_ENV: 'production', AUTOMATION_ENABLED: v }, ({ config }) => config.automation.enabled);
    assert.equal(read(''), false, 'unset: a first deployment schedules nothing');
    assert.equal(read('false'), false);
    assert.equal(read('1'), false);
    assert.equal(read('yes'), false);
    assert.equal(read('TRUE'), false);
    assert.equal(read('true'), true);
  });

  test('the AI worker is opt-IN everywhere, production included', () => {
    for (const NODE_ENV of ['development', 'production']) {
      const read = (v) => withEnv({ NODE_ENV, AI_WORKER_ENABLED: v }, ({ config }) => config.ai.workerEnabled);
      assert.equal(read(''), false);
      assert.equal(read('1'), false);
      assert.equal(read('true'), true);
    }
  });

  // --- production: the public URLs, CORS and webhook validation --------------
  const PROD = {
    NODE_ENV: 'production',
    CORS_ORIGIN: 'https://app.example.com',
    TWILIO_WEBHOOK_BASE_URL: 'https://api.example.com',
    PUBLIC_API_URL: 'https://api.example.com',
    TWILIO_VALIDATE_WEBHOOK: 'true',
    JWT_SECRET: 'y'.repeat(48),
  };
  const validateWith = (overrides) =>
    withEnv({ ...PROD, ...overrides }, ({ validateConfig }) => {
      try {
        validateConfig();
        return null;
      } catch (err) {
        return err.message;
      }
    });

  test('production REFUSES to start with webhook signature validation switched off', () => {
    assert.match(validateWith({ TWILIO_VALIDATE_WEBHOOK: 'false' }), /TWILIO_VALIDATE_WEBHOOK must not be "false" in production/);
    assert.equal(validateWith({ TWILIO_VALIDATE_WEBHOOK: '' }), null, 'unset means ON');
    assert.equal(validateWith({ TWILIO_VALIDATE_WEBHOOK: 'true' }), null);
  });

  test('switching validation off is still possible in development (local testing)', () => {
    withEnv({ NODE_ENV: 'development', TWILIO_VALIDATE_WEBHOOK: 'false' }, ({ validateConfig, config }) => {
      assert.doesNotThrow(() => validateConfig());
      assert.equal(config.webhook.validate, false);
    });
  });

  test('production requires both public URLs to be https', () => {
    for (const name of ['PUBLIC_API_URL', 'TWILIO_WEBHOOK_BASE_URL']) {
      for (const bad of ['http://api.example.com', 'api.example.com', 'not a url']) {
        const message = validateWith({ PUBLIC_API_URL: bad, TWILIO_WEBHOOK_BASE_URL: bad, [name]: bad });
        assert.match(message, /must be an absolute https:\/\/ URL in production/, `${name}=${bad}`);
        assert.equal(message.includes(bad), false, 'the value is not echoed');
      }
    }
  });

  test('production requires PUBLIC_API_URL and TWILIO_WEBHOOK_BASE_URL to be the same URL', () => {
    assert.match(
      validateWith({ PUBLIC_API_URL: 'https://api.example.com', TWILIO_WEBHOOK_BASE_URL: 'https://other.example.com' }),
      /must be the same URL in production/
    );
    assert.equal(
      validateWith({ PUBLIC_API_URL: 'https://api.example.com/', TWILIO_WEBHOOK_BASE_URL: 'https://api.example.com' }),
      null,
      'a trailing slash is not a difference'
    );
  });

  test('production rejects a CORS origin a browser could never send', () => {
    for (const bad of ['https://app.example.com/', 'https://app.example.com/login', 'app.example.com']) {
      assert.match(validateWith({ CORS_ORIGIN: bad }), /not a bare origin/, bad);
    }
    assert.match(validateWith({ CORS_ORIGIN: 'https://app.example.com,https://b.example.com/' }), /1 entry that is not a bare origin/);
    assert.equal(validateWith({ CORS_ORIGIN: 'https://app.example.com, https://staging.example.com:8443' }), null);
  });

  test('on Render a non-production NODE_ENV refuses to start', () => {
    withEnv({ NODE_ENV: 'development', RENDER: 'true' }, ({ validateConfig }) => {
      assert.throws(() => validateConfig(), /NODE_ENV is "development" on Render\. It must be "production"/);
    });
    withEnv({ ...PROD, RENDER: 'true' }, ({ validateConfig }) => {
      assert.doesNotThrow(() => validateConfig());
    });
  });

  test('no validation message ever contains a secret value', () => {
    const secrets = { JWT_SECRET: 'short-secret-value', MONGO_URI: '' };
    withEnv({ NODE_ENV: 'production', CORS_ORIGIN: '', ...secrets }, ({ validateConfig }) => {
      assert.throws(() => validateConfig(), (err) => {
        assert.equal(err.message.includes('short-secret-value'), false);
        return true;
      });
    });
  });

  test('the shutdown timeout defaults to 20 seconds and can be set', () => {
    assert.equal(withEnv({ SHUTDOWN_TIMEOUT_MS: '' }, ({ config }) => config.shutdownTimeoutMs), 20000);
    assert.equal(withEnv({ SHUTDOWN_TIMEOUT_MS: '15000' }, ({ config }) => config.shutdownTimeoutMs), 15000);
  });

  test('SMS_SIMULATE is opt-IN: only the literal "true" simulates', () => {
    const read = (v) => withEnv({ SMS_SIMULATE: v }, ({ config }) => config.sms.simulate);
    assert.equal(read('true'), true);
    assert.equal(read('1'), false);
    assert.equal(read(''), false);
  });

  test('TWILIO_VALIDATE_WEBHOOK defaults to ON and only "false" disables it', () => {
    const read = (v) =>
      withEnv({ TWILIO_VALIDATE_WEBHOOK: v }, ({ config }) => config.webhook.validate);
    assert.equal(read(''), true);
    assert.equal(read('false'), false);
    assert.equal(read('no'), true);
  });
});

// The 12-character minimum, tested as a POLICY with test-local values only.
//
// This deliberately does NOT read server/.env. Asserting the current contents of
// a config file would make the suite environment-dependent and — because
// lengthening ADMIN_PASSWORD is an outstanding production action — would turn
// the suite red the moment that action is carried out. The production finding
// belongs in the README's "Before going live" list, not in a test.
describe('admin password policy — 12-character minimum', () => {
  const User = require('../../models/User');
  const { ensureAdmin } = require('../../utils/seedAdmin');
  const { config } = require('../../config/env');

  // Runs ensureAdmin against an in-memory User, with test-local credentials.
  async function ensureAdminWith(password, { existingAdmin = null } = {}) {
    const originalFindOne = User.findOne;
    const originalCreate = User.create;
    const originalSeed = { ...config.seedAdmin };
    const created = [];

    User.findOne = async () => existingAdmin;
    User.create = async (doc) => {
      created.push(doc);
      return { ...doc };
    };
    config.seedAdmin.name = 'Policy Test Admin';
    config.seedAdmin.email = 'policy@test.invalid';
    config.seedAdmin.password = password;

    try {
      const result = await ensureAdmin();
      return { result, created, error: null };
    } catch (error) {
      return { result: null, created, error };
    } finally {
      User.findOne = originalFindOne;
      User.create = originalCreate;
      Object.assign(config.seedAdmin, originalSeed);
    }
  }

  test('11 characters is REFUSED and no account is created', async () => {
    const { error, created } = await ensureAdminWith('eleven-char');
    assert.ok(error, 'expected ensureAdmin to throw');
    assert.equal(error.code, 'ADMIN_PASSWORD_TOO_SHORT');
    assert.equal(created.length, 0, 'nothing may be written when the policy refuses');
  });

  test('the refusal reports the LENGTH and never the password value', async () => {
    const secret = 'short-one!!';
    const { error } = await ensureAdminWith(secret);
    assert.match(error.message, /11 characters/);
    assert.equal(error.message.includes(secret), false, 'the value must never appear in an error');
  });

  test('exactly 12 characters is ACCEPTED', async () => {
    const twelve = 'abcdefghijkl';
    assert.equal(twelve.length, 12);
    const { result, created, error } = await ensureAdminWith(twelve);
    assert.equal(error, null, error && error.message);
    assert.equal(result.created, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].role, 'admin');
  });

  test('longer than 12 characters is ACCEPTED', async () => {
    const { result, error } = await ensureAdminWith('a-comfortably-long-passphrase');
    assert.equal(error, null, error && error.message);
    assert.equal(result.created, true);
  });

  test('a missing password is refused with a distinct code', async () => {
    const { error } = await ensureAdminWith('');
    assert.ok(error);
    assert.equal(error.code, 'ADMIN_CONFIG_MISSING');
  });

  test('an EXISTING admin is left untouched — the seed is idempotent', async () => {
    const existing = { email: 'already@test.invalid' };
    const { result, created, error } = await ensureAdminWith('eleven-char', {
      existingAdmin: existing,
    });
    assert.equal(error, null);
    assert.equal(result.created, false);
    assert.equal(result.email, existing.email);
    assert.equal(created.length, 0, 'an existing admin must never be overwritten');
  });

  test('the User schema mirrors the rule, so a direct model write cannot bypass it', () => {
    const tooShort = new User({
      name: 'X',
      email: 'x@test.invalid',
      password: 'eleven-char',
      role: 'admin',
    });
    const err = tooShort.validateSync();
    assert.ok(err, 'the schema should reject an 11-character password');
    assert.match(err.errors.password.message, /at least 12 characters/);

    const longEnough = new User({
      name: 'X',
      email: 'x@test.invalid',
      password: 'abcdefghijkl',
      role: 'admin',
    });
    assert.equal(longEnough.validateSync(), undefined);
  });

  test('every layer agrees on the same minimum', () => {
    const { MIN_PASSWORD_LENGTH: registerMin } = require('../../controllers/authController');
    const { MIN_PASSWORD_LENGTH: resetMin } = require('../../controllers/userController');
    assert.equal(registerMin, 12);
    assert.equal(resetMin, 12, 'a password reset must not be able to sidestep registration policy');
  });
});

describe('the test suite never depends on the real environment file', () => {
  test('no test file reads server/.env', () => {
    const fs = require('fs');
    const testRoot = path.join(__dirname, '..');
    const offenders = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.js')) {
          const source = fs.readFileSync(full, 'utf8');
          // The harness names the file only inside comments; a real read would
          // pair it with a filesystem call.
          if (/readFileSync\s*\([^)]*\.env/.test(source) || /existsSync\s*\([^)]*\.env/.test(source)) {
            offenders.push(path.relative(testRoot, full));
          }
        }
      }
    })(testRoot);
    assert.deepEqual(offenders, [], 'these test files read the real .env');
  });
});
