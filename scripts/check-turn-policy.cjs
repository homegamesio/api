'use strict';
// Bounded live checks using normal, temporary API credentials. Never reads the
// server secret. CREATE_PERMISSION sends no packets to the listed peer IPs.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const { createRequire } = require('node:module');
const WebSocket = createRequire(require.resolve('homegames-common/rtc-signaling'))('ws');
const endpoint = process.argv[2] || 'wss://api.homegames.io/rtc';
const checks = [], sockets = [];
const notes = [];
let signaling, realm, stage = 'API credentials';
function credentials() {
    return new Promise((resolve, reject) => {
        signaling = new WebSocket(endpoint);
        const timer = setTimeout(() => reject(Error('Signaling timed out')), 15000);
        const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
        signaling.on('error', error => finish(error));
        signaling.on('open', () => signaling.send(JSON.stringify({ type: 'create' })));
        signaling.on('message', raw => {
            try {
                const message = JSON.parse(raw);
                if (message.type === 'error') return finish(Error(message.message));
                if (message.type !== 'created') return;
                for (const server of message.iceServers || []) {
                    const url = [].concat(server.urls || []).find(value => /^turn:.*\?transport=udp$/.test(value));
                    if (url) return finish(null, { ...server, url: new URL(url.replace(/^turn:/, 'turn://')) });
                }
                finish(Error('No UDP TURN credentials advertised'));
            } catch (error) { finish(error); }
        });
    });
}
const attr = (type, value) => {
    const header = Buffer.alloc(4); header.writeUInt16BE(type); header.writeUInt16BE(value.length, 2);
    return Buffer.concat([header, value, Buffer.alloc((4 - value.length % 4) % 4)]);
};
function packet(type, attrs, auth) {
    const body = Buffer.concat([...attrs, ...(auth ? [attr(6, Buffer.from(auth.username)), attr(0x14, Buffer.from(realm)), attr(0x15, auth.nonce)] : [])]);
    const header = Buffer.alloc(20); header.writeUInt16BE(type); header.writeUInt16BE(body.length + (auth ? 24 : 0), 2);
    header.writeUInt32BE(0x2112a442, 4); crypto.randomFillSync(header, 8, 12);
    const unsigned = Buffer.concat([header, body]);
    if (!auth) return unsigned;
    const key = crypto.createHash('md5').update(auth.username + ':' + realm + ':' + auth.password).digest();
    return Buffer.concat([unsigned, attr(8, crypto.createHmac('sha1', key).update(unsigned).digest())]);
}
function parse(buffer) {
    assert(buffer.length >= 20 && buffer.readUInt32BE(4) === 0x2112a442, 'Valid STUN header');
    assert.equal(buffer.readUInt16BE(2), buffer.length - 20);
    const attrs = new Map();
    for (let offset = 20; offset + 4 <= buffer.length;) {
        const type = buffer.readUInt16BE(offset), length = buffer.readUInt16BE(offset + 2);
        assert(offset + 4 + length <= buffer.length, 'Valid STUN attribute');
        attrs.set(type, buffer.subarray(offset + 4, offset + 4 + length)); offset += 4 + Math.ceil(length / 4) * 4;
    }
    const error = attrs.get(9);
    return { type: buffer.readUInt16BE(0), attrs, error: error ? error[2] * 100 + error[3] : null };
}
async function client(url) {
    const socket = dgram.createSocket('udp4'); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.connect(Number(url.port || 3478), url.hostname, resolve); });
    return data => new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); socket.off('message', receive); socket.off('error', fail); };
        const fail = error => { cleanup(); reject(error); };
        const timer = setTimeout(() => fail(Error('STUN response timed out')), 5000);
        function receive(buffer) {
            if (!buffer.subarray(8, 20).equals(data.subarray(8, 20))) return;
            cleanup(); try { resolve(parse(buffer)); } catch (error) { reject(error); }
        }
        socket.on('message', receive); socket.on('error', fail); socket.send(data, error => { if (error) fail(error); });
    });
}
function peer(ip) {
    const value = Buffer.alloc(8); value[1] = 1; value.writeUInt16BE(443 ^ 0x2112, 2);
    ip.split('.').map(Number).forEach((octet, i) => { value[i + 4] = octet ^ [0x21, 0x12, 0xa4, 0x42][i]; });
    return attr(0x12, value);
}
(async () => {
    const server = await credentials();
    assert(Number(server.username.split(':')[0]) > Date.now() / 1000, 'Credentials expire in the future');
    let request = await client(server.url);
    const relay = attr(0x19, Buffer.from([17, 0, 0, 0]));
    stage = 'Unauthenticated challenge'; const challenge = await request(packet(3, [relay]));
    assert.equal(challenge.error, 401); realm = challenge.attrs.get(0x14).toString();
    assert.equal(realm, server.url.hostname); checks.push('Unauthenticated allocation challenged');
    const auth = { username: server.username, password: server.credential, nonce: challenge.attrs.get(0x15) };
    stage = 'Wrong password'; const invalid = await request(packet(3, [relay], { ...auth, password: 'invalid-test-password' }));
    assert.equal(invalid.error, 401); checks.push('Wrong password rejected');
    // Use a fresh transport after rejected authentication, matching a new
    // browser attempt rather than depending on a failed session's auth cache.
    request = await client(server.url); stage = 'Fresh valid challenge';
    const fresh = await request(packet(3, [relay])); assert.equal(fresh.error, 401);
    auth.nonce = fresh.attrs.get(0x15);
    stage = 'Valid allocation'; const allocated = await request(packet(3, [relay], auth)); assert.equal(allocated.type, 0x103);
    checks.push('API-issued credential allocates on deployed TURN');
    try {
        for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '224.0.0.1']) {
            stage = 'Peer permission ' + ip; const denied = await request(packet(8, [peer(ip)], auth)); assert.equal(denied.error, 403, ip + ' must be denied');
        }
        checks.push('Loopback, private, metadata, CGNAT and multicast peer permissions denied');
        stage = 'Own private address exception';
        const own = await request(packet(8, [peer('172.31.30.122')], auth));
        assert(own.type === 0x108 || own.error === 403);
        notes.push(own.error === 403 ? 'Own private address denied by coturn' :
            'Coturn permits its own mapped private IP. This probe cannot verify packet filtering; the on-host egress guard and its real-packet check are required.');
        stage = 'Public peer permission'; const allowed = await request(packet(8, [peer('1.1.1.1')], auth)); assert.equal(allowed.type, 0x108);
        checks.push('Public peer permission allowed (no peer traffic sent)');
    } finally {
        const removed = await request(packet(4, [attr(0x0d, Buffer.alloc(4))], auth)); assert.equal(removed.type, 0x104);
        checks.push('Test allocation explicitly released');
    }
    console.log(JSON.stringify({ at: new Date().toISOString(), endpoint, checks, notes }, null, 2));
})().catch(error => { console.error(stage + ': ' + error.message); console.error(JSON.stringify({ checks })); process.exitCode = 1; }).finally(() => {
    for (const socket of sockets) socket.close(); signaling?.terminate();
});
