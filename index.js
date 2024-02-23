const http = require('http');
const acme = require('acme-client');
const https = require('https');
const unzipper = require('unzipper');
const url = require('url');
const archiver = require('archiver');
const fs = require('fs');
const aws = require('aws-sdk');
const querystring = require('querystring');
const crypto = require('crypto');
const util = require('util');
const { parse } = require('querystring');
const multiparty = require('multiparty');
const { fork } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const process = require('process');
const { verifyAccessToken, getUserHash } = require('homegames-common');
const redis = require('redis');
const { v4: uuidv4 } = require('uuid');

const SourceType = {
    GITHUB: 'GITHUB'
};

const poolData = {
    UserPoolId: process.env.COGNITO_USER_POOL_ID
};

const AWS_ROUTE_53_HOSTED_ZONE_ID = process.env.AWS_ROUTE_53_HOSTED_ZONE_ID;

const retryPublishRequest = (gameId, sourceInfoHash) => new Promise((resolve, reject) => {
    const messageBody = JSON.stringify({ gameId, sourceInfoHash });
    
    const sqsParams = {
        MessageBody: messageBody,
        QueueUrl: process.env.SQS_QUEUE_URL,
        MessageGroupId: Date.now() + '',
        MessageDeduplicationId: Date.now() + ''
    };

    const sqs = new aws.SQS({region: 'us-west-2'});
    
    sqs.sendMessage(sqsParams, (err, sqsResponse) => {
        console.log(err);
        console.log(sqsResponse);
        if (err) {
            reject(err);
        } else {
            resolve();
        }
    });
 
});

const getDnsRecord = (name) => new Promise((resolve, reject) => {
    const params = {
        HostedZoneId: AWS_ROUTE_53_HOSTED_ZONE_ID,
        StartRecordName: name,
        StartRecordType: 'TXT'
    };

    const route53 = new aws.Route53();
    route53.listResourceRecordSets(params, (err, data) => {
        for (const i in data.ResourceRecordSets) {
            const entry = data.ResourceRecordSets[i];
            if (entry.Name === name + '.') {
                resolve(entry.ResourceRecords[0].Value);
            }
        }
        reject();
    });

});

const deleteDnsRecord = (name) => new Promise((resolve, reject) => {

    getDnsRecord(name).then((value) => {
        const deleteDnsParams = {
            ChangeBatch: {
                Changes: [
                    {
                        Action: 'DELETE',
                        ResourceRecordSet: {
                            Name: name,//dnsChallengeRecord.Name,
                            Type: 'TXT',
                            TTL: 300,
                            ResourceRecords: [
                                {
                                    Value: value,//dnsChallengeRecord.Value
                                }
                            ]
                            //                        TTL: 300,
                            //                        Type: dnsChallengeRecord.Type
                        }
                    }
                ]
            },
            HostedZoneId: AWS_ROUTE_53_HOSTED_ZONE_ID
        };

        const route53 = new aws.Route53();
        route53.changeResourceRecordSets(deleteDnsParams, (err, data) => {
            const deleteParams = {
                Id: data.ChangeInfo.Id
            };

            route53.waitFor('resourceRecordSetsChanged', deleteParams, (err, data) => {
                if (data.ChangeInfo.Status === 'INSYNC') {
                    resolve();
                }
            });

        });
    });

});

const createDnsRecord = (name, value) => new Promise((resolve, reject) => {
    const dnsParams = {
        ChangeBatch: {
            Changes: [
                {
                    Action: 'CREATE',
                    ResourceRecordSet: {
                        Name: name,
                        ResourceRecords: [
                            {
                                Value: '"' + value + '"'
                            }
                        ],
                        TTL: 300,
                        Type: 'TXT'
                    }
                }
            ]
        },
        HostedZoneId: AWS_ROUTE_53_HOSTED_ZONE_ID
    };

    const route53 = new aws.Route53();
    route53.changeResourceRecordSets(dnsParams, (err, data) => {
        if (err) {
            reject(err);
        } else {
            const params = {
                Id: data.ChangeInfo.Id
            };

            route53.waitFor('resourceRecordSetsChanged', params, (err, data) => {
                if (data.ChangeInfo.Status === 'INSYNC') {
                    resolve();
                }
            });
        }
    });

});

const challengeCreateFn = async(authz, challenge, keyAuthorization) => {
    if (challenge.type === 'dns-01') {
        console.log('creating!!');
        await createDnsRecord(`_acme-challenge.${authz.identifier.value}`, keyAuthorization);
    }
};

const challengeRemoveFn = async(authz, challenge, keyAuthorization) => {

    if (challenge.type === 'dns-01') {
        console.log('removing!!');
        await deleteDnsRecord(`_acme-challenge.${authz.identifier.value}`);
    }
};

const storeRecord = (record) => {
	if (record.length > 1000) {
		console.log("Truncating record of length " + record.length);
		record = record.substring(1000);
	}

	const errString = `[${Date.now()}] ${record.toString()}\n`;
	const buf = Buffer.from(errString, 'utf-8');

	const fileSize = buf.length;
	const fileSizeMb = fileSize / (1024 * 1024);

	if (fileSizeMb < 1) {
            console.log('writing log file. size in mb: ' + fileSizeMb);

	    const s3 = new aws.S3();
	    const params = { Bucket: 'homegames', Key: 'error-logs/' + Date.now(), Body: buf };
	    s3.upload(params, {}, (err, data) => {
		console.log('s3 response');
		console.log(err);
		console.log(data);
	    });
       } else {
            console.error("Ignoring bug report larger than 1mb");
            console.error(record);
       }
}

// Redis key structure
//{
//  "publicIp": {
//    "serverId1": {
//      ...
//    },
//    "serverId2": {
//  ...
//    },
//    ...
//  }
//}
const getHomegamesServers = (publicIp) => new Promise((resolve, reject) => {
    redisClient().then(client => {

        client.hgetall(publicIp, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
});

const deleteHostInfo = (publicIp, localIp) => new Promise((resolve, reject) => {
    redisClient().then(client => {

        client.hdel(publicIp, [localIp], (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
});

const registerHost = (publicIp, info, hostId) => new Promise((resolve, reject) => {
    redisClient().then(client => {

        const doUpdate = () => {
            const payload = Object.assign({}, info);
            payload.timestamp = Date.now();
            client.hmset(publicIp, [hostId, JSON.stringify(payload)], (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        };

        // clear out existing entries
        client.hgetall(publicIp, (err, data) => {
            const idsToRemove = [];
            for (serverId in data) {
                const serverInfo = JSON.parse(data[serverId]);
                if (serverInfo.localIp && serverInfo.localIp === info.localIp || !serverInfo.timestamp || serverInfo.timestamp + (5 * 1000 * 60) <= Date.now()) {
                    idsToRemove.push(serverId);
                }
            }

            let toDeleteCount = idsToRemove.length;

            if (toDeleteCount === 0) {
                doUpdate();
            } else {

                for (const idIndex in idsToRemove) {
                    const id = idsToRemove[idIndex];

                    client.hdel(publicIp, [id], (err, data) => {
                        toDeleteCount -= 1;
                        if (toDeleteCount == 0) {
                            doUpdate();
                        }
                    });
                }
            }
        });
    });
});

const generateSocketId = () => {
    return uuidv4();
};

const updatePresence = (publicIp, serverId) => {
    console.log(`updating presence for server ${serverId}`);
    getHostInfo(publicIp, serverId).then(hostInfo => {
        if (!hostInfo) {
            console.warn(`no host info found for server ${serverId}`);
            reject();
        }
        registerHost(publicIp, JSON.parse(hostInfo), serverId).then(() => {
            console.log(`updated presence for server ${serverId}`);
            resolve();
        });
    });
};

const updateHostInfo = (publicIp, serverId, update) => new Promise((resolve, reject) => {
    console.log(`updating host info for server ${serverId}`);
    getHostInfo(publicIp, serverId).then(hostInfo => {
        const newInfo = Object.assign(JSON.parse(hostInfo), update);
        registerHost(publicIp, newInfo, serverId).then(() => {
            console.log(`updated host info for server ${serverId}`);
            resolve();
        }).catch(err => {
            console.error(`failed to update host info for server ${serverId}`);
            console.error(err);
            reject();
        });
    });
});

const logSuccess = (funcName) => {
    console.error(`function ${funcName} succeeded`);
};

const logFailure = (funcName) => {
    console.error(`function ${funcName} failed`);
};


// todo: move to common
const createDNSRecord = (url, ip) => new Promise((resolve, reject) => {
    const params = {
        ChangeBatch: {
            Changes: [
                {
                    Action: 'CREATE', 
                    ResourceRecordSet: {
                        Name: url,
                        ResourceRecords: [
                            {
                                Value: ip
                            }
                        ], 
                        TTL: 60, 
                        Type: 'A'
                    }
                }
            ]
        }, 
        HostedZoneId: process.env.AWS_ROUTE_53_HOSTED_ZONE_ID
    };

    const route53 = new aws.Route53();
    
    route53.changeResourceRecordSets(params, (err, data) => {
        resolve();
    });
});

const verifyDNSRecord = (url, ip) => new Promise((resolve, reject) => {
    const route53 = new aws.Route53();

    const params = {
        HostedZoneId: process.env.AWS_ROUTE_53_HOSTED_ZONE_ID,
        StartRecordName: url,
        StartRecordType: 'A',
        MaxItems: '1'
    };
    
    route53.listResourceRecordSets(params, (err, data) => {
        if (err) {
            console.log('error');
            console.error(err);
            reject();
        } else {
            if (data.ResourceRecordSets.length === 0 || data.ResourceRecordSets[0].Name !== url) {
                createDNSRecord(url, ip).then(() => {
                    resolve();
                });
            } else {
                resolve();
            }
        }
    });
});

const redisClient = () => new Promise((resolve, reject) => {
    setTimeout(() => {
        reject('Redis connection timed out');
    }, 30 * 1000);
    const client = redis.createClient({
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT
    }).on('error', (err) => {
        reject(err);
    }).on('ready', () => {
        resolve(client);
    });
});

const redisGet = (key) => new Promise((resolve, reject) => {
    redisClient().then(client => {
        client.get(key, (err, res) => {
            if (err) {
                reject(err);
            } else {
                resolve(res);
            }
        });
    });
});

const redisSet = (key, value) => new Promise((resolve, reject) => { 
    redisClient().then(client => {
        client.set(key, value, (err, res) => {
            if (err) {
                reject(err);
            } else {
                resolve(res);
            }
        });
    });

});

const redisHmset = (key, obj) => new Promise((resolve, reject) => {
    redisClient().then(client => {
        client.get(key, (err, res) => {
            if (err) {
                reject(err);
            } else {
                resolve(res);
            }
        });
    });
});

const getHostInfo = (publicIp, serverId) => new Promise((resolve, reject) => {
    redisClient().then(client => {
        client.hmget(publicIp, [serverId], (err, data) => {
            if (err || !data) {
                reject(err || 'No host data found');
            } else {
                resolve(data[0]);
            }
        });
    });

});

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

const getProfileInfo = (userId) => new Promise((resolve, reject) => {
    const ddb = new aws.DynamoDB({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'developer',
        Key: {
            'developer_id': {
                S: userId 
            }
        }
    };

    listGamesForAuthor({ author: userId }).then((games) => {
        ddb.getItem(params, (err, data) => {
            if (err) {
                console.log(err);
                reject();
            } else {
                if (data.Item) {
                    resolve({
                        description: data.Item.description?.S,
                        image: data.Item.image?.S,
                        qrValue: data.Item.qr_value?.S,
                        qrMeta: data.Item.qr_meta?.S,
                        games
                    });
                } else {
                    resolve({
                        games
                    });
                }
            }
        });
    });
});

const createGameImagePublishRequest = (userId, assetId, gameId) => new Promise((resolve, reject) => {
    const messageBody = JSON.stringify({ userId, assetId, type: 'gameImage', gameId });
    
    const sqsParams = {
        MessageBody: messageBody,
        QueueUrl: process.env.SQS_IMAGE_QUEUE_URL,
        MessageGroupId: Date.now() + '',
        MessageDeduplicationId: Date.now() + ''
    };

    console.log('params!');
    console.log(sqsParams);
    
    const sqs = new aws.SQS({region: 'us-west-2'});
    
    sqs.sendMessage(sqsParams, (err, sqsResponse) => {
        console.log(err);
        console.log(sqsResponse);
        resolve();
    });
 
});

const createUserImagePublishRequest = (userId, assetId) => new Promise((resolve, reject) => {
    const messageBody = JSON.stringify({ userId, assetId, type: 'userImage' });
    
    const sqsParams = {
        MessageBody: messageBody,
        QueueUrl: process.env.SQS_IMAGE_QUEUE_URL,
        MessageGroupId: Date.now() + '',
        MessageDeduplicationId: Date.now() + ''
    };

    console.log('params!');
    console.log(sqsParams);
    
    const sqs = new aws.SQS({region: 'us-west-2'});
    
    sqs.sendMessage(sqsParams, (err, sqsResponse) => {
        console.log(err);
        console.log(sqsResponse);
        resolve();
    });
 
});

const updateProfileInfo = (userId, { description, qrValue, qrMeta, image }) => new Promise((resolve, reject) => {    
    const ddb = new aws.DynamoDB({
        region: 'us-west-2'
    });

    const attributes = {};

    if (description && description.length <= 200) {
        attributes['description'] = {
            Action: 'PUT',
            Value: {
                S: description
            }
        }
    }

    if (qrValue && qrValue.length <= 200) {
        attributes['qr_value'] = {
            Action: 'PUT',
            Value: {
                S: qrValue
            }
        }
    }

    if (qrMeta && qrMeta.length <= 200) {
        attributes['qr_meta'] = {
            Action: 'PUT',
            Value: {
                S: qrMeta
            }
        }
    }

    if (image) {
        createUserImagePublishRequest(userId, image);
//        attributes['image'] = {
//            Action: 'PUT',
//            Value: {
//                S: image 
//            }
//        }
    }

    if (Object.keys(attributes).length < 1) {
//        reject('Nothing to update');
        resolve();
    } else {
        console.log('updating user ' + userId);
        console.log('with these attributes');
        console.log(attributes);
        const updateParams = {
            TableName: 'developer',
            Key: {
                'developer_id': {
                    S: userId
                }
            },
            AttributeUpdates: attributes
        };

        ddb.updateItem(updateParams, (err, putResult) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    }

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
                console.log('got this rrequest data');
                console.log(requestData);
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
    let earlyReturn = false;
    let _body = '';

    req.on('error', (err) => {
        console.log('request error ' + err);
        cb && cb(null, err);
    });

    req.on('data', chunk => {
        if (!earlyReturn && _body.length > (1000 * 1000)) {
            earlyReturn = true;
            cb && cb(null, 'too large');
        } else if (!earlyReturn) {
            _body += chunk.toString();
        }
    });

    req.on('end', () => {
        if (!earlyReturn) {
            cb && cb(_body);
        }
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

const adminListPendingPublishRequests = () => new Promise((resolve, reject) => {
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

const adminListFailedPublishRequests = () => new Promise((resolve, reject) => {
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
            ':status': 'FAILED' 
        }
    };

    client.query(params, (err, data) => {
        if (err) {
            console.log(err);
        }
        resolve({requests: data.Items});
    });
});

const adminListProcessingPublishRequests = () => new Promise((resolve, reject) => {
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
            ':status': 'PROCESSING' 
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
        console.log("DIDIADIADI");
        console.log(data);
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
        gameId: gameVersion.game_id,
        isReviewed: gameVersion.is_reviewed
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

const getGameVersion = (gameId, sourceInfoHash) => new Promise((resolve, reject) => {
//    const ddb = new aws.DynamoDB({
//        region: 'us-west-2'
//    });
//
//    const params = {
//        TableName: 'game_versions',
//        IndexName: 'request_id_index',
//        Key: {
//            'request_id': {
//                S: `${gameId}:${sourceInfoHash}`
//            }
//        }
//    };
//
//    ddb.getItem(params, (err, data) => {
//        if (err) {
//            console.log(err);
//            reject();
//        } else {
//            resolve(data.Item);
//        }
//    });

    const readClient = new aws.DynamoDB.DocumentClient({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'game_versions',
        IndexName: 'request_id_index',
        Limit: 1,
        KeyConditionExpression: '#request_id = :request_id',
        ExpressionAttributeNames: {
            '#request_id': 'request_id',
        },
        ExpressionAttributeValues: {
            ':request_id': `${gameId}:${sourceInfoHash}`
        }
    };

    readClient.query(params, (err, results) => {
        if (err) {
            console.log(err);
            reject(err.toString());
        } else {
            if (results.Items.length) {
                resolve(results.Items[0]);
                //resolve(Number(results.Items[0].version));
            } else {
                resolve(null);

            }
        }
    });
 

});

const setGameReviewed = (gameId, version) => new Promise((resolve, reject) => {
    const ddb = new aws.DynamoDB({
        region: 'us-west-2'
    });

    const updateParams = {
        TableName: 'game_versions',
        Key: {
            'game_id': {
                S: gameId
            },
            'version': {
                N: version + ''
            }
        },
        AttributeUpdates: {
            'is_reviewed': {
                Action: 'PUT',
                Value: {
                    BOOL: true
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

        getGameVersion(gameId, sourceInfoHash).then((gameVersion) => {
            console.log('this is game version');
            console.log(gameVersion);
            if (gameVersion && newStatus === 'PUBLISHED') {
                setGameReviewed(gameId, gameVersion.version);
            }
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
const profileRegex = '/profile';
const devProfileRegex = '/profile/(\\S*)';
const publishRequestEventsRegex = '/publish_requests/(\\S*)/events';
const gameDetailRegex = '/games/(\\S*)';
const gameVersionDetailRegex = '/games/(\\S*)/version/(\\S*)';
const healthRegex = '/health';
const adminListPendingPublishRequestsRegex = '/admin/publish_requests';
const adminListFailedPublishRequestsRegex = '/admin/publish_requests/failed';
const adminRetryRequestRegex = '/admin/publish_requests/retry';
const assetsListRegex = '/assets';
const verifyPublishRequestRegex = '/verify_publish_request';
const listGamesRegex = '/games';
const podcastRegex = '/podcast';
const linkRegex = '/link';
const ipRegex = '/ip';

// terrible names
const submitPublishRequestRegex = '/public_publish';
const gamePublishRegex = '/games/(\\S*)/publish';
const gameUpdateRegex = '/games/(\\S*)/update';
const requestActionRegex = '/admin/request/(\\S*)/action';
const createAssetRegex = '/asset';
const createGameRegex = '/games';
const bugsRegex = '/bugs';
const contactRegex = '/contact';

const verifyDnsRegex = '/verifyDns';
const certRequestRegex = '/cert';

const requestCert = (publicIp) => new Promise((resolve, reject) => {
    console.log('need to do the thing');
    acme.crypto.createPrivateKey().then(key => {
        const client = new acme.Client({
            directoryUrl: acme.directory.letsencrypt.staging,//production,//.staging
            accountKey: key
        });

        acme.crypto.createCsr({
            commonName: `${getHash(publicIp)}.homegames.link`//,
            //          altNames: ['picodeg.io']
        }).then((certKey, certCsr) => {
            console.log('did this');
            console.log(certKey);
            console.log(certCsr);
            resolve();
        }).catch(err => {
            console.error('error creating csr');
            console.error(err);
            reject(err);
        });
    });
});

const getPublicIp = (req) => {
    const connection = req && req.connection;
    const socket = req && req.socket;

    return req.ip || connection && connection.remoteAddress || socket && socket.remoteAddress || null;
};

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    const requesterIp = getPublicIp(req);

    const requestHandlers = {
        'POST': {
            [profileRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    getReqBody(req, (_body, err) => {
                        const body = JSON.parse(_body);
                        console.log('update body');
                        console.log(body);
                        updateProfileInfo(userId, body).then(() => res.end(''));
                    });
                }
            },
            [verifyDnsRegex]: {
                handle: () => {
                    res.end('ok');
                }
            },
            [adminRetryRequestRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    getCognitoUser(userId).then(userData => {
                        if (userData.isAdmin) {
                            getReqBody(req, (_body, err) => {
                                if (err) {
                                    res.end('error ' + err);
                                } else {
                                    const body = JSON.parse(_body);
                                    if (!body.gameId || !body.sourceInfoHash) {
                                        res.end('requires gameId and sourceInfoHash');
                                    } else {
                                        retryPublishRequest(body.gameId, body.sourceInfoHash);
                                        res.end('ok');
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
                }
            },
            [certRequestRegex]: {
                //               requiresAuth: true,
                handle: () => {
                    requestCert(requesterIp).then(() => {
                        res.end('aite');
                    }).catch(err => {
                        console.error('Error ');
                        console.error(err);
                        res.end('error');
                    });
                }
            },
            [bugsRegex]: {
                handle: () => {
                    getReqBody(req, (_body, err) => {
                        if (err) {
                            console.log('Bug reporting error: ' + err);
                            res.end('error: ' + err);
                        } else {
                            console.log(`${Date.now()} Got bug report: `);
                            storeRecord(_body);
                            res.end('ok');
                        }
                    });
                }
            },
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
                            Source: 'support-form@homegames.io'
                        };

                        const ses = new aws.SES({region: 'us-west-2'});

                        ses.sendEmail(emailParams, (err, data) => {
                            res.end(JSON.stringify({
                                success: !(err)
                            }));
                        });
                    });
                }
            },
            [createGameRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    console.log('got user id ' + userId);
                    const form = new multiparty.Form();
                    form.parse(req, (err, fields, files) => {
                        if (err) {
                            console.error('error parsing form');
                            console.error(err);
                            res.end('error');
                        } else {
                            if (!fields.name || !fields.name.length || !fields.description || !fields.description.length) {
                                res.end('creation requires name & description');
                            } else {
                                const gameId = generateId();
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
                                                    //'thumbnail': {
                                                    //    S: url.replace('https://assets.homegames.io/', '') 
                                                    //}
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

                                if (files.thumbnail?.length) {
                                    console.log('need to do something with thumbnail');

                                    createGameImagePublishRequest(userId, image, gameId);
    
                                    //uploadThumbnail(userId, gameId, files.thumbnail[0]).then((url) => {
                                    //}).catch(err => {
                                    //    console.log('failed to upload thumbnail');
                                    //    console.error(err);
                                    //});

                                }
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
                        console.log("here is data");
                        console.log(data);
    
                        const publishData = {
                            commit: data.commit,
                            requester: userId,
                            owner: data.owner,
                            repo: data.repo,
                            //squishVersion: data.squishVersion,
                            gameId
                        };

                        console.log('publish data');
                        console.log(publishData);
    
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
    
                        const createPublishRequest = ({commit, owner, repo, gameId, requester }) => new Promise((resolve, reject) => {
                
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
                                    },
//                                    'squishVersion': {
//                                        S: squishVersion
//                                    }
                                }
                            };

                            console.log("HERE IS PAREAMS!");
                            console.log(params);
                
                            client.putItem(params, (err, putResult) => {
                                if (!err) {
                                    resolve({sourceInfoHash, gameId});
                                } else {
                                    console.error('error creating publish request');
                                    console.error(err);
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
                        console.log('thjis is data');
 
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
                                    console.log("FDDSFSDF");
                                    if (data.description != game.description) {
                                        console.log("FSDFSDFDSFDSFDSFDSF");
                                        updateGame(gameId, {description: data.description}).then((_game) => {
                                            console.log('dsfjksdfhjkdsf');
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

                                if (data.thumbnail !== game.thumbnail) {
                                    createGameImagePublishRequest(userId, data.thumbnail, gameId);
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

                                        if (reqBody.action === 'approve') {
                                            updateGame(gameId, {published_state: 'APPROVED'});
                                        }
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
            [ipRegex]: {
                handle: () => {
                    const { headers } = req;
                    const requesterIp = headers['x-forwarded-for'] || req.connection.remoteAddress;
                    res.end(requesterIp);
                }
            },
            [linkRegex]: {
                handle: () => {
                    console.log('got a request to ' + req.url + ' (' +  req.method + ')');
                    const { headers } = req;

                    const noServers = () => {
                        res.writeHead(200, {
                            'Content-Type': 'text/plain'
                        });
                        res.end('No Homegames servers found. Contact support@homegames.io for help');
                    };

                    if (!headers) {
                        noServers();
                    } else {
                        res.writeHead(200, {
                            'Content-Type': 'text/plain'
                        });

                        const requesterIp = headers['x-forwarded-for'] || req.connection.remoteAddress;

                        getHomegamesServers(requesterIp).then(servers => {
                            const serverIds = servers && Object.keys(servers) || [];
                            if (serverIds.length === 1) {
                                const serverInfo = JSON.parse(servers[serverIds[0]]);
                                const hasHttps = serverInfo.https;
                                const prefix = hasHttps ? 'https' : 'http';
                                const urlOrIp = serverInfo.verifiedUrl || serverInfo.localIp;
                                res.writeHead(307, {
                                    'Location': `${prefix}://${urlOrIp}`,
                                    'Cache-Control': 'no-store'
                                });
                                res.end();
                            } else if (serverIds.length > 1) {
                                const serverOptions = serverIds.map(serverId => {
                                    const serverInfo = JSON.parse(servers[serverId]);

                                    const prefix = serverInfo.https ? 'https': 'http';
                                    const urlOrIp = serverInfo.verifiedUrl || serverInfo.localIp;
                                    const lastHeartbeat = new Date(Number(serverInfo.timestamp));
                                    return `<li><a href="${prefix}://${urlOrIp}"}>Server ID: ${serverId} (Last heartbeat: ${lastHeartbeat})</a></li>`;
                                });

                                const content = `Homegames server selector: <ul>${serverOptions.join('')}</ul>`;
                                const response = `<html><body>${content}</body></html>`;
                                res.writeHead(200, {
                                    'Content-Type': 'text/html'
                                });
                                res.end(response);
                            } else {
                                console.log('no servers');
                                noServers();
                            }

                        }).catch(err => {
                            console.log('Error getting host info');
                            console.log(err);
                            noServers();
                        });
                    }
                    console.log('ayyyylm oa!');
                    res.end('ayy lmao');
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
            [devProfileRegex]: {
                handle: (devId) => {
                    getProfileInfo(devId).then(data => res.end(JSON.stringify(data)));
                }
            },
            [profileRegex]: {
                handle: (userId) => {
                    getProfileInfo(userId).then(data => res.end(JSON.stringify(data)));
                },
                requiresAuth: true
            },
            [publishRequestsRegex]: {
                handle: (userId, gameId) => {
                    listPublishRequests(gameId).then((publishRequests) => {
                        res.end(JSON.stringify(publishRequests));
                    });
                },
                requiresAuth: true  
            },
            [adminListPendingPublishRequestsRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    getCognitoUser(userId).then(userData => {
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
                }
            },
            [adminListFailedPublishRequestsRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    getCognitoUser(userId).then(userData => {
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
                        }).catch(err => {
                            console.error(err);
                            res.end('Unexpected error occured');
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

const wss = new WebSocket.Server({ server });

const clients = {};

wss.on('connection', (ws, req) => {
    const publicIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    if (!publicIp) {
        console.log('No public IP found for websocket connection.');
        return;
    }

    const socketId = generateSocketId();

    ws.id = socketId;

    clients[ws.id] = ws;

    console.log(`registering socket client with id: ${ws.id}`);

    ws.on('message', (_message) => {
       
        try {
            const message = JSON.parse(_message);

            if (message.type === 'heartbeat') {
                updatePresence(publicIp, ws.id).then(logSuccess('updatePresence')).catch(logFailure('updatePresence'));
            } else if (message.type === 'register') {
                registerHost(publicIp, message.data, ws.id).then(logSuccess('registerHost')).catch(logFailure('registerHost'));
            } else if (message.type === 'verify-dns') {
                console.log('verifying dns for user ' + message.username);
                verifyAccessToken(message.username, message.accessToken).then(() => {
                    const ipSub = message.localIp.replace(/\./g, '-');
                    const userHash = getUserHash(message.username);
                    const userUrl = `${ipSub}.${userHash}.homegames.link`;
                    verifyDNSRecord(userUrl, message.localIp).then(() => {
                        ws.send(JSON.stringify({
                            msgId: message.msgId,
                            url: userUrl,
                            success: true
                        }));
                        updateHostInfo(publicIp, ws.id, {verifiedUrl: userUrl}).then(logSuccess('upateHostInfo')).catch(logFailure('updateHostInfo'));
                    }).catch(logFailure('verifyDNSRecord'));
                }).catch(err => {
                    console.log('Failed to verify access token for user ' + message.username);
                    console.error(err);
                    ws.send(JSON.stringify({
                        msgId: message.msgId,
                        success: false,
                        error: 'Failed to verify access token'
                    }));
                    logFailure('verifyAccessToken');
                });
            } else {
                console.log('received message without ip');
                console.log(message);
            }
        } catch (err) {
            console.log('Error processing client message');
            console.error(err);
        }

    });

    ws.on('close', () => {
        console.log(`deregistering socket client with id: ${ws.id}`);

        clients[ws.id] && delete clients[ws.id];

        deleteHostInfo(publicIp, ws.id).then(() => {
            console.log(`deregistered socket client with id: ${ws.id}`);
        });
    });
});

server.listen(8080);
