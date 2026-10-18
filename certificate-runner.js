'use strict';
const { setTimeout: delay } = require('node:timers/promises');

class CertificateRunner {
    constructor({ store, prepareIssuer, pollMs = 2000, timeoutMs = 300000, sleep = delay, log = console.error }) {
        Object.assign(this, { store, prepareIssuer, pollMs, timeoutMs, sleep, log });
        this.shutdown = new AbortController(); this.state = 'starting'; this.active = null;
    }
    health() { return { enabled: true, state: this.state, processing: !!this.active }; }
    start() {
        if (!this.task) this.task = this.loop();
        return this.task;
    }
    async loop() {
        while (!this.shutdown.signal.aborted) {
            try {
                await (this.initialized ||= this.store.initialize().catch(error => { this.initialized = null; throw error; }));
                if (await this.runOnce()) continue;
            } catch (_) {
                this.state = 'degraded';
                this.log('[certificates] runner unavailable; retrying. Check database, account key and DNS configuration.');
            }
            await this.sleep(this.pollMs, null, { signal: this.shutdown.signal }).catch(() => {});
        }
        this.state = 'stopped';
    }
    async runOnce() {
        const issuer = this.issuer = await this.prepareIssuer();
        const owner = await this.store.acquire();
        if (!owner) { this.state = 'standby'; return false; }
        const controller = new AbortController(), abort = () => controller.abort(new Error('Certificate runner stopping'));
        this.shutdown.signal.addEventListener('abort', abort, { once: true });
        if (this.shutdown.signal.aborted) abort();
        let heartbeat, deadline, renewing = false;
        try {
            await this.store.recover();
            if (controller.signal.aborted) return false;
            const job = await this.store.claim(owner);
            this.state = 'ready';
            if (!job) return false;
            this.active = job._id;
            heartbeat = setInterval(async () => {
                if (renewing) return; renewing = true;
                try { await this.store.heartbeat(owner); } catch (_) { controller.abort(new Error('Lease lost')); }
                finally { renewing = false; }
            }, Math.floor(this.store.leaseMs / 3));
            deadline = setTimeout(() => controller.abort(new Error('Certificate deadline')), this.timeoutMs);
            let result;
            try {
                const cached = await (await this.store.db.collection('certificates')).findOne({ ip: job.ip, csrHash: job.csrHash,
                    expiresAt: { $gt: this.store.now() + 14 * 86400000 } }, { sort: { expiresAt: -1 } });
                if (cached) await require('./certificate-issuer').validateIssuedCertificate(Buffer.from(cached.cert, 'base64'), job.csr, job.domain);
                result = cached ? { certRecord: { ...cached, _id: job._id, createdAt: this.store.now() } }
                    : await issuer.issue(job, controller.signal, fields => this.store.checkpoint(job, fields));
            } catch (_) { result = { interrupted: true }; }
            clearTimeout(deadline);
            // Keep the same result while Mongo is unavailable, never call the CA
            // again because acknowledgement failed. Shutdown leaves a durable
            // RUNNING attempt for review if it cannot persist within the grace.
            while (true) {
                try { await this.store.finish(job, result); break; }
                catch (err) {
                    if (this.shutdown.signal.aborted) throw err;
                    this.state = 'degraded';
                    this.log('[certificates] retaining completed attempt while database persistence retries');
                    await this.sleep(this.pollMs, null, { signal: this.shutdown.signal }).catch(() => {});
                }
            }
            this.state = 'ready'; return true;
        } finally {
            clearInterval(heartbeat); clearTimeout(deadline); this.active = null;
            this.shutdown.signal.removeEventListener('abort', abort);
            await this.store.release(owner).catch(() => {});
        }
    }
    async stop() { this.shutdown.abort(); await this.task; this.issuer?.close?.(); this.state = 'stopped'; }
}
module.exports = { CertificateRunner };
