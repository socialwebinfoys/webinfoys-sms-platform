// Inbox contact identity: the contact's name when it has one, otherwise the
// phone — in the conversation list, the open conversation's header, the contact
// panel and the AI draft cards. The rule is tested directly; that the Inbox uses
// it everywhere is checked against its source (the harness renders without
// effects, so the Inbox has no conversations to render).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { contactIdentity } from '../src/utils/contactIdentity.js';
import { jobContactLabel } from '../src/utils/aiPresentation.js';

const PHONE = '+15121234567';

describe('name with phone fallback', () => {
  test('a named contact: name as the title, phone as secondary', () => {
    assert.deepEqual(contactIdentity({ name: 'Austin City Dental', phone: PHONE }), {
      name: 'Austin City Dental',
      phone: PHONE,
      title: 'Austin City Dental',
      subtitle: PHONE,
      hasName: true,
    });
  });

  test('no name: the phone is the title, and it is not repeated underneath', () => {
    const id = contactIdentity({ name: '', phone: PHONE });
    assert.equal(id.title, PHONE);
    assert.equal(id.subtitle, '');
    assert.equal(id.hasName, false);
  });

  const blanks = [undefined, null, '', '   ', '\t\n', 'undefined', 'null', 'NULL', ' Undefined '];
  for (const name of blanks) {
    test(`a ${JSON.stringify(name)} name falls back to the phone`, () => {
      const id = contactIdentity({ name, phone: PHONE });
      assert.equal(id.title, PHONE);
      assert.equal(id.name, '');
    });
  }

  test('the title is never "undefined", "null", "Unknown" or blank while a phone is known', () => {
    for (const contact of [{ phone: PHONE }, { name: null, phone: PHONE }, { name: '  ', phone: ` ${PHONE} ` }]) {
      const { title } = contactIdentity(contact);
      assert.equal(title, PHONE);
      assert.doesNotMatch(title, /undefined|null|unknown/i);
    }
  });

  test('a full business name is shown whole and trimmed', () => {
    assert.equal(contactIdentity({ name: "  Dr. O'Neil & Sons — Family Dentistry, PLLC ", phone: PHONE }).title, "Dr. O'Neil & Sons — Family Dentistry, PLLC");
  });

  test('a name with no phone shows the name alone', () => {
    const id = contactIdentity({ name: 'Austin City Dental' });
    assert.equal(id.title, 'Austin City Dental');
    assert.equal(id.subtitle, '');
  });
});

describe('when the contact record is missing', () => {
  const convo = { contactName: 'Austin City Dental', contactPhone: PHONE };

  test('the thread’s own copy of the name and phone is used', () => {
    for (const contact of [null, undefined, 'a1b2c3-unpopulated-id']) {
      const id = contactIdentity(contact, convo);
      assert.equal(id.title, 'Austin City Dental');
      assert.equal(id.subtitle, PHONE);
    }
  });

  test('a blank name on the contact falls through to the phone, not to a stale blank', () => {
    const id = contactIdentity({ name: ' ', phone: PHONE }, { contactName: '', contactPhone: PHONE });
    assert.equal(id.title, PHONE);
  });

  test('nothing known at all: an empty title for the caller to label', () => {
    assert.equal(contactIdentity(null, null).title, '');
    assert.equal(contactIdentity(undefined, {}).title, '');
  });

  test('the contact’s own name wins over the thread’s copy', () => {
    assert.equal(contactIdentity({ name: 'New Name', phone: PHONE }, convo).title, 'New Name');
  });
});

describe('AI draft cards use the same rule', () => {
  test('named, unnamed and blank-named contacts', () => {
    assert.equal(jobContactLabel({ contact: { name: 'Austin City Dental', phone: PHONE } }).display, 'Austin City Dental');
    assert.equal(jobContactLabel({ contact: { name: '', phone: PHONE } }).display, PHONE);
    assert.equal(jobContactLabel({ contact: { name: '   ', phone: PHONE } }).display, PHONE, 'a blank name no longer shows as blank');
    assert.equal(jobContactLabel({ contact: null, conversation: { contactPhone: PHONE } }).display, PHONE);
  });

  test('"Unknown contact" appears only when there is neither a name nor a phone', () => {
    assert.equal(jobContactLabel({}).display, 'Unknown contact');
    assert.equal(jobContactLabel(null).display, 'Unknown contact');
  });
});

describe('the Inbox uses it everywhere a contact is shown', () => {
  const src = readFileSync(new URL('../src/pages/Inbox.jsx', import.meta.url), 'utf8');

  test('conversation list: title is the name or the phone; the phone is secondary only under a name', () => {
    assert.match(src, /const id = contactIdentity\(c\.contact, c\);/);
    assert.match(src, /<span className="convo-name">\{id\.title \|\| 'Unknown contact'\}<\/span>/);
    assert.match(src, /\{id\.subtitle && <div className="convo-item-mid muted small">\{id\.subtitle\}<\/div>\}/);
  });

  test('open conversation header', () => {
    assert.match(src, /const who = contactIdentity\(contact, detail\);/);
    assert.match(src, /<strong>\{who\.title \|\| 'Unknown contact'\}<\/strong>\s*\{who\.subtitle && <div className="muted small">\{who\.subtitle\}<\/div>\}/);
  });

  test('contact panel: no empty Name row or dash when the name is missing', () => {
    assert.match(src, /\{who\.name && <tr><td className="muted">Name<\/td><td>\{who\.name\}<\/td><\/tr>\}/);
    assert.match(src, /\{who\.phone && <tr><td className="muted">Phone<\/td>/);
  });

  test('the old "name || phone" expressions are gone', () => {
    assert.doesNotMatch(src, /contact\?\.name \|\| contact\?\.phone/);
    assert.doesNotMatch(src, /c\.contact\.name \|\| c\.contact\.phone/);
  });
});
