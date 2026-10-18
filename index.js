const http = require('node:http');
const { createHandler } = require('./connection-api');
const { createConnectionService } = require('./connection-service');
function createServer(options = {}) {
    const env = options.env || process.env;
    const service = options.service || createConnectionService(env);
    const handle = createHandler({ service, trustProxy: env.RTC_TRUST_PROXY === 'true', ...options });
    let rtc;
    const server = http.createServer((req,res) => {
        // Catch both synchronous routing failures and rejected async handlers.
        // A bad request must not become an unhandled process-level rejection.
        void Promise.resolve().then(() => {
            if (!rtc?.handleRequest(req,res)) return handle(req,res);
        }).catch(() => {
            if (res.destroyed || res.writableEnded) return;
            if (res.headersSent) { res.destroy(); return; }
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        });
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 4096;
    if (options.rtc !== false && env.RTC_ENABLED !== 'false') {
        const { attachRtcSignaling, iceFromEnv } = require('homegames-common/rtc-signaling');
        const limit = (name, fallback) => {
            const value = env[name] === undefined ? fallback : Number(env[name]);
            if (!Number.isSafeInteger(value) || value < 1 || value > 100000) throw new Error(`Invalid ${name}`);
            return value;
        };
        rtc = attachRtcSignaling(server, { trustLoopbackProxy: env.RTC_TRUST_PROXY === 'true', getIceServers: () => iceFromEnv(env),
            maxConnectionsPerIp: limit('RTC_CONNECTIONS_PER_IP', 64), connectionsPerMinute: limit('RTC_CONNECTIONS_PER_MINUTE', 120),
            registrationsPerMinute: limit('RTC_REGISTRATIONS_PER_MINUTE', 60), globalRegistrationsPerMinute: limit('RTC_GLOBAL_REGISTRATIONS_PER_MINUTE', 600) });
    }
    let closing;
    const closeService = () => closing ||= Promise.resolve(service.close?.());
    server.on('listening', () => service.start?.());
    server.on('close', () => { rtc?.close?.(); void closeService().catch(() => {}); });
    server.shutdown = async () => {
        rtc?.close?.();
        const closed = new Promise(resolve => server.close(resolve));
        await Promise.all([closed, closeService()]);
    };
    return server;
}
if (require.main === module) {
    const server = createServer();
    server.listen(Number(process.env.PORT || 8004), process.env.BIND_HOST || '127.0.0.1');
    let stopping = false;
    const stop = () => {
        if (stopping) return; stopping = true;
        const deadline = setTimeout(() => process.exit(1), 45000);
        server.shutdown().then(() => { clearTimeout(deadline); }, () => { clearTimeout(deadline); process.exitCode = 1; });
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
module.exports = { createServer, createHandler };
