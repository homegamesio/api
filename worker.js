/**
 * Publish-request validation worker.
 *
 * Consumes messages from the `publish_requests` RabbitMQ queue.
 * For each request it:
 *   1. Looks up the game's Forgejo repo
 *   2. Checks that `index.js` exists and its metadata() parses statically
 *      (name/squishVersion/services — the facts list endpoints depend on)
 *   3. Checks that a GPLv3 LICENSE file exists
 *   4. Checks that a non-trivial README exists
 *   5. Downloads the repo archive at the given commit and AST-scans every
 *      JS file for banned patterns
 *   6. Runs the game in a sandboxed Docker container (validate.js)
 *      — loads the class, validates metadata, instantiates, squishes the
 *      full node tree, simulates players/input, runs for 5 seconds
 *   7. On success: creates a `gameVersions` record with `published: true`
 *   8. Updates the `publishRequests` record status
 *
 * Run:  node worker.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const amqp = require('amqplib/callback_api');
const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const tar = require('tar');

const {
    DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME,
    QUEUE_HOST,
} = require('./config');
const { forgejoRequest, downloadArchive } = require('./forgejo');
const localPlay = require('homegames-common/local-play');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const QUEUE_NAME = 'publish_requests';
const RECONNECT_DELAY_MS = 5000;

// Docker validation — requires homegames-runner image
let validateGame = null;
try {
    const dockerHelper = require('homegames-common').dockerHelper;
    validateGame = dockerHelper.validateGame;
} catch (e) {
    console.warn('[worker] Docker validation unavailable:', e.message);
}


// ---------------------------------------------------------------------------
// GPLv3 reference text (loaded once at startup)
// ---------------------------------------------------------------------------

const GPL3_PATH = path.join(__dirname, 'gpl-3.0.txt');
const GPL3_TEXT = fs.existsSync(GPL3_PATH) ? fs.readFileSync(GPL3_PATH, 'utf-8') : null;

const normalizeWhitespace = (text) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
const GPL3_NORMALIZED = GPL3_TEXT ? normalizeWhitespace(GPL3_TEXT) : null;

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

let _mongoClient = null;

const getMongoClient = () => {
    if (_mongoClient) return _mongoClient;

    const uri = DB_USERNAME
        ? `mongodb://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`
        : `mongodb://${DB_HOST}:${DB_PORT}/${DB_NAME}`;

    const params = {};
    if (DB_USERNAME) {
        params.auth = { username: DB_USERNAME, password: DB_PASSWORD };
        params.authSource = 'admin';
    }

    _mongoClient = new MongoClient(uri, params);
    return _mongoClient;
};

const getCollection = async (name) => {
    const client = getMongoClient();
    await client.connect();
    return client.db(DB_NAME).collection(name);
};

const generateId = () => crypto.createHash('md5').update(uuidv4()).digest('hex');

// ---------------------------------------------------------------------------
// Forgejo helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a file's content at a commit. Returns null ONLY when the file
 * genuinely doesn't exist (404). Any other failure (Forgejo down, auth,
 * network) throws — so an infra outage never reads as "file not found"
 * and wrongly fails a publish.
 */
const getFileAtCommit = async (owner, repo, filepath, commitSha) => {
    try {
        const refParam = commitSha ? `?ref=${commitSha}` : '';
        const data = await forgejoRequest('GET', `/repos/${owner}/${repo}/contents/${filepath}${refParam}`);
        if (data && data.content) {
            return Buffer.from(data.content, 'base64').toString('utf-8');
        }
        return null;
    } catch (err) {
        if (err && err.status === 404) {
            return null;
        }
        const detail = err && (err.message || (err.status && `HTTP ${err.status}`)) || 'unknown error';
        throw new Error(`Failed to fetch ${filepath} from repository: ${detail}`);
    }
};

/**
 * Download and extract repo archive to a temp directory.
 * Returns { root, dir }: `root` is the temp directory to remove when done,
 * `dir` is the directory containing the repo contents (the archive's
 * top-level directory when there is one).
 */
const downloadAndExtract = async (owner, repo, commitSha) => {
    const archiveBuffer = await downloadArchive(owner, repo, commitSha);
    const tmpDir = path.join(os.tmpdir(), `hg-validate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    await new Promise((resolve, reject) => {
        const { Readable } = require('stream');
        const bufStream = new Readable();
        bufStream.push(archiveBuffer);
        bufStream.push(null);
        bufStream.pipe(tar.x({ cwd: tmpDir }))
            .on('finish', resolve)
            .on('error', reject);
    });

    // tar.gz archives typically contain a top-level directory
    const entries = fs.readdirSync(tmpDir);
    if (entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()) {
        return { root: tmpDir, dir: path.join(tmpDir, entries[0]) };
    }
    return { root: tmpDir, dir: tmpDir };
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LICENSE_FILENAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'License', 'License.md', 'license', 'license.md', 'license.txt'];
const README_FILENAMES = ['README.md', 'README', 'README.txt', 'Readme.md', 'readme.md', 'readme.txt'];

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB — no single source file should be this large
const MAX_TOTAL_SIZE = 20 * 1024 * 1024; // 20MB total repo size
const MIN_README_CONTENT_CHARS = 40; // README must say something real, not just a title

/**
 * Whether README content is substantive: strip markdown headings, dividers,
 * and whitespace, and require a minimum amount of actual prose.
 */
const isSubstantiveReadme = (content) => {
    const stripped = content
        .replace(/^#+\s.*$/gm, '')   // headings
        .replace(/^[-=*_]{3,}\s*$/gm, '') // hr dividers
        .replace(/\s+/g, ' ')
        .trim();
    return stripped.length >= MIN_README_CONTENT_CHARS;
};

const validatePublishRequest = async (gameId, commitSha) => {
    const games = await getCollection('games');
    const game = await games.findOne({ gameId });

    if (!game) {
        return { success: false, error: `Game ${gameId} not found` };
    }

    if (!game.forgejoRepo) {
        return { success: false, error: `Game ${gameId} has no repository` };
    }

    const [owner, repo] = game.forgejoRepo.split('/');

    // -----------------------------------------------------------------------
    // 1. Check index.js exists
    // -----------------------------------------------------------------------
    const indexContent = await getFileAtCommit(owner, repo, 'index.js', commitSha);
    if (indexContent === null) {
        return { success: false, error: 'index.js not found at this version' };
    }

    // -----------------------------------------------------------------------
    // 2. Basic source checks (before downloading the whole repo)
    // -----------------------------------------------------------------------
    if (Buffer.byteLength(indexContent, 'utf-8') > MAX_FILE_SIZE) {
        return { success: false, error: 'index.js exceeds maximum file size (5MB)' };
    }

    // Static metadata check — list endpoints, local play, and the runner all
    // depend on metadata() being statically parseable with literal values.
    // Fail early with a clear message instead of a Docker error later.
    const sourceMeta = localPlay.parseGameSourceMetadata(indexContent);
    if (sourceMeta.error) {
        return { success: false, error: `index.js metadata check failed: ${sourceMeta.error}. metadata() must be a static method returning an object literal.` };
    }
    if (!sourceMeta.squishVersion) {
        return { success: false, error: 'metadata() must include a squishVersion as a string literal (e.g. squishVersion: \'142\')' };
    }
    // Note: whether the version is *supported* is enforced inside the runner
    // image (validate.js) — the image's squish map is the authoritative one.
    if (!sourceMeta.name) {
        return { success: false, error: 'metadata() must include a name as a string literal' };
    }

    // -----------------------------------------------------------------------
    // 3. Check GPLv3 license
    // -----------------------------------------------------------------------
    let licenseFound = false;
    let licenseError = null;

    if (GPL3_NORMALIZED) {
        for (const filename of LICENSE_FILENAMES) {
            const licenseContent = await getFileAtCommit(owner, repo, filename, commitSha);
            if (licenseContent !== null) {
                const normalizedLicense = normalizeWhitespace(licenseContent);
                if (normalizedLicense === GPL3_NORMALIZED) {
                    licenseFound = true;
                    break;
                } else {
                    licenseError = `${filename} exists but is not the GPLv3 license`;
                }
            }
        }

        if (!licenseFound) {
            const error = licenseError || 'No LICENSE file found. A GPLv3 LICENSE file is required.';
            return { success: false, error };
        }
    }

    // -----------------------------------------------------------------------
    // 4. Check README — every published game needs real documentation
    // -----------------------------------------------------------------------
    let readmeContent = null;
    for (const filename of README_FILENAMES) {
        readmeContent = await getFileAtCommit(owner, repo, filename, commitSha);
        if (readmeContent !== null) break;
    }

    if (readmeContent === null) {
        return { success: false, error: 'No README found. A README.md describing the game is required.' };
    }
    if (!isSubstantiveReadme(readmeContent)) {
        return { success: false, error: `README is too thin — describe what the game is and how to play it (at least ${MIN_README_CONTENT_CHARS} characters of actual content beyond headings).` };
    }

    // -----------------------------------------------------------------------
    // 5. Download repo and run Docker validation
    // -----------------------------------------------------------------------
    let tmpRoot = null;
    try {
        console.log(`[worker] Downloading archive for ${owner}/${repo} @ ${commitSha.substring(0, 7)}`);
        const extracted = await downloadAndExtract(owner, repo, commitSha);
        tmpRoot = extracted.root;
        const extractedPath = extracted.dir;

        // Check total repo size and collect all JS files. lstat (not stat) so
        // symlinks are never followed — a symlink pointing outside the
        // extracted tree must not be readable, countable, or scannable.
        let totalSize = 0;
        const jsFiles = [];
        const symlinks = [];
        const walkDir = (dir) => {
            for (const entry of fs.readdirSync(dir)) {
                const full = path.join(dir, entry);
                const stat = fs.lstatSync(full);
                if (stat.isSymbolicLink()) {
                    symlinks.push(path.relative(extractedPath, full));
                } else if (stat.isDirectory()) {
                    if (entry !== 'node_modules' && entry !== '.git') walkDir(full);
                } else {
                    totalSize += stat.size;
                    if (entry.endsWith('.js')) {
                        jsFiles.push(full);
                    }
                }
            }
        };
        walkDir(extractedPath);

        if (symlinks.length > 0) {
            return { success: false, error: `Symbolic links are not allowed in game repositories: ${symlinks.slice(0, 3).join(', ')}` };
        }

        if (totalSize > MAX_TOTAL_SIZE) {
            return { success: false, error: `Repository too large (${(totalSize / 1024 / 1024).toFixed(1)}MB). Maximum is ${MAX_TOTAL_SIZE / 1024 / 1024}MB.` };
        }

        // Check index.js exists in extracted directory
        if (!fs.existsSync(path.join(extractedPath, 'index.js'))) {
            return { success: false, error: 'index.js not found in extracted archive' };
        }

        // AST-based scan of all JS files for dangerous patterns
        const { scanSource } = require('./ast-scanner');

        for (const jsFile of jsFiles) {
            const relPath = path.relative(extractedPath, jsFile);
            const content = fs.readFileSync(jsFile, 'utf-8');

            if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
                return { success: false, error: `${relPath} exceeds maximum file size (5MB)` };
            }

            const scanResult = scanSource(content, relPath);
            if (!scanResult.safe) {
                const firstErrors = scanResult.errors.slice(0, 3);
                const summary = firstErrors.map(e => `${e.file}:${e.line}: ${e.msg}`).join('; ');
                return { success: false, error: summary };
            }
        }

        // Run Docker validation if available
        let validationResult = null;
        const squishVersion = sourceMeta.squishVersion;

        if (validateGame) {
            console.log(`[worker] Running Docker validation for ${owner}/${repo}`);

            validationResult = await validateGame({
                codePath: extractedPath,
                squishVersion,
                timeoutMs: 30000,
            });

            if (!validationResult.success) {
                return { success: false, error: `Runtime validation failed: ${validationResult.error}` };
            }

            if (validationResult.warnings && validationResult.warnings.length > 0) {
                console.log(`[worker] Validation warnings for ${owner}/${repo}:`, validationResult.warnings);
            }

            console.log(`[worker] Docker validation passed for ${owner}/${repo}`);
        } else {
            return { success: false, error: 'Docker validation is required but not available' };
        }

        // Derived from source metadata here at publish time so list endpoints
        // (front page cards) never have to re-derive them from source.
        const multiplayer = sourceMeta.services.includes('multiplayer');
        const localPlayable = localPlay.checkLocalPlayable(sourceMeta).playable;

        return {
            success: true,
            assetIds: validationResult.assetIds || [],
            squishVersion: validationResult.squishVersion || squishVersion,
            multiplayer,
            localPlayable,
            warnings: validationResult.warnings || [],
        };
    } finally {
        // Clean up extracted files
        if (tmpRoot) {
            try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
        }
    }
};

// ---------------------------------------------------------------------------
// Handle a single publish request message
// ---------------------------------------------------------------------------

const handlePublishRequest = async (message) => {
    const { requestId, gameId, commitSha, userId } = message;

    if (!requestId || !gameId || !commitSha) {
        console.error('[worker] Invalid message — missing requestId, gameId, or commitSha');
        return;
    }

    if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) {
        console.error(`[worker] Invalid commitSha in message: ${String(commitSha).slice(0, 60)}`);
        const publishRequestsEarly = await getCollection('publishRequests');
        await publishRequestsEarly.updateOne({ requestId }, {
            $set: { status: 'FAILED', error: 'Invalid commit SHA', completedAt: Date.now() }
        });
        return;
    }

    console.log(`[worker] Processing publish request ${requestId} for game ${gameId} @ ${commitSha.substring(0, 7)}`);

    const publishRequests = await getCollection('publishRequests');

    try {
        await publishRequests.updateOne({ requestId }, { $set: { status: 'PROCESSING' } });

        const result = await validatePublishRequest(gameId, commitSha);

        if (result.success) {
            // Check NSFW status of in-game assets + thumbnail
            let isNsfw = false;
            try {
                const games = await getCollection('games');
                const game = await games.findOne({ gameId });
                const allAssetIds = [...(result.assetIds || [])];
                if (game && game.thumbnail && !allAssetIds.includes(game.thumbnail)) {
                    allAssetIds.push(game.thumbnail);
                }
                if (allAssetIds.length > 0) {
                    const assets = await getCollection('assets');
                    const nsfwCount = await assets.countDocuments({
                        assetId: { $in: allAssetIds },
                        nsfw: true,
                    });
                    isNsfw = nsfwCount > 0;
                }
                console.log(`[worker] NSFW check: ${allAssetIds.length} assets, nsfw=${isNsfw}`);
            } catch (nsfwErr) {
                console.error('[worker] NSFW check failed (defaulting to false):', nsfwErr.message);
            }

            const gameVersions = await getCollection('gameVersions');
            const versionId = generateId();

            await gameVersions.insertOne({
                versionId,
                gameId,
                commitSha,
                publishedAt: Date.now(),
                publishedBy: userId,
                published: true,
                nsfw: isNsfw,
                // Captured so consumers (local play, catalog) don't have to
                // re-derive them from source later.
                assets: result.assetIds || [],
                squishVersion: result.squishVersion || null,
                multiplayer: !!result.multiplayer,
                localPlayable: !!result.localPlayable,
                validationWarnings: result.warnings || [],
            });

            // Update game record to reflect the latest version's NSFW status
            // and play capabilities (consumed by list endpoints / front page).
            const gamesCollection = await getCollection('games');
            await gamesCollection.updateOne({ gameId }, { $set: {
                nsfw: isNsfw,
                multiplayer: !!result.multiplayer,
                localPlayable: !!result.localPlayable,
                latestPublishedSha: commitSha,
            } });

            await publishRequests.updateOne({ requestId }, {
                $set: { status: 'PUBLISHED', versionId, completedAt: Date.now(), warnings: result.warnings || [] }
            });

            console.log(`[worker] ✓ Published version ${versionId} for game ${gameId} (nsfw=${isNsfw})`);
        } else {
            await publishRequests.updateOne({ requestId }, {
                $set: { status: 'FAILED', error: result.error, completedAt: Date.now() }
            });

            console.log(`[worker] ✗ Failed: ${result.error}`);
        }
    } catch (err) {
        console.error(`[worker] Error processing request ${requestId}:`, err);
        try {
            await publishRequests.updateOne({ requestId }, {
                $set: { status: 'FAILED', error: err.message, completedAt: Date.now() }
            });
        } catch (updateErr) {
            console.error('[worker] Failed to update request status:', updateErr);
        }
    }
};

// ---------------------------------------------------------------------------
// RabbitMQ consumer
// ---------------------------------------------------------------------------

const startConsumer = () => {
    const connect = () => {
        console.log(`[worker] Connecting to RabbitMQ at amqp://${QUEUE_HOST}...`);

        amqp.connect(`amqp://${QUEUE_HOST}`, (err, conn) => {
            if (err) {
                console.error(`[worker] RabbitMQ connection failed: ${err.message}. Retrying in ${RECONNECT_DELAY_MS}ms...`);
                setTimeout(connect, RECONNECT_DELAY_MS);
                return;
            }

            conn.on('error', (connErr) => {
                console.error('[worker] RabbitMQ connection error:', connErr.message);
            });

            conn.on('close', () => {
                console.log('[worker] RabbitMQ connection closed. Reconnecting...');
                setTimeout(connect, RECONNECT_DELAY_MS);
            });

            conn.createChannel((err1, channel) => {
                if (err1) {
                    console.error('[worker] Failed to create channel:', err1.message);
                    conn.close();
                    return;
                }

                channel.assertQueue(QUEUE_NAME, { durable: true });
                channel.prefetch(1);

                console.log(`[worker] Waiting for messages on '${QUEUE_NAME}'...`);

                channel.consume(QUEUE_NAME, (msg) => {
                    if (!msg) return;

                    let parsed;
                    try {
                        parsed = JSON.parse(msg.content.toString());
                    } catch (parseErr) {
                        console.error('[worker] Failed to parse message:', parseErr);
                        channel.ack(msg);
                        return;
                    }

                    handlePublishRequest(parsed)
                        .then(() => channel.ack(msg))
                        .catch((handlerErr) => {
                            console.error('[worker] Handler error:', handlerErr);
                            channel.nack(msg, false, false);
                        });
                }, { noAck: false });
            });
        });
    };

    connect();
};

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const main = async () => {
    console.log('[worker] Starting publish-request validation worker');

    try {
        const client = getMongoClient();
        await client.connect();
        console.log('[worker] MongoDB connected');
    } catch (err) {
        console.error('[worker] MongoDB connection failed:', err.message);
        process.exit(1);
    }

    startConsumer();
};

main().catch((err) => {
    console.error('[worker] Fatal error:', err);
    process.exit(1);
});
