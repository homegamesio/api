// ---------------------------------------------------------------------------
// One-off migration: backfill displayName / displayNameLower on pre-email
// accounts.
//
// Why: the new auth model looks users up by `displayNameLower` (or `emailLower`),
// not by `userId`. Accounts created before the email/identity refactor only have
// `userId` (= their old username) and no displayName fields, so login can't find
// them. This backfills displayName = userId so their existing username + password
// keep working.
//
// Idempotent: only touches users missing `displayNameLower`. Safe to re-run.
//
// It also GRANDFATHERS legacy accounts (those with no email on file) as
// `verified: true`, so the new email gate doesn't lock them out of publishing —
// they predate the email requirement and have no address to verify. If you'd
// rather force them to add + verify an email instead, set GRANDFATHER_VERIFIED
// to false below.
//
// Run on the host with the SAME environment as the API (needs DB_* and, because
// config.js validates it, JWT_SECRET):
//
//     node backfill-display-names.js
// ---------------------------------------------------------------------------

const GRANDFATHER_VERIFIED = true;

const { getMongoClient } = require('./db');
const { DB_NAME } = require('./config');

const run = async () => {
    const client = getMongoClient();
    await client.connect();
    const users = client.db(DB_NAME).collection('users');

    const legacy = await users.find({ displayNameLower: { $exists: false } }).toArray();
    console.log(`Found ${legacy.length} account(s) needing backfill.`);

    let updated = 0;
    let skipped = 0;

    for (const u of legacy) {
        const displayName = u.displayName || u.userId;
        if (!displayName) {
            console.warn(`! ${u._id}: no userId/displayName — skipping`);
            skipped++;
            continue;
        }
        const displayNameLower = String(displayName).toLowerCase();

        // Guard against a case-insensitive clash with an already-correct user.
        const clash = await users.findOne({ displayNameLower, userId: { $ne: u.userId } });
        if (clash) {
            console.warn(`! "${displayName}" (userId=${u.userId}) collides with existing user ${clash.userId} — skipping; resolve manually`);
            skipped++;
            continue;
        }

        const set = { displayName, displayNameLower };
        if (GRANDFATHER_VERIFIED && !u.email && u.verified !== true) {
            set.verified = true;
        }

        await users.updateOne({ _id: u._id }, { $set: set });
        updated++;
        console.log(`✓ ${u.userId} -> displayName="${displayName}"${set.verified ? ' (verified)' : ''}`);
    }

    console.log(`Done. Updated ${updated}, skipped ${skipped}.`);
    await client.close();
};

run().then(() => process.exit(0)).catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
