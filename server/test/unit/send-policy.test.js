// Phase 10 — Stage 5: number intelligence / line-type policy.
//
// Exercises the REAL services/sendPolicy against the REAL models/Settings
// statics (resolveAllowedLineTypes, LINE_TYPES) — only getSingleton and the
// Lookup call are substituted, so the compatibility rules and the canonical
// type mapping under test are the shipped ones.
'use strict';

require('../_support/env');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const Settings = require('../../models/Settings');
const Contact = require('../../models/Contact');
const lookupService = require('../../services/lookupService');
const { checkCanSend, checkMobileOnly, canonicalLineType, isLookupFresh } =
  require('../../services/sendPolicy');
const f = require('../_support/factories');
const { fakeDoc } = require('../_support/stubs');

// --- substitutions ---------------------------------------------------------
let currentSettings;
let lookupCalls;
let lookupImpl;

Settings.getSingleton = async () => currentSettings;
Contact.findOne = async () => null;
lookupService.lookupNumber = async (phone) => {
  lookupCalls.push(phone);
  return lookupImpl(phone);
};

beforeEach(() => {
  currentSettings = f.settings();
  lookupCalls = [];
  lookupImpl = async () => ({
    valid: true,
    phone: '+14155552671',
    type: 'mobile',
    carrier: 'Test',
    lookedUpAt: new Date(),
  });
});

const ALL_TYPES = ['mobile', 'landline', 'fixedVoip', 'nonFixedVoip', 'tollFree', 'unknown'];
const DAY = 24 * 60 * 60 * 1000;

function freshContact(type) {
  return fakeDoc(
    f.contact({
      lookup: {
        status: 'valid',
        type,
        carrier: 'Test Carrier',
        canonicalPhone: '+14155552671',
        lookedUpAt: new Date(Date.now() - 1 * DAY), // inside the 30-day default
      },
    })
  );
}

describe('LINE_TYPES is the six canonical Twilio Lookup v2 values', () => {
  test('exactly six, in the documented spelling', () => {
    assert.deepEqual(Settings.LINE_TYPES, ALL_TYPES);
  });
});

describe('6x6 allowedLineTypes matrix (single-type policy)', () => {
  for (const policyType of ALL_TYPES) {
    for (const contactType of ALL_TYPES) {
      const shouldAllow = policyType === contactType;
      test(`policy=[${policyType}] contact=${contactType} -> ${shouldAllow ? 'ALLOWED' : 'BLOCKED'}`, async () => {
        currentSettings = f.settings({ allowedLineTypes: [policyType] });
        const contact = freshContact(contactType);
        const result = await checkMobileOnly({ contact, phone: contact.phone });
        assert.equal(result.allowed, shouldAllow);
        assert.equal(result.filterApplied, true);
        if (!shouldAllow) {
          assert.equal(result.temporary, false, 'a wrong line type is definitive, never retryable');
          assert.match(result.reason, /not an allowed line type/);
        }
        // A fresh classification must never spend a billable Lookup call.
        assert.deepEqual(lookupCalls, []);
      });
    }
  }
});

describe('multi-type policies', () => {
  test('a policy listing several types allows each of them', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile', 'fixedVoip'] });
    for (const t of ['mobile', 'fixedVoip']) {
      const result = await checkMobileOnly({ contact: freshContact(t), phone: '+14155552671' });
      assert.equal(result.allowed, true, `${t} should be allowed`);
    }
  });

  test('a policy listing several types still blocks the others', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile', 'fixedVoip'] });
    for (const t of ['landline', 'nonFixedVoip', 'tollFree', 'unknown']) {
      const result = await checkMobileOnly({ contact: freshContact(t), phone: '+14155552671' });
      assert.equal(result.allowed, false, `${t} should be blocked`);
    }
  });

  test('all six types allowed = filter OFF, short-circuited before any Lookup', async () => {
    currentSettings = f.settings({ allowedLineTypes: [...ALL_TYPES] });
    const result = await checkMobileOnly({
      contact: fakeDoc(f.contact()), // no classification at all
      phone: '+14155552671',
    });
    assert.equal(result.allowed, true);
    assert.equal(result.filterApplied, false);
    assert.deepEqual(lookupCalls, [], 'the filter being off must not cost a Lookup call');
  });
});

describe('legacy mobileOnly compatibility (no allowedLineTypes stored)', () => {
  test('mobileOnly=false means every type is permitted (filter off)', async () => {
    currentSettings = f.settings({ allowedLineTypes: undefined, mobileOnly: false });
    assert.deepEqual(Settings.resolveAllowedLineTypes(currentSettings), ALL_TYPES);
    const result = await checkMobileOnly({ contact: fakeDoc(f.contact()), phone: '+14155552671' });
    assert.equal(result.allowed, true);
    assert.equal(result.filterApplied, false);
  });

  test('mobileOnly=true resolves to exactly ["mobile"]', async () => {
    currentSettings = f.settings({ allowedLineTypes: undefined, mobileOnly: true });
    assert.deepEqual(Settings.resolveAllowedLineTypes(currentSettings), ['mobile']);
    const ok = await checkMobileOnly({ contact: freshContact('mobile'), phone: '+1' });
    const no = await checkMobileOnly({ contact: freshContact('landline'), phone: '+1' });
    assert.equal(ok.allowed, true);
    assert.equal(no.allowed, false);
  });

  test('an explicit allowedLineTypes list overrides the legacy flag', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['landline'], mobileOnly: true });
    assert.deepEqual(Settings.resolveAllowedLineTypes(currentSettings), ['landline']);
  });

  test('an EMPTY allowedLineTypes array falls back rather than blocking everything', async () => {
    // The API refuses to store an empty list; this covers a document that
    // already holds one.
    currentSettings = f.settings({ allowedLineTypes: [], mobileOnly: false });
    assert.deepEqual(Settings.resolveAllowedLineTypes(currentSettings), ALL_TYPES);
  });

  test('resolveAllowedLineTypes returns a fresh array (callers cannot mutate settings)', () => {
    const s = f.settings({ allowedLineTypes: ['mobile'] });
    const a = Settings.resolveAllowedLineTypes(s);
    a.push('landline');
    assert.deepEqual(Settings.resolveAllowedLineTypes(s), ['mobile']);
  });
});

describe('canonicalLineType normalisation', () => {
  const cases = [
    ['mobile', 'mobile'],
    ['landline', 'landline'],
    ['fixedVoip', 'fixedVoip'],
    ['FIXEDVOIP', 'fixedVoip'],
    ['nonFixedVoip', 'nonFixedVoip'],
    ['voip', 'nonFixedVoip'], // legacy cached value -> the stricter reading
    ['tollFree', 'tollFree'],
    ['toll-free', 'tollFree'],
    ['unknown', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    [null, 'unknown'],
    ['something-twilio-invented', 'unknown'],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(canonicalLineType(input), expected);
    });
  }

  test('a legacy "voip" cached value is blocked by a fixedVoip-only policy', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['fixedVoip'] });
    const result = await checkMobileOnly({ contact: freshContact('voip'), phone: '+1' });
    assert.equal(result.allowed, false);
    assert.equal(result.type, 'nonFixedVoip');
  });
});

describe('lookup cache freshness', () => {
  test('isLookupFresh: inside the window is fresh', () => {
    assert.equal(isLookupFresh({ lookedUpAt: new Date(Date.now() - 5 * DAY) }, 30), true);
  });
  test('isLookupFresh: past the window is stale', () => {
    assert.equal(isLookupFresh({ lookedUpAt: new Date(Date.now() - 31 * DAY) }, 30), false);
  });
  test('isLookupFresh: never looked up is not fresh', () => {
    assert.equal(isLookupFresh({ status: 'valid' }, 30), false);
    assert.equal(isLookupFresh(null, 30), false);
  });

  test('a FRESH classification is reused — no Lookup call', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile'] });
    const contact = freshContact('mobile');
    const result = await checkMobileOnly({ contact, phone: contact.phone });
    assert.equal(result.allowed, true);
    assert.deepEqual(lookupCalls, []);
    assert.equal(contact.__saves, 0, 'nothing to re-cache, so nothing is written');
  });

  test('a STALE classification triggers a refresh and is re-cached on the contact', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile'], lookupMaxAgeDays: 30 });
    const contact = fakeDoc(
      f.contact({
        lookup: {
          status: 'valid',
          type: 'landline',
          carrier: 'Old',
          lookedUpAt: new Date(Date.now() - 400 * DAY),
        },
      })
    );
    lookupImpl = async () => ({
      valid: true,
      phone: '+14155552671',
      type: 'mobile',
      carrier: 'New Carrier',
      lookedUpAt: new Date(),
    });
    const result = await checkMobileOnly({ contact, phone: contact.phone });
    assert.equal(lookupCalls.length, 1, 'stale cache must be re-checked (number portability)');
    assert.equal(result.allowed, true, 'the refreshed type is mobile, which is allowed');
    assert.equal(contact.lookup.type, 'mobile');
    assert.equal(contact.lookup.carrier, 'New Carrier');
    assert.equal(contact.__saves, 1, 'the refreshed classification is persisted');
  });

  test('a contact never classified triggers a Lookup', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile'] });
    const contact = fakeDoc(f.contact());
    await checkMobileOnly({ contact, phone: contact.phone });
    assert.equal(lookupCalls.length, 1);
  });

  test('a shorter lookupMaxAgeDays makes a previously fresh cache stale', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile'], lookupMaxAgeDays: 1 });
    const contact = fakeDoc(
      f.contact({
        lookup: { status: 'valid', type: 'mobile', lookedUpAt: new Date(Date.now() - 3 * DAY) },
      })
    );
    await checkMobileOnly({ contact, phone: contact.phone });
    assert.equal(lookupCalls.length, 1);
  });
});

describe('fail-closed behaviour', () => {
  test('Twilio reporting the number INVALID is a definitive block', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile'] });
    lookupImpl = async () => ({ valid: false, phone: '+14155550000', type: '', lookedUpAt: new Date() });
    const result = await checkMobileOnly({ contact: fakeDoc(f.contact()), phone: '+14155550000' });
    assert.equal(result.allowed, false);
    assert.equal(result.temporary, false);
    assert.equal(result.status, 'invalid');
    assert.match(result.reason, /invalid/i);
  });

  test('Lookup outage with NO cached classification blocks, but is RETRYABLE', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile'] });
    lookupImpl = async () => {
      throw Object.assign(new Error('Lookup failed: upstream'), { statusCode: 502 });
    };
    const result = await checkMobileOnly({ contact: fakeDoc(f.contact()), phone: '+14155552671' });
    assert.equal(result.allowed, false);
    assert.equal(result.temporary, true, 'a transient outage must be retried, not failed');
    assert.match(result.reason, /Lookup unavailable/);
  });

  test('Lookup outage WITH a stale ALLOWED classification proceeds, flagged stale', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile'] });
    lookupImpl = async () => {
      throw new Error('Lookup failed: upstream');
    };
    const contact = fakeDoc(
      f.contact({
        lookup: { status: 'valid', type: 'mobile', lookedUpAt: new Date(Date.now() - 400 * DAY) },
      })
    );
    const result = await checkMobileOnly({ contact, phone: contact.phone });
    assert.equal(result.allowed, true);
    assert.equal(result.stale, true);
    assert.equal(result.type, 'mobile');
  });

  test('Lookup outage WITH a stale DISALLOWED classification stays blocked, definitively', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile'] });
    lookupImpl = async () => {
      throw new Error('Lookup failed: upstream');
    };
    const contact = fakeDoc(
      f.contact({
        lookup: { status: 'valid', type: 'landline', lookedUpAt: new Date(Date.now() - 400 * DAY) },
      })
    );
    const result = await checkMobileOnly({ contact, phone: contact.phone });
    assert.equal(result.allowed, false);
    assert.equal(result.stale, true);
    assert.equal(result.temporary, false);
    assert.match(result.reason, /not an allowed line type/);
  });

  test('a stale value can never PERMIT a type that is not on the allow-list', async () => {
    // The guarantee that matters: an outage must not widen the policy.
    currentSettings = f.settings({ allowedLineTypes: ['mobile'] });
    lookupImpl = async () => {
      throw new Error('down');
    };
    for (const t of ['landline', 'fixedVoip', 'nonFixedVoip', 'tollFree', 'unknown']) {
      const contact = fakeDoc(
        f.contact({
          lookup: { status: 'valid', type: t, lookedUpAt: new Date(Date.now() - 400 * DAY) },
        })
      );
      const result = await checkMobileOnly({ contact, phone: contact.phone });
      assert.equal(result.allowed, false, `${t} must stay blocked during an outage`);
    }
  });

  test('a stale INVALID classification stays blocked during an outage', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile'] });
    lookupImpl = async () => {
      throw new Error('down');
    };
    const contact = fakeDoc(
      f.contact({
        lookup: { status: 'invalid', type: 'mobile', lookedUpAt: new Date(Date.now() - 400 * DAY) },
      })
    );
    const result = await checkMobileOnly({ contact, phone: contact.phone });
    assert.equal(result.allowed, false);
  });
});

describe('checkCanSend consent and deliverability gate', () => {
  test('a clean contact is allowed', async () => {
    const result = await checkCanSend({ contact: f.contact() });
    assert.equal(result.allowed, true);
  });

  test('an opted-out contact is blocked definitively', async () => {
    const result = await checkCanSend({ contact: f.contact({ optedOut: true }) });
    assert.equal(result.allowed, false);
    assert.equal(result.temporary, false, 'consent is a decision, never retried');
    assert.equal(result.code, 'opted_out');
  });

  test('an inactive contact is blocked definitively', async () => {
    const result = await checkCanSend({ contact: f.contact({ isActive: false }) });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'inactive');
    assert.equal(result.temporary, false);
  });

  test('a delivery-blocked contact is blocked definitively', async () => {
    const result = await checkCanSend({ contact: f.contact({ deliveryBlocked: true }) });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'delivery_blocked');
    assert.equal(result.temporary, false);
  });

  test('opt-out is checked BEFORE inactive and delivery-block (consent wins the message)', async () => {
    const result = await checkCanSend({
      contact: f.contact({ optedOut: true, isActive: false, deliveryBlocked: true }),
    });
    assert.equal(result.code, 'opted_out');
  });

  test('a legacy contact with no optedOut field at all is allowed', async () => {
    const legacy = f.contact();
    delete legacy.optedOut;
    delete legacy.deliveryBlocked;
    const result = await checkCanSend({ contact: legacy });
    assert.equal(result.allowed, true);
  });

  test('a RAW number belonging to an opted-out contact is still blocked', async () => {
    Contact.findOne = async (filter) => {
      assert.deepEqual(filter, { phone: '+14155552671' });
      return f.contact({ optedOut: true });
    };
    const result = await checkCanSend({ contact: null, phone: '+14155552671' });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'opted_out');
    Contact.findOne = async () => null;
  });

  test('an unknown number with no contact record passes this gate', async () => {
    Contact.findOne = async () => null;
    const result = await checkCanSend({ contact: null, phone: '+14155559999' });
    assert.equal(result.allowed, true);
  });
});

// A number Twilio Lookup DEFINITIVELY reported invalid is refused by the gate
// every send path runs first — so it holds whatever the line-type filter is set
// to. Nothing else about a lookup is treated as invalid.
describe('checkCanSend refuses a definitively invalid number', () => {
  const { isLookupInvalid } = require('../../services/sendPolicy');
  const invalidContact = (over = {}) =>
    f.contact({ lookup: { status: 'invalid', type: '', lookedUpAt: new Date() }, ...over });

  const POLICIES = {
    'mobileOnly=false (the default)': () => f.settings({ mobileOnly: false }),
    'every line type allowed': () => f.settings({ allowedLineTypes: [...ALL_TYPES] }),
    'mobileOnly=true': () => f.settings({ mobileOnly: true }),
    'only landline allowed': () => f.settings({ allowedLineTypes: ['landline'] }),
  };
  for (const [label, settings] of Object.entries(POLICIES)) {
    test(`blocked with ${label}`, async () => {
      currentSettings = settings();
      const result = await checkCanSend({ contact: invalidContact() });
      assert.equal(result.allowed, false);
      assert.equal(result.code, 'invalid_number');
      assert.equal(result.temporary, false, 'a definitive result is never retried');
      assert.match(result.reason, /invalid/i);
      assert.deepEqual(lookupCalls, [], 'the gate reads the cache; it never spends a Lookup');
    });
  }

  test('the line-type filter alone lets it through when every type is allowed — which is why the gate exists', async () => {
    currentSettings = f.settings({ mobileOnly: false });
    const contact = fakeDoc(invalidContact());
    assert.equal((await checkMobileOnly({ contact, phone: contact.phone })).allowed, true);
    assert.equal((await checkCanSend({ contact })).allowed, false);
  });

  test('an invalid result blocks however old it is', async () => {
    const old = invalidContact({ lookup: { status: 'invalid', type: 'mobile', lookedUpAt: new Date(Date.now() - 400 * DAY) } });
    assert.equal((await checkCanSend({ contact: old })).code, 'invalid_number');
    assert.deepEqual(lookupCalls, []);
  });

  test('a RAW number belonging to an invalid contact is blocked too', async () => {
    Contact.findOne = async () => invalidContact();
    const result = await checkCanSend({ contact: null, phone: '+14155552671' });
    assert.equal(result.code, 'invalid_number');
    Contact.findOne = async () => null;
  });

  test('consent is still reported first for an opted-out invalid number', async () => {
    assert.equal((await checkCanSend({ contact: invalidContact({ optedOut: true }) })).code, 'opted_out');
  });

  // Everything that is NOT a definitive invalid result.
  const NOT_INVALID = {
    'not checked': { status: 'unknown', type: '', lastError: '' },
    'no lookup object at all (legacy)': undefined,
    'a lookup attempt that failed': { status: 'unknown', type: '', lastError: 'Lookup failed: Twilio 503', lastAttemptAt: new Date() },
    'rate limited': { status: 'unknown', type: '', lastError: 'Rate limited by Twilio Lookup', lastAttemptAt: new Date() },
    'valid but unclassifiable (Unknown)': { status: 'valid', type: '', lookedUpAt: new Date() },
    'valid mobile': { status: 'valid', type: 'mobile', lookedUpAt: new Date() },
    'valid landline': { status: 'valid', type: 'landline', lookedUpAt: new Date() },
    'valid VoIP': { status: 'valid', type: 'nonFixedVoip', lookedUpAt: new Date() },
    'a failed re-check of a valid number': { status: 'valid', type: 'mobile', lookedUpAt: new Date(), lastError: 'Lookup failed: timeout' },
  };
  for (const [label, lookup] of Object.entries(NOT_INVALID)) {
    test(`${label} is NOT treated as invalid`, async () => {
      const contact = f.contact({ lookup });
      assert.equal(isLookupInvalid(contact), false);
      assert.equal((await checkCanSend({ contact })).allowed, true);
    });
  }

  test('isLookupInvalid is true only for a stored status of "invalid"', () => {
    assert.equal(isLookupInvalid(invalidContact()), true);
    assert.equal(isLookupInvalid(null), false);
    assert.equal(isLookupInvalid({}), false);
    assert.equal(isLookupInvalid({ lookup: { status: 'INVALID' } }), false);
  });

  test('a temporary Lookup failure under the line-type filter stays temporary, and marks nothing invalid', async () => {
    currentSettings = f.settings({ allowedLineTypes: ['mobile'] });
    lookupImpl = async () => {
      throw new Error('Lookup failed: upstream');
    };
    const contact = fakeDoc(f.contact());
    assert.equal((await checkCanSend({ contact })).allowed, true);
    const result = await checkMobileOnly({ contact, phone: contact.phone });
    assert.equal(result.allowed, false);
    assert.equal(result.temporary, true, 'retryable, exactly as before');
    assert.equal(contact.lookup.status, 'unknown', 'a failure never becomes "invalid"');
    assert.equal((await checkCanSend({ contact })).allowed, true);
  });
});
