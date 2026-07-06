const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { JWT_SECRET, HASH_ITERATIONS, HASH_KEY_LENGTH, HASH_DIGEST } = require('./config');

const base64UrlDecode = (str) => {
    const decoded = Buffer.from(str, 'base64url');
    return JSON.parse(decoded);
};

const base64UrlEncode = (obj) => {
    const stringified = JSON.stringify(obj);
    return Buffer.from(stringified).toString('base64url');
};

const getSignature = (encodedHeader, encodedPayload) => {
    const data = `${encodedHeader}.${encodedPayload}`;
    return crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
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
                if (crypto.timingSafeEqual(Buffer.from(validSignature), Buffer.from(tokenSignature))) {
                    resolve(payload);
                } else {
                    reject('Invalid token');
                }
            }
        }
    }
});

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

const generateId = () => getHash(uuidv4());

// Cryptographically-random opaque token (e.g. email verification links).
// The raw token goes in the link; only its hashValue() is stored.
const generateToken = () => crypto.randomBytes(32).toString('hex');

module.exports = {
    base64UrlDecode,
    base64UrlEncode,
    getSignature,
    verifyToken,
    generateJwt,
    hashValue,
    hashPassword,
    getHash,
    generateId,
    generateToken,
};
