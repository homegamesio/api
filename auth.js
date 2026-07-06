const crypto = require('crypto');
const { generateJwt, hashPassword, generateId, hashValue } = require('./crypto');
const {
    getUserByDisplayName, getUserByEmail,
    createUser, setUserVerified, setVerificationCode, getUserRecord,
    setPasswordResetCode, resetUserPassword,
} = require('./db');
const { sendVerificationEmail, sendPasswordResetEmail } = require('./email');

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 60 * 60 * 1000; // 1h
const DISPLAY_NAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 6-digit numeric verification code. Brute force is bounded by the per-user
// attempt rate limit on the verify endpoint plus the 24h expiry + single use.
const generateCode = () => String(crypto.randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');

// (Re)issue a verification code for a user and email it. Best-effort send: a
// send failure doesn't reject (the user can resend), but a DB failure does.
const requestVerification = (user) => new Promise((resolve, reject) => {
    const code = generateCode();
    const codeHash = hashValue(code);
    const expires = Date.now() + VERIFICATION_TTL_MS;

    setVerificationCode(user.userId, codeHash, expires).then(() => {
        sendVerificationEmail(user.email, user.displayName, code)
            .then(() => resolve())
            .catch((err) => {
                console.error('Failed to send verification email:', err && err.message);
                resolve(); // user can resend
            });
    }).catch(reject);
});

// Login by display name OR email + password. Returns the internal userId in the
// JWT; the display name is for UI only.
const login = (request) => new Promise((resolve, reject) => {
    const { username, password } = request;
    if (!username || !password) { reject('username and password required'); return; }

    const identifier = String(username).trim();
    const lookup = identifier.includes('@')
        ? getUserByEmail(identifier.toLowerCase())
        : getUserByDisplayName(identifier.toLowerCase());

    lookup.then((user) => {
        if (!user) { reject('incorrect username or password'); return; }
        hashPassword(password, user.passwordSalt).then((passwordHash) => {
            if (user.passwordHash.toString('hex') !== passwordHash.toString('hex')) {
                reject('incorrect username or password');
                return;
            }
            resolve({
                userId: user.userId,
                displayName: user.displayName,
                token: generateJwt(user.userId),
                isAdmin: user.isAdmin || false,
                verified: !!user.verified,
                created: user.created,
            });
        }).catch(reject);
    }).catch(reject);
});

// Create a developer account. Identity = generated internal userId; displayName
// is a separate immutable handle. Account starts unverified and a verification
// email is sent.
const signup = (request) => new Promise((resolve, reject) => {
    const displayName = request.displayName && String(request.displayName).trim();
    const email = request.email && String(request.email).trim();
    const { password } = request;

    if (!displayName || !email || !password) { reject('displayName, email, and password are required'); return; }
    if (!DISPLAY_NAME_RE.test(displayName)) { reject('Display name must be 3-20 characters: letters, numbers, _ or -'); return; }
    if (!EMAIL_RE.test(email)) { reject('Invalid email address'); return; }

    const displayNameLower = displayName.toLowerCase();
    const emailLower = email.toLowerCase();

    getUserByDisplayName(displayNameLower).then((existingName) => {
        if (existingName) { reject('That display name is taken'); return; }
        getUserByEmail(emailLower).then((existingEmail) => {
            if (existingEmail) { reject('An account with that email already exists'); return; }

            const passwordSalt = crypto.randomBytes(16).toString('hex');
            hashPassword(password, passwordSalt).then((passwordHash) => {
                const userId = generateId();
                const user = {
                    userId,
                    displayName,
                    displayNameLower,
                    email,
                    emailLower,
                    verified: false,
                    passwordHash,
                    passwordSalt,
                    created: Date.now(),
                    isAdmin: false,
                    forgejoAccountCreated: false,
                };

                createUser(user).then(() => {
                    // Forgejo account is provisioned lazily (ensureForgejoUser)
                    // on the first studio action, which is verification-gated.
                    requestVerification(user).finally(() => {
                        resolve({
                            userId,
                            displayName,
                            token: generateJwt(userId),
                            verified: false,
                        });
                    });
                }).catch((err) => {
                    console.error('createUser failed', err);
                    reject('Failed to create account');
                });
            }).catch(reject);
        }).catch(reject);
    }).catch(reject);
});

// Verify the code for the authenticated user. Scoped to userId (the caller is
// authenticated), so there's no token-in-URL and no prefetch exposure.
const verifyEmail = (userId, code) => new Promise((resolve, reject) => {
    if (!code) { reject('Missing code'); return; }
    getUserRecord(userId).then((user) => {
        if (!user) { reject('User not found'); return; }
        if (user.verified) { resolve(user); return; } // idempotent
        if (!user.verificationCodeHash || !user.verificationCodeExpires) {
            reject('No verification code outstanding — request a new one'); return;
        }
        if (user.verificationCodeExpires < Date.now()) {
            reject('Verification code has expired — request a new one'); return;
        }
        if (hashValue(String(code).trim()) !== user.verificationCodeHash) {
            reject('Incorrect code'); return;
        }
        setUserVerified(user.userId).then(() => resolve(user)).catch(reject);
    }).catch(reject);
});

// Re-send a verification email for the currently-authenticated user.
const resendVerification = (userId) => new Promise((resolve, reject) => {
    getUserRecord(userId).then((user) => {
        if (!user) { reject('User not found'); return; }
        if (user.verified) { reject('Account is already verified'); return; }
        requestVerification(user).then(() => resolve()).catch(reject);
    }).catch(reject);
});

// Longer code than email verification — this path is unauthenticated.
const generateResetCode = () => crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 hex chars

// Email a password-reset code. Always resolves (never reveals whether an
// account exists for the address — anti-enumeration).
const requestPasswordReset = (email) => new Promise((resolve) => {
    if (!email) { resolve(); return; }
    getUserByEmail(String(email).trim().toLowerCase()).then((user) => {
        if (!user) { resolve(); return; }
        const code = generateResetCode();
        const codeHash = hashValue(code);
        setPasswordResetCode(user.userId, codeHash, Date.now() + RESET_TTL_MS).then(() => {
            sendPasswordResetEmail(user.email, user.displayName, code)
                .catch((err) => console.error('Failed to send reset email:', err && err.message))
                .finally(resolve);
        }).catch(() => resolve());
    }).catch(() => resolve());
});

// Consume a reset code (by email, since the user is logged out) and set a new
// password.
const resetPassword = (email, code, newPassword) => new Promise((resolve, reject) => {
    if (!email || !code || !newPassword) { reject('email, code, and new password are required'); return; }
    if (String(newPassword).length < 8) { reject('Password must be at least 8 characters'); return; }
    getUserByEmail(String(email).trim().toLowerCase()).then((user) => {
        if (!user || !user.resetCodeHash || !user.resetCodeExpires) { reject('Invalid or expired reset code'); return; }
        if (user.resetCodeExpires < Date.now()) { reject('Reset code has expired — request a new one'); return; }
        if (hashValue(String(code).trim().toUpperCase()) !== user.resetCodeHash) { reject('Incorrect reset code'); return; }
        const passwordSalt = crypto.randomBytes(16).toString('hex');
        hashPassword(newPassword, passwordSalt).then((passwordHash) => {
            resetUserPassword(user.userId, passwordHash, passwordSalt).then(() => resolve()).catch(reject);
        }).catch(reject);
    }).catch(reject);
});

module.exports = {
    login,
    signup,
    verifyEmail,
    resendVerification,
    requestVerification,
    requestPasswordReset,
    resetPassword,
};
