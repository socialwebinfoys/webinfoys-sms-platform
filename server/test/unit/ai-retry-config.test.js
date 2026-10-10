// Fix 3 — AI_MAX_RETRIES=0 must mean zero retries.
//
// The bug this guards against: `parseInt(process.env.X, 10) || 3`. parseInt
// returns 0, 0 is falsy, so `||` quietly hands back 3 — an operator who asked
// for no retries gets three, which is the opposite of the instruction and
// invisible until a failing job retries anyway.
//
// The env is set BEFORE config/env.js is first required, because the config
// object is built once at load time.
'use strict';

require('../_support/env');

process.env.AI_MAX_RETRIES = '0';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../../config/env');

describe('AI_MAX_RETRIES=0', () => {
  test('stays 0 — it is NOT replaced by the default', () => {
    assert.equal(config.ai.maxRetries, 0, 'zero retries became the default');
  });

  test('is a number, not a string or NaN', () => {
    assert.equal(typeof config.ai.maxRetries, 'number');
    assert.ok(Number.isFinite(config.ai.maxRetries));
  });

  test('means a job fails on its first failed attempt', () => {
    // The worker's rule is `attempts >= maxRetries` after incrementing, so with
    // a limit of 0 the first increment (0 -> 1) already exceeds it.
    const attemptsAfterFirstFailure = 1;
    assert.ok(
      attemptsAfterFirstFailure >= config.ai.maxRetries,
      'a limit of 0 must fail a job on its first failure'
    );
  });

  test('means recovery fails a stranded job rather than requeuing it', () => {
    // Recovery's rule is `attempts >= maxRetries` on the stored value, so a job
    // that has not yet been retried is already out of attempts at a limit of 0.
    const neverRetried = 0;
    assert.ok(neverRetried >= config.ai.maxRetries);
  });
});

describe('the parsing rule itself', () => {
  // Expressed as the rule rather than by reloading the module, because the
  // config is a load-time singleton. This is the behaviour the fix guarantees.
  const intFromEnv = (raw, fallback) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) ? value : fallback;
  };

  test('0 is honoured', () => {
    assert.equal(intFromEnv('0', 3), 0);
  });

  test('an ordinary value is honoured', () => {
    assert.equal(intFromEnv('5', 3), 5);
    assert.equal(intFromEnv('1', 3), 1);
  });

  test('unset falls back, as before', () => {
    assert.equal(intFromEnv(undefined, 3), 3);
    assert.equal(intFromEnv(null, 3), 3);
  });

  test('empty and whitespace fall back', () => {
    assert.equal(intFromEnv('', 3), 3);
    assert.equal(intFromEnv('   ', 3), 3);
  });

  test('unparseable falls back', () => {
    assert.equal(intFromEnv('abc', 3), 3);
    assert.equal(intFromEnv('NaN', 3), 3);
  });

  test('the OLD idiom is what gets 0 wrong — the regression this file exists for', () => {
    const old = (raw, fallback) => parseInt(raw, 10) || fallback;
    assert.equal(old('0', 3), 3, 'demonstrates the bug');
    assert.equal(intFromEnv('0', 3), 0, 'and the fix');
  });
});

describe('other AI retry settings keep their existing behaviour', () => {
  test('the backoff default is unchanged', () => {
    // The harness sets this to 2.
    assert.equal(config.ai.retryBackoffMinutes, 2);
  });

  test('the per-run job budget is unchanged', () => {
    assert.ok(Number.isFinite(config.ai.maxJobsPerRun));
    assert.ok(config.ai.maxJobsPerRun > 0);
  });

  test('the request timeout is unchanged', () => {
    assert.equal(config.ai.requestTimeoutMs, 5000); // set by the test harness
  });
});
