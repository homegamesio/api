// Checks the deployed WebSocket route, room admission and ICE configuration.
// This does not prove TURN connectivity; use the browser test with relay forced.
const { createRequire } = require('module');
const WebSocket = createRequire(require.resolve('homegames-common/rtc-signaling'))('ws');
const endpoint = process.argv[2] || 'wss://api.homegames.io/rtc';
const requireTurn = process.argv.includes('--require-turn');
const sockets = [];
let hostAdmitted = false, guestAdmitted = false, finished = false;
const timer = setTimeout(() => finish(new Error('Timed out waiting for signaling')), 15000);

function finish(error) {
    if (finished) return;
    finished = true; clearTimeout(timer);
    sockets.forEach(ws => ws.terminate());
    if (error) { console.error(error.message); process.exitCode = 1; }
    else console.log('PASS: public signaling created a room, admitted a guest and notified the host.');
}
function checkIce(servers = []) {
    const turn = servers.filter(s => [].concat(s.urls || []).some(url => /^turns?:/.test(url)));
    if (requireTurn && !turn.length) throw new Error('Signaling works but no TURN credentials were returned');
    for (const s of turn) {
        if (!s.username || !s.credential || Number(s.username.split(':')[0]) <= Date.now() / 1000) {
            throw new Error('Missing or expired TURN credentials');
        }
    }
    console.log(turn.length ? 'Expiring TURN credentials returned (relay still needs a browser test).' : 'STUN/direct only; TURN is not configured.');
}
function connect(hello, onMessage) {
    const ws = new WebSocket(endpoint); sockets.push(ws);
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('error', finish);
    ws.on('unexpected-response', (_, response) => finish(new Error(`WebSocket upgrade returned HTTP ${response.statusCode}; check RTC_ENABLED and nginx /rtc`)));
    ws.on('close', () => { if (!finished) finish(new Error('Signaling closed before admission completed')); });
    ws.on('message', raw => {
        if (finished) return;
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'error') throw new Error(msg.message);
            onMessage(msg);
            if (hostAdmitted && guestAdmitted) finish();
        } catch (error) { finish(error); }
    });
}
connect({ type: 'create' }, msg => {
    if (msg.type === 'created') {
        checkIce(msg.iceServers);
        connect({ type: 'join', roomId: msg.roomId, invite: msg.invite }, joined => {
            if (joined.type === 'joined') { checkIce(joined.iceServers); guestAdmitted = true; }
        });
    } else if (msg.type === 'peer-joined') hostAdmitted = true;
});
