// ---------------------------------------------------------------------------
// One-off migration: backfill multiplayer / localPlayable / latestPublishedSha
// on game records.
//
// Why: the publish worker now captures these at publish time so list endpoints
// (front page cards with inline play buttons) never re-derive them from source.
// Games published before that change don't have the fields, so their cards get
// no play button until republished — this backfills them from each game's
// latest published version.
//
// Idempotent: only touches games missing any of the three fields. Safe to
// re-run. Games whose source can't be fetched or parsed are logged and skipped.
//
// Run on the host with the SAME environment as the API (needs DB_*, JWT_SECRET
// because config.js validates it, and CREDENTIALS_DIRECTORY for Forgejo):
//
//     node backfill-game-play-meta.js
// ---------------------------------------------------------------------------

const { getMongoClient } = require('./db');
const { DB_NAME } = require('./config');
const { forgejoRequest } = require('./forgejo');
const localPlay = require('homegames-common/local-play');

const run = async () => {
    const client = getMongoClient();
    await client.connect();
    const db = client.db(DB_NAME);
    const games = db.collection('games');
    const versions = db.collection('gameVersions');

    const candidates = await games.find({ $or: [
        { multiplayer: { $exists: false } },
        { localPlayable: { $exists: false } },
        { latestPublishedSha: { $exists: false } },
    ] }).toArray();
    console.log(`Found ${candidates.length} game(s) needing backfill.`);

    let updated = 0;
    let skipped = 0;

    for (const game of candidates) {
        const label = `${game.name || '?'} (${game.gameId})`;

        const latest = await versions.find({ gameId: game.gameId, published: true })
            .sort({ publishedAt: -1 }).limit(1).toArray();
        if (!latest.length) { console.log(`- ${label}: no published versions — skipping`); skipped++; continue; }
        const ref = latest[0].commitSha;

        if (!game.forgejoRepo) { console.log(`- ${label}: no forgejoRepo — skipping`); skipped++; continue; }
        const [owner, repo] = game.forgejoRepo.split('/');

        try {
            // Same entry-point resolution as getLocalPlayContext: shallowest index.js.
            const tree = await forgejoRequest('GET', `/repos/${owner}/${repo}/git/trees/${ref}?recursive=true`);
            const indexFiles = (tree.tree || [])
                .filter(e => e.type === 'blob' && (e.path === 'index.js' || e.path.endsWith('/index.js')))
                .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
            if (!indexFiles.length) { console.log(`- ${label}: no index.js at ${ref} — skipping`); skipped++; continue; }

            const encodedPath = indexFiles[0].path.split('/').map(encodeURIComponent).join('/');
            const fileData = await forgejoRequest('GET', `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${ref}`);
            const source = Buffer.from(fileData.content, 'base64').toString('utf8');

            const meta = localPlay.parseGameSourceMetadata(source);
            const multiplayer = !meta.error && meta.services.includes('multiplayer');
            const localPlayable = localPlay.checkLocalPlayable(meta).playable;

            await games.updateOne({ gameId: game.gameId }, { $set: {
                multiplayer,
                localPlayable,
                latestPublishedSha: ref,
            } });
            updated++;
            console.log(`✓ ${label}: multiplayer=${multiplayer} localPlayable=${localPlayable} ref=${ref.substring(0, 7)}`);
        } catch (err) {
            console.error(`✗ ${label}: ${err && err.message ? err.message : err} — skipping`);
            skipped++;
        }
    }

    console.log(`Done. Updated ${updated}, skipped ${skipped}.`);
    process.exit(0);
};

run().catch(err => { console.error(err); process.exit(1); });
