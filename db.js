const fs = require('fs');
const { Binary, MongoClient } = require('mongodb');
const { DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME } = require('./config');
const { generateId, hashValue } = require('./crypto');
const { mapBlogPost, mapMongoGame } = require('./models');

let _mongoClient = null;

const getMongoClient = () => {
    if (_mongoClient) return _mongoClient;

    const uri = DB_USERNAME ? `mongodb://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}` : `mongodb://${DB_HOST}:${DB_PORT}/${DB_NAME}`;
    const params = {};
    if (DB_USERNAME) {
        params.auth = {
            username: DB_USERNAME,
            password: DB_PASSWORD
        };
        params.authSource = 'admin';
    }

    _mongoClient = new MongoClient(uri, params);
    return _mongoClient;
};

const getMongoCollection = (collectionName) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db(DB_NAME);
        const collection = db.collection(collectionName);
        resolve(collection);
    }).catch(reject);
});

const getMongoAsset = (assetId) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db(DB_NAME);
        const assetCollection = db.collection('assets');
        assetCollection.findOne({ assetId }).then(resolve).catch(reject);
    }).catch(reject);
});

const getMongoDocument = (assetId) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db(DB_NAME);
        const documentCollection = db.collection('documents');
        documentCollection.findOne({ assetId }).then(resolve).catch(reject);
    }).catch(reject);
});

const getUserRecord = (userId) => new Promise((resolve, reject) => {
    getMongoCollection('users').then(collection => {
        collection.findOne({ userId }).then(resolve).catch(reject);
    }).catch(reject);
});

const getUserByDisplayName = (displayNameLower) => new Promise((resolve, reject) => {
    getMongoCollection('users').then(c => c.findOne({ displayNameLower }).then(resolve).catch(reject)).catch(reject);
});

const getUserByEmail = (emailLower) => new Promise((resolve, reject) => {
    getMongoCollection('users').then(c => c.findOne({ emailLower }).then(resolve).catch(reject)).catch(reject);
});

const createUser = (record) => new Promise((resolve, reject) => {
    getMongoCollection('users').then(c => c.insertOne(record).then(() => resolve(record)).catch(reject)).catch(reject);
});

const setUserVerified = (userId) => new Promise((resolve, reject) => {
    getMongoCollection('users').then(c => c.updateOne(
        { userId },
        { $set: { verified: true }, $unset: { verificationCodeHash: '', verificationCodeExpires: '' } }
    ).then(resolve).catch(reject)).catch(reject);
});

const setVerificationCode = (userId, verificationCodeHash, verificationCodeExpires) => new Promise((resolve, reject) => {
    getMongoCollection('users').then(c => c.updateOne(
        { userId },
        { $set: { verificationCodeHash, verificationCodeExpires } }
    ).then(resolve).catch(reject)).catch(reject);
});

const setPasswordResetCode = (userId, resetCodeHash, resetCodeExpires) => new Promise((resolve, reject) => {
    getMongoCollection('users').then(c => c.updateOne(
        { userId },
        { $set: { resetCodeHash, resetCodeExpires } }
    ).then(resolve).catch(reject)).catch(reject);
});

const resetUserPassword = (userId, passwordHash, passwordSalt) => new Promise((resolve, reject) => {
    getMongoCollection('users').then(c => c.updateOne(
        { userId },
        { $set: { passwordHash, passwordSalt }, $unset: { resetCodeHash: '', resetCodeExpires: '' } }
    ).then(resolve).catch(reject)).catch(reject);
});

const createSupportMessage = (body, sourceIp) => new Promise((resolve, reject) => {
    const ipHash = hashValue(sourceIp);
    getMongoCollection('supportMessages').then((collection) => {
        const now = Date.now();
        const oneDayAgo = now - (24 * 60 * 60 * 1000);
        collection.find({ ipHash, 'status': 'PENDING', created: { '$gte': oneDayAgo } }).toArray().then((results) => {
            // if we have 3 pending messages from this ip in the last 24 hours, reject
            if (results.length >= 3) {
                reject({ type: 'TOO_MANY_MESSAGES', message: 'Too many messages from this IP'});
            } else {
                const id = generateId();
                collection.insertOne({ id, created: now, ipHash, 'status': 'PENDING', message: body.message, email: body.email || null }).then(() => {
                    resolve();
                }).catch(reject);
            }
        }).catch(reject);
    }).catch(reject);
});

const createBlogPost = (userId, blogPayload) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db(DB_NAME);
        const blogCollection = db.collection('blog');
        blogCollection.insertOne({ id: generateId(), publishedBy: userId, created: Date.now(), title: blogPayload.title || '', content: blogPayload.content }).then(resolve).catch(reject);
    }).catch(reject);
});

const getBlogPost = (id) => new Promise((resolve, reject) => {
    getMongoCollection('blog').then(collection => {
        collection.findOne({ id }).then(post => {
            if (!post) {
                reject('Not found');
            } else {
                resolve(mapBlogPost(post, true));
            }
        });
    }).catch(reject);
});

const listBlogPosts = (limit, offset, sort, query, includeMostRecent) => new Promise((resolve, reject) => {
    getMongoCollection('blog').then(collection => {
        let dbQuery = {};
        if (query) {
            dbQuery = {
              '$and': [
                {
                  '$or': [
                    { title: { '$regex': query, $options: 'i' } },
                    { content: { '$regex': query, $options: 'i' } }
                  ]
                }
              ]
            };
        }
        collection.countDocuments(dbQuery).then((count) => {
            collection.find(dbQuery).limit(Number(limit)).skip(Number(offset)).sort({ created: -1 }).toArray().then(posts => {
                if (!!includeMostRecent) {
                    const mostRecent = posts.length ? mapBlogPost(posts[0], true) : null;
                    resolve({ posts: posts.map(p => mapBlogPost(p, false)), count, mostRecent });
                } else {
                    resolve({ posts: posts.map(p => mapBlogPost(p, false)), count });
                }
            }).catch(reject);
        }).catch(reject);
    }).catch(reject);
});

const uploadMongo = (developerId, assetId, filePath, fileName, fileSize, fileType) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db(DB_NAME);
        const collection = db.collection('assets');
        collection.findOne({ assetId }).then(asset => {
            const documentCollection = db.collection('documents');
            documentCollection.insertOne({ developerId, assetId, data: new Binary(fs.readFileSync(filePath)), fileSize, fileType }).then(() => resolve(assetId)).catch(reject);
        }).catch(reject);
    }).catch(reject);
});

const getProfileInfo = (userId) => new Promise((resolve, reject) => {
    getMongoProfileInfo(userId).then(resolve).catch(reject);
});

const getMongoProfileInfo = (userId) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db(DB_NAME);
        const collection = db.collection('users');
        collection.findOne({ userId }).then((userResponse) => {
            const { userId, created, image, description, btcAddress } = userResponse;

                resolve({
                    username: userId,
                    created,
                    image,
                    description,
                    btcAddress: btcAddress || null,
                });
        });
    }).catch(reject);
});

const getGame = (gameId) => new Promise((resolve, reject) => {
    getMongoCollection('games').then(collection => {
        collection.findOne({ gameId }).then(game => {
            if (!game) {
                reject('Game not found');
            } else {
                resolve({
                    id: game.gameId,
                    description: game.description,
                    name: game.name,
                    created: game.created,
                    developerId: game.developerId,
                    thumbnail: game.thumbnail,
                    forgejoRepo: game.forgejoRepo || null,
                    featured: game.featured || false,
                });
            }
        }).catch(reject);
    }).catch(reject);
});

const updateGame = (gameId, updateParams) => new Promise((resolve, reject) => {
    if (!updateParams.description && !updateParams.published_state) {
        console.log('missing update params');
        console.log(updateParams);
        resolve();
    } else {

        if (updateParams.description) {
            getMongoCollection('games').then((games) => {
                games.updateOne({ gameId }, { "$set": { description: updateParams.description } }).catch(reject).then(() => {
                    // dumb
                    games.findOne({ gameId }).then((game) => {
                        const gameResult = {
                            id: game.gameId,
                            description: game.description,
                            created: game.description,
                            thumbnail: game.thumbnail,
                            developerId: game.developerId,
                            name: game.name
                        };
                        resolve(gameResult);
                    }).catch(reject);
                });
            }).catch(reject);
        }
    }
});

const { inferAssetType } = require('./models');

const assetTypeFilter = (assetType) => {
    if (!assetType || !['image', 'audio', 'font'].includes(assetType)) {
        return null;
    }
    const contentTypePatterns = {
        image: '^image/',
        audio: '^audio/',
        font: 'font',
    };
    return {
        '$or': [
            { assetType },
            { 'metadata.Content-Type': { '$regex': contentTypePatterns[assetType], $options: 'i' } },
        ],
    };
};

const listPublicAssets = (query, limit = 10, offset = 0, assetType = null, includeNsfw = false) => new Promise((resolve, reject) => {
    getMongoCollection('assets').then(collection => {
        const filters = [{ public: true }];
        if (!includeNsfw) {
            filters.push({ nsfw: { $ne: true } });
        }
        const typeFilter = assetTypeFilter(assetType);
        if (typeFilter) {
            filters.push(typeFilter);
        }
        if (query) {
            filters.push({
                '$or': [
                    { name: { '$regex': query, $options: 'i' } },
                    { description: { '$regex': query, $options: 'i' } },
                    { developerId: { '$regex': query, $options: 'i' } },
                    { tags: { '$regex': query, $options: 'i' } },
                ],
            });
        }
        const dbQuery = filters.length === 1 ? filters[0] : { '$and': filters };

        collection.countDocuments(dbQuery).then((total) => {
            const pageCount = Math.max(1, Math.ceil(total / limit));
            collection.find(dbQuery).limit(Number(limit)).skip(Number(offset)).sort({ created: -1 }).toArray().then(assets => {
                resolve({ assets, count: total, pageCount });
            }).catch(reject);
        }).catch(reject);
    }).catch(reject);
});

const listAssets = (developerId, query, limit = 10, offset = 0) => new Promise((resolve, reject) => {
    getMongoCollection('assets').then(collection => {
        let dbQuery = { developerId };
        if (query) {
            dbQuery = {
              '$and': [
                { developerId },
                {
                  '$or': [
                    { name: { '$regex': query, $options: 'i' } },
                    { description: { '$regex': query, $options: 'i' } },
                    { assetId: { '$regex': query, $options: 'i' } },
                    { tags: { '$regex': query, $options: 'i' } },
                  ]
                }
              ]
            };
        }
        collection.countDocuments(dbQuery).then((count) => {
            collection.find(dbQuery).limit(Number(limit)).skip(Number(offset)).sort({ created: -1 }).toArray().then(assets => {
                resolve({ assets, count });
            }).catch(reject);
        }).catch(reject);
    }).catch(reject);
});

const MAX_ASSETS_PER_USER = 100;

const getAssetCount = (developerId) => new Promise((resolve, reject) => {
    getMongoCollection('assets').then(collection => {
        collection.countDocuments({ developerId }).then(resolve).catch(reject);
    }).catch(reject);
});

const createAssetRecord = (developerId, assetId, size, name, metadata, description, isPublic = false, nsfwResult = null) => new Promise((resolve, reject) => {
   createMongoAssetRecord(developerId, assetId, size, name, metadata, description, isPublic, nsfwResult).then(resolve).catch(reject);
});

const normalizeAssetDescription = (description) => {
    if (!description) return '';
    return String(description).trim().substring(0, 80);
};

const createMongoAssetRecord = (developerId, assetId, size, name, metadata, description, isPublic = false, nsfwResult = null) => new Promise((resolve, reject) => {
    getMongoCollection('assets').then(assetCollection => {
        const contentType = metadata && metadata['Content-Type'];
        assetCollection.insertOne({
            created: Date.now(),
            developerId,
            assetId,
            size,
            name,
            metadata,
            description: normalizeAssetDescription(description),
            tags: [],
            public: !!isPublic,
            assetType: inferAssetType(contentType),
            nsfw: nsfwResult ? nsfwResult.nsfw : false,
            nsfwScore: nsfwResult ? nsfwResult.nsfwScore : 0,
        }).then(() => resolve({ assetId })).catch(reject);
    });
});

const updateAsset = (developerId, assetId, updates) => new Promise((resolve, reject) => {
    getMongoCollection('assets').then(collection => {
        collection.findOne({ assetId, developerId }).then(asset => {
            if (!asset) {
                reject('Asset not found');
                return;
            }
            const setFields = {};
            if (typeof updates.public === 'boolean') {
                setFields.public = updates.public;
            }
            if (updates.description !== undefined) {
                setFields.description = normalizeAssetDescription(updates.description);
            }
            if (Object.keys(setFields).length === 0) {
                resolve({ assetId });
                return;
            }
            collection.updateOne({ assetId, developerId }, { '$set': setFields }).then(() => {
                resolve({ assetId, ...setFields });
            }).catch(reject);
        }).catch(reject);
    }).catch(reject);
});

const deleteAsset = (developerId, assetId) => new Promise((resolve, reject) => {
    getMongoCollection('assets').then(collection => {
        collection.findOne({ assetId, developerId }).then(asset => {
            if (!asset) {
                reject('Asset not found');
                return;
            }
            Promise.all([
                collection.deleteOne({ assetId, developerId }),
                getMongoCollection('documents').then(documentCollection => {
                    documentCollection.deleteOne({ assetId });
                }),
                getMongoCollection('games').then(gamesCollection => {
                    gamesCollection.updateMany({ thumbnail: assetId }, { '$unset': { thumbnail: '' } });
                }),
            ]).then(() => resolve({ assetId })).catch(reject);
        }).catch(reject);
    }).catch(reject);
});

const updateAssetTags = (developerId, assetId, tags) => new Promise((resolve, reject) => {
    getMongoCollection('assets').then(collection => {
        collection.findOne({ assetId, developerId }).then(asset => {
            if (!asset) {
                reject('Asset not found');
            } else {
                collection.updateOne({ assetId, developerId }, { '$set': { tags: tags || [] } }).then(() => {
                    resolve({ assetId, tags });
                }).catch(reject);
            }
        }).catch(reject);
    }).catch(reject);
});

const adminListPendingPublishRequests = () => new Promise((resolve, reject) => {
    getMongoCollection('publishRequests').then((collection) => {
        collection.find({ status: 'PENDING_PUBLISH_APPROVAL' }).toArray().then((results) => {
            resolve({ requests: results });
        }).catch(reject);
    }).catch(reject);
});

const adminAcknowledgeMessage = (messageId) => new Promise((resolve, reject) => {
    getMongoCollection('supportMessages').then((collection) => {
        collection.findOne({ id: messageId }).then(supportMessage => {
            if (supportMessage) {
                collection.updateOne({ id: messageId }, { "$set": { 'status': 'ACKNOWLEDGED' } }).then(resolve).catch(reject);
            }
        }).catch(reject);
    }).catch(reject);
});

const adminListSupportMessages = (page, limit) => new Promise((resolve, reject) => {
    const actualLimit = Number(limit) || 10;
    const actualPage = Number(page) || 1;
    const skip = (actualPage - 1) * actualLimit;

    getMongoCollection('supportMessages').then((collection) => {
        collection.find({ status: 'PENDING' }).sort({ created: -1 }).skip(skip).limit(actualLimit).toArray().then((results) => {
            resolve({ requests: results });
        }).catch(reject);
    }).catch(reject);
});

const adminListFailedPublishRequests = () => new Promise((resolve, reject) => {
    getMongoCollection('publishRequests').then((collection) => {
        collection.find({ status: 'FAILED' }).toArray().then((results) => {
            resolve({ requests: results });
        }).catch(reject);
    }).catch(reject);
});

const listPublishRequests = (gameId) => new Promise((resolve, reject) => {
    getMongoCollection('publishRequests').then(collection => {
        collection.find({ gameId }).limit(100).toArray().then((requests) => {
            resolve(requests.map(r => {
                return {
                    id: r.requestId,
                    'status': r['status'],
                    'assetId': r['assetId'],
                    created: r.created,
                    adminMessage: r.adminMessage,
                    gameVersionId: r.versionId
                }
            }));
        }).catch(reject);
    }).catch(reject);
});

const listGamesForAuthor = (params) => new Promise((resolve, reject) => {
    mongoListGamesForAuthor(params).then(resolve).catch(reject);
});

const mongoListGamesForAuthor = ({ author, page, limit }) => new Promise((resolve, reject) => {
    getMongoCollection('games').then(collection => {
        const actualLimit = limit || 10;
        const skip = ( page - 1 ) * actualLimit;
        collection.find({ developerId: author }).limit(actualLimit).skip(skip).toArray().then(results => {
           resolve(results.map(r => {
                return {
                    id: r.gameId,
                    name: r.name,
                    description: r.description,
                    createdBy: r.createdBy,
                    createdAt: r.createdAt
                }
           }));
        }).catch(reject);
    }).catch(reject);
});

const getGameDetails = (gameId) => new Promise((resolve, reject) => {
    getMongoCollection('games').then(collection => {
        collection.findOne({ gameId }).then(gameResult => {
            if (gameResult == null) {
                reject('Game not found');
            } else {
                getMongoCollection('gameVersions').then(versionCollection => {
                    versionCollection.find({ gameId }).limit(10).sort({ publishedAt: -1 }).toArray().then(versions => {
                        resolve({
                            game: {
                                name: gameResult.name,
                                description: gameResult.description,
                                created: gameResult.created,
                                developerId: gameResult.developerId,
                                thumbnail: gameResult.thumbnail,
                                id: gameResult.gameId,
                                featured: gameResult.featured || false,
                            },
                            versions: versions.map(v => {
                                return {
                                    id: v.versionId,
                                    published: v.publishedAt,
                                    assetId: v.sourceAssetId,
                                    approved: v.approved ? true : false,
                                    squishVersion: v.squishVersion
                                }
                            })
                        });
                    }).catch(reject);
                }).catch(reject);
            }
        }).catch(reject);
    }).catch(reject);
});

const getPublishRequest = (requestId) => new Promise((resolve, reject) => {
    getMongoCollection('publishRequests').then((collection) => {
        collection.findOne({ requestId }).then((result) => {
            if (!result) {
                reject('not found');
            } else {
                resolve(result);
            }
        }).catch(reject);
    }).catch(reject);
});

const updatePublishRequestState = (requestId, gameId, sourceInfoHash, newStatus) => new Promise((resolve, reject) => {
    getMongoCollection('publishRequests').then((publishRequests) => {
        publishRequests.updateOne({ requestId }, { "$set": { status: newStatus } }).catch(reject).then(() => {
            resolve();
        }).catch(reject);
    }).catch(reject);
});

const adminPublishRequestAction = (requestId, action, message) => new Promise((resolve, reject) => {
    if (!action || (action !== 'reject' && action !== 'approve')) {
        reject('invalid action');
    }

    if (!message) {
        if (action === 'reject') {
            reject('rejection requires message');
        }

        message = 'No message available';
    }

    const newStatus = action === 'approve' ? 'PUBLISHED' : 'REJECTED';

    getPublishRequest(requestId).then(requestData => {
        const gameId = requestData.gameId;
        getMongoCollection('publishRequests').then((publishRequests) => {
            publishRequests.updateOne({ requestId }, { "$set": { 'status': newStatus, adminMessage: message } }).catch(reject).then(() => {
                getMongoCollection('gameVersions').then(gameVersions => {
                    gameVersions.updateOne({ versionId: requestData.versionId }, { "$set": { approved: newStatus === 'PUBLISHED' } }).then(() => {
                        resolve(gameId);
                    });
                });
            });
        }).catch(reject);
    }).catch(reject);
});

const listMyGames = (developerId, limit = 10, offset = 0, query) => new Promise((resolve, reject) => {
     getMongoCollection('games').then(collection => {
        let dbQuery = { developerId };
        if (query) {
            dbQuery = {
              '$and': [
                { developerId },
                {
                  '$or': [
                    { name: { '$regex': query, $options: 'i' } },
                    { description: { '$regex': query, $options: 'i' } }
                  ]
                }
              ]
            };
        }
        collection.countDocuments(dbQuery).then((count) => {
            collection.find(dbQuery).limit(Number(limit)).skip(Number(offset)).sort({ created: -1 }).toArray().then(games => {
                resolve({ games: games.map(mapMongoGame), count });
            }).catch(reject);
        });
    }).catch(reject);
});

const updateMongoProfileInfo = (userId, { description, image, btcAddress }) => new Promise((resolve, reject) => {
    getMongoCollection('users').then(users => {
        users.findOne({ userId }).then((foundUser) => {
            if (!foundUser) {
                reject('User not found');
            } else {
                const updates = {};
                if (description && foundUser.description != description) {
                    updates.description = description;
                }
                if (image !== undefined && foundUser.image != image) {
                    updates.image = image || null;
                }
                if (btcAddress !== undefined && foundUser.btcAddress != btcAddress) {
                    updates.btcAddress = btcAddress || null;
                }

                if (Object.keys(updates).length > 0) {
                    users.updateOne({ userId }, { "$set": updates }).catch(reject).then(resolve);
                } else {
                    resolve();
                }
            }
        }).catch(reject);
    }).catch(reject);
});

const createPublishRequestRecord = (userId, assetId, gameId) => new Promise((resolve, reject) => {
    getMongoCollection('publishRequests').then(collection => {
        const requestId = generateId();
        const versionId = generateId();
        collection.insertOne({ userId, created: Date.now(), assetId, gameId, versionId, requestId, 'status': 'CREATED' }).then(() => {
            resolve({ requestId });
        });
    });
});

const submitContentRequest = (request, ip, createContentRequestFn) => new Promise((resolve, reject) => {
    const { v4: uuidv4 } = require('uuid');
    const requestId = uuidv4();

    getMongoCollection('contentRequests').then((collection) => {
        const now = Date.now();
        const messageBody = JSON.stringify({ requestId, created: now, type: request.type, model: request.model, prompt: request.prompt });
        collection.insertOne({ requestId, created: now }).then(() => {
            createContentRequestFn(messageBody).then(() => {
                resolve(requestId);
            }).catch(reject);
        });
    }).catch(reject);
});

const getCertRecord = (publicIp) => new Promise((resolve, reject) => {
    getMongoCollection('certs').then((collection) => {
        collection.findOne({ ip: publicIp }).then((result) => {
            resolve(result);
        });
    });
});

const getCertStatus = (publicIp) => new Promise((resolve, reject) => {
    const body = {
        certFound: false,
        certExpiration: null,
        certIp: publicIp
    };

    getCertRecord(publicIp).then((certRecord) => {
        if (certRecord) {
            body.certFound = true;
            body.certExpiration = certRecord.expiresAt;
            body.cert = certRecord.cert;
            resolve(body);
        } else {
            resolve(body);
        }
    });
});

const deleteGame = (gameId, searchDeleteFn) => new Promise((resolve, reject) => {
    const afterSearchDelete = () => {
        const deleteManyByGameId = (collectionName) => new Promise((res, rej) => {
            getMongoCollection(collectionName).then(collection => {
                collection.deleteMany({ gameId }).then(() => res()).catch(rej);
            }).catch(rej);
        });

        Promise.all([
            deleteManyByGameId('builds'),
            deleteManyByGameId('gameVersions'),
            deleteManyByGameId('publishRequests'),
        ]).then(() => {
            getMongoCollection('games').then(gameCollection => {
                gameCollection.deleteOne({ gameId }).then(() => resolve()).catch(reject);
            }).catch(reject);
        }).catch(reject);
    };

    if (searchDeleteFn) {
        searchDeleteFn(gameId).then(afterSearchDelete).catch(afterSearchDelete);
    } else {
        afterSearchDelete();
    }
});

const deleteDeveloper = (userId) => new Promise((resolve, reject) => {
    const deleteByUser = (collectionName, field) => new Promise((res, rej) => {
        getMongoCollection(collectionName).then(collection => {
            collection.deleteMany({ [field]: userId }).then(() => res()).catch(rej);
        }).catch(rej);
    });

    // Find all games by this developer so we can clean up related collections
    getMongoCollection('games').then(gamesCollection => {
        gamesCollection.find({ developerId: userId }).toArray().then(games => {
            const gameIds = games.map(g => g.gameId);

            const gameCleanups = gameIds.length > 0 ? [
                getMongoCollection('gameVersions').then(c => c.deleteMany({ gameId: { $in: gameIds } })),
                getMongoCollection('publishRequests').then(c => c.deleteMany({ gameId: { $in: gameIds } })),
                getMongoCollection('builds').then(c => c.deleteMany({ gameId: { $in: gameIds } })),
            ] : [];

            Promise.all([
                ...gameCleanups,
                deleteByUser('games', 'developerId'),
                deleteByUser('assets', 'developerId'),
                deleteByUser('documents', 'developerId'),
                deleteByUser('users', 'userId'),
            ]).then(() => {
                resolve({ userId, gamesDeleted: gameIds.length });
            }).catch(reject);
        }).catch(reject);
    }).catch(reject);
});

// ---------------------------------------------------------------------------
// Admin / moderation queries
// ---------------------------------------------------------------------------

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const adminPaginatedList = (collectionName, query, projection, limit, offset, sort) => new Promise((resolve, reject) => {
    getMongoCollection(collectionName).then(collection => {
        collection.countDocuments(query).then(count => {
            collection.find(query, projection ? { projection } : undefined)
                .sort(sort || { created: -1 })
                .skip(Number(offset) || 0)
                .limit(Number(limit) || 25)
                .toArray()
                .then(items => resolve({ items, count }))
                .catch(reject);
        }).catch(reject);
    }).catch(reject);
});

const adminListUsers = (search, limit, offset, sort) => {
    let query = {};
    if (search) {
        const rx = { $regex: escapeRegex(search), $options: 'i' };
        query = { $or: [{ displayName: rx }, { email: rx }, { userId: search }] };
    }
    // Never expose password/verification secrets to the admin UI.
    return adminPaginatedList('users', query, { passwordHash: 0, passwordSalt: 0, verificationCodeHash: 0 }, limit, offset, sort);
};

const adminListGames = (search, limit, offset, sort) => {
    let query = {};
    if (search) {
        const rx = { $regex: escapeRegex(search), $options: 'i' };
        query = { $or: [{ name: rx }, { gameId: search }, { developerId: search }] };
    }
    return adminPaginatedList('games', query, null, limit, offset, sort);
};

const adminListAllAssets = (search, limit, offset, sort) => {
    let query = {};
    if (search) {
        const rx = { $regex: escapeRegex(search), $options: 'i' };
        query = { $or: [{ name: rx }, { assetId: search }, { developerId: search }] };
    }
    return adminPaginatedList('assets', query, null, limit, offset, sort);
};

const adminGetStats = () => Promise.all([
    getMongoCollection('users').then(c => c.countDocuments({})),
    getMongoCollection('users').then(c => c.countDocuments({ verified: true })),
    getMongoCollection('games').then(c => c.countDocuments({})),
    getMongoCollection('assets').then(c => c.countDocuments({})),
    getMongoCollection('gameVersions').then(c => c.countDocuments({ published: true })),
    getMongoCollection('publishRequests').then(c => c.countDocuments({ status: { $in: ['PENDING', 'PROCESSING'] } })),
]).then(([users, verifiedUsers, games, assets, publishedVersions, pendingPublish]) => ({
    users, verifiedUsers, games, assets, publishedVersions, pendingPublish,
}));

const setAssetNsfw = (assetId, nsfw) => new Promise((resolve, reject) => {
    getMongoCollection('assets').then(c => c.updateOne({ assetId }, { $set: { nsfw: !!nsfw } }).then(resolve).catch(reject)).catch(reject);
});

module.exports = {
    getMongoClient,
    getMongoCollection,
    adminListUsers,
    adminListGames,
    adminListAllAssets,
    adminGetStats,
    setAssetNsfw,
    getMongoAsset,
    getMongoDocument,
    getUserRecord,
    getUserByDisplayName,
    getUserByEmail,
    createUser,
    setUserVerified,
    setVerificationCode,
    setPasswordResetCode,
    resetUserPassword,
    createSupportMessage,
    createBlogPost,
    getBlogPost,
    listBlogPosts,
    uploadMongo,
    getProfileInfo,
    getMongoProfileInfo,
    getGame,
    updateGame,
    listAssets,
    listPublicAssets,
    getAssetCount,
    MAX_ASSETS_PER_USER,
    createAssetRecord,
    createMongoAssetRecord,
    updateAsset,
    deleteAsset,
    updateAssetTags,
    adminListPendingPublishRequests,
    adminAcknowledgeMessage,
    adminListSupportMessages,
    adminListFailedPublishRequests,
    listPublishRequests,
    listGamesForAuthor,
    mongoListGamesForAuthor,
    getGameDetails,
    getPublishRequest,
    updatePublishRequestState,
    adminPublishRequestAction,
    listMyGames,
    updateMongoProfileInfo,
    createPublishRequestRecord,
    submitContentRequest,
    getCertRecord,
    getCertStatus,
    deleteGame,
    deleteDeveloper,
};
