const http = require('http');
const fs = require('fs');
const process = require('process');

const config = require('./config');
const cryptoUtils = require('./crypto');
const models = require('./models');
const { dispatchRequest, buildRequestHandlers } = require('./router');
const handlers = require('./handlers');
const studioHandlers = require('./studio-handlers');
const { updateCachedMap, getReqBody, getPublicIp, validateServiceRequest } = require('./helpers');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    const requestHandlers = buildRequestHandlers(handlers, studioHandlers);
    dispatchRequest(req, res, requestHandlers);
});

// ---------------------------------------------------------------------------
// Startup (only when run directly, not when required as a module)
// ---------------------------------------------------------------------------

if (require.main === module) {
    const _CENTROIDS = fs.readFileSync('centroids.json');
    const CENTROIDS = JSON.parse(_CENTROIDS);

    setInterval(() => {
        updateCachedMap(CENTROIDS).then((entries) => {
            handlers.setGameMaps(entries);
        });
    }, 1000 * 5);

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
