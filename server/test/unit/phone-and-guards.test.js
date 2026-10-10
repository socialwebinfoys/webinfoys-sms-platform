// Phase 10 — Stage 2D/2E: phone normalisation and query-parameter guards.
//
// normalizePhone is the gate between operator input and what gets dialled; a
// mistake here produces unroutable numbers (the Phase 0 "+11…" bug) or silently
// messages the wrong person. queryGuards is the Mongo-operator-injection and
// unvalidated-sort defence.
'use strict';

require('../_support/env');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { normalizePhone, NANP_COUNTRY_CODE } = require('../../utils/phoneFormatter');
const { queryString, queryBool, pickSort } = require('../../utils/queryGuards');

describe('normalizePhone — NANP (+1)', () => {
  const valid = [
    ['4155552671', '+14155552671', '10 national digits'],
    ['14155552671', '+14155552671', '11 digits already carrying the country code'],
    ['+14155552671', '+14155552671', 'already E.164'],
    ['(415) 555-2671', '+14155552671', 'formatted with parens and dash'],
    ['415.555.2671', '+14155552671', 'dot separated'],
    ['415 555 2671', '+14155552671', 'space separated'],
    ['+1 (415) 555-2671', '+14155552671', 'E.164 with formatting'],
    ['0014155552671', '+14155552671', '00 international prefix'],
  ];
  for (const [input, expected, why] of valid) {
    test(`${JSON.stringify(input)} -> ${expected} (${why})`, () => {
      const r = normalizePhone(input, '+1');
      assert.equal(r.valid, true, r.error);
      assert.equal(r.e164, expected);
    });
  }

  test('the Phase 0 regression: "14155552671" must NOT become +114155552671', () => {
    const r = normalizePhone('14155552671', '+1');
    assert.equal(r.e164, '+14155552671');
    assert.notEqual(r.e164, '+114155552671');
  });

  test('an already-corrupted +11… number is REJECTED, not silently kept', () => {
    const r = normalizePhone('+114155552671');
    assert.equal(r.valid, false);
    assert.match(r.error, /exactly 10 digits after the country code/);
  });

  const invalid = [
    ['415555267', '9 digits is not a valid NANP number'],
    ['41555526712', '11 digits not starting with 1'],
    ['415-555-267a', 'letters are not digits'],
    ['', 'empty'],
    ['   ', 'whitespace only'],
    [null, 'null'],
    [undefined, 'undefined'],
  ];
  for (const [input, why] of invalid) {
    test(`${JSON.stringify(input)} is rejected (${why})`, () => {
      assert.equal(normalizePhone(input, '+1').valid, false);
    });
  }
});

// Regression tests for DEFECT-1 (Phase 10). phoneFormatter.js states, for the
// NANP branch: "Anything else is a malformed NANP number and is rejected rather
// than guessed at. Note there is deliberately no leading-zero stripping here:
// NANP has no '0' trunk prefix, so a leading 0 means the input is wrong."
//
// The structural NANP rule is NPA-NXX-XXXX where both the area code and the
// exchange code begin with 2-9. Numbers violating it are unroutable and Twilio
// rejects them with error 21211 — the same class of corruption the Phase 0 fix
// existed to prevent.
describe('normalizePhone — NANP structural validity (DEFECT-1 regression)', () => {
  const malformedNanp = [
    ['0415552671', 'area code starts with 0'],
    ['1155552671', 'area code starts with 1'],
    ['1115552671', 'area code 111'],
    ['4150552671', 'exchange code starts with 0'],
    ['4151552671', 'exchange code starts with 1'],
    ['+10415552671', 'E.164 form with a 0 area code'],
    ['+11155552671', 'E.164 form with a 1 area code'],
  ];
  for (const [input, why] of malformedNanp) {
    test(`${JSON.stringify(input)} is rejected (${why})`, () => {
      const r = normalizePhone(input, '+1');
      assert.equal(r.valid, false, `expected rejection but got ${r.e164}`);
    });
  }

  test('a valid NANP number is still accepted (the fix must not over-reject)', () => {
    for (const ok of ['4155552671', '14155552671', '+14155552671', '2125551234', '9995559999']) {
      const r = normalizePhone(ok, '+1');
      assert.equal(r.valid, true, `${ok} should remain valid: ${r.error}`);
    }
  });

  test('"0000000000" is not silently read as the international prefix 00', () => {
    // The "00" -> "+" rule fired on a plainly local 10-digit string and produced
    // "+00000000": no E.164 country code begins with 0.
    const r = normalizePhone('0000000000', '+1');
    assert.equal(r.valid, false, `expected rejection but got ${r.e164}`);
  });

  test('no accepted number may have a country code beginning with 0', () => {
    for (const input of ['0000000000', '0012345678', '+0123456789']) {
      const r = normalizePhone(input, '+1');
      if (r.valid) {
        assert.equal(r.e164.startsWith('+0'), false, `${input} produced ${r.e164}`);
      }
    }
  });

  test('NANP_COUNTRY_CODE is "1"', () => {
    assert.equal(NANP_COUNTRY_CODE, '1');
  });
});

describe('normalizePhone — other countries and E.164 bounds', () => {
  test('a UK number with a trunk 0 drops the 0 and gains +44', () => {
    const r = normalizePhone('07911123456', '+44');
    assert.equal(r.valid, true, r.error);
    assert.equal(r.e164, '+447911123456');
  });

  test('no country code and no default is refused with a helpful message', () => {
    const r = normalizePhone('5552671', '');
    assert.equal(r.valid, false);
    assert.match(r.error, /DEFAULT_COUNTRY_CODE/);
  });

  test('fewer than 8 digits is refused', () => {
    assert.equal(normalizePhone('+1234567').valid, false);
  });

  test('more than 15 digits is refused', () => {
    assert.equal(normalizePhone('+1234567890123456').valid, false);
  });

  test('exactly 8 digits is accepted (lower E.164 bound)', () => {
    const r = normalizePhone('+22345678');
    assert.equal(r.valid, true, r.error);
  });

  test('exactly 15 digits is accepted (upper E.164 bound)', () => {
    const r = normalizePhone('+234567890123456');
    assert.equal(r.valid, true, r.error);
  });

  test('a + followed by letters is refused', () => {
    assert.equal(normalizePhone('+44abcdefghij').valid, false);
  });
});

describe('queryString — collapses any shape to a scalar', () => {
  const cases = [
    ['abc', 'abc', 'a plain string'],
    ['  abc  ', 'abc', 'trimmed'],
    [['a', 'b'], 'a', 'repeated parameter: first wins'],
    [[], '', 'empty array'],
    [{ $ne: '' }, '', 'OPERATOR INJECTION: object carries no usable scalar'],
    [{ $gt: 'x' }, '', 'operator injection variant'],
    [undefined, '', 'absent'],
    [null, '', 'null'],
    [123, '123', 'number coerced'],
    [0, '0', 'zero is not treated as absent'],
    [false, 'false', 'boolean coerced'],
    [[['nested']], 'nested', 'nested array recurses to a scalar'],
  ];
  for (const [input, expected, why] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)} (${why})`, () => {
      assert.equal(queryString(input), expected);
    });
  }

  test('never throws for any input shape', () => {
    for (const v of [Symbol.iterator, () => {}, new Date(), NaN, Infinity, -0]) {
      assert.doesNotThrow(() => queryString(v));
    }
  });
});

describe('queryBool — only the literal strings count', () => {
  const cases = [
    ['true', true],
    ['TRUE', true],
    ['false', false],
    ['False', false],
    ['1', undefined],
    ['0', undefined],
    ['yes', undefined],
    ['', undefined],
    [undefined, undefined],
    [{ $ne: null }, undefined],
    [['true'], true],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${String(expected)}`, () => {
      assert.equal(queryBool(input), expected);
    });
  }

  test('a malformed flag leaves the filter untouched rather than meaning false', () => {
    assert.equal(queryBool('maybe'), undefined);
  });
});

describe('pickSort — allow-list only', () => {
  const allowed = ['createdAt', 'name', 'phone'];

  test('an allowed ascending field is accepted', () => {
    assert.deepEqual(pickSort('name', allowed), { sort: 'name', invalid: null });
  });
  test('an allowed descending field is accepted', () => {
    assert.deepEqual(pickSort('-createdAt', allowed), { sort: '-createdAt', invalid: null });
  });
  test('an absent value falls back to the default', () => {
    assert.deepEqual(pickSort(undefined, allowed), { sort: '-createdAt', invalid: null });
  });
  test('an empty value falls back to the default', () => {
    assert.deepEqual(pickSort('', allowed), { sort: '-createdAt', invalid: null });
  });

  const rejected = [
    'password',
    '-password',
    'lookup.carrier',
    '{"$where":"1"}',
    'createdAt name',
    '__proto__',
    'constructor',
    '-__proto__',
  ];
  for (const value of rejected) {
    test(`${JSON.stringify(value)} is reported invalid and does not become the sort`, () => {
      const r = pickSort(value, allowed);
      assert.equal(r.invalid, value);
      assert.equal(r.sort, '-createdAt');
    });
  }

  test('an array-shaped sort does not crash and is reduced first', () => {
    const r = pickSort(['name', 'phone'], allowed);
    assert.equal(r.sort, 'name');
    assert.equal(r.invalid, null);
  });

  test('an object-shaped sort degrades to the default', () => {
    const r = pickSort({ $ne: '' }, allowed);
    assert.equal(r.sort, '-createdAt');
  });

  test('a custom fallback is honoured', () => {
    assert.equal(pickSort('nope', allowed, 'name').sort, 'name');
  });
});
