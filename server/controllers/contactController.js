// Contact management logic: CRUD, paginated/filtered listing, and file import.
const Contact = require('../models/Contact');
const Import = require('../models/Import');
const Settings = require('../models/Settings');
const Enrollment = require('../models/Enrollment');
const Conversation = require('../models/Conversation');
const { normalizePhone } = require('../utils/phoneFormatter');
const Campaign = require('../models/Campaign');
const ImportPreview = require('../models/ImportPreview');
const { parseContactFile, mapRecordToContact } = require('../utils/fileParser');
const { analyseUpload, buildPreviewPayload, commitImport } = require('../services/importService');
const { enrollContactIds } = require('./enrollmentController');
const lookupService = require('../services/lookupService');
const { applyOptOut, applyOptIn } = require('../utils/optOut');
const { logEvent } = require('../services/logService');
const { timezoneForPhone } = require('../utils/areaCodeTimezone');
const { queryString, pickSort } = require('../utils/queryGuards');
const contactLookup = require('../services/contactLookup');
const importAllocation = require('../services/importAllocation');

const MAX_LIMIT = 100;
// Phase 0: only these fields may be sorted on. `name` and `phone` are indexed or
// cheap; anything else (including unindexed fields) is refused.
const CONTACT_SORT_FIELDS = ['createdAt', 'name', 'phone'];

// Phase 2: validate an optional IANA timezone. '' clears it.
// Returns { value } or { error }.
function normalizeTimezone(tz) {
  if (tz === undefined || tz === null) return { value: undefined };
  const s = String(tz).trim();
  if (s === '') return { value: '' };
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
  } catch (e) {
    return { error: `Invalid timezone: ${s}` };
  }
  return { value: s };
}

// Escape a user-supplied string for safe use inside a RegExp.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Normalize incoming tags into a clean, lowercased, de-duplicated array.
function normalizeTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(',');
  return [...new Set(arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
}

class FilterError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The contact filter for a set of query parameters. ONE builder for the list,
// the lookup counts, Select All and bulk delete, so "the contacts matching the
// current filters" means exactly the same thing everywhere.
// Returns { filter, batchView }; throws FilterError for a bad parameter.
async function buildContactFilter(query = {}, { ignoreLookup = false } = {}) {
  {
    const filter = {};

    // Phase 0: every user-supplied value is reduced to a plain string first, so
    // a repeated (`?search=a&search=b`) or object-shaped parameter can neither
    // crash the handler nor reach the Mongo filter as an operator.
    const search = queryString(query.search);
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ name: re }, { phone: re }, { email: re }];
    }

    const tag = queryString(query.tag);
    if (tag) {
      filter.tags = tag.toLowerCase();
    }

    // Scope to a specific CSV/import (used by the Following contact picker).
    // Coerced to a string so a query-operator object cannot be injected.
    const importId = queryString(query.import);
    if (importId) {
      filter.import = importId;
    }

    // Batch view within one imported list (batch allocation):
    //   batch=current    -> the contacts of the list's LATEST allocated batch
    //   batch=remaining  -> contacts never allocated from this list
    //   batch=<batchId>  -> the contacts of one specific batch
    // Membership is read from each contact's persisted `importBatch` marker,
    // never inferred from positions. Absent = every contact (unchanged).
    let batchView = null;
    const batch = queryString(query.batch);
    if (batch) {
      if (!importId) {
        throw new FilterError(400, 'batch can only be used together with import');
      }
      const imp = await Import.findById(importId);
      if (!imp) {
        throw new FilterError(404, 'Import not found');
      }
      // Numbered over the full history, exactly as the allocation API does.
      const all = (imp.allocation && imp.allocation.batches) || [];
      const batches = all.filter((b) => b.status === 'complete');
      if (batch === 'remaining') {
        // The allocation pool exactly: never allocated, and not a number
        // Twilio Lookup reported invalid (those are excluded from batches).
        filter.importBatch = null;
        filter['lookup.status'] = { $ne: 'invalid' };
        batchView = { view: 'remaining', batch: null };
      } else {
        const chosen =
          batch === 'current'
            ? batches[batches.length - 1]
            : batches.find((b) => String(b._id) === batch);
        if (!chosen && batch !== 'current') {
          const gone = all.find((b) => String(b._id) === batch && b.status === 'deleted');
          throw new FilterError(
            400,
            gone ? `Batch ${all.indexOf(gone) + 1} has been deleted` : 'That batch does not belong to this list'
          );
        }
        // No batch allocated yet: "current batch" is genuinely empty.
        filter.importBatch = chosen ? chosen._id : { $in: [] };
        batchView = {
          view: batch === 'current' ? 'current' : 'batch',
          batch: chosen
            ? { _id: chosen._id, number: all.indexOf(chosen) + 1, size: chosen.size }
            : null,
        };
      }
    }

    if (query.isActive === 'true' || query.isActive === 'false') {
      filter.isActive = query.isActive === 'true';
    }

    // Opt-out filter (Phase 1). "false" uses $ne:true so contacts created
    // before the field existed still count as not opted out.
    if (query.optedOut === 'true') {
      filter.optedOut = true;
    } else if (query.optedOut === 'false') {
      filter.optedOut = { $ne: true };
    }

    // Delivery-block filter (Phase 3), same legacy-safe pattern.
    if (query.deliveryBlocked === 'true') {
      filter.deliveryBlocked = true;
    } else if (query.deliveryBlocked === 'false') {
      filter.deliveryBlocked = { $ne: true };
    }

    // Lookup-status filter: the Twilio Lookup result, which is a separate
    // concept from delivery state and from the sending policy.
    const lookup = queryString(query.lookup);
    if (lookup && !ignoreLookup) {
      if (!contactLookup.LOOKUP_FILTERS.includes(lookup)) {
        throw new FilterError(
          400,
          `Invalid lookup filter "${lookup}". Allowed: ${contactLookup.LOOKUP_FILTERS.join(', ')}`
        );
      }
      return { filter: contactLookup.withLookup(filter, lookup), batchView };
    }
    return { filter, batchView };
  }
}

// GET /api/contacts
// Query params: search, tag, import, batch, lookup, optedOut, deliveryBlocked,
// page, limit, sort (e.g. "-createdAt").
async function listContacts(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;

    let filter;
    let batchView;
    try {
      ({ filter, batchView } = await buildContactFilter(req.query));
    } catch (err) {
      if (err instanceof FilterError) {
        return res.status(err.status).json({ success: false, message: err.message });
      }
      throw err;
    }

    // Phase 0: reject an unknown sort field outright rather than silently using
    // the default, so a mistyped parameter is visible to the caller.
    const { sort, invalid } = pickSort(req.query.sort, CONTACT_SORT_FIELDS);
    if (invalid) {
      return res.status(400).json({
        success: false,
        message: `Invalid sort "${invalid}". Allowed fields: ${CONTACT_SORT_FIELDS.join(', ')} (prefix with "-" for descending).`,
      });
    }

    const [items, total] = await Promise.all([
      Contact.find(filter).sort(sort).skip(skip).limit(limit),
      Contact.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0,
      },
      ...(batchView ? { batchView } : {}),
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/contacts/:id
async function getContact(req, res, next) {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }
    return res.json({ success: true, data: contact });
  } catch (err) {
    return next(err);
  }
}

// POST /api/contacts
async function createContact(req, res, next) {
  try {
    const { name, phone, email, customFields, tags, timezone } = req.body || {};

    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone is required' });
    }

    const normalized = normalizePhone(phone);
    if (!normalized.valid) {
      return res.status(400).json({ success: false, message: normalized.error });
    }

    const tz = normalizeTimezone(timezone);
    if (tz.error) {
      return res.status(400).json({ success: false, message: tz.error });
    }

    const existing = await Contact.findOne({ phone: normalized.e164 });
    if (existing) {
      return res
        .status(409)
        .json({ success: false, message: 'A contact with that phone number already exists' });
    }

    const contact = await Contact.create({
      name: name || '',
      phone: normalized.e164,
      email: email || '',
      customFields: customFields || {},
      tags: normalizeTags(tags),
      // Fall back to the area-code guess so automation can use local hours.
      timezone: tz.value || timezoneForPhone(normalized.e164),
      createdBy: req.user ? req.user._id : undefined,
    });

    return res.status(201).json({ success: true, data: contact });
  } catch (err) {
    return next(err);
  }
}

// PUT /api/contacts/:id
async function updateContact(req, res, next) {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }

    const { name, phone, email, customFields, tags, isActive, timezone } = req.body || {};

    if (timezone !== undefined) {
      const tz = normalizeTimezone(timezone);
      if (tz.error) {
        return res.status(400).json({ success: false, message: tz.error });
      }
      contact.timezone = tz.value;
    }

    if (phone !== undefined) {
      const normalized = normalizePhone(phone);
      if (!normalized.valid) {
        return res.status(400).json({ success: false, message: normalized.error });
      }
      // Guard against colliding with a different contact.
      const clash = await Contact.findOne({ phone: normalized.e164, _id: { $ne: contact._id } });
      if (clash) {
        return res
          .status(409)
          .json({ success: false, message: 'Another contact already uses that phone number' });
      }
      // The same number typed in another format normalizes to the stored value
      // and changes nothing. A genuinely different number invalidates the
      // cached Lookup result, which described the old one.
      if (normalized.e164 !== contact.phone) {
        contact.phone = normalized.e164;
        contactLookup.resetLookup(contact);
      }
    }

    if (name !== undefined) contact.name = name;
    if (email !== undefined) contact.email = email;
    if (customFields !== undefined) contact.customFields = customFields;
    if (tags !== undefined) contact.tags = normalizeTags(tags);
    if (isActive !== undefined) contact.isActive = !!isActive;

    await contact.save();

    // Phase 4: keep the conversation's denormalized copy in step, so inbox
    // search keeps finding this contact after a rename or number change.
    if (name !== undefined || phone !== undefined) {
      await Conversation.updateOne(
        { contact: contact._id },
        { $set: { contactName: contact.name || '', contactPhone: contact.phone || '' } }
      );
    }

    return res.json({ success: true, data: contact });
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/contacts/:id
// Deletes the contact and cascades to its enrollments (so no orphaned enrollment
// or future automation run references a deleted contact). Message history and
// the conversation are intentionally preserved.
async function deleteContact(req, res, next) {
  try {
    const contact = await Contact.findByIdAndDelete(req.params.id);
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }
    const enr = await Enrollment.deleteMany({ contact: contact._id });
    // Keep its list's Total / Remaining in line with the contacts that exist.
    if (contact.import) await reconcileLists([contact.import]);
    return res.json({ success: true, message: 'Contact deleted', deletedEnrollments: enr.deletedCount });
  } catch (err) {
    return next(err);
  }
}

// DELETE /api/contacts   (delete ALL contacts)
// Removes every contact and cascades to ALL enrollments (each references a
// contact that is being deleted). Campaigns, conversations, and SMS message
// history are preserved. Uses deleteMany — efficient for large datasets.
async function deleteAllContacts(req, res, next) {
  try {
    const c = await Contact.deleteMany({});
    const e = await Enrollment.deleteMany({});
    const lists = await Import.find({ 'allocation.initializedAt': { $ne: null } }).select('_id').lean();
    await reconcileLists((lists || []).map((i) => i._id));
    return res.json({ success: true, deletedCount: c.deletedCount, deletedEnrollments: e.deletedCount });
  } catch (err) {
    return next(err);
  }
}

// --- Phase 6: contact import (preview -> confirm) ---------------------------
//
// Three entry points, ONE validation path (services/importService.js):
//   POST /api/contacts/import/preview   parse + validate + report, NO writes
//   POST /api/contacts/import/confirm   re-parse the stored upload, then insert
//   POST /api/contacts/import           legacy one-shot (analyse + commit)
//
// The confirm step deliberately re-reads the ORIGINAL FILE from the stored
// preview and re-runs the same analysis. Rows sent by the client are never
// trusted — a browser could otherwise post back edited rows and have them
// imported as though they had been previewed.

// Create the Import batch record that contacts are linked to.
async function createImportRecord({ filename, totalRows, userId }) {
  return Import.create({
    filename: filename || '',
    totalRows,
    createdBy: userId,
  });
}

// Fold the commit failures into the summary so the buckets still balance.
function finaliseCounts(summary, created, failures) {
  const final = {
    totalRows: summary.totalRows,
    created,
    duplicatesInFile: summary.duplicatesInFile,
    duplicatesInDb: summary.duplicatesInDb,
    // Rows that failed validation at parse time PLUS rows the database rejected
    // on insert. A row rejected by Mongoose moves from `created` to `invalid`
    // here rather than disappearing.
    invalid: summary.invalid + failures.length,
  };
  final.countsBalance =
    final.created + final.duplicatesInFile + final.duplicatesInDb + final.invalid ===
    final.totalRows;
  return final;
}

// POST /api/contacts/import/preview   (multipart: field "file")
// Parses and validates the upload and returns what WOULD happen. Writes no
// contacts, no enrollments, and no completed Import record — the only thing
// persisted is the short-lived ImportPreview holding the uploaded bytes.
async function previewImport(req, res, next) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: 'No file uploaded (use form field "file")' });
    }
    if (req.file.size > ImportPreview.MAX_PREVIEW_BYTES) {
      return res.status(400).json({ success: false, message: 'File is too large to preview' });
    }

    const analysis = await analyseUpload(req.file.buffer, req.file.originalname);
    const payload = buildPreviewPayload(analysis);

    // Store the ORIGINAL bytes so confirm reproduces this exact result.
    const preview = await ImportPreview.create({
      token: ImportPreview.newToken(),
      filename: req.file.originalname || '',
      fileBuffer: req.file.buffer,
      fileSize: req.file.size,
      summary: payload.summary,
      createdBy: req.user._id,
      expiresAt: new Date(Date.now() + ImportPreview.PREVIEW_TTL_MS),
    });

    return res.json({
      success: true,
      previewToken: preview.token,
      expiresAt: preview.expiresAt,
      filename: preview.filename,
      ...payload,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

// POST /api/contacts/import/confirm   { previewToken, enrollCampaignId? }
// Commits a previously previewed upload.
async function confirmImport(req, res, next) {
  try {
    const { previewToken, enrollCampaignId } = req.body || {};
    const token = queryString(previewToken);
    if (!token) {
      return res.status(400).json({ success: false, message: 'previewToken is required' });
    }

    const preview = await ImportPreview.findOne({ token });
    if (!preview) {
      // Covers both "never existed" and "TTL already removed it".
      return res.status(404).json({
        success: false,
        message: 'This preview has expired or does not exist. Upload the file again.',
      });
    }
    // Defence in depth: the TTL monitor runs about once a minute, so a document
    // can outlive its expiry briefly. Never act on one that has.
    if (preview.expiresAt && preview.expiresAt.getTime() <= Date.now()) {
      return res
        .status(410)
        .json({ success: false, message: 'This preview has expired. Upload the file again.' });
    }
    // The upload belongs to the operator who made it.
    if (String(preview.createdBy) !== String(req.user._id)) {
      return res
        .status(403)
        .json({ success: false, message: 'This preview belongs to a different user' });
    }
    // One token imports one file, once.
    if (preview.consumedAt) {
      return res
        .status(409)
        .json({ success: false, message: 'This preview has already been imported' });
    }

    // Validate the campaign BEFORE importing, so a bad id does not leave
    // contacts imported with no enrollment and no clear error.
    let campaign = null;
    const campaignId = queryString(enrollCampaignId);
    if (campaignId) {
      campaign = await Campaign.findById(campaignId).catch(() => null);
      if (!campaign) {
        return res
          .status(400)
          .json({ success: false, message: 'Selected campaign for enrollment was not found' });
      }
      if (!campaign.steps || campaign.steps.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Cannot enroll into a campaign with no steps',
        });
      }
      // A campaign bound to one batch takes only that batch's contacts — never a
      // freshly imported file's.
      if (campaign.batch) {
        return res.status(400).json({
          success: false,
          message: 'That campaign is limited to one batch of its own list, so newly imported contacts cannot be enrolled into it.',
        });
      }
    }

    // Re-parse and re-validate the STORED file. Nothing from the request body
    // influences which rows are imported.
    const analysis = await analyseUpload(preview.fileBuffer, preview.filename);

    const importDoc = await createImportRecord({
      filename: preview.filename,
      totalRows: analysis.summary.totalRows,
      userId: req.user._id,
    });

    const { created, failures, createdIds } = await commitImport({
      valid: analysis.valid,
      summary: analysis.summary,
      importDoc,
      userId: req.user._id,
    });

    const counts = finaliseCounts(analysis.summary, created, failures);

    importDoc.created = counts.created;
    importDoc.duplicates = counts.duplicatesInFile + counts.duplicatesInDb;
    importDoc.invalid = counts.invalid;
    await importDoc.save();

    // Mark consumed only after the write succeeded.
    preview.consumedAt = new Date();
    await preview.save();

    // --- optional: enroll the NEWLY CREATED contacts only -------------------
    let enrollment = null;
    if (campaign && createdIds.length > 0) {
      // Reuses the enrollment pipeline verbatim, so opt-out, inactive,
      // delivery-blocked, import-scope and already-enrolled rules all apply.
      enrollment = await enrollContactIds({
        campaign,
        targetIds: createdIds.map(String),
        selectAll: false,
        userId: req.user._id,
        // These contacts were created by THIS request, so they belong to the
        // import just made rather than the campaign's existing contact list.
        // See enrollContactIds for why that check is waived here — and only here.
        ignoreImportScope: true,
      });
    } else if (campaign) {
      enrollment = {
        total: 0, enrolled: 0, skipped: 0, notFound: 0, notEligible: 0, failed: 0,
        created: [], errors: [],
        note: 'No new contacts were created, so nothing was enrolled.',
      };
    }

    await logEvent({
      eventType: 'import.confirmed',
      severity: 'info',
      message: `Imported ${counts.created} contact(s) from ${preview.filename || 'an upload'}`,
      status: 'imported',
      meta: {
        importId: String(importDoc._id),
        ...counts,
        enrolled: enrollment ? enrollment.enrolled : 0,
        by: String(req.user._id),
      },
    });

    return res.status(200).json({
      success: true,
      summary: {
        ...counts,
        importId: importDoc._id,
        filename: importDoc.filename,
        // Rejected rows, with row numbers and reasons — parse-time failures
        // first, then anything the database refused on insert.
        errors: [...analysis.invalid, ...failures],
        warnings: analysis.warnings,
      },
      enrollment,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

// POST /api/contacts/import  (multipart: field "file")  — BACK-COMPAT
// The original one-shot import. Same engine as preview + confirm, run back to
// back, so there is no second copy of the validation rules and the response
// shape existing callers expect is unchanged.
async function importContacts(req, res, next) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: 'No file uploaded (use form field "file")' });
    }

    const analysis = await analyseUpload(req.file.buffer, req.file.originalname);

    const importDoc = await createImportRecord({
      filename: req.file.originalname,
      totalRows: analysis.summary.totalRows,
      userId: req.user ? req.user._id : undefined,
    });

    const { created, failures } = await commitImport({
      valid: analysis.valid,
      summary: analysis.summary,
      importDoc,
      userId: req.user ? req.user._id : undefined,
    });

    const counts = finaliseCounts(analysis.summary, created, failures);

    importDoc.created = counts.created;
    importDoc.duplicates = counts.duplicatesInFile + counts.duplicatesInDb;
    importDoc.invalid = counts.invalid;
    await importDoc.save();

    // Historical response shape, plus the balanced counts.
    return res.status(200).json({
      success: true,
      summary: {
        totalRows: counts.totalRows,
        created: counts.created,
        duplicatesInFile: counts.duplicatesInFile,
        duplicatesInDb: counts.duplicatesInDb,
        invalid: counts.invalid,
        countsBalance: counts.countsBalance,
        errors: [...analysis.invalid, ...failures],
        warnings: analysis.warnings,
        importId: importDoc._id,
        filename: importDoc.filename,
      },
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

// PATCH /api/contacts/:id/opt-out   { optedOut: true | false }
// Manual opt-out / opt-in by an operator. Opting out also cancels the contact's
// active and paused enrollments and skips their pending follow-up recipients;
// opting back in only clears the flag and never re-enrolls anyone.
async function setOptOut(req, res, next) {
  try {
    const { optedOut } = req.body || {};
    if (typeof optedOut !== 'boolean') {
      return res
        .status(400)
        .json({ success: false, message: 'optedOut must be true or false' });
    }

    const contact = await Contact.findById(req.params.id);
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }

    const operator = req.user ? req.user.name || req.user.email : 'unknown operator';
    let result;
    if (optedOut) {
      result = await applyOptOut(contact, 'manual');
      await logEvent({
        eventType: 'optout.received',
        severity: 'warning',
        message: `${operator} manually opted out ${contact.phone}`,
        status: 'opted_out',
        contact: contact._id,
        meta: {
          source: 'manual',
          by: operator,
          byUserId: req.user ? String(req.user._id) : undefined,
          cancelledEnrollments: result.cancelledEnrollments,
          skippedFollowings: result.skippedFollowings,
        },
      });
    } else {
      result = await applyOptIn(contact);
      await logEvent({
        eventType: 'optin.received',
        severity: 'info',
        message: `${operator} manually opted in ${contact.phone}`,
        status: 'opted_in',
        contact: contact._id,
        meta: {
          source: 'manual',
          by: operator,
          byUserId: req.user ? String(req.user._id) : undefined,
        },
      });
    }

    return res.json({ success: true, data: contact, result });
  } catch (err) {
    return next(err);
  }
}

// POST /api/contacts/:id/lookup
// Runs Twilio Lookup on the contact's phone and stores the enrichment on the
// contact. Serves the stored result (DB cache) unless ?force=true, so repeated
// lookups don't incur repeat Twilio costs.
async function lookupContact(req, res, next) {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }

    const force = req.query.force === 'true' || (req.body && req.body.force === true);
    if (
      !force &&
      contact.lookup &&
      contact.lookup.status !== 'unknown' &&
      contact.lookup.lookedUpAt
    ) {
      return res.json({ success: true, cached: true, lookup: contact.lookup });
    }

    if (!contact.phone) {
      return res.status(400).json({ success: false, message: 'Contact has no phone number' });
    }

    try {
      const result = await lookupService.lookupNumber(contact.phone);
      contact.lookup = {
        status: result.valid ? 'valid' : 'invalid',
        type: result.type || '',
        carrier: result.carrier || '',
        canonicalPhone: result.phone || '',
        lookedUpAt: result.lookedUpAt || new Date(),
      };
      await contact.save();
      return res.json({
        success: true,
        cached: false,
        simulated: !!result.simulated,
        lookup: contact.lookup,
      });
    } catch (lookupErr) {
      // Safe application-level error (no secrets); does not crash the server.
      return res
        .status(lookupErr.statusCode || 502)
        .json({ success: false, message: lookupErr.message || 'Lookup failed' });
    }
  } catch (err) {
    return next(err);
  }
}

// --- Lookup All, lookup counts, bulk delete -----------------------------------

function sendFilterError(res, err) {
  return res.status(err.status).json({ success: false, message: err.message });
}

// GET /api/contacts/lookup-summary   (same filter params as the list)
// Real counts per lookup bucket for the contacts matching the CURRENT filters
// (the lookup filter itself is ignored, so every bucket can be shown), plus how
// many in the Lookup All scope still need a lookup.
async function lookupSummary(req, res, next) {
  try {
    let filter;
    try {
      ({ filter } = await buildContactFilter(req.query, { ignoreLookup: true }));
    } catch (err) {
      if (err instanceof FilterError) return sendFilterError(res, err);
      throw err;
    }
    const keys = contactLookup.LOOKUP_FILTERS;
    const settings = await Settings.getSingleton();
    // Lookup All's scope: the chosen list, narrowed to the chosen batch.
    const { filter: lookupScope } = await buildContactFilter({ import: req.query.import, batch: req.query.batch });
    const [total, needsLookup, ...bucketCounts] = await Promise.all([
      Contact.countDocuments(filter),
      Contact.countDocuments({
        ...lookupScope,
        ...contactLookup.needsLookupCondition(settings.lookupMaxAgeDays || 30),
      }),
      ...keys.map((k) => Contact.countDocuments(contactLookup.withLookup(filter, k))),
    ]);
    const counts = Object.fromEntries(keys.map((k, i) => [k, bucketCounts[i]]));
    return res.json({ success: true, total, counts, needsLookup });
  } catch (err) {
    return next(err);
  }
}

// After deletions or new invalid results, bring each affected list's
// Total / Allocated / Remaining back in line with its actual contacts.
async function reconcileLists(importIds) {
  const ids = [...new Set(importIds.filter(Boolean).map(String))];
  const results = [];
  for (const id of ids) {
    try {
      const a = await importAllocation.reconcileAllocation(id);
      if (a) results.push({ importId: id, total: a.total, allocated: a.allocated, remaining: a.remaining, excluded: a.excluded });
    } catch (err) {
      // A list mid-allocation recounts itself at the start of its next one.
      console.error(`Reconciling import ${id} failed:`, err.message);
    }
  }
  return results;
}

// POST /api/contacts/lookup-all   (admin)   { import? }
// Starts Lookup All in the background over one imported list, or every
// contact. Lookup is billable, so only contacts that NEED a lookup are sent.
async function startLookupAll(req, res, next) {
  try {
    // The scope is derived HERE from (list, batch) — the same server-side
    // membership the Contacts table uses — never from a client contact list.
    // With a batch chosen, only that batch's persisted members are looked up.
    const importId = queryString(req.body && req.body.import);
    const batch = queryString(req.body && req.body.batch);
    let scope = {};
    let scopeLabel = 'all contacts';
    if (importId) {
      const imp = await Import.findById(importId);
      if (!imp) return res.status(404).json({ success: false, message: 'Import not found' });
      let batchView;
      try {
        ({ filter: scope, batchView } = await buildContactFilter({ import: importId, batch }));
      } catch (err) {
        if (err instanceof FilterError) return sendFilterError(res, err);
        throw err;
      }
      const name = imp.filename || 'imported list';
      scopeLabel = batchView && batchView.batch
        ? `Batch ${batchView.batch.number} of ${name}`
        : batchView && batchView.view === 'remaining'
          ? `the remaining contacts of ${name}`
          : name;
    } else if (batch) {
      return res.status(400).json({ success: false, message: 'batch can only be used together with import' });
    }
    let job;
    try {
      job = await contactLookup.startLookupAll({
        scope,
        scopeLabel,
        userId: req.user ? req.user._id : undefined,
        // New invalid numbers leave their lists' pools.
        onFinished: async (finished) => {
          const lists = importId
            ? [importId]
            : (await Import.find({ 'allocation.initializedAt': { $ne: null } }).select('_id').lean()).map((i) => i._id);
          await reconcileLists(lists);
          await logEvent({
            eventType: 'lookup.bulk_finished',
            severity: finished.status === 'done' ? 'info' : 'warning',
            message: finished.message || `Lookup All ${finished.status}`,
            status: finished.status,
            meta: { scope: scopeLabel, total: finished.total, lookedUp: finished.lookedUp, failed: finished.failed, results: finished.results },
          });
        },
      });
    } catch (err) {
      if (err instanceof contactLookup.LookupJobError) {
        return res.status(err.status).json({ success: false, message: err.message, job: contactLookup.getLookupAllStatus() });
      }
      throw err;
    }
    return res.status(202).json({ success: true, job });
  } catch (err) {
    return next(err);
  }
}

// GET /api/contacts/lookup-all/status
async function lookupAllStatus(req, res) {
  return res.json({ success: true, job: contactLookup.getLookupAllStatus() });
}

const BULK_DELETE_MAX_IDS = 1000;
const DELETE_CHUNK = 1000;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// Delete contacts with EXACTLY the single delete's semantics: the contact goes
// and its enrollments go with it (they reference it). Conversations, SMS
// history, campaigns and follow-ups are kept, as they always have been.
// `guard` is re-applied at delete time, so a contact that stopped matching in
// the meantime (e.g. re-looked-up as valid) is not deleted.
async function deleteContactSet(targets, guard) {
  let deleted = 0;
  let deletedEnrollments = 0;
  const fromRemaining = targets.filter((c) => c.import && !c.importBatch).length;
  for (let i = 0; i < targets.length; i += DELETE_CHUNK) {
    const ids = targets.slice(i, i + DELETE_CHUNK).map((c) => c._id);
    const r = await Contact.deleteMany({ ...guard, _id: { $in: ids } });
    deleted += (r && r.deletedCount) || 0;
    const e = await Enrollment.deleteMany({ contact: { $in: ids } });
    deletedEnrollments += (e && e.deletedCount) || 0;
  }
  const lists = await reconcileLists(targets.map((c) => c.import));
  return {
    deleted,
    deletedEnrollments,
    fromRemaining,
    fromAllocated: targets.filter((c) => c.import && c.importBatch).length,
    lists,
  };
}

// Resolve a Select-All request: the contacts matching the given filters,
// minus any unticked. The count must match what the operator confirmed.
async function resolveSelection(body, { forceLookup } = {}) {
  const filters = (body && typeof body.filters === 'object' && body.filters) || {};
  let { filter } = await buildContactFilter(forceLookup ? { ...filters, lookup: undefined } : filters);
  if (forceLookup) filter = contactLookup.withLookup(filter, forceLookup);
  const exclude = (Array.isArray(body.excludeIds) ? body.excludeIds : []).map(String).filter((id) => OBJECT_ID_RE.test(id));
  if (exclude.length) filter = { $and: [filter, { _id: { $nin: exclude } }] };
  const targets = await Contact.find(filter).select('_id import importBatch').lean();
  return { filter, targets };
}

// POST /api/contacts/bulk-delete   (admin)
//   { ids: [...] }                                         -> those contacts
//   { selectAll: true, filters, excludeIds, expectedCount } -> every contact
//      matching the current filters, minus excludeIds
async function bulkDeleteContacts(req, res, next) {
  try {
    const body = req.body || {};
    let targets;
    let guard = {};
    if (body.selectAll === true) {
      if (!Number.isInteger(body.expectedCount) || body.expectedCount < 0) {
        return res.status(400).json({ success: false, message: 'expectedCount is required with selectAll' });
      }
      try {
        ({ targets, filter: guard } = await resolveSelection(body));
      } catch (err) {
        if (err instanceof FilterError) return sendFilterError(res, err);
        throw err;
      }
      if (targets.length !== body.expectedCount) {
        return res.status(409).json({
          success: false,
          message: `The matching contacts changed: ${targets.length} now match, not ${body.expectedCount}. Nothing was deleted — review the list and try again.`,
          count: targets.length,
        });
      }
    } else {
      const { ids } = body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'Provide ids, or selectAll with filters' });
      }
      if (ids.length > BULK_DELETE_MAX_IDS) {
        return res.status(400).json({ success: false, message: `At most ${BULK_DELETE_MAX_IDS} ids per request — use Select All instead.` });
      }
      if (ids.some((id) => typeof id !== 'string' || !OBJECT_ID_RE.test(id))) {
        return res.status(400).json({ success: false, message: 'Every id must be a valid contact id' });
      }
      targets = await Contact.find({ _id: { $in: [...new Set(ids)] } }).select('_id import importBatch').lean();
    }
    if (targets.length === 0) {
      return res.json({ success: true, deleted: 0, deletedEnrollments: 0, fromRemaining: 0, fromAllocated: 0, lists: [] });
    }

    const result = await deleteContactSet(targets, guard);
    await logEvent({
      eventType: 'contacts.bulk_deleted',
      severity: 'warning',
      message: `${req.user ? req.user.name || req.user.email : 'An admin'} deleted ${result.deleted} contact(s)`,
      status: 'deleted',
      meta: { ...result, lists: undefined, selectAll: body.selectAll === true, by: req.user ? String(req.user._id) : undefined },
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
}

// POST /api/contacts/delete-invalid   (admin)   { filters, excludeIds, expectedCount }
// Deletes the contacts matching the current filters WHOSE PERSISTED LOOKUP
// STATUS IS 'invalid' — that condition is forced here, whatever the client
// sends, and re-checked at delete time. Unknown, not checked, failed lookups,
// landline and VoIP can never be deleted by this.
async function deleteInvalidContacts(req, res, next) {
  try {
    const body = req.body || {};
    if (!Number.isInteger(body.expectedCount) || body.expectedCount < 0) {
      return res.status(400).json({ success: false, message: 'expectedCount is required' });
    }
    let targets;
    try {
      ({ targets } = await resolveSelection(body, { forceLookup: 'invalid' }));
    } catch (err) {
      if (err instanceof FilterError) return sendFilterError(res, err);
      throw err;
    }
    if (targets.length !== body.expectedCount) {
      return res.status(409).json({
        success: false,
        message: `The invalid contacts changed: ${targets.length} now match, not ${body.expectedCount}. Nothing was deleted — review the list and try again.`,
        count: targets.length,
      });
    }
    if (targets.length === 0) {
      return res.json({ success: true, deleted: 0, deletedEnrollments: 0, fromRemaining: 0, fromAllocated: 0, lists: [] });
    }
    const result = await deleteContactSet(targets, { 'lookup.status': 'invalid' });
    await logEvent({
      eventType: 'contacts.invalid_deleted',
      severity: 'warning',
      message: `${req.user ? req.user.name || req.user.email : 'An admin'} deleted ${result.deleted} invalid contact(s)`,
      status: 'deleted',
      meta: { ...result, lists: undefined, by: req.user ? String(req.user._id) : undefined },
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  lookupSummary,
  startLookupAll,
  lookupAllStatus,
  bulkDeleteContacts,
  deleteInvalidContacts,
  buildContactFilter,
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  deleteAllContacts,
  importContacts,
  // Phase 6: preview-then-confirm import flow.
  previewImport,
  confirmImport,
  lookupContact,
  setOptOut,
};
