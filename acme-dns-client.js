'use strict';
// The RFC 8555 operations used by the durable certificate runner. No automatic
// order retries: a lost response must remain an operator-review case.
const { createPrivateKey, createPublicKey, createHash, sign } = require('node:crypto');
const { Resolver } = require('node:dns/promises');
const { setTimeout: delay } = require('node:timers/promises');

class AcmeDnsClient {
    constructor({ directoryUrl, accountKey, signal, fetch = globalThis.fetch, pollMs = 2000 }) {
        this.directoryUrl = directoryUrl; this.origin = new URL(directoryUrl).origin;
        if (new URL(directoryUrl).protocol !== 'https:') throw new Error('ACME directory must use HTTPS');
        this.signal = signal; this.fetch = fetch; this.pollMs = pollMs;
        this.key = createPrivateKey(accountKey);
        const publicKey = createPublicKey(this.key).export({ format: 'jwk' });
        if (publicKey.kty === 'RSA' && this.key.asymmetricKeyDetails.modulusLength >= 2048) {
            this.alg = 'RS256'; this.hash = 'sha256';
            this.jwk = { e: publicKey.e, kty: 'RSA', n: publicKey.n };
        } else if (publicKey.kty === 'EC' && ['P-256', 'P-384', 'P-521'].includes(publicKey.crv)) {
            const bits = { 'P-256': 256, 'P-384': 384, 'P-521': 512 }[publicKey.crv];
            this.alg = `ES${bits}`; this.hash = `sha${bits}`;
            this.jwk = { crv: publicKey.crv, kty: 'EC', x: publicKey.x, y: publicKey.y };
        } else throw new Error('Unsupported ACME account key');
        this.thumbprint = createHash('sha256').update(JSON.stringify(this.jwk)).digest('base64url');
    }
    url(value) {
        const url = new URL(value);
        if (url.origin !== this.origin || url.username || url.password || url.hash || value.length > 4096) {
            throw new Error('ACME endpoint must belong to the configured CA origin');
        }
        return url.href;
    }
    async request(url, options = {}) {
        this.signal.throwIfAborted();
        const response = await this.fetch(this.url(url), { ...options, redirect: 'error',
            signal: AbortSignal.any([this.signal, AbortSignal.timeout(30000)]) });
        const chunks = []; let size = 0;
        // Bound the body even when Content-Length is absent or dishonest.
        try {
            if (response.body) for await (const chunk of response.body) {
                size += chunk.length;
                if (size > 262144) throw new Error('ACME response too large');
                chunks.push(Buffer.from(chunk));
            }
        } finally { if (!response.bodyUsed) await response.body?.cancel(); }
        const nonce = response.headers.get('replay-nonce');
        this.nonce = nonce && /^[A-Za-z0-9_-]{1,1024}$/.test(nonce) ? nonce : null;
        return { status: response.status, headers: response.headers, text: Buffer.concat(chunks).toString() };
    }
    async directory() {
        if (!this.endpoints) {
            const response = await this.request(this.directoryUrl);
            if (response.status !== 200) throw new Error(`ACME directory HTTP ${response.status}`);
            const data = JSON.parse(response.text);
            for (const field of ['newAccount', 'newOrder', 'newNonce']) this.url(data[field]);
            if (data.meta?.externalAccountRequired) throw new Error('This CA requires external account binding');
            this.endpoints = data;
        }
        return this.endpoints;
    }
    async post(url, payload, useJwk = false) {
        const endpoints = await this.directory();
        this.url(url);
        if (!useJwk && !this.accountUrl) throw new Error('ACME account is not initialized');
        for (let attempt = 0; attempt < 4; attempt++) {
            this.signal.throwIfAborted();
            if (!this.nonce) {
                const response = await this.request(endpoints.newNonce, { method: 'HEAD' });
                if (![200, 204].includes(response.status) || !this.nonce) throw new Error('ACME nonce unavailable');
            }
            const header = { alg: this.alg, nonce: this.nonce, url,
                ...(useJwk ? { jwk: this.jwk } : { kid: this.accountUrl }) };
            this.nonce = null;
            const protectedValue = Buffer.from(JSON.stringify(header)).toString('base64url');
            const encoded = payload === undefined ? '' : Buffer.from(JSON.stringify(payload)).toString('base64url');
            const signature = sign(this.hash, Buffer.from(`${protectedValue}.${encoded}`),
                { key: this.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
            const response = await this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/jose+json' },
                body: JSON.stringify({ protected: protectedValue, payload: encoded, signature }) });
            if (response.status >= 200 && response.status < 300) return response;
            let type; try { type = JSON.parse(response.text).type; } catch (_) {}
            // badNonce explicitly means the CA rejected the request. Network
            // errors, 429 and 5xx are never retried here.
            if (type === 'urn:ietf:params:acme:error:badNonce' && attempt < 3) continue;
            throw new Error(`ACME request failed (HTTP ${response.status})`);
        }
    }
    async createAccount(payload) {
        const response = await this.post((await this.directory()).newAccount, payload, true);
        const account = JSON.parse(response.text);
        if (account.status !== 'valid') throw new Error('ACME account is not valid');
        this.accountUrl = this.url(response.headers.get('location'));
        return account;
    }
    getAccountUrl() { return this.accountUrl; }
    async createOrder(payload) {
        const response = await this.post((await this.directory()).newOrder, payload);
        return { ...JSON.parse(response.text), url: this.url(response.headers.get('location')) };
    }
    async getAuthorizations(order) {
        if (!Array.isArray(order.authorizations) || order.authorizations.length !== 1) throw new Error('Unexpected ACME authorizations');
        return Promise.all(order.authorizations.map(async url => ({ ...JSON.parse((await this.post(url)).text), url })));
    }
    async getChallengeKeyAuthorization(challenge) {
        if (challenge.type !== 'dns-01' || !/^[A-Za-z0-9_-]{22,256}$/.test(challenge.token)) throw new Error('Invalid DNS challenge token');
        return createHash('sha256').update(`${challenge.token}.${this.thumbprint}`).digest('base64url');
    }
    async verifyChallenge(authz, challenge) {
        const value = await this.getChallengeKeyAuthorization(challenge);
        const resolver = new Resolver({ timeout: 2000, tries: 1 });
        const abort = () => resolver.cancel(); this.signal.addEventListener('abort', abort, { once: true });
        try {
            for (let attempt = 0; attempt < 30; attempt++) {
                this.signal.throwIfAborted();
                try {
                    const records = await resolver.resolveTxt(`_acme-challenge.${authz.identifier.value}`);
                    if (records.some(parts => parts.join('') === value)) return;
                } catch (err) { if (!['ENODATA', 'ENOTFOUND', 'ETIMEOUT', 'ESERVFAIL'].includes(err.code)) throw err; }
                await delay(this.pollMs, null, { signal: this.signal });
            }
            throw new Error('DNS challenge propagation timed out');
        } finally { resolver.cancel(); this.signal.removeEventListener('abort', abort); }
    }
    async completeChallenge(challenge) { return JSON.parse((await this.post(challenge.url, {})).text); }
    async poll(url, statuses) {
        for (let attempt = 0; attempt < 60; attempt++) {
            const response = await this.post(url), data = JSON.parse(response.text);
            if (statuses.includes(data.status)) return { ...data, url };
            if (!['pending', 'processing', 'ready'].includes(data.status)) throw new Error('ACME resource became invalid');
            const retry = response.headers.get('retry-after');
            const ms = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : this.pollMs;
            await delay(Math.max(this.pollMs, Math.min(Number.isFinite(ms) ? ms : this.pollMs, 30000)), null, { signal: this.signal });
        }
        throw new Error('ACME polling timed out');
    }
    async waitForValidStatus(resource) { return this.poll(resource.url, ['valid']); }
    async finalizeOrder(order, csr) {
        const ready = await this.poll(order.url, ['ready', 'valid']);
        if (ready.status === 'valid') return ready;
        const { Pkcs10CertificateRequest } = require('@peculiar/x509');
        const der = new Pkcs10CertificateRequest(csr).rawData;
        await this.post(ready.finalize, { csr: Buffer.from(der).toString('base64url') });
        return this.poll(order.url, ['valid']);
    }
    async getCertificate(order) {
        const response = await this.post(order.certificate);
        if (!response.headers.get('content-type')?.startsWith('application/pem-certificate-chain')) throw new Error('Invalid ACME certificate response');
        return response.text;
    }
}
module.exports = { AcmeDnsClient };
