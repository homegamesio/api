'use strict';
const path = require('node:path');
function certificateConfig(env = process.env) {
    const integer = (name, fallback, min, max) => {
        const value = Number(env[name] ?? fallback);
        if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
        return value;
    };
    const directory = env.ACME_DIRECTORY_URL;
    if (!directory || new URL(directory).protocol !== 'https:') throw new Error('ACME_DIRECTORY_URL must explicitly select an HTTPS ACME directory');
    if (!env.ACME_EMAIL || !env.AWS_ROUTE_53_HOSTED_ZONE_ID) throw new Error('ACME_EMAIL and AWS_ROUTE_53_HOSTED_ZONE_ID are required');
    const accountKeyPath = env.ACME_ACCOUNT_KEY_PATH || '/var/lib/homegames-api/acme-account.pem';
    if (!path.isAbsolute(accountKeyPath)) throw new Error('ACME_ACCOUNT_KEY_PATH must be absolute');
    return { directory, email: env.ACME_EMAIL, zoneId: env.AWS_ROUTE_53_HOSTED_ZONE_ID, accountKeyPath,
        domain: env.CERT_DOMAIN || 'homegames.link', region: env.AWS_REGION || 'us-east-1',
        timeoutMs: integer('CERT_TIMEOUT_MS', 300000, 1000, 600000), pollMs: integer('CERT_POLL_MS', 2000, 100, 60000),
        leaseMs: integer('CERT_LEASE_MS', 120000, 30000, 600000) };
}
module.exports = { certificateConfig };
