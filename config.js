const process = require('process');

const CERT_DOMAIN = process.env.CERT_DOMAIN || 'homegames.link';

const JOB_QUEUE_NAME = process.env.JOB_QUEUE_NAME || 'homegames-jobs';

// DEPRECATED: LLM "modify my game" requests now ride the unified
// JOB_QUEUE_NAME queue as { type: 'LLM_REQUEST', ... } (see
// handleSubmitLLMRequest). Kept only to avoid breaking any external reference;
// nothing in this codebase publishes here anymore.

// Shared secret the self-hosted LLM worker uses to post results back to the
// API. NOT a user JWT — this authenticates the worker, not a person.
const LLM_WORKER_SECRET = process.env.LLM_WORKER_SECRET || '';

// AI "modify my game" edits. Off by default: locally-hosted models aren't
// good/fast enough for full game generation yet. The studio UI is gated by
// its own AI_FEATURES_ENABLED flag; this gates the endpoint itself.
const AI_EDITS_ENABLED = process.env.AI_EDITS_ENABLED === 'true';

// The docs "ask something" assistant (general Q&A about Homegames grounded in
// the knowledge doc — answered by the same LLM worker, never generates games).
// On by default; set DOCS_ASSISTANT_ENABLED=false to turn the endpoint off.
const DOCS_ASSISTANT_ENABLED = process.env.DOCS_ASSISTANT_ENABLED !== 'false';

const CERTS_ENABLED = process.env.CERTS_ENABLED || false;

const DB_TYPE = process.env.DB_TYPE || 'local';

const AWS_ROUTE_53_HOSTED_ZONE_ID = process.env.AWS_ROUTE_53_HOSTED_ZONE_ID;

const QUEUE_HOST = process.env.QUEUE_HOST || 'localhost';

const SALT_ROUNDS = process.env.SALT_ROUNDS || 10;

const HASH_ITERATIONS = process.env.HASH_ITERATIONS || 100000;
const HASH_KEY_LENGTH = process.env.HASH_KEY_LENGTH || 64;
const HASH_DIGEST = process.env.HASH_DIGEST || 'sha512';

const DB_HOST = process.env.DB_HOST;
const DB_PORT = process.env.DB_PORT;
const DB_USERNAME = process.env.DB_USERNAME || '';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'homegames';

const JWT_SECRET = process.env.JWT_SECRET || '';

if (!JWT_SECRET) {
    console.error('Fatal: JWT_SECRET environment variable is not set. Exiting.');
    process.exit(1);
}

const AUTH_TYPE = process.env.AUTH_TYPE || 'mongo';

const FORGEJO_URL = 'http://52.32.110.71:3000';//process.env.FORGEJO_URL || 'http://localhost:3000';
const FORGEJO_WEBHOOK_SECRET = process.env.FORGEJO_WEBHOOK_SECRET || '';
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'http://localhost:80';
const HOMENAMES_URL = process.env.HOMENAMES_URL || 'http://localhost:7400';

// Shared secret for internal-only Homenames session endpoints (teardown,
// persistence toggle). Presented as a Bearer token on behalf of an
// authenticated admin — NOT a user JWT, and never sent to the browser. Must
// match HOMENAMES_API_SECRET on the core/Homenames side. When empty, Homenames
// leaves those endpoints ungated (local/LAN dev).
const HOMENAMES_API_SECRET = process.env.HOMENAMES_API_SECRET || '';

// Public URL of the website (homegamesio) — used to build links in emails and
// to redirect to after email verification.
const WEB_PUBLIC_URL = process.env.WEB_PUBLIC_URL || 'http://localhost:80';

// AWS SES (transactional email — developer signup verification).
// SES_FROM_ADDRESS must be a verified SES identity; if unset, verification
// emails are skipped (the link is logged) so local/dev signup still works.
const SES_REGION = process.env.SES_REGION || 'us-east-1';
const SES_FROM_ADDRESS = process.env.SES_FROM_ADDRESS || '';

// 6 MB max per asset
const MAX_SIZE = 6 * 1024 * 1024;

module.exports = {
    CERT_DOMAIN,
    JOB_QUEUE_NAME,
    LLM_WORKER_SECRET,
    AI_EDITS_ENABLED,
    DOCS_ASSISTANT_ENABLED,
    CERTS_ENABLED,
    DB_TYPE,
    AWS_ROUTE_53_HOSTED_ZONE_ID,
    QUEUE_HOST,
    SALT_ROUNDS,
    HASH_ITERATIONS,
    HASH_KEY_LENGTH,
    HASH_DIGEST,

    DB_HOST,
    DB_PORT,
    DB_USERNAME,
    DB_PASSWORD,
    DB_NAME,
    JWT_SECRET,
    AUTH_TYPE,
    MAX_SIZE,
    FORGEJO_URL,
    FORGEJO_WEBHOOK_SECRET,
    API_PUBLIC_URL,
    HOMENAMES_URL,
    HOMENAMES_API_SECRET,
    WEB_PUBLIC_URL,
    SES_REGION,
    SES_FROM_ADDRESS,
};
