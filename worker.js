/**
 * Publish-request validation worker.
 *
 * Consumes messages from the `publish_requests` RabbitMQ queue.
 * For each request it:
 *   1. Looks up the game's Forgejo repo
 *   2. Checks that `index.js` exists at the given commit
 *   3. Checks that a GPLv3 LICENSE file exists (LICENSE, LICENSE.md, or LICENSE.txt)
 *   4. On success: creates a `gameVersions` record with `published: true`
 *   5. Updates the `publishRequests` record status
 *
 * Run:  node worker.js
 */

const fs = require('fs');
const path = require('path');
const amqp = require('amqplib/callback_api');
const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const {
    DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME,
    QUEUE_HOST, FORGEJO_URL, FORGEJO_ADMIN_TOKEN,
} = require('./config');
const { forgejoRequest } = require('./forgejo');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const QUEUE_NAME = 'publish_requests';
const RECONNECT_DELAY_MS = 5000;

// ---------------------------------------------------------------------------
// GPLv3 reference text (loaded once at startup)
// ---------------------------------------------------------------------------

const GPL3_TEXT = fs.readFileSync(path.join(__dirname, 'gpl-3.0.txt'), 'utf-8');

const normalizeWhitespace = (text) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
const GPL3_NORMALIZED = normalizeWhitespace(GPL3_TEXT);

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
 * Check whether a file exists at a given commit in a Forgejo repo.
 * Returns the file content (decoded from base64) or null if not found.
 */
const getFileAtCommit = async (owner, repo, filepath, commitSha) => {
    try {
        const refParam = commitSha ? `?ref=${commitSha}` : '';
        console.log(`[worker] Fetching file: ${owner}/${repo}/${filepath} @ ${commitSha}`);
        const data = await forgejoRequest('GET', `/repos/${owner}/${repo}/contents/${filepath}${refParam}`);
        console.log(`[worker] Response for ${filepath}:`, data ? `got data (content length: ${(data.content || '').length})` : 'null/empty');
        if (data && data.content) {
            return Buffer.from(data.content, 'base64').toString('utf-8');
        }
        return null;
    } catch (err) {
        console.log(`[worker] Error fetching ${filepath}:`, JSON.stringify(err));
        return null;
    }
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LICENSE_FILENAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'];

const validatePublishRequest = async (gameId, commitSha) => {
    // Look up game to get Forgejo repo info
    const games = await getCollection('games');
    const game = await games.findOne({ gameId });

    if (!game) {
        return { success: false, error: `Game ${gameId} not found` };
    }

    if (!game.forgejoRepo) {
        return { success: false, error: `Game ${gameId} has no repository` };
    }

    const [owner, repo] = game.forgejoRepo.split('/');

    // 1. Check index.js exists
    const indexContent = await getFileAtCommit(owner, repo, 'index.js', commitSha);
    if (indexContent === null) {
        return { success: false, error: 'index.js not found at this version' };
    }

    // 2. Check GPLv3 license
    let licenseFound = false;
    let licenseError = null;

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

    return { success: true };
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

    console.log(`[worker] Processing publish request ${requestId} for game ${gameId} @ ${commitSha.substring(0, 7)}`);

    const publishRequests = await getCollection('publishRequests');

    try {
        // Mark as processing
        await publishRequests.updateOne({ requestId }, { $set: { status: 'PROCESSING' } });

        // Validate
        const result = await validatePublishRequest(gameId, commitSha);

        if (result.success) {
            // Create a published game version
            const gameVersions = await getCollection('gameVersions');
            const versionId = generateId();

            await gameVersions.insertOne({
                versionId,
                gameId,
                commitSha,
                publishedAt: Date.now(),
                publishedBy: userId,
                published: true,
            });

            // Update publish request status
            await publishRequests.updateOne({ requestId }, {
                $set: { status: 'PUBLISHED', versionId, completedAt: Date.now() }
            });

            console.log(`[worker] ✓ Published version ${versionId} for game ${gameId}`);
        } else {
            // Update publish request with failure
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

    // Verify MongoDB
    try {
        const client = getMongoClient();
        await client.connect();
        console.log('[worker] MongoDB connected');
    } catch (err) {
        console.error('[worker] MongoDB connection failed:', err.message);
        process.exit(1);
    }

    // Start consuming
    startConsumer();
};

main().catch((err) => {
    console.error('[worker] Fatal error:', err);
    process.exit(1);
});
