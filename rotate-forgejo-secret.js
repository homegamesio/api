#!/usr/bin/env node
//
// Rotate the FORGEJO_USER_SECRET used to derive per-user Forgejo passwords.
//
// What this script does:
//   1. Derives a new password for every user with a Forgejo account using
//      the NEW secret (read from $CREDENTIALS_DIRECTORY/forgejo-user-secret).
//   2. Resets each user's Forgejo password via the admin API.
//   3. Clears the forgejoPasswordSynced flag so the API knows to re-sync.
//
// Usage:
//   1. Update the forgejo-user-secret file in the credentials directory.
//   2. Run:  node rotate-forgejo-secret.js
//   3. Deploy the API with the new credential file.
//
// The script is idempotent — safe to re-run if it fails partway through.
//

const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const {
    DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME,
} = require('./config');
const { adminEditUser, FORGEJO_USER_SECRET } = require('./forgejo');

const deriveForgejoPassword = (userId) => {
    return crypto.createHmac('sha256', FORGEJO_USER_SECRET).update(userId).digest('hex');
};

const getMongoClient = () => {
    const uri = DB_USERNAME
        ? `mongodb://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`
        : `mongodb://${DB_HOST}:${DB_PORT}/${DB_NAME}`;
    const params = {};
    if (DB_USERNAME) {
        params.auth = { username: DB_USERNAME, password: DB_PASSWORD };
        params.authSource = 'admin';
    }
    return new MongoClient(uri, params);
};

const run = async () => {
    const client = getMongoClient();
    await client.connect();
    const db = client.db(DB_NAME);
    const users = db.collection('users');

    // Find all users that have a Forgejo account
    const forgejoUsers = await users.find({ forgejoAccountCreated: true }).toArray();
    console.log(`Found ${forgejoUsers.length} users with Forgejo accounts.`);

    let synced = 0;
    let failed = 0;

    for (const user of forgejoUsers) {
        const userId = user.userId;
        const newPass = deriveForgejoPassword(userId);

        try {
            await adminEditUser(userId, {
                password: newPass,
                must_change_password: false,
                login_name: userId,
                source_id: 0,
            });

            await users.updateOne(
                { userId },
                { '$set': { forgejoPasswordSynced: true }, '$unset': { forgejoPassword: '' } },
            );

            synced++;
            console.log(`  ✓ ${userId}`);
        } catch (err) {
            failed++;
            console.error(`  ✗ ${userId}:`, err?.body || err?.message || err);
        }
    }

    console.log(`\nDone. Synced: ${synced}, Failed: ${failed}`);

    if (failed > 0) {
        console.log('Re-run the script to retry failed users.');
    }

    await client.close();
};

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
