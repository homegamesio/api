// Tests for homegames-api pure logic
// Run: node --test test/test.js
//
// These tests replicate the pure functions from index.js exactly as written
// and verify their behavior. No changes to index.js are required.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Replicated pure functions from index.js (verbatim logic)
// ---------------------------------------------------------------------------

const JWT_SECRET = 'test-secret';
const HASH_ITERATIONS = 100000;
const HASH_KEY_LENGTH = 64;
const HASH_DIGEST = 'sha512';

const base64UrlEncode = (obj) => {
    const stringified = JSON.stringify(obj);
    return Buffer.from(stringified).toString('base64url');
};

const base64UrlDecode = (str) => {
    const decoded = Buffer.from(str, 'base64url');
    return JSON.parse(decoded);
};

const getSignature = (encodedHeader, encodedPayload) => {
    const data = `${encodedHeader}.${encodedPayload}`;
    return crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
};

const generateJwt = (userId) => {
    const jwtHeader = {
        alg: 'HS256',
        typ: 'JWT'
    };

    const payload = { userId, iat: Date.now() };

    const encodedHeader = base64UrlEncode(jwtHeader);
    const encodedPayload = base64UrlEncode(payload);
    const encodedSignature = getSignature(encodedHeader, encodedPayload);

    return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
};

const verifyToken = (token) => new Promise((resolve, reject) => {
    const bearerPrefix = 'Bearer ';
    if (!token || !token.startsWith(bearerPrefix)) {
        reject('Invalid token');
    } else {
        const tokenValue = token.substring(bearerPrefix.length);
        const tokenPieces = tokenValue.split('.');
        if (tokenPieces.length !== 3) {
            reject('Invalid token structure');
        } else {
            const tokenHeader = tokenPieces[0];
            const tokenPayload = tokenPieces[1];
            const tokenSignature = tokenPieces[2];

            const payload = base64UrlDecode(tokenPayload);
            const validSignature = getSignature(tokenHeader, tokenPayload);
            if (!payload.iat || payload.iat + (15 * 60 * 1000) <= Date.now()) {
                reject('Expired token');
            } else {
                if (validSignature == tokenSignature) {
                    resolve(payload);
                } else {
                    reject('Invalid token');
                }
            }
        }
    }
});

const hashValue = (val) => {
    return crypto.createHash('sha256').update(val).digest('hex');
};

const hashPassword = (password, salt) => new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, HASH_ITERATIONS, HASH_KEY_LENGTH, HASH_DIGEST, (error, hashedPassword) => {
        if (error) {
            reject(error);
        } else {
            resolve(hashedPassword);
        }
    });
});

const getHash = (input) => {
    return crypto.createHash('md5').update(input).digest('hex');
};

const generateId = () => getHash(crypto.randomUUID());

// --- Data mappers ---

const mapElasticSearchGame = (_game) => {
    const game = _game._source;
    return {
        id: game.gameId,
        ...game
    };
};

const mapBlogPost = (post, includeContent) => {
    const mapped = {
        id: post.id,
        publishedBy: post.publishedBy,
        created: post.created,
        title: post.title || ''
    };
    if (includeContent) {
        mapped.content = post.content;
    }
    return mapped;
};

const mapMongoGame = (game) => {
    return {
        id: game.gameId,
        gameId: game.gameId,
        description: game.description || '',
        name: game.name || '',
        developerId: game.developerId,
        created: game.created,
        thumbnail: game.thumbnail
    };
};

const mapGame = (game) => {
    return {
        createdBy: game.created_by && game.created_by.S ? game.created_by.S : game.created_by,
        createdAt: game.created_on && game.created_on.N ? game.created_on.N : game.created_on,
        id: game.game_id && game.game_id.S ? game.game_id.S : game.game_id,
        thumbnail: game.thumbnail && game.thumbnail.S ? game.thumbnail.S : game.thumbnail,
        name: game.name && game.name.S ? game.name.S : game.name,
        description: game.description && game.description.S ? game.description.S : game.description
    };
};

const assetResponse = (asset) => {
    return {
        id: asset.assetId,
        developerId: asset.developerId,
        name: asset.name,
        created: asset.created,
        description: asset.description,
        size: asset.size,
        type: asset.metadata?.['Content-Type'] || null
    };
};

// --- S3 podcast transform ---

const transformS3Response = (s3Content) => {
    const episodeEntryRegex = new RegExp('episode_(\\d+)\.mp3|\.mp4$');
    const transformed = {};
    s3Content.filter(e => episodeEntryRegex.exec(e.Key)).forEach(e => {
        const baseKey = e.Key.substring(0, e.Key.length - 4);
        const ret = {
            key: baseKey
        };

        if (!transformed[baseKey]) {
            transformed[baseKey] = {
                episode: Number(episodeEntryRegex.exec(e.Key)[1])
            };
        }

        if (e.Key.endsWith('.mp3')) {
            transformed[baseKey].audio = `https://podcast.homegames.io/${e.Key}`;
        } else if (e.Key.endsWith('.mp4')) {
            transformed[baseKey].video = `https://podcast.homegames.io/${e.Key}`;
        }
    });

    const sortedKeys = Object.keys(transformed).sort((a, b) => {
        return transformed[a].episode - transformed[b].episode;
    });

    const retList = sortedKeys.map(k => {
        return transformed[k];
    });

    return retList;
};

// --- Route matching logic (replicated from server handler) ---

const matchRoute = (method, url, requestHandlers) => {
    if (!requestHandlers[method]) return null;
    const matchers = Object.keys(requestHandlers[method]).sort((a, b) => b.length - a.length);
    for (let i = 0; i < matchers.length; i++) {
        const matched = url.match(new RegExp(matchers[i]));
        if (matched) {
            const matchedParams = [];
            for (let j = 1; j < matched.length; j++) {
                matchedParams.push(matched[j]);
            }
            return { pattern: matchers[i], params: matchedParams, handler: requestHandlers[method][matchers[i]] };
        }
    }
    return null;
};

// --- getReqBody logic ---

const MAX_SIZE = 50 * 1024 * 1024;

const getPublicIp = (req) => {
    const connection = req && req.connection;
    const socket = req && req.socket;
    return req.ip || connection && connection.remoteAddress || socket && socket.remoteAddress || null;
};

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

    it('should produce a 64-byte result (HASH_KEY_LENGTH)', async () => {
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

describe('mapElasticSearchGame', () => {
    it('should extract _source and add id from gameId', () => {
        const input = {
            _source: {
                gameId: 'abc123',
                name: 'Test Game',
                description: 'A game',
                developerId: 'dev1'
            }
        };
        const result = mapElasticSearchGame(input);
        assert.equal(result.id, 'abc123');
        assert.equal(result.gameId, 'abc123');
        assert.equal(result.name, 'Test Game');
        assert.equal(result.description, 'A game');
        assert.equal(result.developerId, 'dev1');
    });

    it('should spread all _source fields', () => {
        const input = {
            _source: {
                gameId: 'x',
                customField: 'customValue'
            }
        };
        const result = mapElasticSearchGame(input);
        assert.equal(result.customField, 'customValue');
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

describe('route matching', () => {
    // Replicate the regex patterns from index.js
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
        submitPublishRequest: '/public_publish',
        gamePublish: '/games/(\\S*)/publish',
        gameUpdate: '/games/(\\S*)/update',
        requestAction: '/admin/request/(\\S*)/action',
        createAsset: '/asset',
        createGame: '/games',
        login: '/auth/login',
        signup: '/auth/signup',
        assets: '/assets/(\\S*)',
        blog: '/blog',
        blogDetail: '/blog/(\\S*)',
        map: '/map',
        contact: '/contact',
    };

    // Build a handler map like the real code does
    const buildHandlers = (patternNames) => {
        const handlers = {};
        for (const name of patternNames) {
            handlers[patterns[name]] = { name };
        }
        return handlers;
    };

    it('should match /health exactly', () => {
        const handlers = { 'GET': buildHandlers(['health', 'listGames', 'gameDetail']) };
        const result = matchRoute('GET', '/health', handlers);
        assert.ok(result);
        assert.equal(result.handler.name, 'health');
    });

    it('should match /games with no params (list games)', () => {
        const handlers = { 'GET': buildHandlers(['listGames', 'gameDetail', 'gameVersionDetail']) };
        const result = matchRoute('GET', '/games', handlers);
        assert.ok(result);
        // longest match first — gameVersionDetail is longest, then gameDetail, then listGames
        // but /games doesn't match gameDetail's regex /games/(\S*) since there's no trailing /xxx
        // Actually let's check: /games matches /games/(\S*)?
        // The regex /games/(\S*) requires a / after games and then a capture group
        // So /games should NOT match it. Let's verify:
        assert.equal(result.params.length, 0);
    });

    it('should match /games/abc123 and extract gameId', () => {
        const handlers = { 'GET': buildHandlers(['listGames', 'gameDetail', 'gameVersionDetail']) };
        const result = matchRoute('GET', '/games/abc123', handlers);
        assert.ok(result);
        assert.ok(result.params.includes('abc123'));
    });

    it('should match /games/abc/version/v1 and extract both params', () => {
        const handlers = { 'GET': buildHandlers(['gameDetail', 'gameVersionDetail']) };
        const result = matchRoute('GET', '/games/abc/version/v1', handlers);
        assert.ok(result);
        assert.equal(result.handler.name, 'gameVersionDetail');
        assert.deepStrictEqual(result.params, ['abc', 'v1']);
    });

    it('should prefer longer (more specific) patterns', () => {
        const handlers = { 'GET': buildHandlers(['adminListPendingPublishRequests', 'adminListFailedPublishRequests']) };
        const result = matchRoute('GET', '/admin/publish_requests/failed', handlers);
        assert.ok(result);
        assert.equal(result.handler.name, 'adminListFailedPublishRequests');
    });

    it('should match /games/xyz/publish and extract gameId', () => {
        const handlers = { 'POST': buildHandlers(['gamePublish', 'gameUpdate', 'createGame']) };
        const result = matchRoute('POST', '/games/xyz/publish', handlers);
        assert.ok(result);
        assert.equal(result.handler.name, 'gamePublish');
        assert.deepStrictEqual(result.params, ['xyz']);
    });

    it('should match /games/xyz/update and extract gameId', () => {
        const handlers = { 'POST': buildHandlers(['gamePublish', 'gameUpdate', 'createGame']) };
        const result = matchRoute('POST', '/games/xyz/update', handlers);
        assert.ok(result);
        assert.equal(result.handler.name, 'gameUpdate');
        assert.deepStrictEqual(result.params, ['xyz']);
    });

    it('should match /admin/request/req123/action and extract requestId', () => {
        const handlers = { 'POST': buildHandlers(['requestAction']) };
        const result = matchRoute('POST', '/admin/request/req123/action', handlers);
        assert.ok(result);
        assert.deepStrictEqual(result.params, ['req123']);
    });

    it('should match /assets/asset1 and extract assetId', () => {
        const handlers = { 'GET': buildHandlers(['assets', 'assetsList']) };
        const result = matchRoute('GET', '/assets/asset1', handlers);
        assert.ok(result);
        assert.deepStrictEqual(result.params, ['asset1']);
    });

    it('should match /profile/devname and extract devId', () => {
        const handlers = { 'GET': buildHandlers(['profile', 'devProfile']) };
        const result = matchRoute('GET', '/profile/devname', handlers);
        assert.ok(result);
        assert.ok(result.params.includes('devname'));
    });

    it('should match /blog/post1 and extract blogId', () => {
        const handlers = { 'GET': buildHandlers(['blog', 'blogDetail']) };
        const result = matchRoute('GET', '/blog/post1', handlers);
        assert.ok(result);
        assert.ok(result.params.includes('post1'));
    });

    it('should return null for unmatched routes', () => {
        const handlers = { 'GET': buildHandlers(['health']) };
        const result = matchRoute('GET', '/nonexistent', handlers);
        assert.equal(result, null);
    });

    it('should return null for wrong HTTP method', () => {
        const handlers = { 'GET': buildHandlers(['health']) };
        const result = matchRoute('POST', '/health', handlers);
        assert.equal(result, null);
    });

    it('should match /games/g1/publish_requests and extract gameId', () => {
        const handlers = { 'GET': buildHandlers(['publishRequests', 'gameDetail']) };
        const result = matchRoute('GET', '/games/g1/publish_requests', handlers);
        assert.ok(result);
        assert.equal(result.handler.name, 'publishRequests');
        assert.deepStrictEqual(result.params, ['g1']);
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
    // Replicated from index.js - now extracted as a named function
    const supportedModels = {
        'mistral-7b-v0.2': {}
    };

    const supportedServices = {
        'content-generation': {
            validator: (data) => {
                if (!data.model) {
                    return 'missing model';
                }
                if (!supportedModels[data.model]) {
                    return 'unknown model';
                }
                if (!data['prompt']) {
                    return 'missing prompt';
                }
                if (!data['prompt'].length > 100) {
                    return 'prompt too long (> 100 characters)';
                }
                return null;
            }
        }
    };

    const validateServiceRequest = (data) => {
        if (!data.type) {
            return 'request missing type';
        }
        if (!supportedServices[data.type]) {
            return 'unknown service type';
        }
        if (supportedServices[data.type].validator) {
            const serviceValidationErr = supportedServices[data.type].validator(data);
            if (serviceValidationErr) {
                return serviceValidationErr;
            }
        }
        return null;
    };

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
