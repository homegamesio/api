'use strict';
const { createHash } = require('crypto');
const { Pkcs10CertificateRequest, SubjectAlternativeNameExtension } = require('@peculiar/x509');
const normalizeDomain = name => typeof name === 'string' ? name.toLowerCase().replace(/\.$/, '') : '';
function certificateNames(input) {
    const names = input.subjectName.getField('CN');
    const extensions = input.extensions.filter(extension => extension.type === '2.5.29.17');
    if (extensions.length > 1) throw new Error('Duplicate subject alternative names');
    for (const extension of extensions) {
        for (const name of new SubjectAlternativeNameExtension(extension.rawData).names.items) {
            if (name.type !== 'dns') throw new Error('Only DNS identifiers are permitted');
            names.push(name.value);
        }
    }
    return names;
}
function validateCsr(csr, ip, domain) {
    if (typeof ip !== 'string' || !ip || typeof csr !== 'string' || csr.length > 32768) throw new Error('Invalid certificate request');
    const expected = `${createHash('md5').update(ip).digest('hex')}.${normalizeDomain(domain)}`;
    let request, names;
    try { request = new Pkcs10CertificateRequest(csr); names = certificateNames(request); } catch (_) { throw new Error('Invalid CSR'); }
    if (!request.subjectName.getField('CN').length || names.some(name => normalizeDomain(name) !== expected)) {
        throw new Error('Every CSR identifier must match the domain assigned to this network');
    }
    const der = Buffer.from(request.rawData);
    const csrHash = createHash('sha256').update(der).digest('hex');
    return { domain: expected, csrHash };
}
module.exports = { normalizeDomain, validateCsr, certificateNames };
