'use strict';

// Local syntax validation only: no SSH, service changes or runtime secrets.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const filename = process.argv[2] || path.join(__dirname, '../deploy/deployment.env');
let values = {};
try { values = parseEnv(fs.readFileSync(filename, 'utf8')); }
catch (error) {
    if (error.code !== 'ENOENT' || process.argv[2]) {
        console.error('Cannot read deployment environment file.');
        process.exit(1);
    }
}
const absolutePath = value => path.posix.isAbsolute(value) && value !== '/' && !/[\r\n\0]/.test(value);
const fields = [
    ['HG_DEPLOY_SSH_TARGET', value => /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[0-9a-fA-F:]+\])$/.test(value), 'an SSH alias or user@host (configure SSH options separately)'],
    ['HG_DEPLOY_CHECKOUT', absolutePath, 'an absolute remote checkout/release path'],
    ['HG_DEPLOY_SYSTEMD_UNIT', value => /^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*\.service$/.test(value), 'a systemd unit ending in .service'],
    ['HG_DEPLOY_ENV_FILE', absolutePath, 'an absolute remote runtime environment-file path'],
    ['HG_DEPLOY_STAGING_MODE', value => ['separate-instance', 'isolated-service'].includes(value), 'separate-instance or isolated-service'],
    ['HG_DEPLOY_PUBLIC_URL', value => {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
        } catch (_) { return false; }
    }, 'an HTTPS origin without credentials, a path, query or fragment']
];
let invalid = false;
for (const [name, validate, expected] of fields) {
    const value = process.env[name] ?? values[name];
    if (typeof value !== 'string' || !value || value.trim() !== value || !validate(value)) {
        console.error(`${name}: set ${expected}.`);
        invalid = true;
    }
}
if (invalid) process.exitCode = 1;
else console.log('Deployment coordinates are valid. No host was contacted. Remote paths, staging isolation, systemd/nginx and live certificate acceptance still need verification.');
