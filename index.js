const http = require('http');
const fs = require('fs');
const process = require('process');

const config = require('./config');
const cryptoUtils = require('./crypto');
const models = require('./models');
const { dispatchRequest, buildRequestHandlers } = require('./router');
const handlers = require('./handlers');
const studioHandlers = require('./studio-handlers');
const { getReqBody, getPublicIp, validateServiceRequest } = require('./helpers');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// Optional integration: the existing API needs no MCP dependencies until enabled.
const chatgptApp = process.env.CHATGPT_APP_ENABLED === 'true'
    ? require('./chatgpt-app').createProductionHandler() : null;

let rtc = null;
const server = http.createServer((req, res) => {
    if (chatgptApp && chatgptApp.matches(req)) {
        void chatgptApp.handle(req, res);
        return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (rtc?.handleRequest(req, res)) return;

    const requestHandlers = buildRequestHandlers(handlers, studioHandlers);
    dispatchRequest(req, res, requestHandlers);
});

// Rooms are browser hosts, not Node game processes. Preserve the old session
// endpoints for older callers. Current website play and Studio use only RTC.
if (process.env.RTC_ENABLED === 'true') {
    rtc = require('homegames-common/rtc-signaling').attachRtcSignaling(server, {
        trustLoopbackProxy: process.env.RTC_TRUST_PROXY === 'true',
        resolveGame: handlers.resolveRtcGame,
        onRoomCreated: handlers.recordRtcSession,
    });
}

// ---------------------------------------------------------------------------
// Startup (only when run directly, not when required as a module)
// ---------------------------------------------------------------------------

if (require.main === module) {
    server.listen(process.env.PORT || 80);
}

// ---------------------------------------------------------------------------
// Exports (for testing)
// ---------------------------------------------------------------------------

module.exports = {
    // crypto
    base64UrlEncode: cryptoUtils.base64UrlEncode,
    base64UrlDecode: cryptoUtils.base64UrlDecode,
    getSignature: cryptoUtils.getSignature,
    generateJwt: cryptoUtils.generateJwt,
    verifyToken: cryptoUtils.verifyToken,
    hashValue: cryptoUtils.hashValue,
    hashPassword: cryptoUtils.hashPassword,
    getHash: cryptoUtils.getHash,
    generateId: cryptoUtils.generateId,

    // models
    mapElasticSearchGame: models.mapElasticSearchGame,
    mapBlogPost: models.mapBlogPost,
    mapMongoGame: models.mapMongoGame,
    mapGame: models.mapGame,
    assetResponse: models.assetResponse,
    transformS3Response: models.transformS3Response,

    // router
    dispatchRequest,

    // helpers
    getPublicIp,
    getReqBody,
    validateServiceRequest,

    // config
    MAX_SIZE: config.MAX_SIZE,
    HASH_ITERATIONS: config.HASH_ITERATIONS,
    HASH_KEY_LENGTH: config.HASH_KEY_LENGTH,
    HASH_DIGEST: config.HASH_DIGEST,
};
