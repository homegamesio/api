const fs = require('fs');
const url = require('url');
const multiparty = require('multiparty');
const { v4: uuidv4 } = require('uuid');
const { Binary } = require('mongodb');

const { MAX_SIZE, CERT_DOMAIN } = require('./config');
const assetCache = require('./asset-cache');

// Asset bytes are immutable per id, so cached copies can live a long time.
const ASSET_CACHE_MAX_AGE = 31536000; // 1 year

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
const SESSION_CREATE_WINDOW_MS = 30 * 1000;
const sessionCreateLimiter = rateLimit('session-create', SESSION_CREATE_WINDOW_MS, 1);  // 1 session per 30s per IP
const certRequestLimiter = rateLimit('cert-request', 60 * 60 * 1000, 5); // 5 cert requests per hour per IP (each triggers a real ACME order)
const { generateId, getHash, generateJwt, verifyToken } = require('./crypto');
const { assetResponse } = require('./models');
const {
    getUserRecord, createSupportMessage, createBlogPost, getBlogPost, listBlogPosts,
    createComment, listComments, getComment, deleteComment, adminListComments,
    getAssetFileSizes,
    getMongoAsset, getMongoDocument, getMongoCollection, uploadMongo,
    getProfileInfo, getGame, updateGame, listAssets, createAssetRecord,
    getAssetCount, MAX_ASSETS_PER_USER,
    adminListPendingPublishRequests, adminAcknowledgeMessage, adminListSupportMessages,
    adminListFailedPublishRequests, listPublishRequests, getGameDetails, incrementGameDownloads,
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
                        // Drop any of this developer's images from the asset cache.
                        assetCache.evictBy(e => e.developerId === devId);
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

// Password brute-force protection: bound attempts per source IP and, because an
// attacker can rotate IPs, per target account. Successful logins count toward the
// limits too, but they're set well above any legitimate login frequency.
const loginIpLimiter = rateLimit('login-ip', 5 * 60 * 1000, 10);             // 10 / 5min / IP
const loginAccountLimiter = rateLimit('login-account', 15 * 60 * 1000, 20);  // 20 / 15min / account

const handleLogin = (req, res) => {
    const ip = getClientIP(req);
    if (!loginIpLimiter(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many login attempts. Please wait a few minutes.' }));
        return;
    }

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
            // Same normalization as auth.login so alias forms (case, whitespace)
            // share one bucket.
            const account = String(loginBody.username || '').trim().toLowerCase();
            if (account && !loginAccountLimiter(account)) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Too many login attempts for this account. Please wait a few minutes.' }));
                return;
            }
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

// Write an asset payload with caching headers, honoring conditional requests.
const serveAssetEntry = (req, res, entry) => {
    res.setHeader('Cache-Control', `public, max-age=${ASSET_CACHE_MAX_AGE}, immutable`);
    res.setHeader('ETag', entry.etag);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURI(entry.name)}"`);
    if (entry.contentType) {
        res.setHeader('Content-Type', entry.contentType);
    }
    // Client already holds this exact version — skip resending the body.
    if (req.headers['if-none-match'] === entry.etag) {
        res.writeHead(304);
        res.end();
        return;
    }
    res.writeHead(200);
    res.end(entry.buffer);
};

const handleGetAsset = (req, res, assetId) => {
    const cached = assetCache.get(assetId);
    if (cached) {
        serveAssetEntry(req, res, cached);
        return;
    }
    getMongoAsset(assetId).then((assetData) => {
        if (!assetData) {
            res.writeHead(404);
            res.end('Asset not found');
            return;
        }
        getMongoDocument(assetId).then((documentData) => {
            if (!documentData) {
                res.writeHead(404);
                res.end();
                return;
            }
            const contentType = (assetData.metadata && assetData.metadata['Content-Type']) || null;
            const entry = {
                buffer: documentData.data.buffer,
                contentType,
                name: (assetData.name || 'asset').replace(/["\r\n]/g, ''),
                etag: `"asset-${assetId}"`,
                size: documentData.data.buffer.length,
                developerId: assetData.developerId,
            };
            // Only the image hot path is cached in memory (per design); other
            // asset types still get HTTP cache headers but always hit the DB.
            if (contentType && contentType.startsWith('image/')) {
                assetCache.set(assetId, entry);
            }
            serveAssetEntry(req, res, entry);
        });
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
    let { limit, offset, sort, query, type } = queryObject;
    if (!offset) { offset = 0; }
    if (!limit || limit > 100) { limit = 10; }
    listAssets(userId, query, limit, offset, type || null).then(_assets => {
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
            assetCache.del(assetId);
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
                assetCache.del(assetId);
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
            assetCache.del(assetId);
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

const handleAdminListComments = (req, res, userId) =>
    requireAdmin(userId, res, () => adminListResponder(req, res, adminListComments));

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
        const retryAfter = SESSION_CREATE_WINDOW_MS / 1000;
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
        res.end(JSON.stringify({ error: 'One session at a time — please wait a moment.', retryAfter }));
        return;
    }

    const http = require('http');
    const { HOMENAMES_URL } = require('./config');

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
        // "private" here means unlisted — Homenames keeps the session out of
        // its public GET /sessions listing; joining by link still works.
        const isPrivate = body.private === true;
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

            // If no commitSha given, find the latest published version.
            // If one is given, it must be a published commit — Homenames fetches
            // source through the public catalog endpoints, which only serve
            // published commits.
            const findCommit = commitSha
                ? verifyPublishedCommit(gameId, commitSha).then(() => commitSha)
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
                console.log(`[sessions] Requesting session for ${gameId}@${sha.substring(0, 7)} from Homenames`);

                // Call Homenames POST /sessions — pass the game by reference;
                // homegames-core downloads the source itself through the public
                // catalog endpoints (source-tree/source), so the API never has
                // to fetch or stage game code.
                const homenamesUrl = new URL(HOMENAMES_URL);
                const postBody = JSON.stringify({
                    gameId,
                    commitSha: sha,
                    gameKey: game.name || gameId,
                    private: isPrivate,
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
                            // Record a minimal session-start stat (fire-and-forget:
                            // never block or fail the response on a stats write).
                            getMongoCollection('sessions').then(sessions => sessions.insertOne({
                                gameId,
                                commitSha: sha,
                                created: Date.now(),
                                private: isPrivate,
                            })).catch(statErr => console.error('[sessions] stat write failed:', statErr.message));

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
// Admin: running-session view + persistence toggle
//
// The browser must NOT hit Homenames directly for these — the persistence
// toggle is gated by the shared secret, which lives only in server env. The
// API authenticates the admin (requireAdmin) and forwards with the secret.
// ---------------------------------------------------------------------------

// Proxy a request to Homenames, attaching the shared secret. Resolves
// { statusCode, body } (body is the raw string).
const homenamesRequest = (method, pathname, bodyObj) => new Promise((resolve, reject) => {
    const { HOMENAMES_URL, HOMENAMES_API_SECRET } = require('./config');
    const target = new URL(pathname, HOMENAMES_URL);
    const mod = target.protocol === 'https:' ? require('https') : require('http');
    const payload = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
    const headers = {};
    if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (HOMENAMES_API_SECRET) headers['Authorization'] = `Bearer ${HOMENAMES_API_SECRET}`;

    const hnReq = mod.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method,
        headers,
        rejectUnauthorized: false, // Homenames cert is for the public domain, not the internal host
    }, (hnRes) => {
        let data = '';
        hnRes.on('data', (chunk) => { data += chunk; });
        hnRes.on('end', () => resolve({ statusCode: hnRes.statusCode, body: data }));
    });
    hnReq.on('error', reject);
    hnReq.setTimeout(8000, () => { hnReq.destroy(); reject(new Error('Homenames request timed out')); });
    if (payload !== null) hnReq.write(payload);
    hnReq.end();
});

const handleAdminListSessions = (req, res, userId) =>
    requireAdmin(userId, res, () => {
        homenamesRequest('GET', '/sessions').then(({ statusCode, body }) => {
            let parsed;
            try { parsed = JSON.parse(body); } catch (e) { parsed = { sessions: [] }; }
            // The admin table expects { items }. Homenames returns { sessions }.
            const sessions = (parsed && parsed.sessions) || [];
            res.writeHead(statusCode >= 200 && statusCode < 300 ? 200 : statusCode,
                { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ items: sessions, count: sessions.length }));
        }).catch(err => {
            console.error('[admin] list sessions failed:', err.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to reach game server' }));
        });
    });

const handleAdminSetSessionPersistent = (req, res, userId, sessionId) =>
    requireAdmin(userId, res, () => {
        getReqBody(req, (_body, err) => {
            if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'Error reading request' })); return; }
            let body;
            try { body = JSON.parse(_body); } catch (e) { body = {}; }
            const persistent = !!body.persistent;
            homenamesRequest('POST', `/sessions/${encodeURIComponent(sessionId)}/persistent`, { persistent })
                .then(({ statusCode, body: respBody }) => {
                    res.writeHead(statusCode || 500, { 'Content-Type': 'application/json' });
                    res.end(respBody || JSON.stringify({ id: sessionId, persistent }));
                }).catch(errr => {
                    console.error('[admin] set session persistent failed:', errr.message);
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to reach game server' }));
                });
        });
    });

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

// ---------------------------------------------------------------------------
// Game comments
// ---------------------------------------------------------------------------
const MAX_COMMENT_LENGTH = 200;
const commentLimiter = rateLimit('comment', 10 * 60 * 1000, 1); // 1 comment / 10 min / authenticated user
// The anonymous limit (1 / 2h / IP) is enforced in db.createComment against
// Mongo, because a window that long shouldn't reset on process restart.

// Auth is optional here — a valid Authorization header attributes the comment,
// no header means anonymous. The router's requiresAuth flag is binary, so the
// token check lives in the handler.
const handlePostComment = (req, res, gameId) => {
    const finish = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    };

    const authHeader = req.headers.authorization;
    const resolveUser = authHeader
        ? verifyToken(authHeader).then(userInfo => getUserRecord(userInfo.userId))
        : Promise.resolve(null);

    resolveUser.then((user) => {
        // A client that sent a token expects attribution — reject a bad token
        // rather than silently posting anonymously.
        if (authHeader && !user) {
            finish(401, { error: 'Invalid token' });
            return;
        }

        getReqBody(req, (_data) => {
            let body;
            try {
                body = JSON.parse(_data);
            } catch (e) {
                finish(400, { error: 'invalid request json' });
                return;
            }

            const text = typeof body.text === 'string' ? body.text.trim() : '';
            if (!text) {
                finish(400, { error: 'Comment text required' });
                return;
            }
            if (text.length > MAX_COMMENT_LENGTH) {
                finish(400, { error: `Comments are limited to ${MAX_COMMENT_LENGTH} characters` });
                return;
            }

            getGame(gameId).then(() => {
                // Checked after validation so a rejected comment doesn't burn
                // the user's slot (the limiter counts every check).
                if (user && !commentLimiter(user.userId)) {
                    finish(429, { error: 'You can comment once every 10 minutes. Please wait a bit.' });
                    return;
                }
                createComment({
                    gameId,
                    text,
                    userId: user && user.userId,
                    displayName: user && user.displayName,
                    sourceIp: getClientIP(req),
                }).then((comment) => {
                    finish(200, comment);
                }).catch((err) => {
                    if (err && err.type === 'TOO_MANY_COMMENTS') {
                        finish(429, { error: err.message });
                    } else {
                        console.error(err);
                        finish(500, { error: 'Failed to create comment' });
                    }
                });
            }).catch(() => finish(404, { error: 'Game not found' }));
        });
    }).catch(() => finish(401, { error: 'Invalid token' }));
};

const handleGetComments = (req, res, gameId) => {
    const query = url.parse(req.url, true).query;
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 50);
    const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
    listComments(gameId, limit, offset).then(({ comments, total }) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ comments, total, limit, offset }));
    }).catch((err) => {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to list comments' }));
    });
};

// Owner or admin. Anonymous comments have no owner, so admin is the only
// removal path for those.
const handleDeleteComment = (req, res, userId, commentId) => {
    getComment(commentId).then((comment) => {
        if (!comment) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }
        getUserRecord(userId).then((user) => {
            const isAdmin = !!(user && user.isAdmin);
            if (comment.userId !== userId && !isAdmin) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not allowed' }));
                return;
            }
            deleteComment(commentId).then(() => {
                res.writeHead(204);
                res.end();
            }).catch((err) => {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to delete comment' }));
            });
        }).catch((err) => {
            console.error(err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'error' }));
        });
    }).catch((err) => {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'error' }));
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
    handlePostComment, handleGetComments, handleDeleteComment, handleAdminListComments,
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
    handleAdminListSessions, handleAdminSetSessionPersistent,
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

// ---------------------------------------------------------------------------
// Local play — client-side solo sessions + single-file downloads. Multiplayer
// games run locally too (as a solo session); only services the local runtime
// can't provide (e.g. contentGenerator) opt a game out.
// All static analysis — game code is never executed on the API.
// ---------------------------------------------------------------------------

const path = require('path');
const localPlay = require('./local-play');

// The homegames-client UMD bundle inlined into single-file downloads. In the
// sibling-repo dev layout this default resolves automatically; deployments
// set CLIENT_BUNDLE_PATH to wherever the built bundle lives.
const CLIENT_BUNDLE_PATH = process.env.CLIENT_BUNDLE_PATH
    || path.join(__dirname, '..', 'homegames-client', 'dist', 'homegames-client.js');

let _clientBundleSource = null;
const getClientBundleSource = () => {
    if (_clientBundleSource === null) {
        _clientBundleSource = fs.readFileSync(CLIENT_BUNDLE_PATH, 'utf8');
    }
    return _clientBundleSource;
};

// All caches key on gameId:ref — content is immutable per published commit,
// so entries never need invalidation, only eviction.
const LOCAL_CACHE_MAX = 32;
const _localContextCache = new Map();
const _capLocalCache = (map) => {
    while (map.size > LOCAL_CACHE_MAX) map.delete(map.keys().next().value);
};

// Byte-budgeted LRU for the big artifacts (asset bundles, composed download
// HTML) — these run 10-20MB each, so a count cap alone could balloon memory.
class LocalByteCache {
    constructor(maxBytes) {
        this.maxBytes = maxBytes;
        this.map = new Map();
        this.bytes = 0;
    }
    get(key) {
        const entry = this.map.get(key);
        if (!entry) return null;
        this.map.delete(key);
        this.map.set(key, entry); // LRU touch
        return entry.value;
    }
    set(key, value, size) {
        const existing = this.map.get(key);
        if (existing) { this.bytes -= existing.size; this.map.delete(key); }
        this.map.set(key, { value, size });
        this.bytes += size;
        while (this.bytes > this.maxBytes && this.map.size > 1) {
            const oldest = this.map.keys().next().value;
            this.bytes -= this.map.get(oldest).size;
            this.map.delete(oldest);
        }
    }
}

const _localBundleBytes = new LocalByteCache(192 * 1024 * 1024);
const _localHtmlBytes = new LocalByteCache(128 * 1024 * 1024);
const _localBundleInflight = new Map(); // dedups concurrent builds (stampede guard)

// Cache misses are the expensive path (Forgejo fetches, dozens of Mongo asset
// reads, MB-scale composition), and downloads serve 10-20MB responses — cap
// per-IP rates. Cache hits are cheap and repeat visits mostly 304 anyway.
const localManifestLimiter = rateLimit('local-manifest', 60 * 1000, 30);
const localBundleLimiter = rateLimit('local-bundle', 60 * 1000, 20);
const localDownloadLimiter = rateLimit('local-download', 60 * 1000, 6);
const playCountLimiter = rateLimit('play-count', 60 * 1000, 12);

const _tooMany = (res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many requests — try again in a minute' }));
};

const _encodeRepoPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// Fetches a published version's source files from Forgejo and statically
// extracts its metadata. Resolves { gameName, files, entryPoint, meta, playable }.
const getLocalPlayContext = (gameId, ref) => {
    const cacheKey = `${gameId}:${ref}`;
    if (_localContextCache.has(cacheKey)) return _localContextCache.get(cacheKey);

    const promise = verifyPublishedCommit(gameId, ref)
        .then(() => getGame(gameId))
        .then(game => {
            if (!game || !game.forgejoRepo) throw 'Game has no repository';
            const [owner, repo] = game.forgejoRepo.split('/');
            return forgejoRequest('GET', `/repos/${owner}/${repo}/git/trees/${ref}?recursive=true`)
                .then(tree => ({ game, owner, repo, tree }));
        })
        .then(({ game, owner, repo, tree }) => {
            const jsFiles = (tree.tree || []).filter(e => e.type === 'blob' && e.path.endsWith('.js'));
            const indexFiles = jsFiles
                .filter(e => e.path === 'index.js' || e.path.endsWith('/index.js'))
                .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
            if (!indexFiles.length) throw 'No index.js found in version';

            const entryPath = indexFiles[0].path;
            const entryDir = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/') + 1) : '';
            const included = jsFiles.filter(e => e.path.startsWith(entryDir));

            return Promise.all(included.map(e =>
                forgejoRequest('GET', `/repos/${owner}/${repo}/contents/${_encodeRepoPath(e.path)}?ref=${ref}`)
                    .then(fileData => ({
                        path: e.path.slice(entryDir.length),
                        content: Buffer.from(fileData.content, 'base64').toString('utf8'),
                    }))
            )).then(fileList => {
                const files = {};
                for (const f of fileList) files[f.path] = f.content;
                const entryPoint = entryPath.slice(entryDir.length);
                const meta = localPlay.parseGameSourceMetadata(files[entryPoint]);
                const playable = localPlay.checkLocalPlayable(meta);
                return { gameName: meta.name || game.name || 'Homegames', files, entryPoint, meta, playable };
            });
        });

    promise.catch(() => _localContextCache.delete(cacheKey));
    _localContextCache.set(cacheKey, promise);
    _capLocalCache(_localContextCache);
    return promise;
};

// Builds the binary type-1 asset bundle for a version. Asset reads run in
// small batches — a game can declare 80+ assets and each read is a Mongo
// findOne, so an unbounded fan-out would saturate the connection pool.
const buildLocalAssetBundle = (gameId, ref) => {
    const cacheKey = `${gameId}:${ref}`;
    const cached = _localBundleBytes.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    if (_localBundleInflight.has(cacheKey)) return _localBundleInflight.get(cacheKey);

    const promise = getLocalPlayContext(gameId, ref).then(context => {
        const assets = context.meta.assets || [];
        if (!assets.length) return Buffer.alloc(0);

        const entries = [];
        const BATCH_SIZE = 8;
        const runBatch = (start) => {
            if (start >= assets.length) return Promise.resolve();
            return Promise.all(assets.slice(start, start + BATCH_SIZE).map(a =>
                getMongoDocument(a.id).then(doc => {
                    if (!doc || !doc.data) throw `Asset ${a.id} (${a.key}) not found`;
                    const data = Buffer.from(doc.data.buffer);
                    // A truncated asset poisons the whole bundle — refuse to serve it.
                    if (doc.fileSize && data.length !== doc.fileSize) {
                        throw `Asset ${a.id} (${a.key}) is truncated: ${data.length}/${doc.fileSize} bytes`;
                    }
                    entries.push({ key: a.key, type: a.type, data });
                })
            )).then(() => runBatch(start + BATCH_SIZE));
        };

        return runBatch(0).then(() => {
            // Restore declared order (batch completion can interleave pushes)
            const order = {};
            assets.forEach((a, i) => { order[a.key] = i; });
            entries.sort((x, y) => order[x.key] - order[y.key]);
            return localPlay.packAssetBundle(entries);
        });
    }).then(bundle => {
        _localBundleBytes.set(cacheKey, bundle, bundle.length);
        _localBundleInflight.delete(cacheKey);
        return bundle;
    }).catch(err => {
        _localBundleInflight.delete(cacheKey);
        throw err;
    });

    _localBundleInflight.set(cacheKey, promise);
    return promise;
};

const _localPlayError = (res, err) => {
    console.error('[local-play]', err);
    if (typeof err === 'string') {
        const status = err.includes('not published') || err.includes('not found') ? 404 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err }));
    } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
    }
};

const _requireRef = (req, res) => {
    const ref = url.parse(req.url, true).query.ref;
    if (!ref) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ref parameter is required' }));
        return null;
    }
    return ref;
};

// Estimated byte size of the single-file download, computed from stored asset
// sizes so the manifest never has to compose the (10-20MB) artifact: per asset
// a 44-byte bundle header + fileSize, base64 inflation (4/3), the inline JSON
// payload, the client bundle, and the fixed HTML template. Exact when the
// composed HTML is already cached; null when it can't be known cheaply
// (missing size metadata, client bundle unavailable).
const HTML_TEMPLATE_OVERHEAD = 1200;
const estimateDownloadSizeBytes = (gameId, ref, context, downloadable) => {
    if (!downloadable) return Promise.resolve(null);

    const cached = _localHtmlBytes.get(`${gameId}:${ref}`);
    if (cached) return Promise.resolve(cached.html.length);

    let clientLen;
    try {
        clientLen = getClientBundleSource().length;
    } catch (e) {
        return Promise.resolve(null);
    }

    const assets = context.meta.assets || [];
    const sizesPromise = assets.length ? getAssetFileSizes(assets.map(a => a.id)) : Promise.resolve([]);
    return sizesPromise.then((docs) => {
        const sizeById = {};
        docs.forEach(d => { if (typeof d.fileSize === 'number') sizeById[d.assetId] = d.fileSize; });

        let bundleBytes = 0;
        for (const a of assets) {
            if (sizeById[a.id] == null) return null; // unknown asset size — don't guess
            bundleBytes += sizeById[a.id] + 44;
        }

        const b64Len = bundleBytes ? Math.ceil(bundleBytes / 3) * 4 : 0;
        const payloadLen = Buffer.byteLength(JSON.stringify({
            name: context.gameName,
            files: context.files,
            entryPoint: context.entryPoint,
            assetBundleBase64: null,
        }));
        // The real payload swaps JSON's `null` (4 chars) for the quoted base64 string.
        const payloadWithBundle = b64Len ? payloadLen - 4 + b64Len + 2 : payloadLen;

        return clientLen + payloadWithBundle + HTML_TEMPLATE_OVERHEAD;
    }).catch(() => null);
};

function handleGetLocalManifest(req, res, gameId) {
    const ref = _requireRef(req, res);
    if (!ref) return;

    // v2: added downloadSizeBytes — new tag so revalidating clients pick it up.
    const etag = `"manifest-v2-${gameId}-${ref}"`;
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag });
        res.end();
        return;
    }

    if (!localManifestLimiter(getClientIP(req))) return _tooMany(res);

    getLocalPlayContext(gameId, ref).then(context => {
        const downloadable = localPlay.checkDownloadable(context.meta);
        estimateDownloadSizeBytes(gameId, ref, context, downloadable.downloadable).then((downloadSizeBytes) => {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': `public, max-age=${ASSET_CACHE_MAX_AGE}, immutable`,
                'ETag': etag,
            });
            res.end(JSON.stringify({
                localPlayable: context.playable.playable,
                reason: context.playable.reason || null,
                multiplayer: (context.meta.services || []).includes('multiplayer'),
                downloadable: downloadable.downloadable,
                downloadSizeBytes,
                name: context.gameName,
                squishVersion: context.meta.squishVersion,
                entryPoint: context.entryPoint,
                files: context.files,
                assetCount: (context.meta.assets || []).length,
                assetBundleUrl: `/games/${gameId}/asset-bundle?ref=${ref}`,
            }));
        });
    }).catch(err => _localPlayError(res, err));
}

function handleGetLocalAssetBundle(req, res, gameId) {
    const ref = _requireRef(req, res);
    if (!ref) return;

    const etag = `"bundle-${gameId}-${ref}"`;
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag });
        res.end();
        return;
    }

    if (!localBundleLimiter(getClientIP(req))) return _tooMany(res);

    buildLocalAssetBundle(gameId, ref).then(bundle => {
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': bundle.length,
            'Cache-Control': `public, max-age=${ASSET_CACHE_MAX_AGE}, immutable`,
            'ETag': etag,
        });
        res.end(bundle);
    }).catch(err => _localPlayError(res, err));
}

// Beacon from the game page's Play button — local plays count toward the
// game's download total (playing locally downloads the game to the browser).
function handleCountPlay(req, res, gameId) {
    if (!playCountLimiter(getClientIP(req))) return _tooMany(res);
    incrementGameDownloads(gameId);
    res.writeHead(204);
    res.end();
}

function handleGetLocalDownload(req, res, gameId) {
    const ref = _requireRef(req, res);
    if (!ref) return;

    const etag = `"download-${gameId}-${ref}"`;
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag });
        res.end();
        return;
    }

    const shortSha = String(ref).slice(0, 7);
    const cacheKey = `${gameId}:${ref}`;

    const serve = (htmlBuffer, gameName) => {
        incrementGameDownloads(gameId);
        const safeName = (gameName || 'game').replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'game';
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': htmlBuffer.length,
            'Content-Disposition': `attachment; filename="${safeName}-${shortSha}.html"`,
            'Cache-Control': `public, max-age=${ASSET_CACHE_MAX_AGE}, immutable`,
            'ETag': etag,
        });
        res.end(htmlBuffer);
    };

    // Composed HTML is cached — a hit costs one buffer write, no composition.
    const cached = _localHtmlBytes.get(cacheKey);
    if (cached) return serve(cached.html, cached.name);

    if (!localDownloadLimiter(getClientIP(req))) return _tooMany(res);

    let clientBundleSource;
    try {
        clientBundleSource = getClientBundleSource();
    } catch (e) {
        console.error('[local-play] client bundle unavailable at ' + CLIENT_BUNDLE_PATH, e.message);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Downloads are not available on this server' }));
        return;
    }

    Promise.all([
        getLocalPlayContext(gameId, ref),
        buildLocalAssetBundle(gameId, ref),
    ]).then(([context, bundle]) => {
        // Multiplayer games are downloadable (they run as a solo local
        // session); only structurally-broken games are refused.
        const downloadable = localPlay.checkDownloadable(context.meta);
        if (!downloadable.downloadable) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: downloadable.reason }));
            return;
        }

        const html = Buffer.from(localPlay.buildLocalHtml({
            name: context.gameName,
            files: context.files,
            entryPoint: context.entryPoint,
            assetBundleBase64: bundle.length ? bundle.toString('base64') : null,
            clientBundleSource,
        }));

        _localHtmlBytes.set(cacheKey, { html, name: context.gameName }, html.length);
        serve(html, context.gameName);
    }).catch(err => _localPlayError(res, err));
}

module.exports.handleGetLocalManifest = handleGetLocalManifest;
module.exports.handleGetLocalAssetBundle = handleGetLocalAssetBundle;
module.exports.handleCountPlay = handleCountPlay;
module.exports.handleGetLocalDownload = handleGetLocalDownload;
