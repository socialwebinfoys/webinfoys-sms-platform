// Merge-field resolution — the one resolver every message path shares.
//
// Covers the behaviour that was wrong: {{first_name}} cutting a business name to
// its first word, tokens that silently resolved to nothing because of their
// spelling, and tokens that were not recognised at all and would have been sent
// as literal text. Also the CSV `Name` column reaching the contact name.
'use strict';

require('../_support/env');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  renderTemplate,
  renderForContact,
  contactToMergeData,
  extractMergeFields,
} = require('../../utils/mergeFields');
const { parseContactFile, mapRecordToContact } = require('../../utils/fileParser');

const dental = { name: 'Austin City Dental', phone: '+15121234567', email: 'hello@austincitydental.example' };
const send = (text, contact) => renderForContact(text, contact).rendered;

// ---------------------------------------------------------------------------
describe('the CSV Name column', () => {
  async function importCsv(csv) {
    const { records } = await parseContactFile(Buffer.from(csv, 'utf8'), 'Dentists_in_Austin_Texas.csv');
    return records.map(mapRecordToContact);
  }

  test('`Name` maps to the contact name, whole', async () => {
    const [c] = await importCsv('Name,Phone\nAustin City Dental,+15121234567\n');
    assert.equal(c.name, 'Austin City Dental');
    assert.equal(c.phone, '+15121234567');
    assert.deepEqual(c.customFields, {}, 'the name is not left behind as a custom field');
  });

  test('however the header is written: NAME, name, Full Name, Contact Name', async () => {
    for (const header of ['NAME', 'name', 'Name', 'Full Name', 'fullname', 'Contact Name']) {
      const [c] = await importCsv(`${header},Phone\nAustin City Dental,+15121234567\n`);
      assert.equal(c.name, 'Austin City Dental', header);
    }
  });

  test('a UTF-8 BOM (Excel export) does not hide the Name column', async () => {
    const [c] = await importCsv('﻿Name,Phone\nAustin City Dental,+15121234567\n');
    assert.equal(c.name, 'Austin City Dental');
  });

  test('a quoted name containing a comma is kept whole', async () => {
    const [c] = await importCsv('Name,Phone\n"Smith, Jones & Co. Dental",+15121234567\n');
    assert.equal(c.name, 'Smith, Jones & Co. Dental');
  });

  test('other columns are still custom fields, and then usable as merge fields', async () => {
    const [c] = await importCsv('Name,Phone,City,First Name\nAustin City Dental,+15121234567,Austin,Maria\n');
    assert.deepEqual(c.customFields, { City: 'Austin', 'First Name': 'Maria' });
    assert.equal(send('{{first_name}} in {{city}} — {{name}}', c), 'Maria in Austin — Austin City Dental');
  });
});

// ---------------------------------------------------------------------------
describe('names', () => {
  test('{{name}} is the full contact name', () => {
    assert.equal(send('Hello {{name}}', dental), 'Hello Austin City Dental');
  });

  test('{{first_name}} falls back to the FULL name — a business name is not cut to "Austin"', () => {
    assert.equal(send('Hi {{first_name}}, quick question.', dental), 'Hi Austin City Dental, quick question.');
  });

  test('a business name is preserved exactly: case, punctuation, inner spacing', () => {
    const c = { name: "Dr. O'Neil & Sons — Family Dentistry, PLLC", phone: '+15121234567' };
    assert.equal(send('{{name}}|{{first_name}}', c), `${c.name}|${c.name}`);
  });

  test('a separate first-name field wins over the fallback', () => {
    const c = { ...dental, customFields: { 'First Name': 'Maria', 'Last Name': 'Lopez' } };
    assert.equal(send('Hi {{first_name}} {{last_name}} of {{name}}', c), 'Hi Maria Lopez of Austin City Dental');
  });

  test('{{last_name}} is never carved out of the name (no "Austin City Dental City Dental")', () => {
    assert.equal(send('Hi {{first_name}} {{last_name}}!', dental), 'Hi Austin City Dental!');
  });

  test('with no stored name, separate first/last fields still give a name', () => {
    const c = { name: '', phone: '+15121234567', customFields: { first_name: 'Maria', last_name: 'Lopez' } };
    assert.equal(send('{{name}} / {{first_name}}', c), 'Maria Lopez / Maria');
  });

  test('{{phone}} and {{email}}', () => {
    assert.equal(send('{{phone}} {{email}}', dental), '+15121234567 hello@austincitydental.example');
  });
});

// ---------------------------------------------------------------------------
describe('how the token is written does not matter', () => {
  const spellings = [
    '{{name}}', '{{Name}}', '{{NAME}}', '{{ name }}', '{{full_name}}', '{{Full Name}}', '{{fullName}}', '{{contact_name}}',
    '{{first_name}}', '{{First_Name}}', '{{firstName}}', '{{First Name}}', '{{FIRSTNAME}}', '{{first-name}}', '{{ first_name }}',
  ];
  for (const token of spellings) {
    test(`${token} resolves to the contact name`, () => {
      assert.equal(send(`Hi ${token}!`, dental), 'Hi Austin City Dental!');
    });
  }

  test('phone and email aliases', () => {
    assert.equal(send('{{Phone}} {{phone_number}} {{mobile}}', dental), '+15121234567 +15121234567 +15121234567');
    assert.equal(send('{{Email}} {{email_address}}', dental), `${dental.email} ${dental.email}`);
  });
});

// ---------------------------------------------------------------------------
describe('custom fields keep working', () => {
  const c = { ...dental, customFields: { city: 'Austin', 'Practice Type': 'Family', rating: '4.8' } };

  test('exact key, as before', () => {
    assert.equal(send('{{city}} {{rating}}', c), 'Austin 4.8');
  });

  test('a custom field with spaces or capitals in its column name is reachable', () => {
    assert.equal(send('{{Practice Type}} / {{practice_type}} / {{City}}', c), 'Family / Family / Austin');
  });

  test('a Mongoose Map of custom fields works the same', () => {
    const m = { ...dental, customFields: new Map([['city', 'Austin']]) };
    assert.equal(send('{{city}}', m), 'Austin');
  });

  test('a custom field named like a built-in overrides it, as before', () => {
    const o = { ...dental, customFields: { first_name: 'Maria' } };
    assert.equal(contactToMergeData(o).first_name, 'Maria');
  });

  test('an EMPTY custom field never blanks a built-in value', () => {
    const o = { ...dental, customFields: { first_name: '', email: '' } };
    assert.equal(send('{{first_name}} {{email}}', o), `Austin City Dental ${dental.email}`);
  });
});

// ---------------------------------------------------------------------------
describe('missing values', () => {
  const noName = { name: '', phone: '+15121234567' };

  test('a literal placeholder is never left in the message', () => {
    for (const body of [
      'Hi {{first_name}}, hello', 'Hi {{name}}', '{{unknown_field}} hi', 'A {{First Name}} B', 'x {{ }} y', 'x {{}} y',
      'Hi {{first_name}} {{last_name}}, hi',
    ]) {
      const out = send(body, noName);
      assert.ok(!out.includes('{{') && !out.includes('}}'), `${body} -> ${out}`);
    }
  });

  test('the gap is tidied instead of leaving "Hi , …"', () => {
    assert.equal(send('Hi {{first_name}}, quick question.', noName), 'Hi, quick question.');
    assert.equal(send('Hi {{first_name}}! Welcome.', noName), 'Hi! Welcome.');
    assert.equal(send('{{first_name}}, are you open today?', noName), 'are you open today?');
    assert.equal(send('Call {{first_name}} today', noName), 'Call today');
    assert.equal(send('Thanks {{first_name}}', noName), 'Thanks');
    assert.equal(send('Hi {{first_name}} {{last_name}}, hello', noName), 'Hi, hello');
  });

  test('a whitespace-only name counts as missing', () => {
    assert.equal(send('Hi {{first_name}}, hello', { name: '   ', phone: '+1' }), 'Hi, hello');
  });

  test('missing fields are reported, for the preview to show', () => {
    const r = renderForContact('Hi {{first_name}} from {{city}}', noName);
    assert.deepEqual(r.unresolved, ['first_name', 'city']);
  });

  test('null, undefined and empty bodies render to an empty string', () => {
    for (const body of [null, undefined, '']) assert.equal(send(body, dental), '');
  });

  test('a contact with no data at all does not throw', () => {
    assert.equal(send('Hi {{first_name}}!', null), 'Hi!');
    assert.equal(send('Hi {{first_name}}!', {}), 'Hi!');
  });
});

// ---------------------------------------------------------------------------
describe('text without merge fields is untouched', () => {
  const bodies = [
    'Hello there', 'Two  spaces ,  odd , spacing !', '  leading and trailing  ', 'Line one\n\nLine two  \n',
    'Price is {5} or {low}', 'A single { brace } here', 'Emoji 🦷 and ünïcödé', 'Reply STOP to opt out.',
  ];
  for (const body of bodies) {
    test(JSON.stringify(body), () => {
      assert.equal(send(body, dental), body);
      assert.equal(send(body, { name: '', phone: '+1' }), body, 'even for a contact with no name');
    });
  }

  test('with merge fields, the rest of the text is still left exactly as written', () => {
    assert.equal(send('Hi  {{name}} ,  two  spaces', dental), 'Hi  Austin City Dental ,  two  spaces');
  });
});

// ---------------------------------------------------------------------------
describe('one contact’s data never reaches another contact’s message', () => {
  test('rendering many contacts in a row never carries a value over', () => {
    const contacts = [
      { name: 'Austin City Dental', phone: '+15120000001', customFields: { city: 'Austin' } },
      { name: '', phone: '+15120000002' },
      { name: 'Round Rock Smiles', phone: '+15120000003' },
      { name: '', phone: '+15120000004', customFields: { city: 'Dallas' } },
    ];
    const body = 'Hi {{first_name}} in {{city}} ({{phone}})';
    const out = contacts.map((c) => send(body, c));
    assert.deepEqual(out, [
      'Hi Austin City Dental in Austin (+15120000001)',
      'Hi in (+15120000002)',
      'Hi Round Rock Smiles in (+15120000003)',
      'Hi in Dallas (+15120000004)',
    ]);
  });

  test('a value that itself looks like a merge field is plain text (no second pass)', () => {
    assert.equal(renderTemplate('Hi {{first_name}}', { first_name: '{{phone}}', phone: 'SECRET' }).rendered, 'Hi {{phone}}');
  });
});

describe('extractMergeFields', () => {
  test('lists every token, as written, once', () => {
    assert.deepEqual(extractMergeFields('Hi {{first_name}}, {{First Name}} {{first_name}} {{city}}'), ['first_name', 'First Name', 'city']);
    assert.deepEqual(extractMergeFields('no fields'), []);
  });
});
