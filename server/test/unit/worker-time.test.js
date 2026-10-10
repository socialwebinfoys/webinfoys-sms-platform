// Phase 10 — Stage 6G: sending window, send days, timezone resolution, DST and
// retry backoff. These are the pure functions the worker exports for exactly
// this purpose, so they are tested directly with no persistence involved.
'use strict';

require('../_support/env');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../../jobs/automationWorker');
const {
  delayToMs,
  hourInTimezone,
  weekdayInTimezone,
  withinSendingWindow,
  isAllowedSendDay,
  isSendableAt,
  nextSendableTime,
  resolveTimezone,
  retryBackoffFor,
  CLAIM_TTL_MS,
} = worker;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe('delayToMs', () => {
  const cases = [
    [1, 'minutes', MIN],
    [90, 'minutes', 90 * MIN],
    [1, 'hours', HOUR],
    [2, 'days', 2 * 24 * HOUR],
    [0, 'hours', 0],
    [1, undefined, HOUR], // default unit is hours
    [1, 'fortnights', HOUR], // unknown unit falls back to hours
    ['3', 'hours', 3 * HOUR], // numeric string
    [undefined, 'hours', 0],
    [null, 'hours', 0],
    [NaN, 'hours', 0],
  ];
  for (const [value, unit, expected] of cases) {
    test(`${JSON.stringify(value)} ${String(unit)} -> ${expected}ms`, () => {
      assert.equal(delayToMs(value, unit), expected);
    });
  }
});

describe('hourInTimezone / weekdayInTimezone', () => {
  // 2026-07-01T16:30:00Z — northern summer, so US zones are on DST.
  const summer = new Date('2026-07-01T16:30:00Z');

  test('UTC hour', () => {
    assert.equal(hourInTimezone(summer, 'UTC'), 16);
  });
  test('America/New_York in summer is UTC-4', () => {
    assert.equal(hourInTimezone(summer, 'America/New_York'), 12);
  });
  test('America/Los_Angeles in summer is UTC-7', () => {
    assert.equal(hourInTimezone(summer, 'America/Los_Angeles'), 9);
  });
  test('Asia/Kolkata is a :30 offset zone', () => {
    assert.equal(hourInTimezone(summer, 'Asia/Kolkata'), 22);
  });
  test('an invalid timezone returns null rather than throwing', () => {
    assert.equal(hourInTimezone(summer, 'Mars/Olympus_Mons'), null);
  });
  test('midnight renders as 0, never 24', () => {
    assert.equal(hourInTimezone(new Date('2026-07-01T00:00:00Z'), 'UTC'), 0);
  });

  test('weekday mapping: 2026-07-01 is a Wednesday', () => {
    assert.equal(weekdayInTimezone(summer, 'UTC'), 3);
  });
  test('weekday is zone-sensitive across the date line', () => {
    const lateUtc = new Date('2026-07-01T23:30:00Z'); // Wed in UTC
    assert.equal(weekdayInTimezone(lateUtc, 'UTC'), 3);
    assert.equal(weekdayInTimezone(lateUtc, 'Asia/Tokyo'), 4); // already Thursday
  });
  test('an invalid timezone returns null', () => {
    assert.equal(weekdayInTimezone(summer, 'Nowhere/Nothing'), null);
  });
});

describe('withinSendingWindow', () => {
  const window = { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' };

  test('a disabled window always permits', () => {
    const t = new Date('2026-07-01T03:00:00Z');
    assert.equal(withinSendingWindow({ ...window, enabled: false }, null, t), true);
  });
  test('an absent window always permits', () => {
    assert.equal(withinSendingWindow(null, null, new Date()), true);
  });

  const normal = [
    ['2026-07-01T09:00:00Z', true, 'start hour is inclusive'],
    ['2026-07-01T12:00:00Z', true, 'mid-window'],
    ['2026-07-01T17:59:00Z', true, 'last minute inside'],
    ['2026-07-01T18:00:00Z', false, 'end hour is EXCLUSIVE'],
    ['2026-07-01T08:59:00Z', false, 'just before the window'],
    ['2026-07-01T23:00:00Z', false, 'night'],
    ['2026-07-01T00:00:00Z', false, 'midnight'],
  ];
  for (const [iso, expected, why] of normal) {
    test(`09-18 UTC @ ${iso} -> ${expected} (${why})`, () => {
      assert.equal(withinSendingWindow(window, null, new Date(iso)), expected);
    });
  }

  const overnight = { enabled: true, startHour: 22, endHour: 6, timezone: 'UTC' };
  const overnightCases = [
    ['2026-07-01T22:00:00Z', true],
    ['2026-07-01T23:30:00Z', true],
    ['2026-07-01T02:00:00Z', true],
    ['2026-07-01T05:59:00Z', true],
    ['2026-07-01T06:00:00Z', false],
    ['2026-07-01T12:00:00Z', false],
    ['2026-07-01T21:59:00Z', false],
  ];
  for (const [iso, expected] of overnightCases) {
    test(`overnight 22-6 UTC @ ${iso} -> ${expected}`, () => {
      assert.equal(withinSendingWindow(overnight, null, new Date(iso)), expected);
    });
  }

  test('a timezone override takes precedence over the window timezone', () => {
    // 16:30 UTC is outside a 9-18 window in Tokyo (01:30) but inside in New York (12:30).
    const t = new Date('2026-07-01T16:30:00Z');
    assert.equal(withinSendingWindow(window, 'America/New_York', t), true);
    assert.equal(withinSendingWindow(window, 'Asia/Tokyo', t), false);
  });

  test('an unknown timezone PERMITS rather than stranding the message', () => {
    const t = new Date('2026-07-01T03:00:00Z'); // outside the UTC window
    assert.equal(withinSendingWindow(window, 'Not/AZone', t), true);
  });

  test('a 0-24 window is always open', () => {
    const allDay = { enabled: true, startHour: 0, endHour: 24, timezone: 'UTC' };
    for (const h of [0, 5, 12, 23]) {
      const t = new Date(`2026-07-01T${String(h).padStart(2, '0')}:00:00Z`);
      assert.equal(withinSendingWindow(allDay, null, t), true, `hour ${h}`);
    }
  });
});

describe('isAllowedSendDay', () => {
  const window = { timezone: 'UTC' };
  const wednesday = new Date('2026-07-01T12:00:00Z');

  test('an empty list means no restriction (legacy settings)', () => {
    assert.equal(isAllowedSendDay([], null, window, wednesday), true);
  });
  test('an absent list means no restriction', () => {
    assert.equal(isAllowedSendDay(undefined, null, window, wednesday), true);
  });
  test('all seven days means no restriction', () => {
    assert.equal(isAllowedSendDay([0, 1, 2, 3, 4, 5, 6], null, window, wednesday), true);
  });
  test('Wednesday is allowed when listed', () => {
    assert.equal(isAllowedSendDay([3], null, window, wednesday), true);
  });
  test('Wednesday is refused when not listed', () => {
    assert.equal(isAllowedSendDay([1, 2, 4, 5], null, window, wednesday), false);
  });
  test('weekdays-only refuses a Sunday', () => {
    const sunday = new Date('2026-07-05T12:00:00Z');
    assert.equal(isAllowedSendDay([1, 2, 3, 4, 5], null, window, sunday), false);
  });
  test('the day is evaluated in the resolved zone, not UTC', () => {
    const lateWed = new Date('2026-07-01T23:30:00Z'); // Thursday in Tokyo
    assert.equal(isAllowedSendDay([3], 'Asia/Tokyo', window, lateWed), false);
    assert.equal(isAllowedSendDay([4], 'Asia/Tokyo', window, lateWed), true);
  });
  test('an unknown zone permits rather than stranding', () => {
    assert.equal(isAllowedSendDay([3], 'Bad/Zone', window, new Date('2026-07-05T12:00:00Z')), true);
  });
});

describe('isSendableAt combines window AND day', () => {
  const window = { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' };

  test('inside the window on an allowed day -> sendable', () => {
    assert.equal(isSendableAt(new Date('2026-07-01T12:00:00Z'), window, [3], 'UTC'), true);
  });
  test('inside the window on a refused day -> not sendable', () => {
    assert.equal(isSendableAt(new Date('2026-07-01T12:00:00Z'), window, [1], 'UTC'), false);
  });
  test('outside the window on an allowed day -> not sendable', () => {
    assert.equal(isSendableAt(new Date('2026-07-01T03:00:00Z'), window, [3], 'UTC'), false);
  });
});

describe('nextSendableTime', () => {
  const window = { enabled: true, startHour: 9, endHour: 18, timezone: 'UTC' };
  const allDays = [0, 1, 2, 3, 4, 5, 6];

  test('before the window, it returns the window opening on the same day', () => {
    const from = new Date('2026-07-01T03:17:00Z');
    const next = nextSendableTime(from, window, allDays, 'UTC');
    assert.equal(next.toISOString(), '2026-07-01T09:00:00.000Z');
  });

  test('after the window, it rolls to the next morning', () => {
    const from = new Date('2026-07-01T19:05:00Z');
    const next = nextSendableTime(from, window, allDays, 'UTC');
    assert.equal(next.toISOString(), '2026-07-02T09:00:00.000Z');
  });

  test('inside the window it rounds up to the next 15-minute slot, not days later', () => {
    const from = new Date('2026-07-01T12:07:00Z');
    const next = nextSendableTime(from, window, allDays, 'UTC');
    assert.equal(next.toISOString(), '2026-07-01T12:15:00.000Z');
  });

  test('with weekdays only, a Friday evening rolls to Monday morning', () => {
    const fridayNight = new Date('2026-07-03T19:00:00Z'); // 2026-07-03 is a Friday
    const next = nextSendableTime(fridayNight, window, [1, 2, 3, 4, 5], 'UTC');
    assert.equal(next.toISOString(), '2026-07-06T09:00:00.000Z'); // Monday
    assert.equal(weekdayInTimezone(next, 'UTC'), 1);
  });

  test('the result is always itself sendable', () => {
    const samples = [
      '2026-01-15T04:00:00Z',
      '2026-03-08T06:30:00Z', // US spring-forward day
      '2026-11-01T05:30:00Z', // US fall-back day
      '2026-07-01T23:59:00Z',
    ];
    for (const iso of samples) {
      for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Eucla']) {
        const next = nextSendableTime(new Date(iso), window, allDays, tz);
        assert.equal(
          isSendableAt(next, window, allDays, tz),
          true,
          `${iso} in ${tz} produced a non-sendable time ${next.toISOString()}`
        );
      }
    }
  });

  test('a :45-offset zone lands on a sendable slot (why the step is 15 minutes)', () => {
    // Australia/Eucla is UTC+8:45.
    const next = nextSendableTime(new Date('2026-07-01T00:00:00Z'), window, allDays, 'Australia/Eucla');
    assert.equal(isSendableAt(next, window, allDays, 'Australia/Eucla'), true);
  });

  test('it never returns a time before the starting instant', () => {
    const from = new Date('2026-07-01T03:17:00Z');
    assert.ok(nextSendableTime(from, window, allDays, 'UTC').getTime() >= from.getTime());
  });

  test('a never-open day set still returns a bounded fallback, never an infinite loop', () => {
    const impossible = { enabled: true, startHour: 9, endHour: 10, timezone: 'UTC' };
    const from = new Date('2026-07-01T12:00:00Z');
    const next = nextSendableTime(from, impossible, [], 'UTC');
    assert.ok(next instanceof Date);
    assert.ok(next.getTime() > from.getTime());
  });
});

describe('resolveTimezone precedence: enrollment -> contact -> window -> UTC', () => {
  const window = { timezone: 'Europe/London' };

  test('the enrollment override wins', () => {
    assert.equal(
      resolveTimezone({ timezone: 'Asia/Tokyo' }, { timezone: 'America/Denver' }, window),
      'Asia/Tokyo'
    );
  });
  test("falls back to the contact's zone", () => {
    assert.equal(resolveTimezone({ timezone: '' }, { timezone: 'America/Denver' }, window), 'America/Denver');
  });
  test('falls back to the global window zone', () => {
    assert.equal(resolveTimezone({ timezone: '' }, { timezone: '' }, window), 'Europe/London');
  });
  test('falls back to UTC when nothing is set', () => {
    assert.equal(resolveTimezone({}, {}, {}), 'UTC');
    assert.equal(resolveTimezone(null, null, null), 'UTC');
  });
});

describe('retryBackoffFor — exponential from the configured base (5 min)', () => {
  const base = 5 * MIN;
  const cases = [
    [1, base],
    [2, base * 2],
    [3, base * 4],
    [4, base * 8],
    [0, base], // clamped to attempt 1
    [undefined, base],
    [null, base],
  ];
  for (const [attempts, expected] of cases) {
    test(`attempt ${String(attempts)} -> ${expected / MIN} minutes`, () => {
      assert.equal(retryBackoffFor(attempts), expected);
    });
  }

  test('it is strictly increasing', () => {
    let previous = 0;
    for (let n = 1; n <= 6; n += 1) {
      const current = retryBackoffFor(n);
      assert.ok(current > previous, `attempt ${n} should back off further`);
      previous = current;
    }
  });
});

describe('claim lease constant', () => {
  test('CLAIM_TTL_MS is five minutes', () => {
    assert.equal(CLAIM_TTL_MS, 5 * 60 * 1000);
  });
});
