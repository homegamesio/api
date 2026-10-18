#!/usr/bin/env node
'use strict';
// Run as the API service user before enabling production issuance. Reads Mongo
// without creating indexes or changing records. Backup files are private EJSON.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { BSON } = require('mongodb');
const { certificateDatabase } = require('../certificate-database');

const filters = {
    certificateRequests: {}, certificates: {}, certs: {}, certificateAttempts: {}, certificateReviews: {},
    workerJobs: { _id: /^CERT_REQUEST:/ }, workerResults: { _id: /^CERT_REQUEST:/ },
    workerAttempts: { jobId: /^CERT_REQUEST:/ }, workerLocks: { _id: 'api-certificate-runner' }
};

async function backup({ env, root = path.join(os.homedir(), 'homegames-cert-backups'), db = certificateDatabase(env) }) {
    let directory;
    try {
        if (env.CERTS_ENABLED === 'true') throw new Error('Disable certificate issuance before taking the cutover backup');
        directory = path.join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const counts = {};
        for (const [name, filter] of Object.entries(filters)) {
            const records = await (await db.collection(name)).find(filter).limit(10001).toArray();
            if (records.length > 10000) throw new Error('Certificate collection exceeds this cutover backup limit');
            fs.writeFileSync(path.join(directory, name + '.ejson'), BSON.EJSON.stringify(records, { relaxed: false }),
                { mode: 0o600, flag: 'wx' });
            counts[name] = records.length;
        }
        // This marker is written last. A partial directory is never accepted
        // as a complete backup. Restoration is an explicit operator decision.
        fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ schema: 1,
            complete: true, createdAt: new Date().toISOString(), counts }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        return { directory, counts };
    } finally { await db.close(); }
}

function serviceEnv() {
    if (process.platform !== 'linux') throw new Error('Run on the EC2 API host');
    const pid = execFileSync('systemctl', ['show', 'hg-api.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
    if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('API is not running');
    if (Number(process.versions.node.split('.')[0]) !== 24
        || fs.realpathSync(`/proc/${pid}/exe`) !== fs.realpathSync(process.execPath)) {
        throw new Error('The API must be running the same Node 24 runtime as this backup command');
    }
    const allowed = new Set(['MONGODB_URI', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USERNAME', 'DB_PASSWORD', 'DB_AUTH_SOURCE', 'CERTS_ENABLED']);
    return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map(row => {
        const at = row.indexOf('='); return [row.slice(0, at), row.slice(at + 1)];
    }).filter(([key]) => allowed.has(key)));
}

if (require.main === module) {
    Promise.resolve().then(() => backup({ env: serviceEnv() })).then(result => console.log(JSON.stringify({ ...result, apiRuntime: process.version }, null, 2)))
        .catch(() => { console.error('Certificate backup failed. Keep issuance disabled; no credentials were printed.'); process.exitCode = 1; });
}
module.exports = { backup };
