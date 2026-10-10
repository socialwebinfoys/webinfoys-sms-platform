// Phase 10 — Stage 4: inbound keyword classification.
//
// classifyInboundKeyword decides whether an inbound message withdraws consent.
// A false negative keeps messaging someone who said STOP; a false positive
// silently stops a live campaign. Both matter, so the matrix is exhaustive.
'use strict';

require('../_support/env');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classifyInboundKeyword, STOP_KEYWORDS, START_KEYWORDS, HELP_KEYWORDS } =
  require('../../utils/optOut');

describe('STOP keywords', () => {
  const stopWords = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke'];

  test('the documented set is exactly these eight', () => {
    assert.deepEqual([...STOP_KEYWORDS].sort(), [...stopWords].sort());
  });

  for (const word of stopWords) {
    test(`"${word}" classifies as stop`, () => {
      assert.equal(classifyInboundKeyword(word), 'stop');
    });
    test(`"${word.toUpperCase()}" classifies as stop (case-insensitive)`, () => {
      assert.equal(classifyInboundKeyword(word.toUpperCase()), 'stop');
    });
  }

  const variants = [
    '  stop  ',
    'Stop',
    'sToP',
    'stop.',
    'STOP!',
    'stop?',
    'stop,',
    'stop;',
    'stop:',
    'stop...',
    'stop!!!',
    '\tstop\n',
  ];
  for (const v of variants) {
    test(`${JSON.stringify(v)} classifies as stop`, () => {
      assert.equal(classifyInboundKeyword(v), 'stop');
    });
  }
});

describe('START keywords', () => {
  test('the documented set is exactly start/unstop/optin', () => {
    assert.deepEqual([...START_KEYWORDS].sort(), ['optin', 'start', 'unstop']);
  });

  for (const word of ['start', 'unstop', 'optin']) {
    test(`"${word}" classifies as start`, () => {
      assert.equal(classifyInboundKeyword(word), 'start');
    });
  }
  test('"START." classifies as start', () => {
    assert.equal(classifyInboundKeyword('START.'), 'start');
  });

  // The headline compliance rule for this platform.
  test('"yes" is NOT a start keyword — this is the FDGSMS bug that must not recur', () => {
    assert.equal(START_KEYWORDS.has('yes'), false);
    assert.equal(classifyInboundKeyword('yes'), 'none');
    assert.equal(classifyInboundKeyword('YES'), 'none');
    assert.equal(classifyInboundKeyword('Yes!'), 'none');
    assert.equal(classifyInboundKeyword('yeah'), 'none');
    assert.equal(classifyInboundKeyword('y'), 'none');
  });
});

describe('HELP keywords', () => {
  test('the documented set is exactly help/info', () => {
    assert.deepEqual([...HELP_KEYWORDS].sort(), ['help', 'info']);
  });
  for (const word of ['help', 'info', 'HELP', 'Info.']) {
    test(`${JSON.stringify(word)} classifies as help`, () => {
      assert.equal(classifyInboundKeyword(word), 'help');
    });
  }
});

describe('whole-message matching only — no false positives', () => {
  const ordinaryReplies = [
    'stop by later',
    'please stop sending me so many',
    'can you stop',
    'I want to cancel my appointment',
    'the end of the road',
    'quit while you are ahead',
    'unsubscribe me from the newsletter instead',
    'start the engine',
    'help me understand the pricing',
    'stopwatch',
    'nonstop',
    'stops',
    'stopped',
    'endless',
    'cancellation',
    'information',
    'a stop sign',
    'STOP THE PRESSES',
  ];
  for (const body of ordinaryReplies) {
    test(`${JSON.stringify(body)} is an ordinary reply, not a keyword`, () => {
      assert.equal(classifyInboundKeyword(body), 'none');
    });
  }
});

describe('degenerate input never throws', () => {
  const cases = [
    [undefined, 'none'],
    [null, 'none'],
    ['', 'none'],
    ['   ', 'none'],
    ['...', 'none'],
    ['!!!', 'none'],
    [12345, 'none'],
    [{}, 'none'],
    [[], 'none'],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(classifyInboundKeyword(input), expected);
    });
  }

  test('punctuation-only after stripping is not a keyword', () => {
    assert.equal(classifyInboundKeyword('.,;:!?'), 'none');
  });

  test('leading punctuation is NOT stripped, so ".stop" is an ordinary reply', () => {
    // Only TRAILING punctuation is removed — documented behaviour.
    assert.equal(classifyInboundKeyword('.stop'), 'none');
  });
});
