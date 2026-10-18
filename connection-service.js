'use strict';
const { createHash, randomUUID, webcrypto } = require('node:crypto');
const { Resolver } = require('node:dns/promises');
const { validateCsr } = require('./cert-policy');
const { CertificateStore, failure } = require('./certificate-store');
const { certificateDatabase } = require('./certificate-database');
function createConnectionService(env = process.env, dependencies = {}) {
    const enabled = env.CERTS_ENABLED === 'true', domain = env.CERT_DOMAIN || 'homegames.link';
    const db = dependencies.db || certificateDatabase(env), store = dependencies.store || new CertificateStore(db);
    const certDomain = ip => `${createHash('md5').update(ip).digest('hex')}.${domain}`;
    let runner, initialized, startingError;
    const initialize = () => initialized ||= store.initialize().catch(err => { initialized = null; throw err; });
    return {
        start() {
            if (!enabled || runner || startingError) return;
            try {
                const config = require('./certificate-config').certificateConfig(env);
                store.leaseMs = config.leaseMs;
                let prepared;
                const prepareIssuer = dependencies.prepareIssuer || (() => prepared ||= (async () => {
                    const { loadAccountKey, createIssuer, route53Dns } = require('./certificate-issuer');
                    return createIssuer({ config, accountKey: await loadAccountKey(config.accountKeyPath), dns: route53Dns(config) });
                })().catch(err => { prepared = null; throw err; }));
                const { CertificateRunner } = require('./certificate-runner');
                runner = new CertificateRunner({ store, prepareIssuer, pollMs: config.pollMs, timeoutMs: config.timeoutMs });
                void runner.start();
            } catch (_) {
                startingError = true;
                console.error('[certificates] invalid configuration; issuance intake disabled. Check certificate deployment settings.');
            }
        },
        health() { return enabled ? runner?.health() || { enabled: true, state: startingError ? 'misconfigured' : 'starting', processing: false } : { enabled: false }; },
        async request(ip, csr, suppliedId) {
            if (!enabled) throw failure('Certificates are disabled', 503);
            if (startingError) throw failure('Certificate service is not configured', 503);
            let policy;
            try {
                policy = validateCsr(csr, ip, domain);
                const { Pkcs10CertificateRequest } = require('@peculiar/x509');
                if (!await new Pkcs10CertificateRequest(csr).verify(webcrypto)) throw new Error('Invalid CSR signature');
            } catch (err) { throw failure(err.message, 400); }
            const requestId = suppliedId || randomUUID();
            if (typeof requestId !== 'string' || !/^[\w-]{1,128}$/.test(requestId)) throw failure('Invalid requestId', 400);
            await initialize();
            const existing = await (await db.collection('certificates')).findOne({ _id: requestId });
            if (existing) {
                if (existing.ip !== ip || existing.csrHash !== policy.csrHash) throw failure('Certificate request ID already used');
                return { submitted: true, requestId, status: 'COMPLETED' };
            }
            const job = await store.enqueue({ _id: requestId, ip, csr, csrHash: policy.csrHash, domain: policy.domain });
            return { submitted: true, requestId, status: job.state || 'MIGRATION_REQUIRED' };
        },
        async status(ip, requestId) {
            const body = { certFound: false, certificatesEnabled: enabled, certExpiration: null, certIp: ip,
                requestId: requestId || null, certDomain: certDomain(ip), dnsAlias: null };
            if (!enabled) return { ...body, requestId: null };
            if (requestId && !/^[\w-]{1,128}$/.test(requestId)) throw failure('Invalid requestId', 400);
            const filter = { ip, ...(requestId ? { _id: requestId } : {}), expiresAt: { $gt: Date.now() } }, sort = { sort: { createdAt: -1, expiresAt: -1 } };
            let record = await (await db.collection('certificates')).findOne(filter, sort);
            if (!record && !requestId) record = await (await db.collection('certs')).findOne(filter, sort);
            if (record) Object.assign(body, { certFound: true, certExpiration: record.expiresAt, cert: record.cert, status: 'COMPLETED' });
            else if (requestId) {
                const job = await (await db.collection('certificateRequests')).findOne({ _id: requestId, ip });
                if (job?.state) Object.assign(body, { status: job.state === 'INTERRUPTED' ? 'FAILED' : job.state,
                    jobState: job.state, ...(job.state === 'INTERRUPTED' ? { error: job.error, needsReview: true } : {}) });
                else {
                    const result = await (await db.collection('workerResults')).findOne({ _id: `CERT_REQUEST:${requestId}`, ip });
                    if (result?.result?.status === 'FAILED') Object.assign(body, { status: 'FAILED', error: 'Legacy certificate issuance failed; contact the operator.' });
                    else if (job) body.status = 'MIGRATION_REQUIRED';
                }
            }
            try {
                const resolver = new Resolver({ timeout: 1000, tries: 1 });
                body.dnsAlias = (await (dependencies.resolve4 || (name => resolver.resolve4(name)))(body.certDomain))[0] || null;
            } catch (_) { /* DNS availability must not hide a saved certificate. */ }
            return body;
        },
        async close() { await runner?.stop(); await db.close?.(); },
    };
}
module.exports = { createConnectionService };
