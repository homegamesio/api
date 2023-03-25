const http = require('http');
const https = require('https');
const unzipper = require('unzipper');
const url = require('url');
const archiver = require('archiver');
const fs = require('fs');
const aws = require('aws-sdk');
const querystring = require('querystring');
const {
    v4: uuidv4
} = require('uuid');
const crypto = require('crypto');
const util = require('util');
const {
    parse
} = require('querystring');
const multiparty = require('multiparty');
const {
    fork
} = require('child_process');
const path = require('path');
const {
    verifyAccessToken
} = require('homegames-common');

const SourceType = {
    GITHUB: 'GITHUB'
};

const process = require('process');

const poolData = {
    UserPoolId: process.env.COGNITO_USER_POOL_ID
};

const getCognitoUser = (username) => new Promise((resolve, reject) => {
    const params = {
        UserPoolId: poolData.UserPoolId,
        Username: username
    };

    const provider = new aws.CognitoIdentityServiceProvider({region: 'us-west-2'});

    provider.adminGetUser(params, (err, data) => {
        if (err) {
            console.error(err);
            reject('failed to get user');
        } else {
            const isAdminAttribute = data.UserAttributes && data.UserAttributes.filter(a => a.Name === 'custom:isAdmin').length > 0 ? data.UserAttributes.filter(a => a.Name === 'custom:isAdmin')[0] : null;
            resolve({
                created: data.UserCreateDate,
                isAdmin: isAdminAttribute && isAdminAttribute.Value === 'true' ? true : false
            });
        }
    });
});

const uploadThumbnail = (username, gameId, thumbnail) => new Promise((resolve, reject) => {
    const assetId = generateId();

    const childSession = fork(path.join(__dirname, 'upload.js'),
        [
            `--path=${thumbnail.path}`,
            `--developer=${username}`,
            `--id=${assetId}`,
            `--name=${thumbnail.originalFilename}`,
            `--size=${thumbnail.size}`,
            `--type=${thumbnail.headers['content-type']}`
        ]
    );

    resolve('https://assets.homegames.io/' + assetId);
});

const getLatestGameVersion = (gameId) => new Promise((resolve, reject) => {
    const readClient = new aws.DynamoDB.DocumentClient({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'game_versions',
        ScanIndexForward: false,
        Limit: 1,
        KeyConditionExpression: '#game_id = :game_id',
        ExpressionAttributeNames: {
            '#game_id': 'game_id',
        },
        ExpressionAttributeValues: {
            ':game_id': gameId
        }
    };

    readClient.query(params, (err, results) => {
        if (err) {
            console.log(err);
            reject(err.toString());
        } else {
            if (results.Items.length) {
                resolve(Number(results.Items[0].version));
            } else {
                resolve(null);

            }
        }
    });
 
});


// unlisted
const publishGameVersion = (publishRequest) => new Promise((resolve, reject) => {
    const gameId = publishRequest.game_id;
    const requestId = publishRequest.request_id;

    const s3Url = getS3Url(gameId, requestId);

    // verify code is publicly available
    https.get(s3Url, (res) => {
        if (res.statusCode != 200) {
            console.log('bad status code');
            reject();
        } else {
            getLatestGameVersion(gameId).then(currentVersion => {
                const client = new aws.DynamoDB({
                    region: 'us-west-2'
                });

                const newVersion = currentVersion ? currentVersion + 1 : 1;
                getGame(gameId).then(gameData => {
    
                    const params = {
                        TableName: 'game_versions',
                        Item: {
                            'version': {
                                N: '' + newVersion
                            },
                            'commit_hash': {
                                S: publishRequest.commit_hash
                            },
                            'description': {
                                S: publishRequest.notes || 'No description available'
                            },
                            'location': {
                                S: s3Url
                            },
                            'published_at': {
                                N: '' + Date.now()
                            },
                            'published_by': {
                                S: publishRequest.requester
                            },
                            'request_id': {
                                S: requestId
                            },
                            'game_id': {
                                S: gameId
                            },
                            'version_id': {
                                S: generateId()
                            }
                        }
                    };
        
                    client.putItem(params, (err, putResult) => {
                        if (!err) {
                            console.log('published new game version of game id ' + gameId);
                            resolve();
                        } else {
                            console.log('failed to publish version');
                            console.log(err);
                            reject(err);
                        }
                    });
                });
            });
        }
    });
});

const requestIdFromCode = (code) => new Promise((resolve, reject) => {
    const ddb = new aws.DynamoDB({
        region: 'us-west-2'
    });

    const codeParams = {
        TableName: 'verification_requests',
        IndexName: 'code-index',
        Key: {
            'code': {
                S: code
            }
        }
    };

    ddb.getItem(codeParams, (err, data) => {
        if (err) {
            console.log(err);
            reject();
        } else {
            const requestId = data.Item.publish_request_id.S;
            resolve(request);
        }
    });

});

const getPublishRequestFromCode = (code) => new Promise((resolve, reject) => {
    requestIdFromCode(code).then(requestId => {
        const ddb = new aws.DynamoDB({
            region: 'us-west-2'
        });

        const params = {
            TableName: 'publish_requests',
            IndexName: 'request_id-index',
            Key: {
                'request_id': {
                    S: requestId
                }
            }
        };

        ddb.getItem(params, (err, data) => {
            if (err) {
                console.log(err);
                reject();
            } else {
                resolve();
            }
        });
    });
});

const verifyCode = (code, requestId) => new Promise((resolve, reject) => {
    console.log(`verifying code ${code} with request ${requestId}`);
    const ddb = new aws.DynamoDB({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'verification_requests',
        Key: {
            'publish_request_id': {
                S: requestId
            }
        }
    };

    ddb.getItem(params, (err, data) => {
        if (err) {
            console.log(err);
            reject();
        } else {
            const _requestCode = data.Item.code.S;
            if (code == _requestCode) {
                resolve();
            } else {
                console.log('requested code doesnt match code in record');
                reject();
            }
        }
    });
});

const getPublishRequest = (requestId) => new Promise((resolve, reject) => {
    const readClient = new aws.DynamoDB.DocumentClient({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'publish_requests',
        IndexName: 'request_id-index',
        KeyConditionExpression: '#requestId = :requestId',
        ExpressionAttributeNames: {
            '#requestId': 'request_id'
        },
        ExpressionAttributeValues: {
            ':requestId': requestId
        }
    };

    readClient.query(params, (err, result) => {
        if (err) {
            reject();
        } else {
            if (result.Items.length != 1) {
                console.log('wrong length');
                console.log(result.Items);
                reject();
            } else {
                resolve(result.Items[0]);
            }
        }
    });
 
});


// copied from homedome
const getS3Url = (gameId, requestId) => {
    return `https://hg-games.s3-us-west-2.amazonaws.com/${gameId}/${requestId}/code.zip`;
};

const updatePublishRequestState = (gameId, sourceInfoHash, newStatus) => new Promise((resolve, reject) => {
    const ddb = new aws.DynamoDB({
        region: 'us-west-2'
    });

    const updateParams = {
        TableName: 'publish_requests',
        Key: {
            'game_id': {
                S: gameId
            },
            'source_info_hash': {
                S: sourceInfoHash
            }
        },
        AttributeUpdates: {
            'status': {
                Action: 'PUT',
                Value: {
                    S: newStatus
                }
            }
        }
    };

    ddb.updateItem(updateParams, (err, putResult) => {
        console.log(err);
        if (err) {
            reject();
        } else {
            resolve();
        }
    });
});

const emitEvent = (requestId, eventType, message = null) => new Promise((resolve, reject) => {

    const client = new aws.DynamoDB({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'publish_events',
        Item: {
            'request_id': {
                S: requestId
            },
            'event_date': {
                N: `${Date.now()}`
            },
            'event_type': {
                S: eventType
            }
        }
    };

    if (message != null) {
        params.Item.message = {S: message};
    }

    client.putItem(params, (err, putResult) => {
        if (!err) {
            resolve();
        } else {
            reject(err);
        }
    });
});

const verifyPublishRequest = (code, requestId) => new Promise((resolve, reject) => {
    emitEvent(requestId, 'VERIFICATION_ATTEMPT', 'Attempting to verify publish request from email code').then(() => {
        verifyCode(code, requestId).then(() => {
            getPublishRequest(requestId).then(requestData => {
                const { game_id, source_info_hash } = requestData;
                if (requestData.status == 'CONFIRMED') {
                    reject('already confirmed');
                } else {
                    resolve(requestData); 
                }
            });
        }).catch(err => {
            console.log('verify error ' + err);
            emitEvent(requestId, 'VERIFICATION_ERROR', 'Failed verifying code').then(() => {
                reject();
            });
        });
    });
});

// 50 MB max
const MAX_SIZE = 50 * 1024 * 1024;

const getHash = (input) => {
    return crypto.createHash('md5').update(input).digest('hex');
};

const generateId = () => getHash(uuidv4());

const getReqBody = (req, cb) => {
    let _body = '';
    req.on('data', chunk => {
        _body += chunk.toString();
    });

    req.on('end', () => {
        cb && cb(_body);
    });
};

const getGame = (gameId) => new Promise((resolve, reject) => {

    const client = new aws.DynamoDB({
        region: 'us-west-2'
    });

    const params = {
        TableName: process.env.GAME_TABLE,
        Key: {
            'game_id': {
                S: gameId 
            }
        }
    };

    client.getItem(params, (err, result) => {
        if (err) {
            reject(err.toString());
        } else {
            if (result.Item) {
                resolve(mapGame(result.Item));
            } else {
                reject('No results');
            }
        }
    });
});

const updateGame = (gameId, updateParams) => new Promise((resolve, reject) => {
    if (!updateParams.description && !updateParams.published_state) {
        console.log('missing update params');
        console.log(updateParams);
        resolve();
    } else {


        const ddb = new aws.DynamoDB({
            region: 'us-west-2'
        });

        const nowString = '' + Date.now();

        const attributeUpdates = {
            'updated': {
                Action: 'PUT',
                Value: {
                    S: nowString    
                }
            }
        };

        if (updateParams.description) {
            attributeUpdates.description = {
                Action: 'PUT',
                Value: {
                    S: updateParams.description
                }
            };
        }

        if (updateParams.published_state) {
            attributeUpdates.published_state = {
                Action: 'PUT',
                Value: {
                    S: updateParams.published_state
                }
            };
        }
        const updateRequestParams = {
            TableName: process.env.GAME_TABLE,
            Key: {
                'game_id': {
                    S: gameId
                }
            },
            AttributeUpdates: attributeUpdates
        };

        ddb.updateItem(updateRequestParams, (err, putResult) => {
            if (err) {
                console.log(err);
                reject();
            } else {
                resolve();
            }
        });
    }
});

const listAssets = (developerId) => new Promise((resolve, reject) => {
    const client = new aws.DynamoDB({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'homegames_assets',
        ScanIndexForward: false,
        KeyConditionExpression: '#developer_id = :developer_id',
        ExpressionAttributeNames: {
            '#developer_id': 'developer_id'
        },
        ExpressionAttributeValues: {
            ':developer_id': {
                S: developerId
            }
        }
    };

    client.query(params, (err, results) => {
        if (!err) {
            const res = results.Items.map(i => {
                return {
                    'developerId': i.developer_id.S,
                    'size': Number(i.size.N),
                    'assetId': i.asset_id.S,
                    'created': Number(i.created_at.N),
                    'status': i['status'].S,
                    'type': JSON.parse(i['metadata'].S)['Content-Type'],
                    'name': i.name && i.name.S || 'No name available'
                };
            });
            resolve(res);
        } else {
            console.log(err);
            reject();
        }
    });

});

const createRecord = (developerId, assetId, size, name, metadata) => new Promise((resolve, reject) => {
    const client = new aws.DynamoDB({
        region: 'us-west-2'
    });
    const params = {
        TableName: 'homegames_assets',
        Item: {
            'developer_id': {
                S: developerId
            },
            'asset_id': {
                S: assetId
            },
            'created_at': {
                N: '' + Date.now()
            },
            'metadata': {
                S: JSON.stringify(metadata)
            },
            'status': {
                S: 'created'
            },
            'size': {
                N: '' + size
            },
            'name': {
                S: name
            }
        }
    };

    client.putItem(params, (err, putResult) => {
        if (!err) {
            resolve();
        } else {
            reject(err);
        }
    });

});

const DEFAULT_GAME_ORDER = {
    'game_name': {
        order: 'asc'
    }
};

const getPublishRequestEvents = (requestId) => new Promise((resolve, reject) => {
    const client = new aws.DynamoDB.DocumentClient({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'publish_events',
        KeyConditionExpression: '#request_id= :request_id',
        ExpressionAttributeNames: {
            '#request_id': 'request_id'
        },
        ExpressionAttributeValues: {
            ':request_id': requestId 
        }
    };

    client.query(params, (err, data) => {
        if (err) {
            console.log(err);
        }
        resolve({events: data.Items});
    });

});

const adminListPublishRequests = () => new Promise((resolve, reject) => {
    const client = new aws.DynamoDB.DocumentClient({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'publish_requests',
        IndexName: 'status-index',
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: {
            '#status': 'status'
        },
        ExpressionAttributeValues: {
            ':status': 'PENDING_PUBLISH_APPROVAL' 
        }
    };

    client.query(params, (err, data) => {
        if (err) {
            console.log(err);
        }
        resolve({requests: data.Items});
    });

});

const listPublishRequests = (gameId) => new Promise((resolve, reject) => {
    const client = new aws.DynamoDB.DocumentClient({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'publish_requests',
        KeyConditionExpression: '#game_id = :game_id',
        ExpressionAttributeNames: {
            '#game_id': 'game_id'
        },
        ExpressionAttributeValues: {
            ':game_id': gameId
        }
    };

    client.query(params, (err, data) => {
        if (err) {
            console.log(err);
        }
        resolve({requests: data.Items});
    });

});

const listGamesForAuthor = ({ author, page, limit }) => new Promise((resolve, reject) => {

    const client = new aws.DynamoDB.DocumentClient({
        region: process.env.DYNAMO_REGION
    });

    const params = {
        TableName: process.env.GAME_TABLE,
        IndexName: 'created_by_index',
        KeyConditionExpression: '#created_by = :created_by',
        ExpressionAttributeNames: {
            '#created_by': 'created_by'
        },
        ExpressionAttributeValues: {
            ':created_by': author
        }
    };

    client.query(params, (err, data) => {
        if (err) {
            reject([{error: err}]);
        } else {
            resolve(data.Items.map(mapGame));
        }
    });

});

const getGameDetails = (gameId) => new Promise((resolve, reject) => { 

    getGame(gameId).then(gameDetails => {
        const client = new aws.DynamoDB.DocumentClient({
            region: process.env.DYNAMO_REGION
        });

        const params = {
            TableName: 'game_versions',
            // IndexName: 'name_index',
            KeyConditionExpression: '#game_id = :game_id',
            ExpressionAttributeNames: {
                '#game_id': 'game_id'
            },
            ExpressionAttributeValues: {
                ':game_id': gameId
            }
        };

        client.query(params, (err, data) => {
            if (err) {
                console.log(err);
                reject(err);
            } else {
                resolve({
            ...gameDetails,
                    versions: data.Items.map(mapGameVersion)
                });
            }
        });
    });
});

const mapGameVersion = (gameVersion) => {
    return {
        version: gameVersion.version,
        publishedBy: gameVersion.published_by,
        'location': gameVersion['location'],
        description: gameVersion.description,
        versionId: gameVersion.version_id,
        publishedAt: gameVersion.published_at,
        commitHash: gameVersion.commit_hash,
        gameId: gameVersion.game_id
    };
};

const queryGames = (query) => new Promise((resolve, reject) => {
    const client = new aws.DynamoDB.DocumentClient({
        region: process.env.DYNAMO_REGION
    });

    const params = {
        TableName: process.env.GAME_TABLE,
        IndexName: 'name_index',
        KeyConditionExpression: '#published_state = :approved and begins_with(#name, :name)',
        ExpressionAttributeNames: {
            '#published_state': 'published_state',
            '#name': 'name'
        },
        ExpressionAttributeValues: {
            ':name': query,
            ':approved': 'APPROVED'
        }
    };

    client.query(params, (err, data) => {
        if (err) {
            console.log(err);
            reject(err);
        } else {
            resolve(data.Items.map(mapGame));
        }
    });
});

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

let gamesCache = {};

const listGames = (limit = 10, offset = 0, sort = DEFAULT_GAME_ORDER, query = null, tags = []) => new Promise((resolve, reject) => {
    if (gamesCache.timestamp && gamesCache.timestamp > Date.now() - (1 * 1000 * 60)) { //1 min
        resolve(gamesCache.pages);
    } else {
        console.log('fetching from dynamo');
        const client = new aws.DynamoDB.DocumentClient({
            region: process.env.DYNAMO_REGION
        });

        const queryParams = {
            TableName: process.env.GAME_TABLE,
            Limit: 6,
            IndexName: 'name_index',
            KeyConditionExpression: '#published_state = :approved',
            ExpressionAttributeNames: {
                '#published_state': 'published_state',
            },
            ExpressionAttributeValues: {
                ':approved': 'APPROVED'
            }
        };

        // get data from dynamo in pages of 1MB by default or Limit if present
        // dumb and expensive because we can support more than Limit, but 1MB is a lot and is weird to get in one big blob, so paginate mostly for user experience
        // should use ES cache if we get a lot of traffic
        const pages = {};
        let pageCount = 1;

        const makeQueries = (lastResult) => new Promise((resolve, reject) => {

            client.query(queryParams, (err, data) => {

                if (err) {
                    console.log(err);
                    reject();
                } else {
                    if (data.Items.length) {
                        pages[pageCount++] = data.Items.map(mapGame);
                    }
                    if (data.LastEvaluatedKey) {
                        queryParams.ExclusiveStartKey = data.LastEvaluatedKey;
                        makeQueries(queryParams).then(resolve);
                    } else {
                        gamesCache = {pages, timestamp: Date.now()};
                        resolve(pages);
                    }
                }
                     
            });
    
        });

        makeQueries().then(resolve);
    }
});

const adminPublishRequestAction = (requestId, action, message) => new Promise((resolve, reject) => {
    const ddb = new aws.DynamoDB({
        region: 'us-west-2'
    });

    if (!action || action !== 'reject' && action !== 'approve') {
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
        const sourceInfoHash = requestData.source_info_hash;
        const gameId = requestData.game_id;

        const updateParams = {
            TableName: 'publish_requests',
            Key: {
                'game_id': {
                    S: gameId
                },
                'source_info_hash': {
                    S: sourceInfoHash
                }
            },
            AttributeUpdates: {
                'status': {
                    Action: 'PUT',
                    Value: {
                        S: newStatus
                    }
                },
                'adminMessage': {
                    Action: 'PUT',
                    Value: {
                        S: message
                    }
                }
            }
        };

        ddb.updateItem(updateParams, (err, putResult) => {
            if (err) {
                console.log(err);
                reject();
            } else {
                resolve(gameId);
            }
        });
    });

});

let s3Cache;

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
            transformed[baseKey].audio = `https://podcast.homegames.io/${e.Key}`
        } else if (e.Key.endsWith('.mp4')) {
            transformed[baseKey].video = `https://podcast.homegames.io/${e.Key}`
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

const fillS3Cache = () => new Promise((resolve, reject) => {
    const s3 = new aws.S3();

    const getNext = (continuationToken) => new Promise((resolve, reject) => {
        const s3Params = {
            Bucket: 'podcast.homegames.io'
        };

        if (continuationToken) {
            s3Params['ContinuationToken'] = continuationToken;
        }

        s3.listObjects(s3Params, (err, data) => {
            resolve(data);
        });
    });

    let allData = [];
    const waitUntilDone = (continuationToken) => new Promise((resolve, reject) => {
        getNext(continuationToken).then((data) => {
            allData = allData.concat(data.Contents);
            if (data.continuationToken) {
                waitUntilDone(data.continuationToken).then(resolve);
            } else {
                resolve();
            }
        }).catch(err => {
            console.error(err);
            reject(err);
        });
    });

    waitUntilDone().then(() => {
        const transformedData = transformS3Response(allData);
        s3Cache = {
            timestamp: Date.now(),
            data: transformedData
        };

        resolve(s3Cache);
    }).catch(err => {
        reject(err);
    });
        
});

const getPodcastData = (offset = 0, limit = 20, sort = 'desc') => new Promise((resolve, reject) => {
    if (s3Cache && (s3Cache.timestamp > Date.now() - (1000 * 60 * 5))) {
        const startIndex = offset > 0 ? Math.min(s3Cache.data.length, Number(offset)) : 0;
        const endIndex = Math.min(startIndex + limit, s3Cache.data.length);
        const retList = [...s3Cache.data];
        if (sort === 'desc') {
            retList.reverse();
        }
        resolve(retList.slice(startIndex, endIndex));
    } else {
        fillS3Cache().then(() => {
            const startIndex = offset > 0 ? Math.min(s3Cache.data.length, Number(offset)) : 0;
            const endIndex = Math.min(startIndex + limit, s3Cache.data.length);

            const retList = [...s3Cache.data];
            if (sort === 'desc') {
                retList.reverse();
            }
            resolve(retList.slice(startIndex, endIndex));
        });
    }
});

const publishRequestsRegex = '/games/(\\S*)/publish_requests';
const publishRequestEventsRegex = '/publish_requests/(\\S*)/events';
const gameDetailRegex = '/games/(\\S*)';
const gameVersionDetailRegex = '/games/(\\S*)/version/(\\S*)';
const healthRegex = '/health';
const adminListPublishRequestsRegex = '/admin/publish_requests';
const assetsListRegex = '/assets';
const verifyPublishRequestRegex = '/verify_publish_request';
const listGamesRegex = '/games';
const podcastRegex = '/podcast';

// terrible names
const submitPublishRequestRegex = '/public_publish';
const gamePublishRegex = '/games/(\\S*)/publish';
const gameUpdateRegex = '/games/(\\S*)/update';
const requestActionRegex = '/admin/request/(\\S*)/action';
const createAssetRegex = '/asset';
const createGameRegex = '/games';

const contactRegex = '/contact';

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    const requestHandlers = {
        'POST': {
            [contactRegex]: {
                handle: () => {
                    getReqBody(req, (_body) => {
                        console.log('got this message');
                        console.log(_body);
                        const body = JSON.parse(_body);

                        const bodyText = body.message || 'Empty message';

                        const bodyEmail = body.email || 'No email provided';

                        const emailParams = {
                            Destination: {
                                ToAddresses: [
                                    'support@homegames.io'
                                ]
                            },
                            Message: {
                                Body: {
                                    Text: {
                                        Charset: 'UTF-8',
                                        Data: `Email: ${bodyEmail}\n\nMessage:${bodyText}`
                                    }
                                },
                                Subject: {
                                    Charset: 'UTF-8',
                                    Data: 'New Homegames Support Form Message'
                                }
                            },
                            Source: "support-form@homegames.io"
                        };

                        const ses = new aws.SES({region: 'us-west-2'});

                        ses.sendEmail(emailParams, (err, data) => {
                            res.end(JSON.stringify({
                                success: !(!!err)
                            }));
                        });
                    });
                }
            },
            [createGameRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    const form = new multiparty.Form();
                    form.parse(req, (err, fields, files) => {
                        if (err) {
                            console.error('error parsing form');
                            console.error(err);
                            res.end('error');
                        } else {
                            if (!files.thumbnail || !files.thumbnail.length || !fields.name || !fields.name.length || !fields.description || !fields.description.length) {
                                res.end('creation requires name, thumbnail & description');
                            } else {
                                const gameId = generateId();
                                uploadThumbnail(userId, gameId, files.thumbnail[0]).then((url) => {
                                    const nowString = '' + Date.now();
                                    const params = {
                                        RequestItems: {
                                            [process.env.GAME_TABLE]: [{
                                                PutRequest: {
                                                    Item: {
                                                        'game_id': {
                                                            S: gameId
                                                        },
                                                        'created_by': {
                                                            S: userId 
                                                        },
                                                        'name': {
                                                            S: fields.name[0]
                                                        },
                                                        'created_on': {
                                                            N: nowString
                                                        },
                                                        'updated': {
                                                            N: nowString
                                                        },
                                                        'description': {
                                                            S: fields.description[0] 
                                                        },
                                                        'thumbnail': {
                                S: url.replace('https://assets.homegames.io/', '') 
                                                        }
                                                    }
                                                }
                                            }]
                                        }
                                    };
        
                                    const client = new aws.DynamoDB({
                                        region: 'us-west-2'
                                    });
                                    client.batchWriteItem(params, (err, putResult) => {
                                        if (!err) {
                                            res.writeHead(200, {
                                                'Content-Type': 'application/json'
                                            });
                                            res.end(JSON.stringify(mapGame(params.RequestItems[process.env.GAME_TABLE][0].PutRequest.Item)));
                                        } else {
                                            console.log(err);
                                            res.end('error');
                                        }
                                    });
    
                                });
                            }
                        }
                    });
                }
            },
            [createAssetRegex]: {
                requiresAuth: true,
                handle: (userId) => {
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
    
                                    createRecord(userId, assetId, f.size, f.originalFilename, {
                                        'Content-Type': f.headers['content-type']
                                    }).then(() => {
    
                                        const childSession = fork(path.join(__dirname, 'upload.js'),
                                            [
                                                `--path=${f.path}`,
                                                `--developer=${userId}`,
                                                `--id=${assetId}`,
                                                `--name=${f.originalFilename}`,
                                                `size=${f.size}`,
                                                `type=${f.headers['content-type']}`
                                            ]
                                        );
                                        res.writeHead(200, {
                                            'Content-Type': 'application/json'
                                        });
                                        res.end(JSON.stringify({
                                            assetId
                                        }));
    
                                    });
                                }
                            });
                        }
                    });
                }

            },
            [gamePublishRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    const form = new multiparty.Form();
    
                    getReqBody(req, (_data) => {
                        const data = JSON.parse(_data);
                        const _gamePublishRegex = new RegExp('/games/(\\S*)/publish');
                        const gameId = _gamePublishRegex.exec(req.url)[1];
    
                        const publishData = {
                            commit: data.commit,
                            requester: userId,
                            owner: data.owner,
                            repo: data.repo,
                            gameId
                        };
    
                        const buildSourceInfoHash = ({sourceType, commit, owner, repo}) => {
                            const stringConcat = `${sourceType}${commit}${owner}${repo}`;
                            return crypto.createHash('md5').update(stringConcat).digest('hex');
                        };
    
                        const verifyNoExistingPublishRequest = ({commit, owner, repo, gameId, requester}) => new Promise((resolve, reject) => {
    
                            const sourceInfoHash = buildSourceInfoHash({sourceType: SourceType.GITHUB, commit, owner, repo});
    
                            const readClient = new aws.DynamoDB.DocumentClient({
                                region: 'us-west-2'
                            });
    
                            const readParams = {
                                TableName: 'publish_requests',
                                Key: {
                                    'game_id': gameId,
                                    'source_info_hash': sourceInfoHash
                                }
                            };
    
                            readClient.get(readParams, (err, data) => {
                                // todo: handle error separately
                                if (err || data.Item) {
                                    reject();
                                } else {
                                    resolve();
                                }
                            });
                        });
    
                        const createPublishRequest = ({commit, owner, repo, gameId, requester}) => new Promise((resolve, reject) => {
                
                            const sourceInfoHash = buildSourceInfoHash({sourceType: SourceType.GITHUB, commit, owner, repo});
    
                            const client = new aws.DynamoDB({
                                region: 'us-west-2'
                            });
    
                            const requestId = `${gameId}:${sourceInfoHash}`;
    
                            const params = {
                                TableName: 'publish_requests',
                                Item: {
                                    'request_id': {
                                        S: requestId
                                    },
                                    'commit_hash': {
                                        S: commit
                                    },
                                    'repo_owner': {
                                        S: owner
                                    },
                                    'repo_name': {
                                        S: repo
                                    },
                                    'game_id': {
                                        S: gameId
                                    },
                                    'requester': {
                                        S: requester
                                    }, 
                                    'source_info_hash': {
                                        S: sourceInfoHash
                                    },
                                    'created': {
                                        N: `${Date.now()}`
                                    },
                                    'status': {
                                        S: 'SUBMITTED'
                                    }
                                }
                            };
                
                            client.putItem(params, (err, putResult) => {
                                if (!err) {
                                    resolve({sourceInfoHash, gameId});
                                } else {
                                    reject(err);
                                }
                            });
                        });
    
                        verifyNoExistingPublishRequest(publishData).then(() => {
                            createPublishRequest(publishData).then((publishRecord) => {
                                const messageBody = JSON.stringify(publishRecord);
    
                                const sqsParams = {
                                    MessageBody: messageBody,
                                    QueueUrl: process.env.SQS_QUEUE_URL,
                                    MessageGroupId: Date.now() + '',
                                    MessageDeduplicationId: publishRecord.sourceInfoHash
                                };
    
                                const sqs = new aws.SQS({region: 'us-west-2'});
    
                                sqs.sendMessage(sqsParams, (err, sqsResponse) => {
                                    console.log(err);
                                    console.log(sqsResponse);
                                    res.end('created publish request');
                                });
                            }).catch((err) => {
                                console.error('sqs error');
                                console.error(err);
                                res.writeHead(500);
                                res.end('Failed to create publish request');
                            });
                        }).catch(() => {
                            res.writeHead(400);
                            res.end('Publish request already exists');
                        });
                    });
                }

            },
            [gameUpdateRegex]: {
                requiresAuth: true,
                handle: (userId, gameId) => {
                    getReqBody(req, (_data) => {
                        const data = JSON.parse(_data);
    
                        const changed = data.description || data.thumbnail;
    
                        if (changed) {
                            getGame(gameId).then(game => {
                                console.log('got game!');
                                console.log(game);
                                if (userId != game.createdBy) {
                                    res.writeHead(400, {
                                        'Content-Type': 'text/plain'
                                    });
                                    res.end('You cannot modify a game that you didnt create');
                                } else {
                                    if (data.description != game.description) {
                                        updateGame(gameId, {description: data.description}).then((_game) => {
                                            // sigh. 
                                            setTimeout(() => {
                                                res.writeHead(200, {
                                                    'Content-Type': 'application/json'
                                                });
                                                res.end(JSON.stringify(_game));
                                            }, 250);
                                        });
                                    } else {
                                        res.end('hmmm');
                                    }
                                }
                            }).catch(err => {
                                res.end(err.toString());
                            });
                        } else {
                            res.writeHead(400, {
                                'Content-Type': 'text/plain'
                            });
                            res.end('No valid changes');
                        }
                    });
                }
            },
            [submitPublishRequestRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    getReqBody(req, (_data) => {
                        const data = JSON.parse(_data);

            const { requestId } = data;
            getPublishRequest(requestId).then(requestData => {
                            updatePublishRequestState(requestData.game_id, requestData.source_info_hash, 'PENDING_PUBLISH_APPROVAL').then(() => {
                                        res.end('ok');
                                }).catch(err => {
                    res.end(err.toString());
                });
                            }).catch(err => {
                                res.end(err.toString());
                            });
                    });
                }
            },
            [requestActionRegex]: {
                requiresAuth: true,
                handle: (userId, requestId) => {
                    getCognitoUser(userId).then(userData => {
                        const _requestActionRegex = new RegExp('/admin/request/(\\S*)/action');
                        const requestId = _requestActionRegex.exec(req.url)[1];
                        if (userData.isAdmin) {
                            getReqBody(req, (_data) => {
                                const reqBody = JSON.parse(_data);
                                if (reqBody.action) {
                                    adminPublishRequestAction(requestId, reqBody.action, reqBody.message).then((gameId) => {
                                        updateGame(gameId, {published_state: 'APPROVED'});
                                        res.end('approved!');
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
                }
            }
        },
        'GET': {
            [podcastRegex]: {
                handle: () => {
                    const queryObject = url.parse(req.url, true).query;
                    const { limit, offset, sort } = queryObject;
                    getPodcastData(Number(offset || 0), Number(limit || 20), sort || 'desc').then(podcastData => {
                        res.end(JSON.stringify(podcastData));
                    });
                }
            },
            [listGamesRegex]: {
                handle: () => {
                    const queryObject = url.parse(req.url, true).query;
                    const { query, author, page, limit } = queryObject;
                    if (author) {
                        listGamesForAuthor({ author, page, limit }).then((data) => {
                            res.writeHead(200, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                games: data
                            }));
                        }).catch(err => {
                            console.log('unable to list games for author');
                            console.log(err);
                            res.end('error');
                        });
                    } else if (query) {
            console.log('query is ' + query);
                        queryGames(query).then(data => {
                            res.writeHead(200, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                games: data
                            })); 
                        });
                    } else {
                        listGames().then(pages=> {
                            res.writeHead(200, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify({
                                games: pages[page || 1],
                                pageCount: Object.keys(pages).length
                            })); 
                        });
                    }
                }
            },
            [gameDetailRegex]: {
                handle: (gameId) => {
                    getGameDetails(gameId).then(data => {
                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });
                        res.end(JSON.stringify(data)); 
                    }).catch(err => {
                        console.log(err);
                        res.end('error');
                    });
                }
            },
            [gameVersionDetailRegex]: {
                handle: (gameId, versionId) => {
                    getGameDetails(gameId).then(data => {
                        const foundVersion = data.versions.find(v => v.versionId === versionId);
                        if (!foundVersion) {
                            res.end('Version not found');
                        } else {
                            res.end(JSON.stringify(foundVersion));
                        }
                    }).catch((err) => {
                        console.log('game detail fetch err');
                        console.log(err);
                        res.end('Game not found');
                    });
                }
            },
            [publishRequestEventsRegex]: {
                requiresAuth: true,
                handle: (userId, gameId) => {
                    getPublishRequestEvents(gameId).then((publishRequests) => {
                        res.end(JSON.stringify(publishRequests));
                    });
                }
            },
            [verifyPublishRequestRegex]: {
                handle: () => {
                    const queryObject = url.parse(req.url, true).query;
                    const { code, requestId } = queryObject;
                    verifyPublishRequest(code, requestId).then((publishRequest) => {
                        publishGameVersion(publishRequest).then(() => {
                emitEvent(requestId, 'VERIFICATION_SUCCESS').then(() => {
                                updatePublishRequestState(publishRequest.game_id, publishRequest.source_info_hash, 'CONFIRMED').then(() => {
                                    res.end('verified!');
                    });
                            });
            });
                    }).catch(err => {
                        res.end(err);
                    });
                }
            },
            [assetsListRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    listAssets(userId).then(assets => {
                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });

                        res.end(JSON.stringify({
                            assets
                        }));
                    }).catch((err) => {
                        console.log(err);
                        res.end('error');
                    });
                }
            },
            [publishRequestsRegex]: {
                handle: (userId, gameId) => {
                    listPublishRequests(gameId).then((publishRequests) => {
                        res.end(JSON.stringify(publishRequests));
                    });
                },
                requiresAuth: true  
            },
            [adminListPublishRequestsRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    getCognitoUser(userId).then(userData => {
                        if (userData.isAdmin) {
                            adminListPublishRequests().then(publishRequests => {
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
                }
            },
            [healthRegex]: {
                handle: () => {
                    res.end('ok!');
                }
            }
        }
    };
    if (req.method === 'OPTIONS') {
        res.end('ok');
    } else if (!requestHandlers[req.method]) {
        res.writeHead(400);
        res.end('Unsupported method: ' + req.method);
    } else {
        // sort with largest values upfront to get the most specific match
        const matchers = Object.keys(requestHandlers[req.method]).sort((a, b) => b.length - a.length);
        let matched = null;
        for (let i = 0; i < matchers.length; i++) {
            matched = req.url.match(new RegExp(matchers[i]));
            if (matched) {
                const matchedParams = [];
                for (let j = 1; j < matched.length; j++) {
                    matchedParams.push(matched[j]);
                }
                const handlerInfo = requestHandlers[req.method][matchers[i]];
                if (handlerInfo.requiresAuth) {
                    const username = req.headers['hg-username'];
                    const token = req.headers['hg-token'];
    
                    if (!username || !token) {
                        res.end('API requires username & auth token');
                    } else {
                        verifyAccessToken(username, token).then(() => {
                            handlerInfo.handle(username, ...matchedParams);
                        });
                    }
                } else {
                    handlerInfo.handle(...matchedParams);
                }
                break;
            }
        }
        if (!matched) {
            res.writeHead(404);
            res.end('not found');
        }
    }

});

server.listen(8000);
