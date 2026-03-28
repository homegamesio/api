const fs = require('fs');
const url = require('url');
const multiparty = require('multiparty');
const { v4: uuidv4 } = require('uuid');
const { Binary } = require('mongodb');

const { MAX_SIZE } = require('./config');
const { generateId, getHash } = require('./crypto');
const { assetResponse } = require('./models');
const {
    getUserRecord, createSupportMessage, createBlogPost, getBlogPost, listBlogPosts,
    getMongoAsset, getMongoDocument, getMongoCollection, uploadMongo,
    getProfileInfo, getGame, updateGame, listAssets, createAssetRecord,
    adminListPendingPublishRequests, adminAcknowledgeMessage, adminListSupportMessages,
    adminListFailedPublishRequests, listPublishRequests, getGameDetails,
    getPublishRequest, updatePublishRequestState, adminPublishRequestAction,
    listMyGames, updateMongoProfileInfo, deleteGame, getCertStatus,
} = require('./db');
const { elasticDeleteGame, listGames, listPublicGamesForAuthor, updateGameIndex } = require('./search');
const { createGameImagePublishRequest, createContentRequest, createProfileImageTask } = require('./queue');
const { login, signup } = require('./auth');
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
    // createGame in db.js calls updateGameSearch and createGameImagePublishRequest
    // but the original was in index.js with access to both. We replicate it here.
    const { updateGameSearch } = require('./search');
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
                updateGameSearch(beforeMongoInsertsId).catch((err) => {
                    console.error("Failed to update game search");
                    console.error(err);
                });
                createGameImagePublishRequest(developerId, thumbnailAssetId, gameId).catch((err) => {
                    console.error('Failed to create game image request');
                    console.error(err);
                });
            }).catch(reject);
        });
    });
};

const updateProfileInfo = (userId, { description, image }) => {
    return updateMongoProfileInfo(userId, { description, image }, createProfileImageTask);
};

// DELETE handlers

const handleDeleteGame = (req, res, userId, gameId) => {
    getUserRecord(userId).then(userData => {
        if (userData.isAdmin) {
            console.log('wanna delete ' + gameId);
            deleteGame(gameId, elasticDeleteGame).then(() => res.end(''));
        } else {
            console.warn(`user ${userId} tried to delete game ${gameId}`);
            res.end('');
        }
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
    const requesterIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    handleCertRequest(requesterIp).then(response => {
        zipCert(response).then((zippedB64) => {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream'
            });
            res.end(zippedB64);
        });
    }).catch(err => {
        res.writeHead(400);
        res.end(err);
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

                console.log("FIFIFIFI");
                console.log(files);
                const fileValues = Object.values(files);

                let hack = false;

                const uploadedFiles = fileValues[0].map(f => {
                    if (hack) {
                        return;
                    }
                    hack = true;

                    if (f.size > MAX_SIZE) {
                        res.writeHead(400);
                        res.end('File size exceeds ' + MAX_SIZE + ' bytes');
                    } else {
                        const assetId = generateId();
                        const description = fields?.description?.[0] || '';
                        createAssetRecord(userId, assetId, f.size, f.originalFilename, {
                            'Content-Type': f.headers['content-type']
                        }, `thumbnail for game ${gameId}`).then((asset) => {
                            getMongoCollection('documents').then(documentCollection => {
                                documentCollection.insertOne({ developerId: userId, assetId, data: new Binary(fs.readFileSync(f.path)), fileSize: f.size, fileType: f.headers['content-type'] }).then(() => {
                                    console.log('dsfjkdsfkjhdsfkjhds');
                                    console.log(asset);
                                    createGame(userId, asset.assetId, fields, files).then(game => {
                                        console.log('created game');
                                        console.log(game);
                                        res.writeHead(200, {
                                            'Content-Type': 'application/json'
                                        });
                                        res.end(JSON.stringify(game));
                                    });
                                });
                            });
                        });
                    }
                });
            }
        }
    });
};

const handleCreateAsset = (req, res, userId) => {
    const form = new multiparty.Form();
    form.parse(req, (err, fields, files) => {
        if (!files) {
            res.end('no');
        } else {
            const fileValues = Object.values(files);
            let hack = false;

            const uploadedFiles = fileValues[0].map(f => {
                if (hack) {
                    return;
                }
                hack = true;

                if (f.size > MAX_SIZE) {
                    res.writeHead(400);
                    res.end('File size exceeds ' + MAX_SIZE + ' bytes');
                } else {
                    const assetId = getHash(uuidv4());
                    const description = fields?.description?.[0] || '';
                    createAssetRecord(userId, assetId, f.size, f.originalFilename, {
                        'Content-Type': f.headers['content-type']
                    }, description).then(() => {
                        uploadMongo(userId, assetId, f.path, f.originalFilename, f.size, f.headers['content-type']).then((assetId) => {
                            res.writeHead(200, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({ assetId }));
                        });
                    });
                }
            });
        }
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
                    createGameImagePublishRequest(userId, data.thumbnail, gameId);
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

const handleSubmitPublishRequest = (req, res, userId) => {
    getReqBody(req, (_data) => {
        const data = JSON.parse(_data);
        const { requestId } = data;
        getPublishRequest(requestId).then(requestData => {
            updatePublishRequestState(requestId, requestData.game_id, requestData.source_info_hash, 'PENDING_PUBLISH_APPROVAL').then(() => {
                res.end('ok');
            }).catch(err => {
                res.end(err.toString());
            });
        }).catch(err => {
            res.end(err.toString());
        });
    });
};

const handleCreateBlog = (req, res, userId) => {
    getUserRecord(userId).then(userData => {
        if (!userData.isAdmin) {
            res.writeHead(401);
            res.end('Not an admin');
        } else {
            getReqBody(req, (_data) => {
                createBlogPost(userId, JSON.parse(_data)).then(() => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(_data);
                });
            });
        }
    }).catch(err => {
        res.end(err.toString());
    });
};

const handleSignup = (req, res) => {
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
            signup(signupBody).then((token) => {
                res.end(JSON.stringify({ token }));
            }).catch(signupError => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: signupError}));
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
                res.end(err.toString());
            });
        }
    });
};

const handleRequestAction = (req, res, userId, requestId) => {
    getUserRecord(userId).then(userData => {
        if (userData.isAdmin) {
            getReqBody(req, (_data) => {
                const reqBody = JSON.parse(_data);
                if (reqBody.action) {
                    adminPublishRequestAction(requestId, reqBody.action, reqBody.message).then((gameId) => {
                        if (reqBody.action === 'approve') {
                            updateGameIndex(gameId, getGame).then(() => {
                                res.end('');
                            }).catch(err => {
                                res.end(err.toString());
                            });
                        }
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
    const requesterIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    getCertStatus(requesterIp).then((certStatus) => {
        const body = certStatus;
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
                    console.log("JDSFJDSJFDSF");
                    res.writeHead(200, { 'Content-Disposition': `inline; filename=${encodeURI(assetData.name)}` });
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
    let { query, author, offset, limit } = queryObject;
    if (!offset) { offset = 0; }
    if (!limit) { limit = 10; }
    if (author) {
        listPublicGamesForAuthor({ author, offset, limit }).then((data) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        }).catch(err => {
            console.log('unable to list games for author');
            console.log(err);
            res.end('error');
        });
    } else {
        listGames(limit, offset, null, query).then(results => {
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
                res.end(JSON.stringify(supportMessages));
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

const handleHealth = (req, res) => {
    res.end('ok!');
};

module.exports = {
    setGameMaps,
    handleDeleteGame,
    handlePostMap, handlePostProfile, handleVerifyDns, handleAdminAck,
    handlePostCertRequest, handleBugs, handleContact,
    handleCreateGame, handleCreateAsset, handleGamePublish, handleGameUpdate,
    handleServices, handleSubmitPublishRequest, handleCreateBlog,
    handleSignup, handleLogin, handleRequestAction,
    handleGetMap, handleGetCertStatus, handleGetAsset,
    handleGetBlog, handleGetBlogDetail, handleGithubLink,
    handleGetPodcast, handleGetServiceRequest,
    handleListMyGames, handleListGames, handleGetGameDetail,
    handleGetIp, handleGetGameVersionDetail, handleListAssets,
    handleGetDevProfile, handleGetProfile, handleGetPublishRequests,
    handleAdminListSupportMessages, handleAdminListPendingPublishRequests,
    handleAdminListFailedPublishRequests, handleHealth,
};
