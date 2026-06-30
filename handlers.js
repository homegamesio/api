const fs = require('fs');
const url = require('url');
const multiparty = require('multiparty');
const { v4: uuidv4 } = require('uuid');
const { Binary } = require('mongodb');

const { MAX_SIZE, CERT_DOMAIN } = require('./config');

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
const _rateLimiters = {};

const rateLimit = (key, windowMs, max) => {
    if (!_rateLimiters[key]) {
        _rateLimiters[key] = { clients: new Map() };
        // Evict stale entries periodically
        const interval = setInterval(() => {
            const now = Date.now();
            for (const [ip, entry] of _rateLimiters[key].clients) {
                if (now - entry.start > windowMs * 2) _rateLimiters[key].clients.delete(ip);
            }
        }, windowMs);
        if (interval.unref) interval.unref();
    }
    return (ip) => {
        const now = Date.now();
        const clients = _rateLimiters[key].clients;
        let entry = clients.get(ip);
        if (!entry || now - entry.start > windowMs) {
            entry = { count: 0, start: now };
            clients.set(ip, entry);
        }
        entry.count++;
        return entry.count <= max;
    };
};

// Returns the real source IP as seen by our trusted nginx hop.
// nginx (with the standard `$proxy_add_x_forwarded_for`) APPENDS the connecting
// peer's IP to any client-supplied X-Forwarded-For, so the trustworthy value is
// the RIGHTMOST entry — the leftmost entries are attacker-controllable and must
// not be used for authz (cert/DNS ownership is bound to this value).
// NOTE: assumes a single trusted proxy (nginx). If a CDN is ever placed in
// front of nginx, this must take the appropriate trusted hop instead.
const getClientIP = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const hops = forwarded.split(',').map(h => h.trim()).filter(Boolean);
        if (hops.length) return hops[hops.length - 1];
    }
    return req.socket?.remoteAddress || 'unknown';
};

const assetUploadLimiter = rateLimit('asset-upload', 60 * 1000, 5);     // 5 uploads per minute per IP
const signupLimiter = rateLimit('signup', 24 * 60 * 60 * 1000, 1);       // 1 signup per 24 hours per IP
const sessionCreateLimiter = rateLimit('session-create', 60 * 1000, 1);  // 1 session per minute per IP
const certRequestLimiter = rateLimit('cert-request', 60 * 60 * 1000, 5); // 5 cert requests per hour per IP (each triggers a real ACME order)
const { generateId, getHash, generateJwt } = require('./crypto');
const { assetResponse } = require('./models');
const {
    getUserRecord, createSupportMessage, createBlogPost, getBlogPost, listBlogPosts,
    getMongoAsset, getMongoDocument, getMongoCollection, uploadMongo,
    getProfileInfo, getGame, updateGame, listAssets, createAssetRecord,
    getAssetCount, MAX_ASSETS_PER_USER,
    adminListPendingPublishRequests, adminAcknowledgeMessage, adminListSupportMessages,
    adminListFailedPublishRequests, listPublishRequests, getGameDetails,
    getPublishRequest, updatePublishRequestState, adminPublishRequestAction,
    listMyGames, updateMongoProfileInfo, deleteGame, getCertStatus,
    updateAssetTags, listPublicAssets, updateAsset, deleteAsset,
    deleteDeveloper,
    adminListUsers, adminListGames, adminListAllAssets, adminGetStats, setAssetNsfw,
} = require('./db');
const { listGames, listPublicGamesForAuthor, deleteGame: searchDeleteGame } = require('./search');
const { createGameImagePublishRequest, createContentRequest, createProfileImageTask } = require('./queue');
const { login, signup, verifyEmail, resendVerification, requestPasswordReset, resetPassword } = require('./auth');
const { detectMime } = require('./detect');
const { classifyImage } = require('./nsfw');
const {
    getReqBody, downloadFromGithub, submitPublishRequest, getDnsRecord,
    zipCert, handleCertRequest, getPodcastData, validateServiceRequest,
} = require('./helpers');

// In-memory state for game map (populated by setInterval in index.js)
let gameMaps = [];
const setGameMaps = (maps) => { gameMaps = maps; };

// Wrappers for functions that need cross-module references
const createGame = (developerId, thumbnailAssetId, fields, files) => {
    const { createGame: _createGame } = require('./db');
    return new Promise((resolve, reject) => {
        console.log('creating game with thumbnail asset ' + thumbnailAssetId);
        getMongoCollection('games').then(collection => {
            const gameId = generateId();
            const gameData = {
                gameId,
                description: fields?.description?.[0] || '',
                name: fields?.name?.[0] || '',
                developerId,
                created: Date.now()
            };

            const beforeMongoInsertsId = Object.assign({}, gameData);
            collection.insertOne(gameData).then(() => {
                resolve(beforeMongoInsertsId);
                createGameImagePublishRequest(developerId, thumbnailAssetId, gameId).catch((err) => {
                    console.error('Failed to create game image request');
                    console.error(err);
                });
            }).catch(reject);
        });
    });
};

const updateProfileInfo = (userId, { description, image, btcAddress }) => {
    return updateMongoProfileInfo(userId, { description, image, btcAddress });
};

// DELETE handlers

const handleDeleteDeveloper = (req, res, userId, devId) => {
    getUserRecord(userId).then(userData => {
        if (!userData.isAdmin) {
            console.warn(`user ${userId} tried to delete developer ${devId}`);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not an admin' }));
            return;
        }

        // Clean up Forgejo repos for all the developer's games
        getMongoCollection('games').then(gamesCollection => {
            gamesCollection.find({ developerId: devId }).toArray().then(games => {
                const { deleteRepo, deleteForgejoUser } = require('./forgejo');
                const forgejoCleanups = games
                    .filter(g => g.forgejoRepo)
                    .map(g => {
                        const [owner, repo] = g.forgejoRepo.split('/');
                        return deleteRepo(owner, repo).catch(err => {
                            console.warn(`Forgejo delete failed for ${g.forgejoRepo}`, err);
                        });
                    });

                // Also remove games from search index
                const searchCleanups = games.map(g => searchDeleteGame(g.gameId).catch(() => {}));

                Promise.all([...forgejoCleanups, ...searchCleanups]).then(() => {
                    // Finally remove the developer's Forgejo account itself (their
                    // repos are gone above; purge=true mops up anything missed).
                    // Best-effort — don't fail the whole delete if this errors.
                    return deleteForgejoUser(devId).catch(err => {
                        console.warn(`Forgejo user delete failed for ${devId}`, err);
                    });
                }).then(() => {
                    deleteDeveloper(devId).then(result => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ deleted: true, userId: devId, gamesDeleted: result.gamesDeleted }));
                    }).catch(err => {
                        console.error(`Failed to delete developer ${devId}`, err);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Delete failed' }));
                    });
                });
            });
        }).catch(err => {
            console.error('Failed to look up developer games', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Delete failed' }));
        });
    });
};

const handleDeleteGame = (req, res, userId, gameId) => {
    getUserRecord(userId).then(userData => {
        getGame(gameId).then((game) => {
            if (!userData.isAdmin && game.developerId !== userId) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not authorized to delete this game' }));
                return;
            }

            deleteGame(gameId, searchDeleteGame).then(() => {
                const forgejoCleanup = game.forgejoRepo
                    ? (() => {
                        const { deleteRepo } = require('./forgejo');
                        const [owner, repo] = game.forgejoRepo.split('/');
                        return deleteRepo(owner, repo).catch((err) => {
                            console.warn(`Forgejo delete failed for ${game.forgejoRepo}`, err);
                        });
                    })()
                    : Promise.resolve();

                forgejoCleanup.then(() => {
                    res.statusCode = 200;
                    res.end(JSON.stringify({ deleted: true, gameId }));
                });
            }).catch((err) => {
                console.error(`Failed to delete game ${gameId}`, err);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'Delete failed' }));
            });
        }).catch(() => {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Game not found' }));
        });
    });
};

// POST handlers

const handlePostMap = (req, res) => {
    res.end('');
};

const handlePostProfile = (req, res, userId) => {
    getReqBody(req, (_body, err) => {
        const body = JSON.parse(_body);
        console.log('update body');
        console.log(body);
        updateProfileInfo(userId, body).then(() => {
            res.writeHead(200, {
                'Content-Type': 'application/json'
            });
            res.end('{}');
        });
    });
};

const handleVerifyDns = (req, res) => {
    res.end('ok');
};

const handleAdminAck = (req, res, userId) => {
    getUserRecord(userId).then(userData => {
        if (userData.isAdmin) {
            getReqBody(req, (_body, err) => {
                if (err) {
                    res.end('error ' + err);
                } else {
                    const body = JSON.parse(_body);
                    if (!body.messageId) {
                        res.end('requires messageId');
                    } else {
                        adminAcknowledgeMessage(body.messageId).then(() => {
                            res.writeHead(200, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({ success: true }));
                        });
                    }
                }
            });
        } else {
            console.log('user attempted to call admin API: ' + userId);
            res.end('user is not an admin');
        }
    }).catch(err => {
        console.log(err);
        res.end('failed to get user data');
    });
};

const handlePostCertRequest = (req, res) => {
    console.log('need to request a cert');
    // Bind the cert to the REAL source IP (anonymous, but you can only request a
    // cert for the network you're actually connecting from — not a spoofed XFF).
    const requesterIp = getClientIP(req);
    if (!certRequestLimiter(requesterIp)) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('Too many certificate requests. Please try again later.');
        return;
    }
    // The client generates the keypair locally and submits only the CSR (public
    // key); the TLS private key never reaches us.
    getReqBody(req, (_body, bodyErr) => {
        if (bodyErr) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Could not read request body');
            return;
        }
        let csr;
        try {
            csr = JSON.parse(_body).csr;
        } catch (parseErr) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid request body');
            return;
        }
        handleCertRequest(requesterIp, csr).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ submitted: true }));
        }).catch(err => {
            console.log('cert request failed: ' + err);
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end(String(err && err.message ? err.message : err));
        });
    });
};

const handleBugs = (req, res) => {
    getReqBody(req, (_body, err) => {
        if (err) {
            console.log('Bug reporting error: ' + err);
            res.end('error: ' + err);
        } else {
            console.log(`${Date.now()} Got bug report: `);
            console.log(_body);
            res.end('ok');
        }
    });
};

const handleContact = (req, res) => {
    getReqBody(req, (_body) => {
        console.log('got this message');
        console.log(_body);
        const body = JSON.parse(_body);

        const requesterIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        createSupportMessage(body, requesterIp).then(() => {
            res.end(JSON.stringify({success: true}));
        }).catch(err => {
            console.log('this happened');
            console.log(err);
            if (err?.type == 'TOO_MANY_MESSAGES') {
                res.writeHead(400);
                res.end('Too many messages from this IP');
            } else {
                res.end(err?.toString() || 'Error. Contact @homegamesio on twitter for support');
            }
        });
    });
};

const handleCreateGame = (req, res, userId) => {
    console.log('got user id ' + userId);
    const form = new multiparty.Form();
    form.parse(req, (err, fields, files) => {
        if (err) {
            console.error('error parsing form');
            console.error(err);
            res.end('error');
        } else {
            if (!fields.name || !fields.name.length || !fields.description || !fields.description.length || !files) {
                res.end('creation requires name & description');
            } else {
                const gameId = generateId();
                const fileValues = Object.values(files);
                const f = fileValues[0][0];

                if (f.size > MAX_SIZE) {
                    res.writeHead(400);
                    res.end('File size exceeds ' + MAX_SIZE + ' bytes');
                    return;
                }

                (async () => {
                    const buffer = fs.readFileSync(f.path);
                    const detectedMime = detectMime(buffer);
                    if (!detectedMime) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Unsupported file type' }));
                        return;
                    }

                    let nsfwResult = null;
                    if (detectedMime.startsWith('image/')) {
                        try {
                            nsfwResult = await classifyImage(buffer);
                        } catch (err) {
                            console.error('NSFW classification failed:', err);
                        }
                    }

                    const assetId = generateId();
                    const asset = await createAssetRecord(userId, assetId, f.size, f.originalFilename, {
                        'Content-Type': detectedMime
                    }, `thumbnail for game ${gameId}`, false, nsfwResult);
                    const documentCollection = await getMongoCollection('documents');
                    await documentCollection.insertOne({ developerId: userId, assetId, data: new Binary(buffer), fileSize: f.size, fileType: detectedMime });
                    const game = await createGame(userId, asset.assetId, fields, files);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(game));
                })().catch(err => {
                    console.error('Game creation error:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Game creation failed' }));
                });
            }
        }
    });
};

const handleCreateAsset = (req, res, userId) => {
    const ip = getClientIP(req);
    if (!assetUploadLimiter(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upload limit: 5 per minute. Please wait.' }));
        return;
    }

    Promise.all([getAssetCount(userId), getUserRecord(userId)]).then(([count, userData]) => {
        if (count >= MAX_ASSETS_PER_USER && !userData?.isAdmin) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Asset limit reached (${MAX_ASSETS_PER_USER} max). Delete unused assets to upload more.` }));
            return;
        }
        const form = new multiparty.Form();
        form.parse(req, (err, fields, files) => {
            if (!files) {
                res.end('no');
            } else {
                const fileValues = Object.values(files);
                const f = fileValues[0][0];

                if (f.size > MAX_SIZE) {
                    res.writeHead(400);
                    res.end('File size exceeds ' + MAX_SIZE + ' bytes');
                    return;
                }

                (async () => {
                    const buffer = fs.readFileSync(f.path);
                    const detectedMime = detectMime(buffer);
                    if (!detectedMime) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Unsupported file type' }));
                        return;
                    }

                    let nsfwResult = null;
                    if (detectedMime.startsWith('image/')) {
                        try {
                            nsfwResult = await classifyImage(buffer);
                        } catch (err) {
                            console.error('NSFW classification failed:', err);
                        }
                    }

                    const assetId = getHash(uuidv4());
                    const description = (fields?.description?.[0] || '').trim().substring(0, 80);
                    const isPublic = fields?.public?.[0] === 'true' || fields?.public?.[0] === true;
                    await createAssetRecord(userId, assetId, f.size, f.originalFilename, {
                        'Content-Type': detectedMime
                    }, description, isPublic, nsfwResult);
                    await uploadMongo(userId, assetId, f.path, f.originalFilename, f.size, detectedMime);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ assetId }));
                })().catch(err => {
                    console.error('Asset upload error:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Upload failed' }));
                });
            }
        });
    }).catch(err => {
        console.error('Error checking asset count:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
    });
};

const handleGamePublish = (req, res, userId, _gameId) => {
    const form = new multiparty.Form();
    form.parse(req, (err, fields, files) => {
        console.log('cool heres form');
        console.log(fields);
        console.log(files);

        const { gameId, type } = fields;
        console.log('fjjfjffj');
        console.log(gameId);
        if (!gameId || !gameId.length || !type || !type.length) {
            res.writeHead(400);
            res.end('gameId & type are required');
        } else {
            if (type[0] == 'zip') {
                if (!files || files.length < 1) {
                    res.writeHead(400);
                    res.end('missing file');
                }
            } else if (type[0] == 'github') {
                const { commit, repo, owner } = fields;
                downloadFromGithub(owner, repo, commit).then(zip => {
                    submitPublishRequest(userId, gameId[0], fields, {file: [zip.zipPath]}).then(publishRequest => {
                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });
                        res.end(JSON.stringify(publishRequest));
                    });
                }).catch(err => {
                    res.end(JSON.stringify(err));
                });
            } else {
                res.writeHead(400);
                res.end('Unknown type');
            }
        }
    });
};

const handleGameUpdate = (req, res, userId, gameId) => {
    getReqBody(req, (_data) => {
        const data = JSON.parse(_data);
        const changed = data.description || data.thumbnail;

        if (changed) {
            getGame(gameId).then(game => {
                if (userId != game.developerId) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('You cannot modify a game that you didnt create');
                } else {
                    if (data.description !== undefined && !data.description.trim() && game.description && game.description.trim()) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Cannot remove description once set' }));
                        return;
                    }
                    if (data.thumbnail !== undefined && !data.thumbnail && game.thumbnail) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Cannot remove thumbnail once set' }));
                        return;
                    }

                    if (data.description != game.description) {
                        updateGame(gameId, {description: data.description}).then((_game) => {
                            res.end(JSON.stringify(_game));
                        });
                    } else {
                        getGame(gameId).then((_game) => {
                            res.end(JSON.stringify(_game));
                        }).catch(err => {
                            res.end(err.toString());
                        });
                    }
                }

                if (data.thumbnail !== game.thumbnail) {
                    getMongoAsset(data.thumbnail).then(asset => {
                        if (asset && asset.nsfw) {
                            getMongoCollection('games').then(c => c.updateOne({ gameId }, { $set: { nsfw: true } }));
                        } else {
                            // Thumbnail is clean — fall back to latest version's nsfw flag
                            getMongoCollection('gameVersions').then(c => {
                                c.find({ gameId, published: true }).sort({ publishedAt: -1 }).limit(1).toArray().then(versions => {
                                    const versionNsfw = versions.length > 0 && !!versions[0].nsfw;
                                    getMongoCollection('games').then(gc => gc.updateOne({ gameId }, { $set: { nsfw: versionNsfw } }));
                                });
                            });
                        }
                    }).catch(err => {
                        console.error('NSFW check on thumbnail update failed:', err);
                    });
                }
            }).catch(err => {
                res.end(err.toString());
            });
        } else {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('No valid changes');
        }
    });
};

const handleServices = (req, res) => {
    const requesterIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    console.log('requester ip ' + requesterIp);

    getReqBody(req, (_data) => {
        console.log('dsfdsf');
        console.log(_data);
        const data = JSON.parse(_data);
        const validationErr = validateServiceRequest(data);
        if (validationErr) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: validationErr }));
        } else {
            const { submitContentRequest } = require('./db');
            submitContentRequest(data, requesterIp, createContentRequest).then(requestId => {
                res.end(JSON.stringify({requestId}));
            }).catch(err => {
                console.error(err);
                res.writeHead(400);
                res.end(JSON.stringify(err));
            });
        }
    });
};

const handleSignup = (req, res) => {
    const ip = getClientIP(req);
    if (!signupLimiter(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Account creation is limited to one per day. Please try again later.' }));
        return;
    }

    getReqBody(req, (_data) => {
        let signupBody = {};
        let err = false;
        try {
            signupBody = JSON.parse(_data);
        } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({error: 'invalid request json' }));
            err = true;
        }

        if (!err) {
            signup(signupBody).then((result) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            }).catch(signupError => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: typeof signupError === 'string' ? signupError : 'Signup failed' }));
            });
        }
    });
};

const handleLogin = (req, res) => {
    getReqBody(req, (_data) => {
        let loginBody = {};
        let err = false;
        try {
            loginBody = JSON.parse(_data);
        } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({error: 'invalid request json'}));
            err = true;
        }

        if (!err) {
            console.log('want to login and generate token for user');
            login(loginBody).then(tokenPayload => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(tokenPayload));
            }).catch(err => {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Login failed' }));
            });
        }
    });
};

const handleRefreshToken = (req, res, userId) => {
    const token = generateJwt(userId);
    getUserRecord(userId).then((user) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            token,
            displayName: user && user.displayName,
            verified: !!(user && user.verified),
        }));
    }).catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token }));
    });
};

// Current authenticated user — lets the client hydrate displayName/verified
// without re-logging-in (e.g. after clicking the email verification link).
const handleMe = (req, res, userId) => {
    getUserRecord(userId).then((user) => {
        if (!user) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            userId: user.userId,
            displayName: user.displayName,
            verified: !!user.verified,
            isAdmin: !!user.isAdmin,
        }));
    }).catch(() => { res.writeHead(500); res.end(JSON.stringify({ error: 'error' })); });
};

// Verify the email code for the authenticated user (POST { code }). No link /
// token in a URL, so email-client prefetching can't consume it.
const verifyAttemptLimiter = rateLimit('verify-attempt', 10 * 60 * 1000, 10); // 10 attempts / 10 min / user

const handleVerifyCode = (req, res, userId) => {
    if (!verifyAttemptLimiter(userId)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many attempts. Please wait a few minutes.' }));
        return;
    }
    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'Error reading request' })); return; }
        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }
        verifyEmail(userId, body && body.code).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, verified: true }));
        }).catch((verifyErr) => {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: typeof verifyErr === 'string' ? verifyErr : 'Verification failed' }));
        });
    });
};

const resendLimiter = rateLimit('verify-resend', 10 * 60 * 1000, 3); // 3 per 10 min per user

const handleResendVerification = (req, res, userId) => {
    if (!resendLimiter(userId)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many requests. Please wait a few minutes.' }));
        return;
    }
    resendVerification(userId).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    }).catch((err) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Failed to resend' }));
    });
};

// Forgot password: email a reset code. Always 200 (anti-enumeration).
const forgotPasswordLimiter = rateLimit('forgot-password', 15 * 60 * 1000, 5);  // 5 / 15min / IP
const resetPasswordLimiter = rateLimit('reset-password', 15 * 60 * 1000, 10);   // 10 / 15min / IP

const handleForgotPassword = (req, res) => {
    if (!forgotPasswordLimiter(getClientIP(req))) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many requests. Please wait a few minutes.' }));
        return;
    }
    getReqBody(req, (_body) => {
        let body; try { body = JSON.parse(_body); } catch (e) { body = {}; }
        requestPasswordReset(body && body.email).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    });
};

// Reset password using the emailed code (user is logged out, so keyed by email).
const handleResetPassword = (req, res) => {
    if (!resetPasswordLimiter(getClientIP(req))) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many requests. Please wait a few minutes.' }));
        return;
    }
    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'Error reading request' })); return; }
        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }
        resetPassword(body.email, body.code, body.newPassword).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        }).catch((resetErr) => {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: typeof resetErr === 'string' ? resetErr : 'Reset failed' }));
        });
    });
};

const handleRequestAction = (req, res, userId, requestId) => {
    getUserRecord(userId).then(userData => {
        if (userData.isAdmin) {
            getReqBody(req, (_data) => {
                const reqBody = JSON.parse(_data);
                if (reqBody.action) {
                    adminPublishRequestAction(requestId, reqBody.action, reqBody.message).then((gameId) => {
                        res.end('');
                    }).catch(err => {
                        console.log('error performing publish action');
                        console.log(err);
                        res.end('error performing publish request action');
                    });
                } else {
                    res.end('request missing action');
                }
            });
        } else {
            console.log('user ' + userId + ' attempted to perform action on request');
            res.end('not an admin');
        }
    }).catch(err => {
        console.log('failed to get user data');
        console.log(err);
        res.end('could not get user data');
    });
};

// GET handlers

const handleGetMap = (req, res) => {
    console.log('gonna return in memory value of map');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(gameMaps));
};

const handleGetCertStatus = (req, res) => {
    // Real source IP only — status/cert for a network is readable only from that
    // network, not by anyone supplying a spoofed X-Forwarded-For.
    const requesterIp = getClientIP(req);
    getCertStatus(requesterIp).then((certStatus) => {
        const body = certStatus;
        // The domain this network is allowed to request a cert for. The client
        // needs this to build a CSR with the correct common name, since only we
        // know its (trusted) public IP.
        body.certDomain = `${getHash(requesterIp)}.${CERT_DOMAIN}`;
        getDnsRecord(requesterIp).then((dnsRecord) => {
            console.log('this is the dns record');
            console.log(dnsRecord);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            body.dnsAlias = dnsRecord;
            res.end(JSON.stringify(body));
        }).catch(err => {
            res.end(JSON.stringify(err));
        });
    }).catch(err => {
        res.writeHead(400);
        res.end(err);
    });
};

const handleGetAsset = (req, res, assetId) => {
    getMongoAsset(assetId).then((assetData) => {
        if (!assetData) {
            res.writeHead(404);
            res.end('Asset not found');
        } else {
            getMongoDocument(assetId).then((documentData) => {
                if (documentData) {
                    const safeName = (assetData.name || 'asset').replace(/["\r\n]/g, '');
                    const headers = { 'Content-Disposition': `inline; filename="${encodeURI(safeName)}"` };
                    const storedContentType = assetData.metadata && assetData.metadata['Content-Type'];
                    if (storedContentType) {
                        headers['Content-Type'] = storedContentType;
                    }
                    res.writeHead(200, headers);
                    res.end(documentData.data.buffer);
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });
        }
    }).catch(err => {
        res.end(JSON.stringify(err));
    });
};

const handleGetBlog = (req, res) => {
    const queryObject = url.parse(req.url, true).query;
    const { limit, offset, sort, query, includeMostRecent } = queryObject;
    listBlogPosts(limit || 1, offset || 0, sort || '', query || '', includeMostRecent === 'true').then((blogPosts) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(blogPosts));
    }).catch(err => {
        res.end(JSON.stringify(err));
    });
};

const handleGetBlogDetail = (req, res, blogId) => {
    getBlogPost(blogId).then((blogPost) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(blogPost));
    }).catch(err => {
        res.writeHead(500);
        res.end(JSON.stringify({error: err}));
    });
};

const handleGithubLink = (req, res, userId) => {
    res.end('ayo');
};

const handleGetPodcast = (req, res) => {
    const queryObject = url.parse(req.url, true).query;
    const { limit, offset, sort } = queryObject;
    getPodcastData(Number(offset || 0), Number(limit || 20), sort || 'desc').then(podcastData => {
        res.end(JSON.stringify(podcastData));
    }).catch(err => {
        res.end(JSON.stringify(err));
    });
};

const handleGetServiceRequest = (req, res, requestId) => {
    getMongoCollection('contentRequests').then((contentRequests) => {
        console.log("looking for conttent request " + requestId);
        contentRequests.findOne({ requestId }).then((contentReq) => {
            console.log(contentReq);
            if (!contentReq) {
                res.end('{}');
            } else {
                res.end(JSON.stringify({ response: contentReq.response || null, createdAt: contentReq.created, requestId }));
            }
        });
    }).catch(err => {
        res.end(JSON.stringify(err));
    });
};

const handleListMyGames = (req, res, userId) => {
    const queryObject = url.parse(req.url, true).query;
    let { query, offset, limit } = queryObject;
    if (!offset) { offset = 0; }
    if (!limit) { limit = 10; }
    listMyGames(userId, limit, offset, query).then(results => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
    }).catch(err => {
        res.end(JSON.stringify(err));
    });
};

const handleListGames = (req, res) => {
    const queryObject = url.parse(req.url, true).query;
    let { query, author, offset, limit, featured, includeNsfw } = queryObject;
    if (!offset) { offset = 0; }
    if (!limit) { limit = 10; }
    const nsfw = includeNsfw === 'true';
    if (author) {
        listPublicGamesForAuthor({ author, offset, limit, includeNsfw: nsfw }).then((data) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        }).catch(err => {
            console.log('unable to list games for author');
            console.log(err);
            res.end('error');
        });
    } else {
        listGames(limit, offset, null, query, featured === 'true' ? true : null, nsfw).then(results => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
        }).catch(err => {
            res.end(JSON.stringify(err));
        });
    }
};

const handleGetGameDetail = (req, res, gameId) => {
    getGameDetails(gameId).then(data => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }).catch(err => {
        console.log(err);
        res.end('error');
    });
};

const handleGetIp = (req, res) => {
    const { headers } = req;
    const requesterIp = headers['x-forwarded-for'] || req.connection.remoteAddress;
    res.end(requesterIp);
};

const handleGetGameVersionDetail = (req, res, gameId, versionId) => {
    getGameDetails(gameId).then(data => {
        const foundVersion = data.versions.find(v => v.id === versionId);
        if (!foundVersion) {
            res.writeHead(404);
            res.end('Version not found');
        } else {
            res.end(JSON.stringify(foundVersion));
        }
    }).catch((err) => {
        console.log('game detail fetch err');
        console.log(err);
        res.end('Game not found');
    });
};

const handleListAssets = (req, res, userId) => {
    const queryObject = url.parse(req.url, true).query;
    let { limit, offset, sort, query } = queryObject;
    if (!offset) { offset = 0; }
    if (!limit || limit > 100) { limit = 10; }
    listAssets(userId, query, limit, offset).then(_assets => {
        const { assets, count } = _assets;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ assets: assets.map(assetResponse), count }));
    }).catch((err) => {
        console.log(err);
        res.end('error');
    });
};

const handleListPublicAssets = (req, res) => {
    const queryObject = url.parse(req.url, true).query;
    let { limit, offset, query, type, includeNsfw } = queryObject;
    if (!offset) { offset = 0; }
    if (!limit || limit > 100) { limit = 10; }
    listPublicAssets(query || null, limit, offset, type || null, includeNsfw === 'true').then(({ assets, count, pageCount }) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            assets: assets.map(assetResponse),
            count,
            pageCount,
        }));
    }).catch((err) => {
        console.error(err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to list assets' }));
    });
};

const handleDeleteAsset = (req, res, userId, assetId) => {
    Promise.all([getMongoAsset(assetId), getUserRecord(userId)]).then(([asset, userData]) => {
        if (!asset) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Asset not found' }));
            return;
        }
        if (asset.developerId !== userId && !userData.isAdmin) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Not allowed' }));
            return;
        }
        deleteAsset(asset.developerId, assetId).then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        }).catch(() => {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Asset not found' }));
        });
    }).catch(() => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal error' }));
    });
};

const handleUpdateAssetMeta = (req, res, userId, assetId) => {
    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end('Error reading request'); return; }
        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
        }

        const updates = {};
        if (typeof body.public === 'boolean') {
            updates.public = body.public;
        }
        if (body.description !== undefined) {
            if (String(body.description).length > 80) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Description must be 80 characters or less' }));
                return;
            }
            updates.description = body.description;
        }

        if (Object.keys(updates).length === 0) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'No valid fields to update' }));
            return;
        }

        Promise.all([getMongoAsset(assetId), getUserRecord(userId)]).then(([asset, userData]) => {
            if (!asset) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Asset not found' }));
                return;
            }
            if (asset.developerId !== userId && !userData.isAdmin) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Not allowed' }));
                return;
            }
            updateAsset(asset.developerId, assetId, updates).then((result) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            }).catch(() => {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Asset not found' }));
            });
        }).catch(() => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Internal error' }));
        });
    });
};

const handleUpdateAssetTags = (req, res, userId, assetId) => {
    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end('Error reading request'); return; }
        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
        }
        const { tags } = body;
        if (!Array.isArray(tags)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'tags must be an array of strings' }));
            return;
        }
        // Sanitize: lowercase, trim, deduplicate, limit length
        const cleanTags = [...new Set(tags.map(t => String(t).trim().toLowerCase()).filter(t => t.length > 0 && t.length <= 50))].slice(0, 20);
        updateAssetTags(userId, assetId, cleanTags).then(result => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        }).catch(err => {
            res.writeHead(404);
            res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Failed to update tags' }));
        });
    });
};

const handleGetDevProfile = (req, res, devId) => {
    getProfileInfo(devId).then(data => res.end(JSON.stringify(data))).catch(err => {
        res.end(JSON.stringify(err));
    });
};

const handleGetProfile = (req, res, userId) => {
    getProfileInfo(userId).then(data => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }).catch(err => {
        res.end(JSON.stringify(err));
    });
};

const handleGetPublishRequests = (req, res, userId, gameId) => {
    listPublishRequests(gameId).then((publishRequests) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(publishRequests));
    }).catch(err => {
        res.end(JSON.stringify(err));
    });
};

const handleAdminListSupportMessages = (req, res, userId) => {
    getUserRecord(userId).then(userData => {
        if (userData.isAdmin) {
            const queryObject = url.parse(req.url, true).query;
            let { page, limit } = queryObject;
            adminListSupportMessages(page, limit).then(supportMessages => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(supportMessages));
            }).catch(err => {
                console.error('failed to list support messages', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'failed to list messages' }));
            });
        } else {
            console.log('user attempted to call admin API: ' + userId);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'user is not an admin' }));
        }
    }).catch(err => {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'failed to get user data' }));
    });
};

const handleAdminListPendingPublishRequests = (req, res, userId) => {
    getUserRecord(userId).then(userData => {
        if (userData.isAdmin) {
            adminListPendingPublishRequests().then(publishRequests => {
                res.end(JSON.stringify(publishRequests));
            }).catch(err => {
                console.log('failed to list publish requests');
                console.error(err);
                res.end('failed to list requests');
            });
        } else {
            console.log('user attempted to call admin API: ' + userId);
            res.end('user is not an admin');
        }
    }).catch(err => {
        console.log(err);
        res.end('failed to get user data');
    });
};

const handleAdminListFailedPublishRequests = (req, res, userId) => {
    getUserRecord(userId).then(userData => {
        if (userData.isAdmin) {
            adminListFailedPublishRequests().then(publishRequests => {
                res.end(JSON.stringify(publishRequests));
            }).catch(err => {
                console.log('failed to list publish requests');
                console.error(err);
                res.end('failed to list requests');
            });
        } else {
            console.log('user attempted to call admin API: ' + userId);
            res.end('user is not an admin');
        }
    }).catch(err => {
        console.log(err);
        res.end('failed to get user data');
    });
};

// ---------------------------------------------------------------------------
// Admin moderation console — DB-wide listing + stats. All gated on isAdmin.
// ---------------------------------------------------------------------------

// Run fn(user) only if the caller is an admin; otherwise 403.
const requireAdmin = (userId, res, fn) => {
    getUserRecord(userId).then(user => {
        if (!user || !user.isAdmin) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not an admin' }));
            return;
        }
        fn(user);
    }).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to verify admin' }));
    });
};

// Shared list responder: parses ?search/&page/&limit/&sort/&order and runs a list fn.
const adminListResponder = (req, res, listFn) => {
    const { search, page, limit, sort, order } = url.parse(req.url, true).query;
    const lim = Math.min(Number(limit) || 25, 100);
    const pg = Math.max(Number(page) || 1, 1);
    const offset = (pg - 1) * lim;
    // Only allow sorting by a simple field name; default to newest-first.
    const sortField = (sort && /^[a-zA-Z0-9_.]+$/.test(sort)) ? sort : 'created';
    const sortDir = order === 'asc' ? 1 : -1;
    const sortSpec = { [sortField]: sortDir };
    listFn(search, lim, offset, sortSpec).then(({ items, count }) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items, count, page: pg, limit: lim, sort: sortField, order: sortDir === 1 ? 'asc' : 'desc' }));
    }).catch(err => {
        console.error('admin list failed', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to list' }));
    });
};

const handleAdminListUsers = (req, res, userId) =>
    requireAdmin(userId, res, () => adminListResponder(req, res, adminListUsers));

const handleAdminListGames = (req, res, userId) =>
    requireAdmin(userId, res, () => adminListResponder(req, res, adminListGames));

const handleAdminListAssets = (req, res, userId) =>
    requireAdmin(userId, res, () => adminListResponder(req, res, adminListAllAssets));

const handleAdminStats = (req, res, userId) =>
    requireAdmin(userId, res, () => {
        adminGetStats().then(stats => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stats));
        }).catch(err => {
            console.error('admin stats failed', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to load stats' }));
        });
    });

const handleAdminSetAssetNsfw = (req, res, userId, assetId) =>
    requireAdmin(userId, res, () => {
        getReqBody(req, (_body, err) => {
            if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'Error reading request' })); return; }
            let body;
            try { body = JSON.parse(_body); } catch (e) { body = {}; }
            setAssetNsfw(assetId, !!body.nsfw).then(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ assetId, nsfw: !!body.nsfw }));
            }).catch(() => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to update' }));
            });
        });
    });

const handleHealth = (req, res) => {
    res.end('ok!');
};

// ---------------------------------------------------------------------------
// Game Sessions — create a session on homegames-core via Homenames
// ---------------------------------------------------------------------------

const handleCreateSession = (req, res) => {
    const ip = getClientIP(req);
    if (!sessionCreateLimiter(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session limit: 1 per minute. Please wait.' }));
        return;
    }

    const http = require('http');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { pipeline } = require('stream');
    const { HOMENAMES_URL } = require('./config');
    const { downloadArchive } = require('./forgejo');

    getReqBody(req, (_body, err) => {
        if (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Error reading request' }));
            return;
        }

        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }

        const { gameId, commitSha } = body;
        if (!gameId) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'gameId is required' }));
            return;
        }

        // Look up the game to find its Forgejo repo
        getGame(gameId).then(game => {
            if (!game.forgejoRepo) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Game has no repository' }));
                return;
            }

            // If no commitSha given, find the latest published version
            const findCommit = commitSha
                ? Promise.resolve(commitSha)
                : new Promise((resolve, reject) => {
                    getMongoCollection('gameVersions').then(collection => {
                        collection.find({ gameId, published: true })
                            .sort({ publishedAt: -1 })
                            .limit(1)
                            .toArray()
                            .then(versions => {
                                if (versions.length === 0) {
                                    reject('No published versions for this game');
                                } else {
                                    resolve(versions[0].commitSha);
                                }
                            }).catch(reject);
                    }).catch(reject);
                });

            findCommit.then(sha => {
                const [owner, repo] = game.forgejoRepo.split('/');

                console.log(`[sessions] Downloading archive for ${owner}/${repo}@${sha.substring(0, 7)}`);

                // Download the archive from Forgejo
                downloadArchive(owner, repo, sha).then(archiveBuf => {
                    const tar = require('tar');
                    const { Readable } = require('stream');

                    // Extract archive to temp directory
                    const tmpDir = path.join(os.tmpdir(), `hg-game-${gameId}-${sha.substring(0, 7)}-${Date.now()}`);
                    fs.mkdirSync(tmpDir, { recursive: true });

                    const bufStream = new Readable();
                    bufStream.push(archiveBuf);
                    bufStream.push(null);

                    bufStream.pipe(tar.x({ cwd: tmpDir }))
                        .on('error', (extractErr) => {
                            console.error('[sessions] Failed to extract archive:', extractErr.message);
                            res.writeHead(500);
                            res.end(JSON.stringify({ error: 'Failed to extract game archive' }));
                        })
                        .on('finish', () => {

                    // Find the extracted directory (Forgejo wraps in a subdir like "reponame")
                    const entries = fs.readdirSync(tmpDir).filter(e => {
                        return fs.statSync(path.join(tmpDir, e)).isDirectory();
                    });

                    const gamePath = entries.length > 0
                        ? path.join(tmpDir, entries[0])
                        : tmpDir;

                    // Verify index.js exists
                    if (!fs.existsSync(path.join(gamePath, 'index.js'))) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Game archive does not contain index.js' }));
                        return;
                    }

                    console.log(`[sessions] Game extracted to ${gamePath}, calling Homenames`);

                    // Call Homenames POST /sessions
                    const homenamesUrl = new URL(HOMENAMES_URL);
                    const postBody = JSON.stringify({
                        gamePath: path.join(gamePath, 'index.js'),
                        gameId,
                        gameKey: game.name || gameId,
                    });

                    const homenamesReq = http.request({
                        hostname: homenamesUrl.hostname,
                        port: homenamesUrl.port,
                        path: '/sessions',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(postBody),
                        },
                    }, (homenamesRes) => {
                        let data = '';
                        homenamesRes.on('data', (chunk) => { data += chunk; });
                        homenamesRes.on('end', () => {
                            if (homenamesRes.statusCode >= 200 && homenamesRes.statusCode < 300) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(data);
                            } else {
                                console.error('[sessions] Homenames error:', data);
                                res.writeHead(homenamesRes.statusCode || 500);
                                res.end(data);
                            }
                        });
                    });

                    homenamesReq.on('error', (e) => {
                        console.error('[sessions] Failed to reach Homenames:', e.message);
                        res.writeHead(502);
                        res.end(JSON.stringify({ error: 'Failed to reach game server' }));
                    });

                    homenamesReq.write(postBody);
                    homenamesReq.end();

                    }); // end tar on('finish')

                }).catch(archiveErr => {
                    console.error('[sessions] Failed to download archive:', archiveErr);
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to download game code' }));
                });
            }).catch(commitErr => {
                res.writeHead(400);
                res.end(JSON.stringify({ error: typeof commitErr === 'string' ? commitErr : 'Failed to find version' }));
            });
        }).catch(gameErr => {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Game not found' }));
        });
    });
};

// ---------------------------------------------------------------------------
// Get published versions for a game (for the version dropdown in "Try it")
// ---------------------------------------------------------------------------

const handleGetPublishedVersions = (req, res, gameId) => {
    getMongoCollection('gameVersions').then(collection => {
        collection.find({ gameId, published: true })
            .sort({ publishedAt: -1 })
            .toArray()
            .then(versions => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    versions: versions.map(v => ({
                        versionId: v.versionId,
                        commitSha: v.commitSha,
                        publishedAt: v.publishedAt,
                        publishedBy: v.publishedBy,
                    })),
                }));
            }).catch(err => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to list versions' }));
            });
    }).catch(err => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Database error' }));
    });
};

module.exports = {
    setGameMaps,
    handleDeleteGame, handleDeleteAsset, handleDeleteDeveloper,
    handlePostMap, handlePostProfile, handleVerifyDns, handleAdminAck,
    handlePostCertRequest, handleBugs, handleContact,
    handleCreateGame, handleCreateAsset, handleGamePublish, handleGameUpdate,
    handleServices,
    handleSignup, handleLogin, handleRequestAction,
    handleVerifyCode, handleResendVerification, handleMe,
    handleForgotPassword, handleResetPassword,
    handleGetMap, handleGetCertStatus, handleGetAsset,
    handleGetBlog, handleGetBlogDetail, handleGithubLink,
    handleGetPodcast, handleGetServiceRequest,
    handleListMyGames, handleListGames, handleGetGameDetail,
    handleGetIp, handleGetGameVersionDetail, handleListAssets,
    handleGetDevProfile, handleGetProfile, handleGetPublishRequests,
    handleAdminListSupportMessages, handleAdminListPendingPublishRequests,
    handleAdminListFailedPublishRequests, handleHealth,
    handleAdminListUsers, handleAdminListGames, handleAdminListAssets,
    handleAdminStats, handleAdminSetAssetNsfw,
    handleCreateSession, handleGetPublishedVersions,
    handleRefreshToken, handleUpdateAssetTags, handleUpdateAssetMeta,
    handleListPublicAssets,
    handleGetGameSourceTree, handleGetGameSourceFile,
};

// ---------------------------------------------------------------------------
// Public source viewing (read-only, published versions only)
// ---------------------------------------------------------------------------

const { forgejoRequest } = require('./forgejo');

const verifyPublishedCommit = (gameId, commitSha) => new Promise((resolve, reject) => {
    getMongoCollection('gameVersions').then(collection => {
        collection.findOne({ gameId, commitSha, published: true }).then(version => {
            if (!version) {
                reject('Version not found or not published');
            } else {
                resolve(version);
            }
        }).catch(reject);
    }).catch(reject);
});

function handleGetGameSourceTree(req, res, gameId) {
    const queryObject = url.parse(req.url, true).query;
    const ref = queryObject.ref;

    if (!ref) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'ref parameter is required' }));
        return;
    }

    verifyPublishedCommit(gameId, ref).then(() => {
        getGame(gameId).then(game => {
            if (!game.forgejoRepo) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Game has no repository' }));
                return;
            }

            const [owner, repo] = game.forgejoRepo.split('/');
            forgejoRequest('GET', `/repos/${owner}/${repo}/git/trees/${ref}?recursive=true`).then(tree => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(tree));
            }).catch(err => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to get file tree' }));
            });
        }).catch(() => {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Game not found' }));
        });
    }).catch(err => {
        res.writeHead(403);
        res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Access denied' }));
    });
}

function handleGetGameSourceFile(req, res, gameId) {
    const queryObject = url.parse(req.url, true).query;
    const { path: filePath, ref } = queryObject;

    if (!ref || !filePath) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'ref and path parameters are required' }));
        return;
    }

    verifyPublishedCommit(gameId, ref).then(() => {
        getGame(gameId).then(game => {
            if (!game.forgejoRepo) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Game has no repository' }));
                return;
            }

            const [owner, repo] = game.forgejoRepo.split('/');
            forgejoRequest('GET', `/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`).then(fileData => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(fileData));
            }).catch(err => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to get file' }));
            });
        }).catch(() => {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Game not found' }));
        });
    }).catch(err => {
        res.writeHead(403);
        res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Access denied' }));
    });
}
