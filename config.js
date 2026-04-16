const process = require('process');

const CERT_DOMAIN = process.env.CERT_DOMAIN || 'homegames.link';

const JOB_QUEUE_NAME = process.env.JOB_QUEUE_NAME || 'homegames-jobs';

const SourceType = {
    GITHUB: 'GITHUB'
};

const poolData = {
    UserPoolId: process.env.COGNITO_USER_POOL_ID
};

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

const JWT_SECRET = process.env.JWT_SECRET || 'hello world!';

const AUTH_TYPE = process.env.AUTH_TYPE || 'mongo';

const FORGEJO_URL = process.env.FORGEJO_URL || 'http://52.32.110.71:3000';
const FORGEJO_ADMIN_TOKEN = process.env.FORGEJO_ADMIN_TOKEN || '';
const FORGEJO_WEBHOOK_SECRET = process.env.FORGEJO_WEBHOOK_SECRET || '';
const FORGEJO_USER_SECRET = process.env.FORGEJO_USER_SECRET || 'change-me-forgejo-user-secret';
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'http://localhost:80';

// 50 MB max
const MAX_SIZE = 50 * 1024 * 1024;

module.exports = {
    CERT_DOMAIN,
    JOB_QUEUE_NAME,
    SourceType,
    poolData,
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
    FORGEJO_ADMIN_TOKEN,
    FORGEJO_WEBHOOK_SECRET,
    FORGEJO_USER_SECRET,
    API_PUBLIC_URL,
};
