// Contact-import engine (Phase 6).
//
// ONE validation path, used by all three entry points:
//   POST /api/contacts/import/preview   -> analyseUpload()                (no writes)
//   POST /api/contacts/import/confirm   -> analyseUpload() + commitImport()
//   POST /api/contacts/import           -> analyseUpload() + commitImport()  (legacy)
//
// Keeping preview and confirm on the same function is what makes "confirm
// imports exactly what you previewed" true by construction rather than by two
// code paths agreeing with each other.
//
// COUNT INTEGRITY
// Every data row lands in exactly one bucket, and the buckets always sum to the
// row total:
//
//   totalRows = created + duplicatesInFile + duplicatesInDb + invalid
//
// at preview time `created` is the projected `valid` count. At confirm time a
// row that passed validation but was then rejected by Mongoose (e.g. a
// malformed email) moves from `created` to `invalid` and is reported with its
// row number — it is never allowed to vanish from the totals.
const Contact = require('../models/Contact');
const { normalizePhone } = require('../utils/phoneFormatter');
const { parseContactFile, mapRecordToContact } = require('../utils/fileParser');
const { timezoneForPhone } = require('../utils/areaCodeTimezone');

// How many valid rows the preview shows. The rest are imported but not listed.
const PREVIEW_VALID_LIMIT = 200;

// Normalize incoming tags into a clean, lowercased, de-duplicated array.
function normalizeTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(',');
  return [...new Set(arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
}

// Validate an optional IANA timezone from the import file. An unusable value is
// dropped (with a warning on the row) rather than failing the whole contact —
// timezone is an optimisation, not identity.
function parseTimezone(value) {
  const s = String(value || '').trim();
  if (!s) return { value: '' };
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
  } catch (e) {
    return { value: '', warning: `Unknown timezone "${s}" — ignored` };
  }
  return { value: s };
}

// Optional opt-in date. Same tolerance: unparseable means "no evidence
// recorded", not "reject the contact".
function parseOptInDate(value) {
  const s = String(value || '').trim();
  if (!s) return { value: null };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    return { value: null, warning: `Unreadable opt_in_date "${s}" — ignored` };
  }
  return { value: d };
}

// Parse + validate an uploaded file WITHOUT touching the database for writes.
// The only query it runs is a read to find phones that already exist.
//
// Returns { summary, valid, invalid } where
//   valid   — rows that would be inserted, in file order
//   invalid — every rejected row with its row number and reason
async function analyseUpload(buffer, originalName) {
  const { headers, records } = await parseContactFile(buffer, originalName);

  if (records.length === 0) {
    const err = new Error('File contains no data rows');
    err.statusCode = 400;
    throw err;
  }

  const summary = {
    totalRows: records.length,
    valid: 0,
    duplicatesInFile: 0,
    duplicatesInDb: 0,
    invalid: 0,
  };
  const invalid = [];
  const warnings = [];

  // --- pass 1: per-row validation + de-duplicate within the file -----------
  const seenInFile = new Map(); // e164 -> first row number that used it
  const candidates = [];

  for (const record of records) {
    const mapped = mapRecordToContact(record);
    const normalized = normalizePhone(mapped.phone);

    if (!normalized.valid) {
      summary.invalid += 1;
      invalid.push({
        row: mapped.__row,
        phone: mapped.phone || '',
        name: mapped.name || '',
        reason: normalized.error,
      });
      continue;
    }

    if (seenInFile.has(normalized.e164)) {
      summary.duplicatesInFile += 1;
      invalid.push({
        row: mapped.__row,
        phone: normalized.e164,
        name: mapped.name || '',
        reason: `Duplicate phone within the file (first seen on row ${seenInFile.get(normalized.e164)})`,
      });
      continue;
    }
    seenInFile.set(normalized.e164, mapped.__row);

    const tz = parseTimezone(mapped.timezone);
    const optIn = parseOptInDate(mapped.optInDate);
    if (tz.warning) warnings.push({ row: mapped.__row, reason: tz.warning });
    if (optIn.warning) warnings.push({ row: mapped.__row, reason: optIn.warning });

    candidates.push({
      row: mapped.__row,
      name: mapped.name,
      phone: normalized.e164,
      email: mapped.email,
      customFields: mapped.customFields,
      tags: normalizeTags(mapped.tags),
      // An explicit timezone column wins; otherwise fall back to the US area
      // code guess (Phase 2) so automation can respect local hours.
      timezone: tz.value || timezoneForPhone(normalized.e164),
      optedInAt: optIn.value,
      optInSource: String(mapped.optInSource || '').trim(),
    });
  }

  // --- pass 2: drop phones that already exist (single indexed read) --------
  const valid = [];
  if (candidates.length > 0) {
    const existing = await Contact.find({ phone: { $in: candidates.map((c) => c.phone) } })
      .select('phone')
      .lean();
    const existingSet = new Set(existing.map((e) => e.phone));

    for (const c of candidates) {
      if (existingSet.has(c.phone)) {
        summary.duplicatesInDb += 1;
        invalid.push({
          row: c.row,
          phone: c.phone,
          name: c.name,
          reason: 'Phone already exists in the database',
        });
        continue;
      }
      valid.push(c);
    }
  }

  summary.valid = valid.length;

  return { headers, summary, valid, invalid, warnings };
}

// Build the preview payload the API returns. Caps the valid list so a 50k-row
// file does not produce a 50k-row HTTP response.
function buildPreviewPayload({ headers, summary, valid, invalid, warnings }) {
  return {
    headers,
    summary: {
      ...summary,
      // Stated explicitly so a reader never has to work out whether the buckets
      // are meant to add up.
      countsBalance:
        summary.valid + summary.duplicatesInFile + summary.duplicatesInDb + summary.invalid ===
        summary.totalRows,
    },
    validSample: valid.slice(0, PREVIEW_VALID_LIMIT).map((c) => ({
      row: c.row,
      name: c.name,
      phone: c.phone,
      email: c.email,
      tags: c.tags,
      timezone: c.timezone,
    })),
    validSampleTruncated: valid.length > PREVIEW_VALID_LIMIT,
    // Every rejected row is returned — these are the ones an operator must act
    // on, so they are never truncated.
    invalid,
    warnings,
  };
}

// Insert the valid rows and return the final counts.
//
// `ordered: false` so one row rejected by Mongoose validation cannot abort the
// batch. Any such row is moved from `created` to `invalid` WITH its row number,
// recovered from the write error's index — the previous implementation reported
// `row: null` here, which made those failures untraceable.
async function commitImport({ valid, summary, importDoc, userId }) {
  const result = { createdIds: [] };
  const failures = [];
  let created = 0;

  if (valid.length > 0) {
    const toInsert = valid.map((c) => ({
      name: c.name,
      phone: c.phone,
      email: c.email,
      customFields: c.customFields,
      tags: c.tags,
      timezone: c.timezone,
      // Consent evidence (Phase 6). Only ever set on a NEW contact, so it can
      // never resurrect someone who had opted out.
      ...(c.optedInAt ? { optedInAt: c.optedInAt } : {}),
      ...(c.optInSource ? { optInSource: c.optInSource } : {}),
      import: importDoc ? importDoc._id : undefined,
      createdBy: userId,
    }));

    // `rawResult: true` is what makes Phase 6D's "nothing silently disappears"
    // guarantee possible. With `ordered: false` alone, Mongoose DROPS documents
    // that fail schema validation and resolves successfully — the caller is
    // never told, and those rows vanish from every count. rawResult returns
    // `mongoose.results`, an array positionally aligned with the input where
    // each entry is either the saved document or the Error that rejected it,
    // which is exactly what lets the row number be recovered.
    const record = (idx, raw) => {
      const source = valid[idx] || null;
      failures.push({
        row: source ? source.row : null,
        phone: source ? source.phone : '',
        name: source ? source.name : '',
        // Mongoose validation messages name the field and the rule; they never
        // contain credentials.
        reason: `Rejected on insert: ${raw}`,
      });
    };

    try {
      const res = await Contact.insertMany(toInsert, { ordered: false, rawResult: true });
      const results = (res && res.mongoose && res.mongoose.results) || null;

      if (Array.isArray(results)) {
        results.forEach((entry, idx) => {
          if (entry && entry._id) {
            created += 1;
            result.createdIds.push(entry._id);
          } else if (entry instanceof Error) {
            record(idx, entry.message || 'validation failed');
          }
        });
      } else {
        // Older driver shape: fall back to the acknowledged count.
        created = (res && res.insertedCount) || 0;
      }
    } catch (bulkErr) {
      // A MongoDB write error (e.g. a duplicate key from a concurrent import)
      // still throws. Partial success is reported the same way.
      const insertedDocs = bulkErr.insertedDocs || [];
      created = insertedDocs.length;
      result.createdIds = insertedDocs.map((d) => d._id);

      const errors = bulkErr.writeErrors || bulkErr.errors || [];
      const list = Array.isArray(errors) ? errors : Object.values(errors);
      for (const we of list) {
        const idx = typeof we.index === 'number' ? we.index : -1;
        const raw = (we.err && (we.err.errmsg || we.err.message)) || we.errmsg || we.message || 'Insert failed';
        record(idx, raw);
      }
      // Validation errors can ride along on a thrown result too.
      const vErrors = (bulkErr.mongoose && bulkErr.mongoose.validationErrors) || [];
      vErrors.forEach((e) => record(typeof e.index === 'number' ? e.index : -1, e.message || 'validation failed'));
    }
  }

  return { created, failures, createdIds: result.createdIds || [] };
}

module.exports = {
  analyseUpload,
  buildPreviewPayload,
  commitImport,
  normalizeTags,
  PREVIEW_VALID_LIMIT,
};
