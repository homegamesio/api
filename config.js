const process = require('process');

const CERT_DOMAIN = process.env.CERT_DOMAIN || 'homegames.link';

const JOB_QUEUE_NAME = process.env.JOB_QUEUE_NAME || 'homegames-jobs';

// DEPRECATED: LLM "modify my game" requests now ride the unified
// JOB_QUEUE_NAME queue as { type: 'LLM_REQUEST', ... } (see
// handleSubmitLLMRequest). Kept only to avoid breaking any external reference;
// nothing in this codebase publishes here anymore.
const LLM_QUEUE_NAME = process.env.LLM_QUEUE_NAME || 'llm_requests';

// Shared secret the self-hosted MLX worker uses to post results back to the
// API. NOT a user JWT — this authenticates the worker, not a person.
const LLM_WORKER_SECRET = process.env.LLM_WORKER_SECRET || '';

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

// 6 MB max per asset
const MAX_SIZE = 6 * 1024 * 1024;

module.exports = {
    CERT_DOMAIN,
    JOB_QUEUE_NAME,
    LLM_QUEUE_NAME,
    LLM_WORKER_SECRET,
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
};
