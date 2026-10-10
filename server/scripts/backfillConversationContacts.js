// One-off backfill (Phase 4): copy each contact's name and phone onto its
// conversation, so threads created before those denormalized fields existed
// become searchable in the inbox.
//
// Safe by design:
//   * Only ever SETS contactName / contactPhone. Nothing is deleted, no other
//     field is touched, and no message is modified.
//   * Idempotent — running it twice changes nothing the second time.
//   * Dry run by default. Pass --apply to write.
//
//   node scripts/backfillConversationContacts.js           # report only
//   node scripts/backfillConversationContacts.js --apply   # write
const { config, validateConfig } = require('../config/env');
const { connectDB, disconnectDB } = require('../config/db');
const Conversation = require('../models/Conversation');
const Contact = require('../models/Contact');

async function run() {
  const apply = process.argv.includes('--apply');
  validateConfig();
  await connectDB();

  // Conversations whose denormalized copy is missing or empty.
  const stale = await Conversation.find({
    $or: [
      { contactPhone: { $in: [null, ''] } },
      { contactPhone: { $exists: false } },
      { contactName: { $exists: false } },
    ],
  }).select('_id contact contactName contactPhone');

  console.log(`Conversations needing a backfill: ${stale.length}`);
  if (stale.length === 0) {
    await disconnectDB();
    return;
  }

  let updated = 0;
  let missingContact = 0;
  for (const convo of stale) {
    const contact = await Contact.findById(convo.contact).select('name phone');
    if (!contact) {
      missingContact += 1;
      console.log(`  - ${convo._id}: contact no longer exists, skipped`);
      continue;
    }
    console.log(
      `  - ${convo._id}: ${apply ? 'setting' : 'would set'} name="${contact.name || ''}" phone="${contact.phone || ''}"`
    );
    if (apply) {
      await Conversation.updateOne(
        { _id: convo._id },
        { $set: { contactName: contact.name || '', contactPhone: contact.phone || '' } }
      );
      updated += 1;
    }
  }

  console.log(
    apply
      ? `Done. Updated ${updated} conversation(s); ${missingContact} skipped (no contact).`
      : `Dry run only — nothing was written. Re-run with --apply to update ${stale.length - missingContact} conversation(s).`
  );

  await disconnectDB();
}

run().catch(async (err) => {
  console.error('Backfill failed:', err.message);
  try {
    await disconnectDB();
  } catch (e) {
    /* already closed */
  }
  process.exit(1);
});
