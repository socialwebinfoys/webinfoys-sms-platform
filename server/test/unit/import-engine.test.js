// Phase 10 — Stage 8: the import engine.
//
// Covers the hand-written RFC-4180 CSV parser, XLSX decoding, header mapping,
// and the count-integrity invariant:
//
//   totalRows = valid + duplicatesInFile + duplicatesInDb + invalid
//
// analyseUpload performs exactly one database READ (existing phones), which is
// substituted here; it performs no writes, so no persistence is needed.
'use strict';

require('../_support/env');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { parseCSV, rowsToRecords, mapRecordToContact, parseContactFile } =
  require('../../utils/fileParser');
const Contact = require('../../models/Contact');
const { analyseUpload, buildPreviewPayload, normalizeTags, PREVIEW_VALID_LIMIT } =
  require('../../services/importService');
const { query } = require('../_support/stubs');

// The single read analyseUpload performs: which phones already exist.
let existingPhones = [];
Contact.find = () => query(existingPhones.map((phone) => ({ phone })));
beforeEach(() => {
  existingPhones = [];
});

const csv = (text) => Buffer.from(text, 'utf8');

describe('parseCSV — RFC-4180 behaviour', () => {
  test('simple rows', () => {
    assert.deepEqual(parseCSV('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  });
  test('CRLF line endings', () => {
    assert.deepEqual(parseCSV('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  });
  test('a quoted field containing a comma', () => {
    assert.deepEqual(parseCSV('a,b\n"x,y",2'), [['a', 'b'], ['x,y', '2']]);
  });
  test('a quoted field containing a newline', () => {
    assert.deepEqual(parseCSV('a,b\n"line1\nline2",2'), [['a', 'b'], ['line1\nline2', '2']]);
  });
  test('an escaped double quote ("")', () => {
    assert.deepEqual(parseCSV('a\n"say ""hi"""'), [['a'], ['say "hi"']]);
  });
  test('a UTF-8 BOM is stripped from the first header', () => {
    assert.deepEqual(parseCSV('﻿name,phone\nAda,+1'), [['name', 'phone'], ['Ada', '+1']]);
  });
  test('a file not ending in a newline still yields its last row', () => {
    assert.deepEqual(parseCSV('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  });
  test('empty fields are preserved as empty strings', () => {
    assert.deepEqual(parseCSV('a,b,c\n1,,3'), [['a', 'b', 'c'], ['1', '', '3']]);
  });
  test('an empty input yields no rows', () => {
    assert.deepEqual(parseCSV(''), []);
  });
});

describe('header mapping', () => {
  const aliases = [
    ['phone', 'phone'],
    ['Phone Number', 'phone'],
    ['mobile', 'phone'],
    ['Cell', 'phone'],
    ['tel', 'phone'],
    ['telephone', 'phone'],
    ['number', 'phone'],
  ];
  for (const [header, field] of aliases) {
    test(`"${header}" maps to ${field}`, () => {
      const { records } = rowsToRecords([[header], ['+14155552671']]);
      assert.equal(mapRecordToContact(records[0]).phone, '+14155552671');
    });
  }

  test('name aliases', () => {
    for (const header of ['name', 'Full Name', 'contact name']) {
      const { records } = rowsToRecords([[header], ['Ada']]);
      assert.equal(mapRecordToContact(records[0]).name, 'Ada');
    }
  });

  test('email aliases', () => {
    for (const header of ['email', 'e-mail', 'Email Address']) {
      const { records } = rowsToRecords([[header], ['a@b.co']]);
      assert.equal(mapRecordToContact(records[0]).email, 'a@b.co');
    }
  });

  test('timezone aliases', () => {
    for (const header of ['timezone', 'time zone', 'tz', 'IANA Timezone']) {
      const { records } = rowsToRecords([[header], ['America/Denver']]);
      assert.equal(mapRecordToContact(records[0]).timezone, 'America/Denver');
    }
  });

  test('opt-in evidence aliases', () => {
    const { records } = rowsToRecords([
      ['opt_in_date', 'opt-in-source'],
      ['2026-01-01', 'web form'],
    ]);
    const mapped = mapRecordToContact(records[0]);
    assert.equal(mapped.optInDate, '2026-01-01');
    assert.equal(mapped.optInSource, 'web form');
  });

  test('an unrecognised column becomes a custom field', () => {
    const { records } = rowsToRecords([['phone', 'Favourite Colour'], ['+14155552671', 'blue']]);
    const mapped = mapRecordToContact(records[0]);
    assert.equal(mapped.customFields['Favourite Colour'], 'blue');
  });

  test('a recognised tags column does NOT also become a custom field', () => {
    const { records } = rowsToRecords([['phone', 'tags'], ['+14155552671', 'a,b']]);
    const mapped = mapRecordToContact(records[0]);
    assert.equal(mapped.tags, 'a,b');
    assert.equal('tags' in mapped.customFields, false);
  });

  test('fully blank rows are skipped', () => {
    const { records } = rowsToRecords([['phone'], [''], ['   '], ['+14155552671']]);
    assert.equal(records.length, 1);
  });

  test('row numbers are 1-based against the ORIGINAL file, for error reporting', () => {
    const { records } = rowsToRecords([['phone'], ['+14155552671'], ['+14155552672']]);
    assert.equal(records[0].__row, 2);
    assert.equal(records[1].__row, 3);
  });

  test('a column with no header is ignored', () => {
    const { records } = rowsToRecords([['phone', ''], ['+14155552671', 'orphan']]);
    assert.equal(Object.keys(mapRecordToContact(records[0]).customFields).length, 0);
  });
});

describe('normalizeTags', () => {
  test('splits, trims, lowercases and de-duplicates', () => {
    assert.deepEqual(normalizeTags(' VIP , vip ,New '), ['vip', 'new']);
  });
  test('accepts an array', () => {
    assert.deepEqual(normalizeTags(['A', 'b', 'A']), ['a', 'b']);
  });
  test('empty input yields an empty array', () => {
    assert.deepEqual(normalizeTags(''), []);
    assert.deepEqual(normalizeTags(undefined), []);
    assert.deepEqual(normalizeTags(null), []);
  });
});

describe('analyseUpload — count integrity', () => {
  function assertBalances(summary) {
    assert.equal(
      summary.valid + summary.duplicatesInFile + summary.duplicatesInDb + summary.invalid,
      summary.totalRows,
      `buckets ${JSON.stringify(summary)} do not sum to totalRows`
    );
  }

  test('all-valid file', async () => {
    const { summary, valid } = await analyseUpload(
      csv('name,phone\nAda,4155552671\nGrace,4155552672\n'),
      'a.csv'
    );
    assert.equal(summary.totalRows, 2);
    assert.equal(summary.valid, 2);
    assert.equal(valid.length, 2);
    assertBalances(summary);
  });

  test('a duplicate WITHIN the file is counted once and reported with the first row number', async () => {
    const { summary, invalid } = await analyseUpload(
      csv('name,phone\nAda,4155552671\nAda2,4155552671\n'),
      'a.csv'
    );
    assert.equal(summary.valid, 1);
    assert.equal(summary.duplicatesInFile, 1);
    assert.match(invalid[0].reason, /Duplicate phone within the file \(first seen on row 2\)/);
    assertBalances(summary);
  });

  test('a phone already in the database is counted as duplicatesInDb', async () => {
    existingPhones = ['+14155552671'];
    const { summary, invalid } = await analyseUpload(
      csv('name,phone\nAda,4155552671\nGrace,4155552672\n'),
      'a.csv'
    );
    assert.equal(summary.valid, 1);
    assert.equal(summary.duplicatesInDb, 1);
    assert.match(invalid[0].reason, /already exists in the database/);
    assertBalances(summary);
  });

  test('an invalid phone is counted as invalid, with the row number and reason', async () => {
    const { summary, invalid } = await analyseUpload(
      csv('name,phone\nAda,not-a-phone\nGrace,4155552672\n'),
      'a.csv'
    );
    assert.equal(summary.valid, 1);
    assert.equal(summary.invalid, 1);
    assert.equal(invalid[0].row, 2);
    assert.ok(invalid[0].reason);
    assertBalances(summary);
  });

  test('a missing phone is invalid, not silently dropped', async () => {
    const { summary } = await analyseUpload(csv('name,phone\nAda,\nGrace,4155552672\n'), 'a.csv');
    assert.equal(summary.invalid, 1);
    assertBalances(summary);
  });

  test('every bucket at once still balances', async () => {
    existingPhones = ['+14155552673'];
    const { summary } = await analyseUpload(
      csv(
        [
          'name,phone',
          'Valid,4155552671', // valid
          'Dup,4155552671', // duplicate in file
          'Existing,4155552673', // duplicate in db
          'Bad,xyz', // invalid
          'Empty,', // invalid
        ].join('\n')
      ),
      'a.csv'
    );
    assert.equal(summary.totalRows, 5);
    assert.equal(summary.valid, 1);
    assert.equal(summary.duplicatesInFile, 1);
    assert.equal(summary.duplicatesInDb, 1);
    assert.equal(summary.invalid, 2);
    assertBalances(summary);
  });

  test('a file with headers but no data rows is a 400', async () => {
    await assert.rejects(() => analyseUpload(csv('name,phone\n'), 'a.csv'), (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /no data rows/);
      return true;
    });
  });

  test('an unsupported extension is a 400', async () => {
    await assert.rejects(() => parseContactFile(csv('a'), 'notes.txt'), (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    });
  });

  test('an unparseable timezone is a WARNING, not a rejected contact', async () => {
    const { summary, valid, warnings } = await analyseUpload(
      csv('name,phone,timezone\nAda,4155552671,Mars/Olympus\n'),
      'a.csv'
    );
    assert.equal(summary.valid, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].reason, /Unknown timezone/);
    // Falls back to the area-code guess rather than storing a bad zone.
    assert.notEqual(valid[0].timezone, 'Mars/Olympus');
  });

  test('a valid timezone column wins over the area-code guess', async () => {
    const { valid } = await analyseUpload(
      csv('name,phone,timezone\nAda,4155552671,Asia/Tokyo\n'),
      'a.csv'
    );
    assert.equal(valid[0].timezone, 'Asia/Tokyo');
  });

  test('a US area code auto-fills the timezone when no column is supplied', async () => {
    const { valid } = await analyseUpload(csv('name,phone\nAda,4155552671\n'), 'a.csv');
    assert.equal(valid[0].timezone, 'America/Los_Angeles');
  });

  test('an unreadable opt_in_date is a warning, not a rejection', async () => {
    const { summary, warnings, valid } = await analyseUpload(
      csv('name,phone,opt_in_date\nAda,4155552671,not-a-date\n'),
      'a.csv'
    );
    assert.equal(summary.valid, 1);
    assert.match(warnings[0].reason, /Unreadable opt_in_date/);
    assert.equal(valid[0].optedInAt, null);
  });

  test('phones are normalised to E.164 before the duplicate check, so formats collapse', async () => {
    const { summary } = await analyseUpload(
      csv('name,phone\nA,4155552671\nB,(415) 555-2671\nC,+14155552671\n'),
      'a.csv'
    );
    assert.equal(summary.valid, 1);
    assert.equal(summary.duplicatesInFile, 2);
    assertBalances(summary);
  });

  test('analyseUpload writes nothing (no create/insertMany/save is reachable)', async () => {
    // Contact.find is the only model call it may make. If it attempted a write
    // the harness would surface it, because bufferCommands is off and no
    // connection exists.
    const originalCreate = Contact.create;
    const originalInsert = Contact.insertMany;
    let wrote = false;
    Contact.create = () => {
      wrote = true;
      throw new Error('write attempted');
    };
    Contact.insertMany = () => {
      wrote = true;
      throw new Error('write attempted');
    };
    try {
      await analyseUpload(csv('name,phone\nAda,4155552671\n'), 'a.csv');
      assert.equal(wrote, false, 'preview must not write');
    } finally {
      Contact.create = originalCreate;
      Contact.insertMany = originalInsert;
    }
  });
});

describe('buildPreviewPayload', () => {
  test('states countsBalance explicitly', async () => {
    const analysis = await analyseUpload(csv('name,phone\nAda,4155552671\n'), 'a.csv');
    const payload = buildPreviewPayload(analysis);
    assert.equal(payload.summary.countsBalance, true);
  });

  test(`the valid sample is capped at ${PREVIEW_VALID_LIMIT} rows and flagged when truncated`, async () => {
    const rows = ['name,phone'];
    for (let i = 0; i < PREVIEW_VALID_LIMIT + 25; i += 1) {
      // 415 555 xxxx range, kept structurally valid.
      rows.push(`P${i},415555${String(1000 + i).padStart(4, '0')}`);
    }
    const analysis = await analyseUpload(csv(rows.join('\n')), 'big.csv');
    const payload = buildPreviewPayload(analysis);
    assert.equal(analysis.summary.valid, PREVIEW_VALID_LIMIT + 25);
    assert.equal(payload.validSample.length, PREVIEW_VALID_LIMIT);
    assert.equal(payload.validSampleTruncated, true);
  });

  test('ALL invalid rows are returned, never truncated — the operator must act on them', async () => {
    const rows = ['name,phone'];
    for (let i = 0; i < 250; i += 1) rows.push(`P${i},bad-${i}`);
    const analysis = await analyseUpload(csv(rows.join('\n')), 'bad.csv');
    const payload = buildPreviewPayload(analysis);
    assert.equal(payload.invalid.length, 250);
  });

  test('the preview never echoes the uploaded bytes back', async () => {
    const analysis = await analyseUpload(csv('name,phone\nAda,4155552671\n'), 'a.csv');
    const payload = buildPreviewPayload(analysis);
    assert.equal('fileBuffer' in payload, false);
    assert.equal(JSON.stringify(payload).includes('fileBuffer'), false);
  });
});

describe('XLSX parsing goes through the same validation path', () => {
  async function xlsxBuffer(rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contacts');
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  test('a valid xlsx imports like the equivalent csv', async () => {
    const buf = await xlsxBuffer([
      ['name', 'phone'],
      ['Ada', '4155552671'],
      ['Grace', '4155552672'],
    ]);
    const { summary } = await analyseUpload(buf, 'contacts.xlsx');
    assert.equal(summary.totalRows, 2);
    assert.equal(summary.valid, 2);
  });

  test('xlsx duplicate and invalid rows land in the same buckets', async () => {
    existingPhones = ['+14155552673'];
    const buf = await xlsxBuffer([
      ['name', 'phone'],
      ['A', '4155552671'],
      ['B', '4155552671'],
      ['C', '4155552673'],
      ['D', 'nope'],
    ]);
    const { summary } = await analyseUpload(buf, 'contacts.xlsx');
    assert.equal(summary.valid, 1);
    assert.equal(summary.duplicatesInFile, 1);
    assert.equal(summary.duplicatesInDb, 1);
    assert.equal(summary.invalid, 1);
    assert.equal(
      summary.valid + summary.duplicatesInFile + summary.duplicatesInDb + summary.invalid,
      summary.totalRows
    );
  });

  test('a numeric phone cell is coerced to a string, not mangled', async () => {
    const buf = await xlsxBuffer([
      ['name', 'phone'],
      ['Ada', 4155552671],
    ]);
    const { summary, valid } = await analyseUpload(buf, 'contacts.xlsx');
    assert.equal(summary.valid, 1);
    assert.equal(valid[0].phone, '+14155552671');
  });

  test('an xlsx with no data rows is a 400', async () => {
    const buf = await xlsxBuffer([['name', 'phone']]);
    await assert.rejects(() => analyseUpload(buf, 'empty.xlsx'), (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    });
  });
});

describe('fuzzing: malformed CSV never throws an unhandled error', () => {
  const nasty = [
    'name,phone\n"unterminated,4155552671',
    'name,phone\n,,,,,\n',
    'name,phone\n\n\n\n',
    'phone\n+1\n+12\n+123',
    'name,phone\nAda,=1+1\n',
    'name,phone\nAda,"4155552671"\n',
    'name,phone\n' + 'x'.repeat(5000) + ',4155552671\n',
    'name,phone\nAda,+1-415-555-2671\n',
    'name,phone\n"Ada ""The First""",4155552671\n',
    'name,phone\n\u0000Ada,4155552671\n',
    'phone,phone\n4155552671,4155552672\n',
    'name,phone\nAda,4155552671,extra,columns\n',
  ];
  for (const [i, text] of nasty.entries()) {
    test(`fuzz case ${i} is handled without throwing`, async () => {
      try {
        const { summary } = await analyseUpload(csv(text), 'fuzz.csv');
        assert.equal(
          summary.valid + summary.duplicatesInFile + summary.duplicatesInDb + summary.invalid,
          summary.totalRows,
          'buckets must still balance for malformed input'
        );
      } catch (err) {
        // Only the documented "no data rows" 400 is an acceptable rejection.
        assert.equal(err.statusCode, 400, `unexpected error: ${err.stack}`);
      }
    });
  }
});
