'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const { X509Certificate, createPrivateKey, generateKeyPair, randomUUID, webcrypto } = require('node:crypto');
const { promisify } = require('node:util');
const { AcmeDnsClient } = require('./acme-dns-client');
const { setTimeout: delay } = require('node:timers/promises');
const { validateCsr, normalizeDomain, certificateNames } = require('./cert-policy');

async function loadAccountKey(filename) {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    try { await fs.lstat(filename); }
    catch (err) {
        if (err.code !== 'ENOENT') throw err;
        const temporary = filename + '.' + randomUUID();
        try {
            const handle = await fs.open(temporary, 'wx', 0o600);
            try {
                const pair = await promisify(generateKeyPair)('rsa', { modulusLength: 2048 });
                await handle.writeFile(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })); await handle.sync();
            } finally { await handle.close(); }
            try { await fs.link(temporary, filename); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally { await fs.unlink(temporary).catch(() => {}); }
    }
    const info = await fs.lstat(filename);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('ACME account key must be a regular private file (0600)');
    const key = await fs.readFile(filename); createPrivateKey(key); return key;
}

// Every awaited network step is abortable, and the following step checks the
// durable owner again. A timeout never falls through into another ACME action.
function abortable(task, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
async function validateIssuedCertificate(cert, csr, domain) {
    const { Pkcs10CertificateRequest } = require('@peculiar/x509');
    const request = new Pkcs10CertificateRequest(csr), leaf = new X509Certificate(cert);
    const names = certificateNames(new (require('@peculiar/x509').X509Certificate)(leaf.raw));
    if (!await request.verify(webcrypto) || !Buffer.from(request.publicKey.rawData).equals(leaf.publicKey.export({ type: 'spki', format: 'der' }))
        || !names.length || names.some(name => normalizeDomain(name) !== domain)
        || !leaf.checkHost(domain, { wildcards: false }) || Date.parse(leaf.validTo) <= Date.now()
        || Date.parse(leaf.validFrom) > Date.now() + 300000) throw new Error('CA certificate does not match the request');
    return Date.parse(leaf.validTo);
}

function createIssuer({ Client = AcmeDnsClient, dns, config, accountKey, now = Date.now }) {
    const nameFor = job => `_acme-challenge.${job.domain}.`;
    async function cleanup(job, challenge) {
        if (challenge.name !== nameFor(job) || !/^[A-Za-z0-9_-]{20,128}$/.test(challenge.value)) throw new Error('Invalid saved DNS challenge');
        // Route 53 changes commonly need tens of seconds to reach INSYNC.
        // Keep cleanup bounded, but allow the same propagation window as a
        // challenge write. A saved challenge remains available after failure.
        const signal = AbortSignal.timeout(120000);
        const current = await dns.read(challenge.name, signal);
        if (!current) return;
        const remaining = current.ResourceRecords.filter(record => record.Value !== JSON.stringify(challenge.value));
        if (remaining.length === current.ResourceRecords.length) return;
        await dns.change(remaining.length ? 'UPSERT' : 'DELETE', remaining.length ? { ...current, ResourceRecords: remaining } : current, signal);
    }
    return {
        cleanup,
        close: () => dns.close?.(),
        async issue(job, signal, checkpoint) {
            const policy = validateCsr(job.csr, job.ip, config.domain);
            if (policy.csrHash !== job.csrHash || policy.domain !== job.domain) throw new Error('Saved certificate policy mismatch');
            const step = async (phase, task) => {
                if (signal.aborted) throw signal.reason;
                await checkpoint({ phase });
                return abortable(task, signal);
            };
            const client = new Client({ directoryUrl: config.directory, accountKey, signal });
            await step('ACCOUNT', () => client.createAccount({ termsOfServiceAgreed: true, contact: [`mailto:${config.email}`] }));
            // Persist the intent before creation, then the returned order URL.
            // A lost createOrder response is an operator-review case.
            const order = await step('ORDER', () => client.createOrder({ identifiers: [{ type: 'dns', value: job.domain }] }));
            await checkpoint({ orderUrl: order.url, accountUrl: client.getAccountUrl(), directory: config.directory });
            const authzs = await step('AUTHORIZATIONS', () => client.getAuthorizations(order));
            for (const authz of authzs) {
                if (authz.identifier?.type !== 'dns' || normalizeDomain(authz.identifier.value) !== job.domain || authz.wildcard) throw new Error('Unauthorized ACME identifier');
                if (authz.status === 'valid') continue;
                const challenge = authz.challenges.find(item => item.type === 'dns-01');
                if (!challenge) throw new Error('DNS challenge unavailable');
                const value = await step('CHALLENGE', () => client.getChallengeKeyAuthorization(challenge));
                if (!/^[A-Za-z0-9_-]{20,128}$/.test(value)) throw new Error('Invalid DNS challenge');
                const saved = { name: nameFor(job), value };
                await checkpoint({ challenge: saved, cleanupPending: true });
                try {
                    const current = await step('DNS_READ', () => dns.read(saved.name, signal));
                    const values = [...(current?.ResourceRecords || [])];
                    if (!values.some(item => item.Value === JSON.stringify(value))) values.push({ Value: JSON.stringify(value) });
                    await step('DNS_WRITE', () => dns.change('UPSERT', { Name: saved.name, Type: 'TXT', TTL: current?.TTL || 60, ResourceRecords: values }, signal));
                    await step('DNS_VERIFY', () => client.verifyChallenge(authz, challenge));
                    await step('CHALLENGE_COMPLETE', () => client.completeChallenge(challenge));
                    await step('CHALLENGE_WAIT', () => client.waitForValidStatus(challenge));
                } finally {
                    try { await cleanup(job, saved); await checkpoint({ cleanupPending: false }); }
                    catch (_) { /* Saved challenge enables explicit cleanup after restart/outage. */ }
                }
            }
            const finalized = await step('FINALIZE', () => client.finalizeOrder(order, job.csr));
            const cert = await step('DOWNLOAD', () => client.getCertificate(finalized));
            const expiresAt = await validateIssuedCertificate(cert, job.csr, job.domain);
            return { certRecord: { _id: job._id, ip: job.ip, csrHash: job.csrHash, domain: job.domain,
                expiresAt, cert: Buffer.from(cert).toString('base64'), createdAt: now() } };
        },
    };
}

function route53Dns(config) {
    const { Route53Client, ListResourceRecordSetsCommand, ChangeResourceRecordSetsCommand, GetChangeCommand } = require('@aws-sdk/client-route-53');
    const client = new Route53Client({ region: config.region, maxAttempts: 2 });
    return {
        close: () => client.destroy(),
        async read(name, signal) {
            const response = await client.send(new ListResourceRecordSetsCommand({ HostedZoneId: config.zoneId,
                StartRecordName: name, StartRecordType: 'TXT', MaxItems: 1 }), { abortSignal: signal });
            return response.ResourceRecordSets.find(item => item.Name.toLowerCase() === name && item.Type === 'TXT') || null;
        },
        async change(action, record, signal) {
            const response = await client.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: config.zoneId,
                ChangeBatch: { Changes: [{ Action: action, ResourceRecordSet: record }] } }), { abortSignal: signal });
            for (let attempt = 0; attempt < 60; attempt++) {
                const status = await client.send(new GetChangeCommand({ Id: response.ChangeInfo.Id }), { abortSignal: signal });
                if (status.ChangeInfo.Status === 'INSYNC') return;
                await delay(2000, null, { signal });
            }
            throw new Error('DNS propagation timed out');
        },
    };
}
module.exports = { loadAccountKey, createIssuer, route53Dns, validateIssuedCertificate, abortable };
