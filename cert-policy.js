'use strict';
const { createHash } = require('crypto');
const normalizeDomain = name => typeof name === 'string' ? name.toLowerCase().replace(/\.$/, '') : '';
function validateCsr(acme, csr, ip, domain) {
    if (typeof ip !== 'string' || !ip || typeof csr !== 'string' || csr.length > 32768) throw new Error('Invalid certificate request');
    const expected = `${createHash('md5').update(ip).digest('hex')}.${normalizeDomain(domain)}`;
    let names;
    try { names = acme.crypto.readCsrDomains(csr); } catch (_) { throw new Error('Invalid CSR'); }
    const all = [names.commonName, ...(names.altNames || [])];
    if (!names.commonName || all.some(name => normalizeDomain(name) !== expected)) {
        throw new Error('Every CSR identifier must match the domain assigned to this network');
    }
    const der = Buffer.from(csr.replace(/-----[^\n]+-----/g, '').replace(/\s/g, ''), 'base64');
    const csrHash = createHash('sha256').update(der).digest('hex');
    return { domain: expected, csrHash };
}
module.exports = { normalizeDomain, validateCsr };
