const fs = require('fs');
const { Binary, MongoClient } = require('mongodb');
const { DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME } = require('./config');
const { generateId, hashValue } = require('./crypto');
const { mapBlogPost, mapMongoGame } = require('./models');

const getMongoClient = () => {
    console.log('dbdbdbd');
    console.log(DB_USERNAME);
    console.log(DB_PASSWORD);
    console.log(DB_HOST);
    const uri = DB_USERNAME ? `mongodb://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}` : `mongodb://${DB_HOST}:${DB_PORT}/${DB_NAME}`;
    const params = {};
    if (DB_USERNAME) {
        params.auth = {
            username: DB_USERNAME,
            password: DB_PASSWORD
        };
        params.authSource = 'admin';
    }

    return new MongoClient(uri, params);
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
        console.log('for ' + userId);
        collection.findOne({ userId }).then((userResponse) => {
            console.log('found user');
            console.log(userResponse);
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
                        console.log(game);
                        console.log("fdsfds");
                        resolve(gameResult);
                    }).catch(reject);
                });
            }).catch(reject);
        }
    }
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

const createAssetRecord = (developerId, assetId, size, name, metadata, description) => new Promise((resolve, reject) => {
   createMongoAssetRecord(developerId, assetId, size, name, metadata, description).then(resolve).catch(reject);
});

const createMongoAssetRecord = (developerId, assetId, size, name, metadata, description) => new Promise((resolve, reject) => {
    getMongoCollection('assets').then(assetCollection => {
        assetCollection.insertOne({ created: Date.now(), developerId, assetId, size, name, metadata, description, tags: [] }).then(() => resolve({assetId})).catch(reject);
    });
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
            console.log('found message');
            console.log(supportMessage);
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
    console.log("gonna list games");
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
                        console.log("VIERIEIREIRIER");
                        console.log(versions);
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
    console.log('looking for ' + requestId);
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
        console.log("this is publish request");
        console.log(requestData);
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
            console.log('reuslt!');
            console.log(result);
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
        getMongoCollection('games').then(gameCollection => {
            gameCollection.deleteOne({ gameId }).then(() => {
                console.log('deleted game from db');
                getMongoCollection('gameVersions').then(gameVersions => {
                    gameVersions.deleteMany({ gameId }).then(() => {
                        console.log('deleted game versions');
                        getMongoCollection('publishRequests').then(publishRequests => {
                            publishRequests.deleteMany({ gameId }).then(() => {
                                console.log('deleted publish requests');
                                resolve();
                            }).catch(resolve);
                        }).catch(resolve);
                    }).catch(resolve);
                }).catch(resolve);
            }).catch(reject);
        }).catch(reject);
    };

    if (searchDeleteFn) {
        searchDeleteFn(gameId).then(afterSearchDelete).catch(afterSearchDelete);
    } else {
        afterSearchDelete();
    }
});

module.exports = {
    getMongoClient,
    getMongoCollection,
    getMongoAsset,
    getMongoDocument,
    getUserRecord,
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
    createAssetRecord,
    createMongoAssetRecord,
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
};
