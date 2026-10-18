#!/usr/bin/env node
'use strict';
// Local operator tool, intentionally not an HTTP administration endpoint.
const fs = require('node:fs/promises');
const { certificateDatabase } = require('../certificate-database');
const { CertificateStore } = require('../certificate-store');
const { importLegacy, completeReviewed, retryReviewed } = require('../certificate-operations');
const usage = 'Usage: node scripts/certificates.js inspect [requestId] | cleanup requestId | complete requestId certificate.pem | retry requestId --reviewed reason | migrate-broker queue --old-worker-stopped';
async function main(args = process.argv.slice(2)) {
    const [command, id, extra, reason] = args;
    if (!['inspect','cleanup','complete','retry','migrate-broker'].includes(command)) throw new Error(usage);
    const db = certificateDatabase(), store = new CertificateStore(db); let owner;
    try {
        const jobs = await db.collection('certificateRequests');
        if (command === 'inspect') {
            const rows = await jobs.find(id ? { _id: id } : { $or: [{ state: { $ne: 'COMPLETED' } }, { cleanupPending: true }] }, { projection: {
                _id: 1, domain: 1, state: 1, phase: 1, startedAt: 1, updatedAt: 1, cleanupPending: 1, orderUrl: 1 } }).limit(100).toArray();
            console.log(JSON.stringify(rows, null, 2)); return;
        }
        await store.initialize(); owner = await store.acquire();
        if (!owner) throw new Error('Certificate runner is active. Stop issuance before running this operation.');
        // Keep the global lease while inspecting a bounded queue/performing DNS.
        const timer = setInterval(() => { void store.heartbeat(owner).catch(() => {}); }, 30000);
        try {
            if (command === 'migrate-broker') {
                if (!id || extra !== '--old-worker-stopped') throw new Error(usage);
                const { createRequire } = require('node:module'), path = require('node:path');
                const amqp = createRequire(path.join(__dirname, '../legacy/package.json'))('amqplib');
                const connection = await amqp.connect(process.env.QUEUE_URL || `amqp://${process.env.QUEUE_HOST || 'localhost'}`, { timeout: 10000 });
                connection.on('error', () => {});
                try {
                    const channel = await connection.createChannel(); channel.on('error', () => {});
                    const queue = await channel.checkQueue(id);
                    if (queue.consumerCount) throw new Error('Queue still has a consumer; stop the old worker first');
                    const held = []; let imported = 0, deferred = 0, heldBytes = 0;
                    try {
                        for (let n = 0; n < Math.min(queue.messageCount, 1000); n++) {
                            await store.heartbeat(owner);
                            const message = await channel.get(id, { noAck: false }); if (!message) break;
                            held.push(message); heldBytes += message.content.length;
                            if (heldBytes > 32 * 1024 * 1024) { deferred++; break; }
                            if (message.content.length > 100000) { deferred++; continue; }
                            let data;
                            try { data = JSON.parse(message.content.toString()); }
                            catch (_) { throw new Error('Invalid legacy JSON message; it remains queued for review'); }
                            if (data.type !== 'CERT_REQUEST') { deferred++; continue; }
                            const result = await importLegacy(store, data, process.env.CERT_DOMAIN || 'homegames.link');
                            if (result.acknowledge) { channel.ack(message); held.pop(); heldBytes -= message.content.length; imported++; } else deferred++;
                        }
                    } finally { for (const message of held) channel.nack(message, false, true); }
                    console.log(JSON.stringify({ imported, deferred, cappedAt: 1000 }));
                } finally { await connection.close(); }
                return;
            }
            const job = await jobs.findOne({ _id: id }); if (!job) throw new Error('Unknown request');
            if (command === 'cleanup') {
                if (!job.cleanupPending || !job.challenge) throw new Error('No saved DNS challenge needs cleanup');
                const config = require('../certificate-config').certificateConfig();
                const { createIssuer, route53Dns } = require('../certificate-issuer');
                const issuer = createIssuer({ dns: route53Dns(config), config });
                try { await issuer.cleanup(job, job.challenge); } finally { issuer.close(); }
                await jobs.updateOne({ _id: id }, { $set: { cleanupPending: false } });
            } else if (command === 'complete') await completeReviewed(store, job, await fs.readFile(extra, 'utf8'));
            else if (extra === '--reviewed') await retryReviewed(store, job, reason);
            else throw new Error(usage);
            console.log(JSON.stringify({ requestId: id, action: command, completed: true }));
        } finally { clearInterval(timer); }
    } finally { if (owner) await store.release(owner).catch(() => {}); await db.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
