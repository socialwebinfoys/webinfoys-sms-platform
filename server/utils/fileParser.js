// Parses uploaded contact files (CSV / XLSX) into plain row objects.
//
// The CSV parser is written from scratch (RFC-4180 style: quoted fields,
// embedded commas/newlines, and "" escaping). XLSX is a zipped-XML binary
// format, so it is decoded with the exceljs library; the row-to-contact mapping
// and validation below are our own.
const ExcelJS = require('exceljs');

// --- CSV --------------------------------------------------------------------

// Turn CSV text into an array of arrays (rows of string cells).
function parseCSV(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;

  // Strip a leading UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (c === '\r') {
      i += 1; // handled by the \n branch
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }

  // Flush the final field/row (file may not end with a newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// --- XLSX -------------------------------------------------------------------

// Read the first worksheet of an .xlsx buffer into an array of arrays.
async function parseXLSXBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    // row.values is 1-indexed (index 0 is unused).
    const cells = row.values.slice(1).map((v) => {
      if (v === null || v === undefined) return '';
      // Cells can be rich objects (hyperlinks, rich text, formula results).
      if (typeof v === 'object') {
        if (v.text !== undefined) return String(v.text);
        if (v.result !== undefined) return String(v.result);
        if (v.hyperlink !== undefined) return String(v.hyperlink);
        return '';
      }
      return String(v);
    });
    rows.push(cells);
  });

  return rows;
}

// --- Rows -> records --------------------------------------------------------

// Convert array-of-arrays (first row = header) into array of objects keyed by
// the trimmed header names. Fully empty rows are skipped.
function rowsToRecords(rows) {
  if (!rows || rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map((h) => String(h || '').trim());
  const records = [];

  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const isEmpty = cells.every((c) => String(c || '').trim() === '');
    if (isEmpty) continue;

    const record = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      record[header] = cells[idx] !== undefined ? String(cells[idx]).trim() : '';
    });
    record.__row = r + 1; // 1-based row number in the original file (for reporting)
    records.push(record);
  }

  return { headers, records };
}

// Entry point: detect format by extension and return { headers, records }.
async function parseContactFile(buffer, originalName) {
  const name = String(originalName || '').toLowerCase();

  if (name.endsWith('.csv')) {
    const rows = parseCSV(buffer.toString('utf8'));
    return rowsToRecords(rows);
  }

  if (name.endsWith('.xlsx')) {
    const rows = await parseXLSXBuffer(buffer);
    return rowsToRecords(rows);
  }

  throw Object.assign(new Error('Unsupported file type. Upload a .csv or .xlsx file.'), {
    statusCode: 400,
  });
}

// Map a raw record's headers to known contact fields; unknown columns become
// custom fields. Header matching is case-insensitive with common aliases.
function mapRecordToContact(record) {
  const nameRe = /^(name|full ?name|contact ?name)$/i;
  const phoneRe = /^(phone|phone ?number|mobile|mobile ?number|cell|number|tel|telephone)$/i;
  const emailRe = /^(e-?mail|email ?address)$/i;
  const tagsRe = /^tags?$/i;
  // Phase 6 optional columns. `timezone` feeds the existing Contact.timezone
  // (Phase 2 sending windows); the opt-in pair is consent evidence for 10DLC /
  // TCPA disputes and maps onto the existing optedInAt + optInSource fields.
  const timezoneRe = /^(time ?zone|tz|iana ?timezone)$/i;
  const optInDateRe = /^(opt[_ -]?in[_ -]?date|consent ?date|opted[_ -]?in[_ -]?at)$/i;
  const optInSourceRe = /^(opt[_ -]?in[_ -]?source|consent ?source)$/i;

  const contact = { name: '', phone: '', email: '', customFields: {} };

  Object.keys(record).forEach((key) => {
    if (key === '__row') return;
    const value = record[key];
    if (nameRe.test(key)) contact.name = value;
    else if (phoneRe.test(key)) contact.phone = value;
    else if (emailRe.test(key)) contact.email = value;
    // A recognized "tags" column is handled as the tags array by the import
    // controller, so keep it out of customFields to avoid duplicating it.
    else if (tagsRe.test(key)) contact.tags = value;
    else if (timezoneRe.test(key)) contact.timezone = value;
    else if (optInDateRe.test(key)) contact.optInDate = value;
    else if (optInSourceRe.test(key)) contact.optInSource = value;
    else if (value !== '') contact.customFields[key] = value;
  });

  contact.__row = record.__row;
  return contact;
}

module.exports = {
  parseCSV,
  parseXLSXBuffer,
  rowsToRecords,
  parseContactFile,
  mapRecordToContact,
};
