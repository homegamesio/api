// Tests for homegames-api
// Run: node --test test/test.js (or: npm test)
//
// These tests import the actual functions from index.js and verify their behavior.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
    base64UrlEncode,
    base64UrlDecode,
    getSignature,
    generateJwt,
    verifyToken,
    hashValue,
    hashPassword,
    getHash,
    generateId,
    mapBlogPost,
    mapMongoGame,
    mapGame,
    assetResponse,
    transformS3Response,
    dispatchRequest,
    getPublicIp,
    getReqBody,
    validateServiceRequest,
    MAX_SIZE,
    HASH_ITERATIONS,
    HASH_KEY_LENGTH,
    HASH_DIGEST,
} = require('../index.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('base64url encoding/decoding', () => {
    it('should round-trip an object', () => {
        const obj = { userId: 'testuser', iat: 1234567890 };
        const encoded = base64UrlEncode(obj);
        const decoded = base64UrlDecode(encoded);
        assert.deepStrictEqual(decoded, obj);
    });

    it('should produce url-safe characters (no +, /, =)', () => {
        const obj = { data: 'this has special chars: +/=?&#' };
        const encoded = base64UrlEncode(obj);
        assert.ok(!encoded.includes('+'), 'should not contain +');
        assert.ok(!encoded.includes('/'), 'should not contain /');
        assert.ok(!encoded.includes('='), 'should not contain =');
    });

    it('should handle empty object', () => {
        const encoded = base64UrlEncode({});
        const decoded = base64UrlDecode(encoded);
        assert.deepStrictEqual(decoded, {});
    });

    it('should handle nested objects', () => {
        const obj = { a: { b: { c: [1, 2, 3] } } };
        const encoded = base64UrlEncode(obj);
        const decoded = base64UrlDecode(encoded);
        assert.deepStrictEqual(decoded, obj);
    });
});

describe('getSignature', () => {
    it('should produce a deterministic signature', () => {
        const header = base64UrlEncode({ alg: 'HS256', typ: 'JWT' });
        const payload = base64UrlEncode({ userId: 'test', iat: 1000 });
        const sig1 = getSignature(header, payload);
        const sig2 = getSignature(header, payload);
        assert.equal(sig1, sig2);
    });

    it('should produce different signatures for different payloads', () => {
        const header = base64UrlEncode({ alg: 'HS256', typ: 'JWT' });
        const payload1 = base64UrlEncode({ userId: 'alice', iat: 1000 });
        const payload2 = base64UrlEncode({ userId: 'bob', iat: 1000 });
        assert.notEqual(getSignature(header, payload1), getSignature(header, payload2));
    });

    it('should produce a base64url-safe string', () => {
        const header = base64UrlEncode({ alg: 'HS256', typ: 'JWT' });
        const payload = base64UrlEncode({ userId: 'test', iat: 999 });
        const sig = getSignature(header, payload);
        assert.ok(!sig.includes('+'));
        assert.ok(!sig.includes('/'));
        assert.ok(!sig.includes('='));
    });
});

describe('generateJwt', () => {
    it('should produce a 3-part dot-separated token', () => {
        const token = generateJwt('testuser');
        const parts = token.split('.');
        assert.equal(parts.length, 3);
    });

    it('should encode the correct header', () => {
        const token = generateJwt('testuser');
        const header = base64UrlDecode(token.split('.')[0]);
        assert.deepStrictEqual(header, { alg: 'HS256', typ: 'JWT' });
    });

    it('should encode the userId in the payload', () => {
        const token = generateJwt('alice');
        const payload = base64UrlDecode(token.split('.')[1]);
        assert.equal(payload.userId, 'alice');
    });

    it('should set iat to approximately now', () => {
        const before = Date.now();
        const token = generateJwt('testuser');
        const after = Date.now();
        const payload = base64UrlDecode(token.split('.')[1]);
        assert.ok(payload.iat >= before && payload.iat <= after);
    });

    it('should produce a valid signature', () => {
        const token = generateJwt('testuser');
        const [header, payload, signature] = token.split('.');
        const expectedSig = getSignature(header, payload);
        assert.equal(signature, expectedSig);
    });
});

describe('verifyToken', () => {
    it('should verify a freshly generated token', async () => {
        const token = generateJwt('alice');
        const payload = await verifyToken(`Bearer ${token}`);
        assert.equal(payload.userId, 'alice');
    });

    it('should reject a token without Bearer prefix', async () => {
        const token = generateJwt('alice');
        await assert.rejects(() => verifyToken(token), (err) => {
            assert.equal(err, 'Invalid token');
            return true;
        });
    });

    it('should reject null token', async () => {
        await assert.rejects(() => verifyToken(null), (err) => {
            assert.equal(err, 'Invalid token');
            return true;
        });
    });

    it('should reject empty string', async () => {
        await assert.rejects(() => verifyToken(''), (err) => {
            assert.equal(err, 'Invalid token');
            return true;
        });
    });

    it('should reject a token with wrong structure (2 parts)', async () => {
        await assert.rejects(() => verifyToken('Bearer aa.bb'), (err) => {
            assert.equal(err, 'Invalid token structure');
            return true;
        });
    });

    it('should reject a token with wrong structure (1 part)', async () => {
        await assert.rejects(() => verifyToken('Bearer justonepart'), (err) => {
            assert.equal(err, 'Invalid token structure');
            return true;
        });
    });

    it('should reject a token with tampered signature', async () => {
        const token = generateJwt('alice');
        const parts = token.split('.');
        parts[2] = 'tampered_signature';
        await assert.rejects(() => verifyToken(`Bearer ${parts.join('.')}`), (err) => {
            assert.equal(err, 'Invalid token');
            return true;
        });
    });

    it('should reject a token with tampered payload', async () => {
        const token = generateJwt('alice');
        const parts = token.split('.');
        // Replace payload with a different userId but keep original signature
        parts[1] = base64UrlEncode({ userId: 'eve', iat: Date.now() });
        await assert.rejects(() => verifyToken(`Bearer ${parts.join('.')}`), (err) => {
            assert.equal(err, 'Invalid token');
            return true;
        });
    });

    it('should reject an expired token (iat older than 15 minutes)', async () => {
        const jwtHeader = { alg: 'HS256', typ: 'JWT' };
        const payload = { userId: 'alice', iat: Date.now() - (16 * 60 * 1000) }; // 16 min ago
        const encodedHeader = base64UrlEncode(jwtHeader);
        const encodedPayload = base64UrlEncode(payload);
        const sig = getSignature(encodedHeader, encodedPayload);
        const expiredToken = `${encodedHeader}.${encodedPayload}.${sig}`;

        await assert.rejects(() => verifyToken(`Bearer ${expiredToken}`), (err) => {
            assert.equal(err, 'Expired token');
            return true;
        });
    });

    it('should accept a token at exactly 14 minutes', async () => {
        const jwtHeader = { alg: 'HS256', typ: 'JWT' };
        const payload = { userId: 'alice', iat: Date.now() - (14 * 60 * 1000) };
        const encodedHeader = base64UrlEncode(jwtHeader);
        const encodedPayload = base64UrlEncode(payload);
        const sig = getSignature(encodedHeader, encodedPayload);
        const token = `${encodedHeader}.${encodedPayload}.${sig}`;

        const result = await verifyToken(`Bearer ${token}`);
        assert.equal(result.userId, 'alice');
    });

    it('should reject a token with missing iat', async () => {
        const jwtHeader = { alg: 'HS256', typ: 'JWT' };
        const payload = { userId: 'alice' }; // no iat
        const encodedHeader = base64UrlEncode(jwtHeader);
        const encodedPayload = base64UrlEncode(payload);
        const sig = getSignature(encodedHeader, encodedPayload);
        const token = `${encodedHeader}.${encodedPayload}.${sig}`;

        await assert.rejects(() => verifyToken(`Bearer ${token}`), (err) => {
            assert.equal(err, 'Expired token');
            return true;
        });
    });
});

describe('hashValue', () => {
    it('should return a hex string', () => {
        const result = hashValue('test');
        assert.match(result, /^[0-9a-f]+$/);
    });

    it('should return a 64-char SHA-256 hash', () => {
        const result = hashValue('test');
        assert.equal(result.length, 64);
    });

    it('should be deterministic', () => {
        assert.equal(hashValue('hello'), hashValue('hello'));
    });

    it('should produce different hashes for different inputs', () => {
        assert.notEqual(hashValue('hello'), hashValue('world'));
    });

    it('should match known SHA-256 value', () => {
        // SHA-256 of "test" is well-known
        const expected = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
        assert.equal(hashValue('test'), expected);
    });
});

describe('hashPassword', () => {
    it('should produce a buffer', async () => {
        const salt = 'somesalt';
        const result = await hashPassword('mypassword', salt);
        assert.ok(Buffer.isBuffer(result));
    });

    it('should produce a result of HASH_KEY_LENGTH bytes', async () => {
        const result = await hashPassword('mypassword', 'somesalt');
        assert.equal(result.length, HASH_KEY_LENGTH);
    });

    it('should be deterministic for same password and salt', async () => {
        const r1 = await hashPassword('pass', 'salt1');
        const r2 = await hashPassword('pass', 'salt1');
        assert.ok(r1.equals(r2));
    });

    it('should produce different results for different salts', async () => {
        const r1 = await hashPassword('pass', 'salt1');
        const r2 = await hashPassword('pass', 'salt2');
        assert.ok(!r1.equals(r2));
    });

    it('should produce different results for different passwords', async () => {
        const r1 = await hashPassword('pass1', 'salt');
        const r2 = await hashPassword('pass2', 'salt');
        assert.ok(!r1.equals(r2));
    });
});

describe('getHash (md5)', () => {
    it('should return a 32-char hex string', () => {
        const result = getHash('test');
        assert.equal(result.length, 32);
        assert.match(result, /^[0-9a-f]+$/);
    });

    it('should be deterministic', () => {
        assert.equal(getHash('hello'), getHash('hello'));
    });

    it('should match known MD5 value', () => {
        // MD5 of "test" is well-known
        assert.equal(getHash('test'), '098f6bcd4621d373cade4e832627b4f6');
    });
});

describe('generateId', () => {
    it('should return a 32-char hex string', () => {
        const id = generateId();
        assert.equal(id.length, 32);
        assert.match(id, /^[0-9a-f]+$/);
    });

    it('should produce unique IDs', () => {
        const ids = new Set();
        for (let i = 0; i < 100; i++) {
            ids.add(generateId());
        }
        assert.equal(ids.size, 100);
    });
});

describe('mapBlogPost', () => {
    it('should include basic fields without content when includeContent is false', () => {
        const post = { id: '1', publishedBy: 'admin', created: 1000, title: 'Hello', content: 'World' };
        const result = mapBlogPost(post, false);
        assert.equal(result.id, '1');
        assert.equal(result.publishedBy, 'admin');
        assert.equal(result.created, 1000);
        assert.equal(result.title, 'Hello');
        assert.equal(result.content, undefined);
    });

    it('should include content when includeContent is true', () => {
        const post = { id: '1', publishedBy: 'admin', created: 1000, title: 'Hello', content: 'World' };
        const result = mapBlogPost(post, true);
        assert.equal(result.content, 'World');
    });

    it('should default title to empty string when missing', () => {
        const post = { id: '1', publishedBy: 'admin', created: 1000 };
        const result = mapBlogPost(post, false);
        assert.equal(result.title, '');
    });
});

describe('mapMongoGame', () => {
    it('should map all fields correctly', () => {
        const game = {
            gameId: 'g1',
            description: 'desc',
            name: 'MyGame',
            developerId: 'dev1',
            created: 12345,
            thumbnail: 'thumb1'
        };
        const result = mapMongoGame(game);
        assert.deepStrictEqual(result, {
            id: 'g1',
            gameId: 'g1',
            description: 'desc',
            name: 'MyGame',
            developerId: 'dev1',
            created: 12345,
            thumbnail: 'thumb1'
        });
    });

    it('should default description and name to empty string when missing', () => {
        const game = { gameId: 'g1', developerId: 'dev1', created: 1 };
        const result = mapMongoGame(game);
        assert.equal(result.description, '');
        assert.equal(result.name, '');
    });

    it('should handle undefined thumbnail', () => {
        const game = { gameId: 'g1', developerId: 'dev1', created: 1 };
        const result = mapMongoGame(game);
        assert.equal(result.thumbnail, undefined);
    });
});

describe('mapGame (DynamoDB-style mapping)', () => {
    it('should handle DynamoDB-style .S/.N fields', () => {
        const game = {
            created_by: { S: 'alice' },
            created_on: { N: 12345 },
            game_id: { S: 'g1' },
            thumbnail: { S: 'thumb' },
            name: { S: 'Game' },
            description: { S: 'Desc' }
        };
        const result = mapGame(game);
        assert.equal(result.createdBy, 'alice');
        assert.equal(result.createdAt, 12345);
        assert.equal(result.id, 'g1');
        assert.equal(result.thumbnail, 'thumb');
        assert.equal(result.name, 'Game');
        assert.equal(result.description, 'Desc');
    });

    it('should handle plain values (non-DynamoDB)', () => {
        const game = {
            created_by: 'bob',
            created_on: 99999,
            game_id: 'g2',
            thumbnail: 'th2',
            name: 'Game2',
            description: 'Desc2'
        };
        const result = mapGame(game);
        assert.equal(result.createdBy, 'bob');
        assert.equal(result.createdAt, 99999);
        assert.equal(result.id, 'g2');
    });

    it('should handle missing fields gracefully', () => {
        const game = {};
        const result = mapGame(game);
        assert.equal(result.createdBy, undefined);
        assert.equal(result.createdAt, undefined);
        assert.equal(result.id, undefined);
    });
});

describe('assetResponse', () => {
    it('should map all fields correctly', () => {
        const asset = {
            assetId: 'a1',
            developerId: 'dev1',
            name: 'photo.png',
            created: 1000,
            description: 'A photo',
            size: 2048,
            metadata: { 'Content-Type': 'image/png' }
        };
        const result = assetResponse(asset);
        assert.deepStrictEqual(result, {
            id: 'a1',
            developerId: 'dev1',
            name: 'photo.png',
            created: 1000,
            description: 'A photo',
            size: 2048,
            type: 'image/png'
        });
    });

    it('should return null type when metadata is missing', () => {
        const asset = { assetId: 'a1', developerId: 'dev1', name: 'f', created: 1, description: '', size: 0 };
        const result = assetResponse(asset);
        assert.equal(result.type, null);
    });

    it('should return null type when Content-Type is missing from metadata', () => {
        const asset = { assetId: 'a1', developerId: 'dev1', name: 'f', created: 1, description: '', size: 0, metadata: {} };
        const result = assetResponse(asset);
        assert.equal(result.type, null);
    });
});

describe('transformS3Response', () => {
    it('should transform mp3 entries into podcast objects', () => {
        const input = [
            { Key: 'episode_1.mp3' },
            { Key: 'episode_2.mp3' }
        ];
        const result = transformS3Response(input);
        assert.equal(result.length, 2);
        assert.equal(result[0].episode, 1);
        assert.equal(result[0].audio, 'https://podcast.homegames.io/episode_1.mp3');
        assert.equal(result[1].episode, 2);
    });

    it('should sort by episode number ascending', () => {
        const input = [
            { Key: 'episode_3.mp3' },
            { Key: 'episode_1.mp3' },
            { Key: 'episode_2.mp3' }
        ];
        const result = transformS3Response(input);
        assert.equal(result[0].episode, 1);
        assert.equal(result[1].episode, 2);
        assert.equal(result[2].episode, 3);
    });

    it('should combine mp3 and mp4 entries for same episode', () => {
        const input = [
            { Key: 'episode_1.mp3' },
            { Key: 'episode_1.mp4' }
        ];
        const result = transformS3Response(input);
        assert.equal(result.length, 1);
        assert.equal(result[0].audio, 'https://podcast.homegames.io/episode_1.mp3');
        assert.equal(result[0].video, 'https://podcast.homegames.io/episode_1.mp4');
    });

    it('should return empty array for no matching entries', () => {
        const input = [
            { Key: 'random_file.txt' },
            { Key: 'readme.md' }
        ];
        const result = transformS3Response(input);
        assert.equal(result.length, 0);
    });

    it('should return empty array for empty input', () => {
        assert.equal(transformS3Response([]).length, 0);
    });

    it('should handle mp4-only episodes', () => {
        const input = [
            { Key: 'episode_5.mp4' }
        ];
        const result = transformS3Response(input);
        assert.equal(result.length, 1);
        assert.equal(result[0].video, 'https://podcast.homegames.io/episode_5.mp4');
        assert.equal(result[0].audio, undefined);
    });
});

describe('route matching via dispatchRequest', () => {
    // We test dispatchRequest with mock req/res objects and handler maps
    // that use the same regex patterns from index.js

    const patterns = {
        publishRequests: '/games/(\\S*)/publish_requests',
        profile: '/profile',
        devProfile: '/profile/(\\S*)',
        gameDetail: '/games/(\\S*)',
        gameVersionDetail: '/games/(\\S*)/version/(\\S*)',
        health: '/health',
        adminListPendingPublishRequests: '/admin/publish_requests',
        adminListFailedPublishRequests: '/admin/publish_requests/failed',
        assetsList: '/assets',
        listGames: '/games',
        listMyGames: '/my-games',
        gamePublish: '/games/(\\S*)/publish',
        gameUpdate: '/games/(\\S*)/update',
        requestAction: '/admin/request/(\\S*)/action',
        assets: '/assets/(\\S*)',
        blog: '/blog',
        blogDetail: '/blog/(\\S*)',
        map: '/map',
        contact: '/contact',
    };

    // Helper: create a mock res that captures what was written
    const mockRes = () => {
        const r = {
            headers: {},
            statusCode: 200,
            ended: false,
            body: null,
            setHeader(k, v) { r.headers[k] = v; },
            writeHead(code, headers) { r.statusCode = code; Object.assign(r.headers, headers || {}); },
            end(body) { r.ended = true; r.body = body; }
        };
        return r;
    };

    // Helper: build a handler map that records which handler was called with which params
    const buildTrackedHandlers = (method, patternNames) => {
        const calls = {};
        const handlers = {};
        for (const name of patternNames) {
            handlers[patterns[name]] = {
                handle: (req, res, ...params) => { calls[name] = params; res.end('ok'); }
            };
        }
        return { requestHandlers: { [method]: handlers }, calls };
    };

    it('should match /health and call handler', () => {
        const { requestHandlers, calls } = buildTrackedHandlers('GET', ['health', 'listGames', 'gameDetail']);
        const req = { method: 'GET', url: '/health', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.ok(calls.health);
        assert.ok(res.ended);
    });

    it('should match /games/abc123 and pass gameId param', () => {
        const { requestHandlers, calls } = buildTrackedHandlers('GET', ['listGames', 'gameDetail', 'gameVersionDetail']);
        const req = { method: 'GET', url: '/games/abc123', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.ok(calls.gameDetail);
        assert.ok(calls.gameDetail.includes('abc123'));
    });

    it('should match /games/abc/version/v1 and pass both params', () => {
        const { requestHandlers, calls } = buildTrackedHandlers('GET', ['gameDetail', 'gameVersionDetail']);
        const req = { method: 'GET', url: '/games/abc/version/v1', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.ok(calls.gameVersionDetail);
        assert.deepStrictEqual(calls.gameVersionDetail, ['abc', 'v1']);
    });

    it('should prefer longer (more specific) patterns', () => {
        const { requestHandlers, calls } = buildTrackedHandlers('GET', ['adminListPendingPublishRequests', 'adminListFailedPublishRequests']);
        const req = { method: 'GET', url: '/admin/publish_requests/failed', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.ok(calls.adminListFailedPublishRequests);
        assert.equal(calls.adminListPendingPublishRequests, undefined);
    });

    it('should match /games/xyz/publish and pass gameId', () => {
        const { requestHandlers, calls } = buildTrackedHandlers('POST', ['gamePublish', 'gameUpdate']);
        const req = { method: 'POST', url: '/games/xyz/publish', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.ok(calls.gamePublish);
        assert.deepStrictEqual(calls.gamePublish, ['xyz']);
    });

    it('should match /admin/request/req123/action and pass requestId', () => {
        const { requestHandlers, calls } = buildTrackedHandlers('POST', ['requestAction']);
        const req = { method: 'POST', url: '/admin/request/req123/action', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.ok(calls.requestAction);
        assert.deepStrictEqual(calls.requestAction, ['req123']);
    });

    it('should match /assets/asset1 and pass assetId', () => {
        const { requestHandlers, calls } = buildTrackedHandlers('GET', ['assets', 'assetsList']);
        const req = { method: 'GET', url: '/assets/asset1', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.ok(calls.assets);
        assert.deepStrictEqual(calls.assets, ['asset1']);
    });

    it('should match /profile/devname and pass devId', () => {
        const { requestHandlers, calls } = buildTrackedHandlers('GET', ['profile', 'devProfile']);
        const req = { method: 'GET', url: '/profile/devname', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.ok(calls.devProfile);
        assert.ok(calls.devProfile.includes('devname'));
    });

    it('should match /blog/post1 and pass blogId', () => {
        const { requestHandlers, calls } = buildTrackedHandlers('GET', ['blog', 'blogDetail']);
        const req = { method: 'GET', url: '/blog/post1', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.ok(calls.blogDetail);
        assert.ok(calls.blogDetail.includes('post1'));
    });

    it('should match /games/g1/publish_requests and pass gameId', () => {
        const { requestHandlers, calls } = buildTrackedHandlers('GET', ['publishRequests', 'gameDetail']);
        const req = { method: 'GET', url: '/games/g1/publish_requests', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.ok(calls.publishRequests);
        assert.deepStrictEqual(calls.publishRequests, ['g1']);
    });

    it('should return 404 for unmatched routes', () => {
        const { requestHandlers } = buildTrackedHandlers('GET', ['health']);
        const req = { method: 'GET', url: '/nonexistent', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.equal(res.statusCode, 404);
        assert.equal(res.body, 'not found');
    });

    it('should return 400 for unsupported method', () => {
        const { requestHandlers } = buildTrackedHandlers('GET', ['health']);
        const req = { method: 'PATCH', url: '/health', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.equal(res.statusCode, 400);
        assert.ok(res.body.includes('Unsupported method'));
    });

    it('should handle OPTIONS with 200', () => {
        const req = { method: 'OPTIONS', url: '/anything', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, {});
        assert.equal(res.statusCode, 200);
        assert.ok(res.ended);
    });

    it('should pass req and res to handler', () => {
        let receivedReq, receivedRes;
        const requestHandlers = {
            'GET': {
                '/test': {
                    handle: (req, res) => { receivedReq = req; receivedRes = res; res.end('ok'); }
                }
            }
        };
        const req = { method: 'GET', url: '/test', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.equal(receivedReq, req);
        assert.equal(receivedRes, res);
    });

    it('should enforce auth and reject missing auth header', () => {
        const requestHandlers = {
            'GET': {
                '/secret': {
                    requiresAuth: true,
                    handle: (req, res, userId) => { res.end('ok'); }
                }
            }
        };
        const req = { method: 'GET', url: '/secret', headers: {} };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        assert.equal(res.body, 'API requires authorization');
    });

    it('should enforce auth and reject invalid token', async () => {
        const requestHandlers = {
            'GET': {
                '/secret': {
                    requiresAuth: true,
                    handle: (req, res, userId) => { res.end('ok'); }
                }
            }
        };
        const req = { method: 'GET', url: '/secret', headers: { authorization: 'Bearer bad.token.here' } };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        // verifyToken is async so we need to wait a tick
        await new Promise(r => setTimeout(r, 10));
        assert.equal(res.statusCode, 401);
    });

    it('should enforce auth and pass userId for valid token', async () => {
        let capturedUserId;
        const requestHandlers = {
            'GET': {
                '/secret': {
                    requiresAuth: true,
                    handle: (req, res, userId) => { capturedUserId = userId; res.end('ok'); }
                }
            }
        };
        const token = generateJwt('alice');
        const req = { method: 'GET', url: '/secret', headers: { authorization: `Bearer ${token}` } };
        const res = mockRes();
        dispatchRequest(req, res, requestHandlers);
        await new Promise(r => setTimeout(r, 10));
        assert.equal(capturedUserId, 'alice');
        assert.equal(res.body, 'ok');
    });
});

describe('getPublicIp', () => {
    it('should prefer req.ip', () => {
        const req = { ip: '1.2.3.4', connection: { remoteAddress: '5.6.7.8' }, socket: { remoteAddress: '9.10.11.12' } };
        assert.equal(getPublicIp(req), '1.2.3.4');
    });

    it('should fall back to connection.remoteAddress', () => {
        const req = { connection: { remoteAddress: '5.6.7.8' }, socket: { remoteAddress: '9.10.11.12' } };
        assert.equal(getPublicIp(req), '5.6.7.8');
    });

    it('should fall back to socket.remoteAddress', () => {
        const req = { socket: { remoteAddress: '9.10.11.12' } };
        assert.equal(getPublicIp(req), '9.10.11.12');
    });

    it('should return null when nothing is available', () => {
        const req = {};
        assert.equal(getPublicIp(req), null);
    });
});

describe('getReqBody', () => {
    // Mock a readable stream to simulate req
    const { Readable } = require('stream');

    const mockReq = (chunks) => {
        const stream = new Readable({
            read() {
                for (const chunk of chunks) {
                    this.push(chunk);
                }
                this.push(null);
            }
        });
        return stream;
    };

    it('should collect body from chunks', (_, done) => {
        const req = mockReq(['hello', ' ', 'world']);
        getReqBody(req, (body, err) => {
            assert.equal(body, 'hello world');
            assert.equal(err, undefined);
            done();
        });
    });

    it('should handle empty body', (_, done) => {
        const req = mockReq([]);
        getReqBody(req, (body, err) => {
            assert.equal(body, '');
            assert.equal(err, undefined);
            done();
        });
    });

    it('should handle JSON body', (_, done) => {
        const payload = JSON.stringify({ key: 'value' });
        const req = mockReq([payload]);
        getReqBody(req, (body, err) => {
            assert.equal(body, payload);
            const parsed = JSON.parse(body);
            assert.equal(parsed.key, 'value');
            done();
        });
    });
});

describe('adminPublishRequestAction validation logic', () => {
    // Test just the synchronous validation logic from adminPublishRequestAction
    // (the DB parts can't be tested without mongo)

    const validateAction = (action, message) => {
        if (!action || (action !== 'reject' && action !== 'approve')) {
            return { error: 'invalid action' };
        }
        if (!message) {
            if (action === 'reject') {
                return { error: 'rejection requires message' };
            }
            message = 'No message available';
        }
        const newStatus = action === 'approve' ? 'PUBLISHED' : 'REJECTED';
        return { newStatus, message };
    };

    it('should return PUBLISHED for approve action', () => {
        const result = validateAction('approve', 'looks good');
        assert.equal(result.newStatus, 'PUBLISHED');
        assert.equal(result.message, 'looks good');
    });

    it('should return REJECTED for reject action', () => {
        const result = validateAction('reject', 'bad code');
        assert.equal(result.newStatus, 'REJECTED');
        assert.equal(result.message, 'bad code');
    });

    it('should reject invalid action', () => {
        const result = validateAction('delete', 'msg');
        assert.equal(result.error, 'invalid action');
    });

    it('should reject null action', () => {
        const result = validateAction(null, 'msg');
        assert.equal(result.error, 'invalid action');
    });

    it('should reject empty string action', () => {
        const result = validateAction('', 'msg');
        assert.equal(result.error, 'invalid action');
    });

    it('should require message for reject', () => {
        const result = validateAction('reject', null);
        assert.equal(result.error, 'rejection requires message');
    });

    it('should default message to "No message available" for approve without message', () => {
        const result = validateAction('approve', null);
        assert.equal(result.message, 'No message available');
        assert.equal(result.newStatus, 'PUBLISHED');
    });
});

describe('password hashing round-trip', () => {
    it('should verify a password via hash comparison (simulating login)', async () => {
        // Simulate signup: generate salt, hash password
        const passwordSalt = crypto.randomBytes(16).toString('hex');
        const passwordHash = await hashPassword('mypassword123', passwordSalt);

        // Simulate login: hash the candidate with the same salt, compare
        const candidateHash = await hashPassword('mypassword123', passwordSalt);
        assert.equal(passwordHash.toString('hex'), candidateHash.toString('hex'));
    });

    it('should fail verification with wrong password', async () => {
        const passwordSalt = crypto.randomBytes(16).toString('hex');
        const passwordHash = await hashPassword('mypassword123', passwordSalt);

        const candidateHash = await hashPassword('wrongpassword', passwordSalt);
        assert.notEqual(passwordHash.toString('hex'), candidateHash.toString('hex'));
    });
});

describe('JWT full round-trip (generate → verify)', () => {
    it('should round-trip correctly', async () => {
        const token = generateJwt('testuser');
        const payload = await verifyToken(`Bearer ${token}`);
        assert.equal(payload.userId, 'testuser');
        assert.ok(typeof payload.iat === 'number');
    });

    it('different users produce different tokens', () => {
        const t1 = generateJwt('alice');
        const t2 = generateJwt('bob');
        assert.notEqual(t1, t2);
    });
});

describe('signup validation logic', () => {
    // Replicate the validation from the signup function
    const validateSignup = (username, password) => {
        if (!username || !password) {
            return { error: 'signup requires username & password' };
        }
        return { ok: true };
    };

    it('should pass with valid username and password', () => {
        assert.deepStrictEqual(validateSignup('user', 'pass'), { ok: true });
    });

    it('should fail with missing username', () => {
        assert.equal(validateSignup(null, 'pass').error, 'signup requires username & password');
        assert.equal(validateSignup('', 'pass').error, 'signup requires username & password');
    });

    it('should fail with missing password', () => {
        assert.equal(validateSignup('user', null).error, 'signup requires username & password');
        assert.equal(validateSignup('user', '').error, 'signup requires username & password');
    });

    it('should fail with both missing', () => {
        assert.equal(validateSignup(null, null).error, 'signup requires username & password');
    });
});

describe('validateServiceRequest', () => {
    it('should return null for valid request', () => {
        const result = validateServiceRequest({ type: 'content-generation', model: 'mistral-7b-v0.2', prompt: 'hello' });
        assert.equal(result, null);
    });

    it('should reject missing type', () => {
        assert.equal(validateServiceRequest({}), 'request missing type');
    });

    it('should reject unknown service type', () => {
        assert.equal(validateServiceRequest({ type: 'unknown-service' }), 'unknown service type');
    });

    it('should reject missing model', () => {
        assert.equal(validateServiceRequest({ type: 'content-generation' }), 'missing model');
    });

    it('should reject unknown model', () => {
        assert.equal(validateServiceRequest({ type: 'content-generation', model: 'gpt-9000' }), 'unknown model');
    });

    it('should reject missing prompt', () => {
        assert.equal(validateServiceRequest({ type: 'content-generation', model: 'mistral-7b-v0.2' }), 'missing prompt');
    });
});

describe('MAX_SIZE constant', () => {
    it('should be 50MB', () => {
        assert.equal(MAX_SIZE, 50 * 1024 * 1024);
        assert.equal(MAX_SIZE, 52428800);
    });
});

describe('HASH constants', () => {
    it('should have correct iteration count', () => {
        assert.equal(HASH_ITERATIONS, 100000);
    });

    it('should have correct key length', () => {
        assert.equal(HASH_KEY_LENGTH, 64);
    });

    it('should use sha512', () => {
        assert.equal(HASH_DIGEST, 'sha512');
    });
});
