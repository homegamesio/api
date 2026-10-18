'use strict';
const { randomUUID } = require('node:crypto');
const failure = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const REVIEW = 'Certificate issuance was interrupted. The operator must review ACME and DNS state before retrying.';

class CertificateStore {
    constructor(db, { now = Date.now, leaseMs = 120000 } = {}) { Object.assign(this, { db, now, leaseMs }); }
    async initialize() {
        const jobs = await this.db.collection('certificateRequests');
        // Legacy requests have no active field and are deliberately excluded.
        await jobs.createIndex({ domain: 1 }, { unique: true, partialFilterExpression: { active: true }, name: 'one_active_certificate_per_domain' });
        await jobs.createIndex({ state: 1, createdAt: 1 });
        await (await this.db.collection('certificateAttempts')).createIndex({ projected: 1 });
        await (await this.db.collection('certificates')).createIndex({ ip: 1, csrHash: 1, expiresAt: -1 });
    }
    async enqueue(data) {
        const jobs = await this.db.collection('certificateRequests');
        const known = await jobs.findOne({ _id: data._id });
        if (known) {
            if (known.ip !== data.ip || known.csrHash !== data.csrHash) throw failure('Certificate request ID already used');
            return known;
        }
        if (await jobs.countDocuments({ active: true }, { limit: 1000 }) >= 1000) throw failure('Certificate queue is full', 503);
        try {
            await jobs.insertOne({ ...data, state: 'QUEUED', active: true, createdAt: this.now(), updatedAt: this.now() });
        } catch (err) {
            if (err.code !== 11000) throw err;
            const prior = await jobs.findOne({ _id: data._id });
            if (!prior) throw failure('A certificate request for this network is already pending or awaiting review.');
            if (prior.ip !== data.ip || prior.csrHash !== data.csrHash) throw failure('Certificate request ID already used');
            // Never turn an old broker request into a second ACME order.
            return prior;
        }
        return jobs.findOne({ _id: data._id });
    }
    async acquire() {
        const locks = await this.db.collection('workerLocks'), owner = randomUUID();
        try {
            await locks.updateOne({ _id: 'api-certificate-runner', leaseUntil: { $lte: this.now() } },
                { $set: { owner, leaseUntil: this.now() + this.leaseMs } }, { upsert: true });
            return owner;
        } catch (err) { if (err.code === 11000) return null; throw err; }
    }
    async heartbeat(owner) {
        const result = await (await this.db.collection('workerLocks')).updateOne(
            { _id: 'api-certificate-runner', owner, leaseUntil: { $gt: this.now() } }, { $set: { leaseUntil: this.now() + this.leaseMs } });
        if (!result.matchedCount) throw new Error('Certificate runner lease lost');
    }
    async release(owner) { await (await this.db.collection('workerLocks')).deleteOne({ _id: 'api-certificate-runner', owner }); }
    async check(job) {
        const lock = await (await this.db.collection('workerLocks')).findOne({ _id: 'api-certificate-runner', owner: job.owner, leaseUntil: { $gt: this.now() } });
        const current = await (await this.db.collection('certificateRequests')).findOne({ _id: job._id, owner: job.owner, state: 'RUNNING' });
        if (!lock || !current) throw new Error('Certificate attempt no longer owns its lease');
    }
    async checkpoint(job, fields) {
        await this.check(job);
        const result = await (await this.db.collection('certificateRequests')).updateOne({ _id: job._id, owner: job.owner, state: 'RUNNING' },
            { $set: { ...fields, updatedAt: this.now() } });
        if (!result.matchedCount) throw new Error('Certificate attempt changed');
    }
    async recover() {
        const jobs = await this.db.collection('certificateRequests');
        const attempts = await this.db.collection('certificateAttempts');
        for (const attempt of await attempts.find({ projected: false, 'result.certRecord': { $exists: true } }).toArray()) {
            const job = await jobs.findOne({ _id: attempt.requestId });
            if (job) {
                await this.finish(job, attempt.result);
                await attempts.updateOne({ _id: attempt._id }, { $set: { projected: true } });
            }
        }
        for (const job of await jobs.find({ state: 'RUNNING' }).toArray()) {
            const cert = await (await this.db.collection('certificates')).findOne({ _id: job._id, ip: job.ip, csrHash: job.csrHash });
            if (cert) await this.finish(job, { certRecord: cert });
            else await jobs.updateOne({ _id: job._id, state: 'RUNNING', owner: job.owner },
                { $set: { state: 'INTERRUPTED', error: REVIEW, updatedAt: this.now() } });
        }
    }
    async claim(owner) {
        await this.heartbeat(owner);
        return (await this.db.collection('certificateRequests')).findOneAndUpdate({ state: 'QUEUED' },
            { $set: { state: 'RUNNING', owner, startedAt: this.now(), updatedAt: this.now() } },
            { sort: { createdAt: 1 }, returnDocument: 'after', includeResultMetadata: false });
    }
    async finish(job, result) {
        // A returned certificate survives failures in the remaining writes.
        // A late completion may be retained even after lease loss; never issue
        // another order to recover a missing acknowledgement.
        await (await this.db.collection('certificateAttempts')).updateOne({ _id: `${job._id}:${job.owner}` },
            { $setOnInsert: { requestId: job._id, result, projected: false, completedAt: this.now() } }, { upsert: true });
        if (result.certRecord) await (await this.db.collection('certificates')).updateOne({ _id: job._id },
            { $setOnInsert: result.certRecord }, { upsert: true });
        await (await this.db.collection('certificateRequests')).updateOne({ _id: job._id, ip: job.ip, csrHash: job.csrHash,
            ...(!result.certRecord ? { owner: job.owner, state: 'RUNNING' } : {}) },
            { $set: { state: result.certRecord ? 'COMPLETED' : 'INTERRUPTED', active: !result.certRecord,
                error: result.certRecord ? null : REVIEW, updatedAt: this.now() } });
        await (await this.db.collection('certificateAttempts')).updateOne({ _id: `${job._id}:${job.owner}` }, { $set: { projected: true } });
    }
}
module.exports = { CertificateStore, failure, REVIEW };
