// Invalid numbers in the UI. The backend decides who is eligible
// (server/test/api/invalid-number-eligibility.test.js); these tests check that
// the pages only offer what the server returned, and that the new
// `invalid_number` reason is shown in words rather than as a raw code.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { describeReason, describeApiError } from '../src/utils/aiPresentation.js';

const page = (name) => readFileSync(new URL(`../src/pages/${name}.jsx`, import.meta.url), 'utf8');

describe('the invalid_number reason is readable', () => {
  test('an AI job stopped for an invalid number says so', () => {
    assert.equal(describeReason('invalid_number'), 'Twilio Lookup reports this number as invalid.');
  });

  test('the neighbouring reasons are unchanged', () => {
    assert.equal(describeReason('opted_out'), 'This contact has opted out of SMS.');
    assert.equal(describeReason('delivery_blocked'), 'Messages to this number keep failing to be delivered.');
  });

  test('a refused approval surfaces the server’s message', () => {
    const err = { response: { status: 403, data: { message: 'Twilio Lookup reports this number as invalid', reason: 'invalid_number' } } };
    assert.match(JSON.stringify(describeApiError(err)), /invalid/i);
  });
});

describe('Enrollments: the picker only ever offers what the server returned', () => {
  const src = page('Enrollments');

  test('enrollable contacts come from the eligible-contacts endpoint and nowhere else', () => {
    assert.match(src, /api\.get\(`\/campaigns\/\$\{cid\}\/eligible-contacts`/);
    assert.doesNotMatch(src, /api\.get\(['"`]\/contacts['"`?]/, 'the page never lists raw contacts');
  });

  test('"Select all" is resolved by the server, not from a client-side id list', () => {
    assert.match(src, /selectAll: true/);
  });

  test('contacts the server refused are reported to the operator', () => {
    assert.match(src, /not eligible/i);
  });

  test('a refused reactivation shows the server’s reason', () => {
    assert.match(src, /api\.patch\(`\/enrollments\/\$\{row\._id\}`, \{ status \}\)/);
    assert.match(src, /setError\(err\.response\?\.data\?\.message \|\| 'Failed to update'\)/);
  });
});

describe('Follow-ups: an invalid number cannot be ticked, and a skip is explained', () => {
  const src = page('Following');

  test('an invalid contact is shown disabled and labelled in the contact picker', () => {
    assert.match(src, /const invalidNumber = c\.lookup\?\.status === 'invalid';/);
    assert.match(src, /disabled=\{invalidNumber\}/);
    assert.match(src, /checked=\{!invalidNumber && isChecked\(String\(c\._id\)\)\}/);
    assert.match(src, /· invalid number/);
  });

  test('only a status of exactly "invalid" disables a row', () => {
    assert.doesNotMatch(src, /lookup\?\.status === 'unknown'/);
    assert.doesNotMatch(src, /lookup\?\.status !== 'valid'/);
  });

  test('a recipient skipped for an invalid number reads "invalid number"', () => {
    assert.match(src, /if \(r === 'invalid_number'\) return 'invalid number';/);
  });
});
