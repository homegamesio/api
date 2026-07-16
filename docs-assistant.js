const crypto = require('crypto');
const { getReqBody } = require('./helpers');
const { generateId } = require('./crypto');
const { getMongoCollection } = require('./db');

// ---------------------------------------------------------------------------
// Docs assistant ("ask something" box on docs.html).
//
// Public, unauthenticated Q&A about Homegames and how to make games. Questions
// are queued as DOCS_QUESTION jobs on the unified homegames-jobs queue; the
// self-hosted LLM worker answers them grounded in the knowledge doc
// (homegames-common/docs/homegames-knowledge.md) and posts results back to
// /internal/docs-answer. The assistant answers questions — it never generates
// or edits games (AI game edits are gated separately by AI_EDITS_ENABLED).
//
// The backing model runs on a single home machine, so this endpoint is
// deliberately stingy: short questions, per-IP limits, and a global in-flight
// cap so a burst can't queue an hour of work.
// ---------------------------------------------------------------------------

const MAX_QUESTION_LENGTH = 500;
const MAX_ANSWER_LENGTH = 20000;
const MAX_IN_FLIGHT = 20;

// Mirrors handlers.js getClientIP: nginx appends the peer IP, so the rightmost
// X-Forwarded-For hop is the only trustworthy value.
const getClientIP = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const hops = forwarded.split(',').map(h => h.trim()).filter(Boolean);
        if (hops.length) return hops[hops.length - 1];
    }
    return req.socket?.remoteAddress || 'unknown';
};

const ipHash = (ip) => crypto.createHash('md5').update(ip).digest('hex');

// Same shape as handlers.js rateLimit (module-local copy to keep this
// self-contained): fixed window per IP with periodic eviction.
const rateLimit = (windowMs, max) => {
    const clients = new Map();
    const interval = setInterval(() => {
        const now = Date.now();
        for (const [ip, entry] of clients) {
            if (now - entry.start > windowMs * 2) clients.delete(ip);
        }
    }, windowMs);
    if (interval.unref) interval.unref();
    return (ip) => {
        const now = Date.now();
        let entry = clients.get(ip);
        if (!entry || now - entry.start > windowMs) {
            entry = { count: 0, start: now };
            clients.set(ip, entry);
        }
        entry.count++;
        return entry.count <= max;
    };
};

const burstLimiter = rateLimit(30 * 1000, 1);            // 1 question per 30s per IP
const dailyLimiter = rateLimit(24 * 60 * 60 * 1000, 30); // 30 questions per day per IP

const enqueueDocsQuestion = (requestId, question) => new Promise((resolve, reject) => {
    const amqp = require('amqplib/callback_api');
    const { QUEUE_HOST, JOB_QUEUE_NAME } = require('./config');

    // frameMax=0 for the same broker-handshake reason as the LLM publish path
    // (see studio-handlers.js / worker/index.js).
    amqp.connect(`amqp://${QUEUE_HOST}?frameMax=0`, (cErr, conn) => {
        if (cErr) { reject(cErr); return; }
        conn.on('error', (e) => reject(e));
        conn.createConfirmChannel((chErr, channel) => {
            if (chErr) {
                try { conn.close(); } catch (e) {}
                reject(chErr);
                return;
            }
            channel.assertQueue(JOB_QUEUE_NAME, { durable: true });
            channel.sendToQueue(
                JOB_QUEUE_NAME,
                Buffer.from(JSON.stringify({ type: 'DOCS_QUESTION', requestId, question })),
                { persistent: true },
                (confErr) => {
                    if (confErr) reject(confErr); else resolve();
                    channel.close(() => { try { conn.close(); } catch (e) {} });
                }
            );
        });
    });
});

// POST /docs/ask  { question } -> { requestId, status }
const handleAskDocs = (req, res) => {
    const { DOCS_ASSISTANT_ENABLED } = require('./config');
    if (!DOCS_ASSISTANT_ENABLED) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'The docs assistant is currently offline' }));
        return;
    }

    const ip = getClientIP(req);
    if (!burstLimiter(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'One question at a time — try again in a moment' }));
        return;
    }
    if (!dailyLimiter(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Daily question limit reached — try again tomorrow' }));
        return;
    }

    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end('Error reading request'); return; }

        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
        }

        const question = (body.question || '').trim();
        if (question.length < 3) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'question is required' }));
            return;
        }
        if (question.length > MAX_QUESTION_LENGTH) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: `question must be ${MAX_QUESTION_LENGTH} characters or fewer` }));
            return;
        }

        getMongoCollection('docsQuestions').then(collection => {
            collection.countDocuments({ status: { $in: ['PENDING', 'PROCESSING'] } }).then(inFlight => {
                if (inFlight >= MAX_IN_FLIGHT) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'The assistant is busy right now — try again in a few minutes' }));
                    return;
                }

                const requestId = generateId();
                const record = {
                    requestId,
                    question,
                    ipHash: ipHash(ip),
                    status: 'PENDING',
                    created: Date.now(),
                };

                collection.insertOne(record).then(() => {
                    enqueueDocsQuestion(requestId, question).then(() => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ requestId, status: 'PENDING' }));
                    }).catch(qErr => {
                        console.error('Failed to enqueue docs question', qErr);
                        collection.updateOne(
                            { requestId },
                            { $set: { status: 'FAILED', error: 'queue unavailable', completedAt: Date.now() } }
                        ).catch(() => {});
                        res.writeHead(503, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'The assistant is unavailable right now' }));
                    });
                }).catch(insErr => {
                    console.error('Failed to create docs question record', insErr);
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to create question' }));
                });
            }).catch(() => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Database error' }));
            });
        }).catch(() => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Database error' }));
        });
    });
};

// GET /docs/ask/:id -> { status, answer?, error? }
const handleGetDocsAnswer = (req, res, requestId) => {
    if (!requestId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'requestId is required' }));
        return;
    }

    getMongoCollection('docsQuestions').then(collection => {
        collection.findOne({ requestId }).then(record => {
            if (!record) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'No question with that id' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                requestId: record.requestId,
                status: record.status,
                answer: record.answer || null,
                error: record.status === 'FAILED' ? (record.error || 'Unknown error') : null,
            }));
        }).catch(() => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Database error' }));
        });
    }).catch(() => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Database error' }));
    });
};

// POST /internal/docs-answer  (worker -> API, LLM_WORKER_SECRET bearer)
// { requestId, status: 'COMPLETED'|'FAILED', answer?, error? }
const handleDocsAnswerResult = (req, res) => {
    const { LLM_WORKER_SECRET } = require('./config');

    const auth = req.headers.authorization || '';
    if (!LLM_WORKER_SECRET || auth !== `Bearer ${LLM_WORKER_SECRET}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }

    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end('Error reading request'); return; }

        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
        }

        const { requestId, status, answer, error } = body;
        if (!requestId || !['COMPLETED', 'FAILED'].includes(status)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'requestId and a valid status are required' }));
            return;
        }
        if (status === 'COMPLETED' && typeof answer !== 'string') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'answer is required for COMPLETED status' }));
            return;
        }

        const update = status === 'COMPLETED'
            ? { status, answer: answer.slice(0, MAX_ANSWER_LENGTH) }
            : { status, error: error || 'Unknown error' };

        getMongoCollection('docsQuestions').then(collection => {
            collection.updateOne(
                { requestId, status: { $in: ['PENDING', 'PROCESSING'] } },
                { $set: { ...update, completedAt: Date.now() } }
            ).then(r => {
                if (r.matchedCount === 0) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'No in-flight question with that id' }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                }
            }).catch(() => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Database error' }));
            });
        }).catch(() => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Database error' }));
        });
    });
};

module.exports = {
    handleAskDocs,
    handleGetDocsAnswer,
    handleDocsAnswerResult,
};
