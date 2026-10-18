'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { validateCsr } = require('./cert-policy');
const { validateIssuedCertificate } = require('./certificate-issuer');
const { REVIEW } = require('./certificate-store');

async function importLegacy(store, data, domain = 'homegames.link') {
    if (data?.type !== 'CERT_REQUEST') throw new Error('Only certificate messages can be imported');
    const csr = typeof data.cert === 'string' ? data.cert : data.cert?.type === 'Buffer' && Array.isArray(data.cert.data) ? Buffer.from(data.cert.data).toString() : '';
    const policy = validateCsr(csr, data.ip, domain);
    const id = data.requestId || createHash('sha256').update(data.ip + '\n' + csr).digest('hex');
    if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) throw new Error('Invalid legacy request ID');
    const jobs = await store.db.collection('certificateRequests');
    const old = await jobs.findOne({ _id: id });
    if (old && (old.ip !== data.ip || old.csrHash !== policy.csrHash)) throw new Error('Legacy request identity conflict');
    if (old?.state) return { requestId: id, state: old.state, acknowledge: old.state !== 'INTERRUPTED' };
    const cert = await (await store.db.collection('certificates')).findOne({ _id: id, ip: data.ip, csrHash: policy.csrHash });
    const previous = await (await store.db.collection('workerJobs')).findOne({ _id: `CERT_REQUEST:${id}` });
    const result = await (await store.db.collection('workerResults')).findOne({ _id: `CERT_REQUEST:${id}` });
    const attempt = await (await store.db.collection('workerAttempts')).findOne({ jobId: `CERT_REQUEST:${id}` });
    const ambiguous = !!(previous?.attempts || result || attempt);
    const record = { ip: data.ip, csr, csrHash: policy.csrHash, domain: policy.domain, createdAt: old?.createdAt || store.now(),
        state: cert ? 'COMPLETED' : ambiguous ? 'INTERRUPTED' : 'QUEUED', active: !cert, importedAt: store.now(),
        ...(ambiguous && !cert ? { error: REVIEW, phase: 'LEGACY_REVIEW' } : {}) };
    await jobs.updateOne({ _id: id, state: { $exists: false } }, { $set: record }, { upsert: !old });
    // An ambiguous message retains its old account key in the original broker
    // payload for operator recovery. No account/private key is copied to Mongo.
    return { requestId: id, state: record.state, acknowledge: !ambiguous || !!cert };
}
async function completeReviewed(store, job, cert) {
    if (!['INTERRUPTED', undefined].includes(job.state)) throw new Error('Only interrupted or legacy requests can be reconciled');
    if (!job.csr || !job.domain) throw new Error('Import the matching legacy CSR before reconciling');
    const expiresAt = await validateIssuedCertificate(cert, job.csr, job.domain);
    await store.finish({ ...job, owner: 'review-' + randomUUID() }, { certRecord: { _id: job._id, ip: job.ip, csrHash: job.csrHash,
        domain: job.domain, expiresAt, cert: Buffer.from(cert).toString('base64'), createdAt: store.now() } });
}
async function retryReviewed(store, job, reason) {
    if (job.state !== 'INTERRUPTED' || job.cleanupPending || typeof reason !== 'string' || reason.trim().length < 8) {
        throw new Error('Retry requires an interrupted request, completed DNS cleanup and a meaningful review reason');
    }
    if (await (await store.db.collection('certificates')).findOne({ _id: job._id })) throw new Error('A certificate already exists; reconcile it instead');
    await (await store.db.collection('certificateReviews')).insertOne({ _id: randomUUID(), requestId: job._id,
        reviewedAt: store.now(), reason: reason.trim(), priorOwner: job.owner, priorOrderUrl: job.orderUrl || null });
    await (await store.db.collection('certificateRequests')).updateOne({ _id: job._id, state: 'INTERRUPTED' },
        { $set: { state: 'QUEUED', active: true, reviewedAt: store.now() }, $unset: { owner: '', error: '', phase: '', orderUrl: '', accountUrl: '' } });
}
module.exports = { importLegacy, completeReviewed, retryReviewed };
