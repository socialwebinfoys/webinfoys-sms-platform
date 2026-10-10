// One-off repair for US/Canada contacts corrupted by the old phone-normalization
// bug (Phase 0, item G).
//
// The old normalizer prepended the default country code even when the number
// already carried it, so "14155552671" with DEFAULT_COUNTRY_CODE=+1 was stored
// as "+114155552671" — an unroutable number. This script finds those rows and
// rewrites them to the correct "+1" + 10 digits.
//
// SAFETY
//   * DRY RUN IS THE DEFAULT. Without --apply nothing is written, ever.
//   * Only `Contact.phone` is rewritten (plus the denormalized
//     `Conversation.contactPhone`, so the inbox keeps matching, and the
//     contact's cached Lookup result, which described the old number). Historical
//     SMSMessage `to`/`from` values are deliberately LEFT ALONE: they record what
//     was actually sent and are an audit trail, not current state.
//   * A row whose corrected number already belongs to a DIFFERENT contact is
//     skipped and reported as a conflict — merging contacts is a human decision,
//     never something a migration should guess at.
//   * Nothing is deleted. No collection is dropped. No document is created.
//
// USAGE
//   node scripts/fixUsPhones.js            # dry run (default) — reports only
//   node scripts/fixUsPhones.js --apply    # actually write the corrections
const mongoose = require('mongoose');

const { config, validateConfig } = require('../config/env');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const { emptyLookup } = require('../services/contactLookup');

// Exactly: '+1', then a second '1', then 10 more digits (12 digits total).
// This is the precise shape the old bug produced for an 11-digit US input.
const CORRUPTED_PHONE = /^\+11\d{10}$/;

// '+114155552671' -> '+14155552671' (keep the last 10 national digits).
function correctedPhone(phone) {
  return '+1' + phone.slice(-10);
}

async function run() {
  const apply = process.argv.includes('--apply');

  validateConfig();
  await mongoose.connect(config.mongoUri);
  // Never print the URI (it contains the database password) — only the db name.
  console.log(`Connected to database: ${mongoose.connection.name}`);
  console.log(apply ? 'MODE: APPLY (changes will be written)' : 'MODE: DRY RUN (no changes)');
  console.log('');

  // Fetch candidates by regex. Read-only in both modes.
  const candidates = await Contact.find({ phone: CORRUPTED_PHONE })
    .select('_id name phone')
    .lean();

  if (candidates.length === 0) {
    console.log('No contacts match the corrupted pattern ^\\+11\\d{10}$. Nothing to do.');
    await mongoose.disconnect();
    return { scanned: 0, fixable: 0, conflicts: 0, updated: 0 };
  }

  console.log(`Found ${candidates.length} contact(s) with a corrupted +1 number.\n`);

  const planned = [];
  const conflicts = [];

  for (const c of candidates) {
    const next = correctedPhone(c.phone);
    // Does the corrected number already exist on another contact?
    const clash = await Contact.findOne({ phone: next, _id: { $ne: c._id } })
      .select('_id name')
      .lean();
    if (clash) {
      conflicts.push({ id: String(c._id), from: c.phone, to: next, existingId: String(clash._id) });
    } else {
      planned.push({ id: String(c._id), name: c.name || '(no name)', from: c.phone, to: next });
    }
  }

  console.log(`Correctable: ${planned.length}`);
  for (const p of planned) {
    console.log(`  ${p.from}  ->  ${p.to}   (${p.id} ${p.name})`);
  }

  if (conflicts.length > 0) {
    console.log(`\nCONFLICTS (skipped — corrected number already belongs to another contact): ${conflicts.length}`);
    for (const k of conflicts) {
      console.log(`  ${k.from}  ->  ${k.to}   blocked by contact ${k.existingId}`);
    }
    console.log('\n  Resolve these by hand: decide which contact is canonical, move any');
    console.log('  history you want to keep, then re-run this script.');
  }

  let updated = 0;
  let conversationsSynced = 0;

  if (!apply) {
    console.log('\nDRY RUN — nothing was written.');
    console.log('Re-run with --apply to write these corrections.');
  } else {
    console.log('\nApplying corrections...');
    for (const p of planned) {
      // Targeted $set on one field. Never a bulk/unfiltered update.
      // The cached Lookup result described the corrupted number (which Twilio
      // reports invalid), so it is reset along with the phone.
      const res = await Contact.updateOne(
        { _id: p.id, phone: p.from },
        { $set: { phone: p.to, lookup: emptyLookup() } }
      );
      if (res.modifiedCount > 0) {
        updated += 1;
        // Keep the inbox's denormalized copy (Phase 4) in step with the contact.
        const conv = await Conversation.updateOne(
          { contact: p.id },
          { $set: { contactPhone: p.to } }
        );
        if (conv.modifiedCount > 0) conversationsSynced += 1;
      } else {
        // The row changed between the scan and the write — report, do not retry.
        console.log(`  SKIPPED ${p.id}: phone no longer ${p.from} (changed concurrently)`);
      }
    }
    console.log(`Updated ${updated} contact(s); synced ${conversationsSynced} conversation(s).`);
  }

  console.log('\nSummary:');
  console.log(`  scanned:   ${candidates.length}`);
  console.log(`  fixable:   ${planned.length}`);
  console.log(`  conflicts: ${conflicts.length}`);
  console.log(`  updated:   ${updated}${apply ? '' : ' (dry run)'}`);

  await mongoose.disconnect();
  return { scanned: candidates.length, fixable: planned.length, conflicts: conflicts.length, updated };
}

run().catch((err) => {
  // Message only — never dump the config or the connection string.
  console.error('fixUsPhones failed:', err.message);
  process.exit(1);
});
