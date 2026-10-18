#!/usr/bin/env node
'use strict';
// Run on the API host with Node 24. Uses only the staging CA, a generated
// staging database, a private account key, and ephemeral loopback listeners.
// State is retained so rerunning resumes the SAME requests after a failure.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), https = require('node:https');
const { randomUUID, X509Certificate, createPrivateKey, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { certificateDatabase } = require('../certificate-database');
const { createConnectionService } = require('../connection-service');
const { createServer } = require('../index');
const { createCsr } = require('../test/create-csr');
const { route53Dns, validateIssuedCertificate } = require('../certificate-issuer');
const STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

function serviceDatabaseEnv(unit) {
    if (process.platform !== 'linux' || unit !== 'hg-api.service') throw new Error('Only the existing hg-api.service is supported');
    const pid = execFileSync('systemctl', ['show', unit, '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
    if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('The API service is not running');
    const allowed = new Set(['MONGODB_URI', 'DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_AUTH_SOURCE']);
    return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map(row => {
        const at = row.indexOf('='); return [row.slice(0, at), row.slice(at + 1)];
    }).filter(([key]) => allowed.has(key)));
}
function writePrivate(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
}
async function verifyHttps(chain, key, domain) {
    const leaf = new X509Certificate(chain);
    assert(leaf.checkPrivateKey(createPrivateKey(key)), 'Issued certificate must match the server key');
    assert(leaf.checkHost(domain, { wildcards: false }), 'Issued certificate must match the network hostname');
    const server = https.createServer({ cert: chain, key }, (req, res) => res.end('homegames-staging-ready'));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
        const body = await new Promise((resolve, reject) => {
            // Trust this staging chain for this one probe only. Never change
            // machine/browser trust or NODE_TLS_REJECT_UNAUTHORIZED.
            const request = https.get({ host: '127.0.0.1', port: server.address().port, servername: domain,
                ca: chain, allowPartialTrustChain: true, agent: false, timeout: 10000 }, res => {
                let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve(text)); res.on('error', reject);
            });
            request.on('error', reject); request.on('timeout', () => request.destroy(new Error('HTTPS probe timed out')));
        });
        assert.equal(body, 'homegames-staging-ready');
    } finally { await new Promise(resolve => server.close(resolve)); }
}
async function runStaging({ env = process.env, dependencies = {}, log = console.log } = {}) {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Run this check with Node 24 or newer');
    if (!env.ACME_EMAIL || !env.AWS_ROUTE_53_HOSTED_ZONE_ID) throw new Error('Set ACME_EMAIL and AWS_ROUTE_53_HOSTED_ZONE_ID');
    const root = path.resolve(env.HG_CERT_STAGING_DIR || path.join(os.homedir(), 'homegames-cert-staging'));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const filename = path.join(root, 'run.json');
    let state;
    if (fs.existsSync(filename)) state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    else {
        state = { schema: 1, runId: randomUUID(), requests: [] };
        state.database = 'homegames_cert_staging_' + state.runId.replace(/-/g, '');
        writePrivate(filename, state);
    }
    assert(state.schema === 1 && /^homegames_cert_staging_[a-f0-9]{32}$/.test(state.database), 'Invalid staging state; use a fresh staging directory');
    const settings = { ...env, DB_NAME: state.database, CERTS_ENABLED: 'true', CERT_DOMAIN: env.CERT_DOMAIN || 'homegames.link',
        ACME_DIRECTORY_URL: STAGING, ACME_ACCOUNT_KEY_PATH: path.join(root, 'acme-account.pem'),
        CERT_LEASE_MS: '30000', CERT_POLL_MS: '500', CERT_TIMEOUT_MS: '300000', RTC_ENABLED: 'false', RTC_TRUST_PROXY: 'false' };
    const db = certificateDatabase(settings);
    const dns = dependencies.dns || route53Dns({ zoneId: settings.AWS_ROUTE_53_HOSTED_ZONE_ID, region: settings.AWS_REGION || 'us-west-2' });
    let server, service, base;
    const start = async () => {
        service = createConnectionService(settings, dependencies);
        server = createServer({ env: settings, service, rtc: false });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        base = `http://127.0.0.1:${server.address().port}`;
    };
    const request = async (route, body) => {
        const response = await fetch(base + route, { method: body ? 'POST' : 'GET',
            headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        const data = await response.json();
        if (!response.ok) throw new Error(`Staging API HTTP ${response.status}: ${data.error}`);
        return data;
    };
    const poll = async id => {
        const until = Date.now() + 330000; let last;
        while (Date.now() < until) {
            const current = await request('/cert-status?requestId=' + encodeURIComponent(id));
            if (current.needsReview || current.status === 'MIGRATION_REQUIRED') throw new Error(`Request ${id} needs operator review. State was preserved; do not start a new run.`);
            if (current.status === 'FAILED') throw new Error(`Request ${id} failed`);
            if (current.cert) return current;
            const job = await (await db.collection('certificateRequests')).findOne({ _id: id }, { projection: { phase: 1, state: 1 } });
            const phase = job?.phase || job?.state || 'waiting';
            if (phase !== last) { log(`Certificate ${id}: ${phase}`); last = phase; }
            await delay(1500);
        }
        throw new Error(`Request ${id} timed out. State was preserved; rerun with the same staging directory.`);
    };
    log(`Staging state: ${root}\nStaging database: ${state.database}`);
    try {
        // A completed issuance can outlive a timed-out DNS cleanup. Reuse the
        // real operator recovery command on THIS run's staging records before
        // starting the test API. No CA order is created by cleanup.
        for (const saved of state.requests) {
            const job = await (await db.collection('certificateRequests')).findOne({ _id: saved.id });
            if (job?.state === 'COMPLETED' && job.cleanupPending) {
                log(`Recovering saved DNS cleanup for ${saved.id}`);
                execFileSync(process.execPath, [path.join(__dirname, 'certificates.js'), 'cleanup', saved.id],
                    { env: settings, stdio: 'inherit', timeout: 150000 });
            }
        }
        await start();
        const initial = await request('/cert-status');
        assert.equal(initial.certificatesEnabled, true);
        assert.equal(initial.certIp, '127.0.0.1');
        if (state.domain) assert.equal(initial.certDomain, state.domain, 'Staging certificate domain changed');
        state.domain = initial.certDomain;
        const name = `_acme-challenge.${state.domain}.`;
        // Record the original values once, including on retry after a failed run.
        if (!state.originalTxt) {
            state.originalTxt = (await dns.read(name, AbortSignal.timeout(15000)))?.ResourceRecords || [];
            writePrivate(filename, state);
        }
        while (state.requests.length < 2) {
            const [key, csr] = await createCsr({ commonName: state.domain });
            state.requests.push({ id: randomUUID(), key: key.toString(), csr: csr.toString() });
            writePrivate(filename, state);
        }
        const certificates = [];
        for (const [index, saved] of state.requests.entries()) {
            const body = { csr: saved.csr, requestId: saved.id };
            await request('/request-cert', body);
            await request('/request-cert', body); // Simulate a lost submission acknowledgement.
            const issued = await poll(saved.id), chain = Buffer.from(issued.cert, 'base64').toString();
            await validateIssuedCertificate(chain, saved.csr, state.domain);
            await verifyHttps(chain, saved.key, state.domain);
            const row = await (await db.collection('certificateRequests')).findOne({ _id: saved.id });
            assert.equal(row.state, 'COMPLETED');
            assert.equal(row.cleanupPending, false, 'DNS cleanup must finish before accepting the test');
            assert.equal(await (await db.collection('certificateAttempts')).countDocuments({ requestId: saved.id }), 1, 'Duplicate submissions must share one issuance attempt');
            certificates.push(chain);
            log(`PASS: server ${index + 1}, duplicate request, matching certificate/key/hostname and HTTPS handshake`);
            await server.shutdown(); server = null;
            await start();
            const recovered = await request('/cert-status?requestId=' + saved.id);
            assert.equal(recovered.cert, issued.cert, 'API restart must preserve the issued certificate');
            log(`PASS: API restart retrieves server ${index + 1}'s saved certificate`);
        }
        assert.notEqual(new X509Certificate(certificates[0]).fingerprint256, new X509Certificate(certificates[1]).fingerprint256);
        assert.equal(new X509Certificate(certificates[0]).checkPrivateKey(createPrivateKey(state.requests[1].key)), false);
        assert.equal((await request('/cert-status?requestId=' + state.requests[0].id)).cert, Buffer.from(certificates[0]).toString('base64'));
        assert.equal((await service.status('192.0.2.99', state.requests[0].id)).certFound, false);
        const after = (await dns.read(name, AbortSignal.timeout(15000)))?.ResourceRecords || [];
        for (const record of state.originalTxt) assert(after.some(item => item.Value === record.Value), 'Existing DNS TXT values must be preserved');
        for (const saved of state.requests) {
            const row = await (await db.collection('certificateRequests')).findOne({ _id: saved.id });
            assert(!after.some(item => item.Value === JSON.stringify(row.challenge?.value)), 'Challenge TXT value must be removed');
            assert(!JSON.stringify(row).includes('PRIVATE KEY'), 'Server private keys must stay outside MongoDB');
        }
        const report = { passed: true, completedAt: new Date().toISOString(), node: process.version, directory: STAGING,
            database: state.database, domain: state.domain, requests: state.requests.map(({ id }) => id),
            fingerprints: certificates.map(cert => new X509Certificate(cert).fingerprint256) };
        writePrivate(path.join(root, 'report.json'), report);
        log('PASS: separate server keys on one network, request ownership, DNS cleanup and durable retrieval');
        return report;
    } finally { await server?.shutdown(); await db.close(); dns.close?.(); }
}
if (require.main === module) {
    const args = process.argv.slice(2);
    let env = process.env;
    try {
        if (args.length) {
            if (args.length !== 2 || args[0] !== '--from-service') throw new Error('Usage: node scripts/check-certificate-staging.cjs [--from-service hg-api.service]');
            env = { ...serviceDatabaseEnv(args[1]), ...env };
        }
        runStaging({ env }).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
            console.error(error.message); process.exitCode = 1;
        });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { runStaging, verifyHttps, serviceDatabaseEnv, STAGING };
