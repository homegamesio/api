const http = require('http');
const decompress = require('decompress');
const acme = require('acme-client');
const https = require('https');
const unzipper = require('unzipper');
const url = require('url');
const archiver = require('archiver');
const fs = require('fs');
const querystring = require('querystring');
const crypto = require('crypto');
const util = require('util');
const { parse } = require('querystring');
const multiparty = require('multiparty');
const { fork } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const process = require('process');
const { getUserHash } = require('homegames-common');
const redis = require('redis');
const { v4: uuidv4 } = require('uuid');
const { Binary, MongoClient } = require('mongodb');
const amqp = require('amqplib/callback_api');

const SourceType = {
    GITHUB: 'GITHUB'
};

const poolData = {
    UserPoolId: process.env.COGNITO_USER_POOL_ID
};

const CERTS_ENABLED = true;//process.env.CERTS_ENABLED;

const DB_TYPE = process.env.DB_TYPE || 'local';

const AWS_ROUTE_53_HOSTED_ZONE_ID = process.env.AWS_ROUTE_53_HOSTED_ZONE_ID;

const QUEUE_HOST = process.env.QUEUE_HOST || 'localhost';

const SALT_ROUNDS = process.env.SALT_ROUNDS || 10;

const HASH_ITERATIONS = process.env.HASH_ITERATIONS || 100000;
const HASH_KEY_LENGTH = process.env.HASH_KEY_LENGTH || 64;
const HASH_DIGEST = process.env.HASH_DIGEST || 'sha512';

const ELASTICSEARCH_HOST = process.env.ELASTICSEARCH_HOST;
const ELASTICSEARCH_PORT = process.env.ELASTICSEARCH_PORT;
const ELASTICSEARCH_GAME_INDEX = process.env.ELASTICSEARCH_GAME_INDEX;
const ELASTICSEARCH_DEVELOPER_INDEX = process.env.ELASTICSEARCH_DEVELOPER_INDEX;

const DB_HOST = process.env.DB_HOST;
const DB_PORT = process.env.DB_PORT;
const DB_USERNAME = process.env.DB_USERNAME || '';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

const JWT_SECRET = process.env.JWT_SECRET || 'hello world!';

// mongo, local (in memory)
const AUTH_TYPE = process.env.AUTH_TYPE || 'mongo';

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
            if (validSignature == tokenSignature) {
                resolve(payload);
            } else {
                reject('Invalid token');
            }
        }
    }
});

const hashValue = (val) => {
    return crypto.createHash('sha256').update(val).digest('hex');
}

const hashPassword = (password, salt) => new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, HASH_ITERATIONS, HASH_KEY_LENGTH, HASH_DIGEST, (error, hashedPassword) => {
        if (error) {
            reject(error);
        } else {
            resolve(hashedPassword);
        }
    });
});

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


const downloadZip = (url) =>
  new Promise((resolve, reject) => {
    const outDir = `/tmp/${Date.now()}`;
    fs.mkdirSync(outDir);
    const zipPath = `${outDir}/data.zip`;

    const zipWriteStream = fs.createWriteStream(zipPath);

    zipWriteStream.on('close', () => {
            console.log('reososeoso');
            console.log(zipPath);
		resolve({
			zipPath
		});
    });

    https.get(url, (res) => {
	res.pipe(zipWriteStream);
	zipWriteStream.on('finish', () => {
		zipWriteStream.close();
	});
    }).on('error', (err) => {
        console.error(err);
        reject(err);
    });
  });

const downloadFromGithub = (owner, repo, commit = '') =>
  new Promise((resolve, reject) => {
    const commitString = commit ? "/" + commit : "";
    const thing = `https://codeload.github.com/${owner}/${repo}/zip${commitString}`;
    downloadZip(thing).then(resolve);
  });

const getMongoClient = () => {
    const uri = DB_USERNAME ? `mongodb://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/homegames` : `mongodb://${DB_HOST}:${DB_PORT}/homegames`;
    console.log("URI");
    console.log(uri);
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

const getMongoAsset = (assetId) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db('homegames');
        const assetCollection = db.collection('assets');
        assetCollection.findOne({ assetId }).then(resolve).catch(reject);
    });
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
                }); 
            }
        });
    });
});

const createBlogPost = (userId, blogPayload) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db('homegames');
        const blogCollection = db.collection('blog');
        blogCollection.insertOne({ id: generateId(), publishedBy: userId, created: Date.now(), title: blogPayload.title || '', content: blogPayload.content }).then(resolve).catch(reject);
    });
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
        console.log('cikciciciciic ' + limit + ', offset: ' + offset + ', include ' + includeMostRecent);
        collection.countDocuments(dbQuery).then((count) => {
            collection.find(dbQuery).limit(Number(limit)).skip(Number(offset)).sort({ created: -1 }).toArray().then(posts => {
                console.log("the fuck lol " + includeMostRecent);
                console.log(includeMostRecent);
                if (!!includeMostRecent) {
                    console.log('dodididin 1');
                    const mostRecent = posts.length ? mapBlogPost(posts[0], true) : null;
                    resolve({ posts: posts.map(p => mapBlogPost(p, false)), count, mostRecent });
                } else {
                    resolve({ posts: posts.map(p => mapBlogPost(p, false)), count });
                }
            }).catch(reject);
        });
    }).catch(reject);
 
});

const getMongoDocument = (assetId) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db('homegames');
        const documentCollection = db.collection('documents');
        documentCollection.findOne({ assetId }).then(resolve).catch(reject);
    });
});

const getUserRecord = (userId) => new Promise((resolve, reject) => {
    getMongoCollection('users').then(collection => {
        collection.findOne({ userId }).then(resolve).catch(reject);
    });
});

const login = (request) => new Promise((resolve, reject) => {
    const { username, password } = request;

    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db('homegames');
        const collection = db.collection('users');
        collection.findOne({ userId: username }).then((usernameResponse) => {
            if (usernameResponse == null) {
                reject('user doesnt exist');
            } else {
                const passwordSalt = usernameResponse.passwordSalt;//.toString('hex');
                hashPassword(password, passwordSalt).then((passwordHash) => {
                    if (usernameResponse.passwordHash.toString('hex') === passwordHash.toString('hex')) {
                        resolve({
                            username,
                            token: generateJwt(username),
                            isAdmin: usernameResponse.isAdmin || false,
                            created: usernameResponse.created
                        });
                    } else {
                        reject('incorrect username or password');
                    }
                    //collection.insertOne({ username, passwordHash, passwordSalt }).then(() => {
                    //    const token = generateJwt(username);
                    //    resolve({
                    //        username, 
                    //        token
                    //    });
                    //});
                });
            } 
        });
    });
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

    console.log('jdjdjdj');
    console.log(encodedSignature);
    console.log('fjfjfjfjfjfjfjfjb ');
    console.log(encodedPayload);

    return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
};

const mongoSignup = (userId, password) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db('homegames');
        const collection = db.collection('users');
        collection.findOne({ userId }).then((userResponse) => {
            if (userResponse == null) {
                const passwordSalt = crypto.randomBytes(16).toString('hex');
                hashPassword(password, passwordSalt).then((passwordHash) => {
                    collection.insertOne({ userId, passwordHash, passwordSalt, created: Date.now() }).then(() => {
                        const token = generateJwt(userId);
                        resolve({
                            userId, 
                            token
                        });
                    });
                });
            } else {
                reject('username already exists');
            }
        });
    });
});

const signup = (request) => new Promise((resolve, reject) => {
    const { username, password } = request;
    if (!username || !password) {
        reject('signup requires username & password');
    } else {
        if (AUTH_TYPE === 'mongo') {
            console.log('babba');
            mongoSignup(username, password).then(resolve).catch((err) => {
                console.log('sdfdsfdks ' + err);
                reject(err);
            });
        }
    }
});

const getLatestContentRequestForIp = (ip) => new Promise((resolve, reject) => {
    const client = new aws.DynamoDB.DocumentClient({
        region: 'us-west-2'
    });

    const params = {
        TableName: 'content-requests',
        IndexName: 'ip_address_index',
        Limit: 1,
        ScanIndexForward: false,
        KeyConditionExpression: '#ip_address = :ip_address',
        ExpressionAttributeNames: {
            '#ip_address': 'ip_address'
        },
        ExpressionAttributeValues: {
            ':ip_address': ip
        }
    };

    client.query(params, (err, data) => {
        if (data?.Items?.length) {
            resolve(data.Items[0]);
        } else {
            resolve(null);
        }
//        if (err) {
//            reject([{error: err}]);
//        } else {
//            resolve(data.Items.map(mapGame));
//        }
    });

});

const submitContentRequest = (request, ip) => new Promise((resolve, reject) => {
    getLatestContentRequestForIp(ip).then((last) => {
        if (!last || last.created_at + (30 * 1000) < Date.now()) {
            if (!request.type) {
                reject('i aint got no type');
            } else {
                const requestId = uuidv4();
 
                const ddbClient = new aws.DynamoDB({
                    region: 'us-west-2'
                });

                const now = Date.now();

                const messageBody = JSON.stringify({ requestId, createdAt: now, type: request.type, model: request.model, prompt: request.prompt });

// todo: i dont like storing these. maybe store in redis with short (< 1 hour) ttl
                const params = {
                    TableName: 'content-requests',
                    Item: {
                        'request_id': {
                            S: requestId
                        },
                        'created_at': {
                            N: `${now}`
                        },
                        'ip_address': {
                            S: '' + ip
                        }
                    }
                };

                ddbClient.putItem(params, (err, putResult) => {
                    console.log(err);
                    console.log(putResult);
            
                    const sqsParams = {
                        MessageBody: messageBody,
                        QueueUrl: process.env.CONTENT_QUEUE_URL,
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
                            resolve(requestId);
                        }
                    });

                }); 
            }
        } else {
            console.log("FSDHFKJSDFJKDSF");
            reject('Too many requests for IP');
        }
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

        const route53 = new aws.Route53Client();
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

const uploadMongo = (developerId, assetId, filePath, fileName, fileSize, fileType) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db('homegames');
        const collection = db.collection('assets');
        collection.findOne({ assetId }).then(asset => {
            console.log("found asset to upload");
            console.log(asset);
            const documentCollection = db.collection('documents');
            documentCollection.insertOne({ developerId, assetId, data: new Binary(fs.readFileSync(filePath)), fileSize, fileType }).then(() => resolve(assetId)).catch(reject);
        });
    }); 
});

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
    getMongoProfileInfo(userId).then(resolve).catch(reject);
});

const getMongoProfileInfo = (userId) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db('homegames');
        const collection = db.collection('users');
        console.log('for ' + userId);
        collection.findOne({ userId }).then((userResponse) => {
            console.log('found user');
            console.log(userResponse);
            const { userId, created, image, description } = userResponse;

                resolve({
                    username: userId,
                    created,
                    image, 
                    description
                });
        });
    });
});

const updateGameSearch = (gameData) => new Promise((resolve, reject) => {
    const body = JSON.stringify(gameData);
    
    const options = {
        hostname: ELASTICSEARCH_HOST,
        port: ELASTICSEARCH_PORT,
        path: `/games/_doc/${gameData.gameId}`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };
    
    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            const parsed = JSON.parse(data);
            resolve();
        });
    });

    req.on('error', (e) => {
        console.error(`problem with request: ${e.message}`);
        reject();
    });

    req.write(body);
    req.end();

});

const createGame = (developerId, thumbnailAssetId, fields, files) => new Promise((resolve, reject) => {
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

const createGameImagePublishRequest = (userId, assetId, gameId) => new Promise((resolve, reject) => {
    amqp.connect(`amqp://${QUEUE_HOST}`, (err, conn) => {
        if (err) {
            reject(err);
        } else {
            conn.createChannel((err1, channel) => {
                if (err1) {
                    reject(err1);
                } else {
                    console.log('created channel');
                    channel.assertQueue('homegames-jobs', {
                        durable: false
                    });

                    channel.sendToQueue('homegames-jobs', Buffer.from(JSON.stringify({ type: 'GAME_IMAGE_APPROVAL_REQUEST', userId, assetId, gameId })));
                    console.log('sent message');
                    resolve();
                }
            });
        }
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

const updateProfileInfo = (userId, { description, image }) => new Promise((resolve, reject) => {
    updateMongoProfileInfo(userId, { description, image }).then(resolve).catch(reject);
});

const getMongoCollection = (collectionName) => new Promise((resolve, reject) => {
    const client = getMongoClient();
    client.connect().then(() => {
        const db = client.db('homegames');
        const collection = db.collection(collectionName);
        resolve(collection);
    });
});

const createProfileImageTask = (userId, assetId) => new Promise((resolve, reject) => {
    amqp.connect(`amqp://${QUEUE_HOST}`, (err, conn) => {
        console.log('erererer');
        console.log(err);
        console.log("FJSDFJKSDF");
        console.log(assetId);
        console.log(conn);
        if (err) {
            reject(err);
        } else {
            conn.createChannel((err1, channel) => {
                if (err1) {
                    reject(err1);
                } else {
                    console.log('created channel');
                    channel.assertQueue('homegames-jobs', {
                        durable: false
                    });

                    channel.sendToQueue('homegames-jobs', Buffer.from(JSON.stringify({ type: 'PROFILE_IMAGE_APPROVAL_REQUEST', userId, assetId })));
                    console.log('sent message');
                    resolve();
                }
            });
        }
    });

});

const updateMongoProfileInfo = (userId, { description, image }) => new Promise((resolve, reject) => {
    getMongoCollection('users').then(users => {
        users.findOne({ userId }).then((foundUser) => {
            console.log('fiouffofu');
            console.log(foundUser);
            if (!foundUser) {
                reject('User not found');
            } else {
                if (image) {
                    createProfileImageTask(userId, image);
                }
                if (description && foundUser.description != description) {
                    users.updateOne({ userId }, { "$set": { description } }).catch(reject).then(resolve);
                } else {
                    resolve();
                }

                resolve();
            }
        });
    });
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
    console.log('looking for ' + requestId);
    getMongoCollection('publishRequests').then((collection) => {
        collection.findOne({ requestId }).then((result) => {
            if (!result) {
                reject('not found');
            } else {
                resolve(result);
            }
        });
    });

});


// copied from homedome
const getS3Url = (gameId, requestId) => {
    return `https://hg-games.s3-us-west-2.amazonaws.com/${gameId}/${requestId}/code.zip`;
};

const updatePublishRequestState = (requestId, gameId, sourceInfoHash, newStatus) => new Promise((resolve, reject) => {
    getMongoCollection('publishRequests').then((publishRequests) => {
        publishRequests.updateOne({ requestId }, { "$set": { status: newStatus } }).catch(reject).then(() => {
            resolve();
        });
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
    getMongoCollection('games').then(collection => {
        collection.findOne({ gameId }).then(game => {
            resolve({ 
                id: game.gameId,
                description: game.description,
                name: game.name,
                created: game.created,
                developerId: game.developerId,
                thumbnail: game.thumbnail
            });
        });
    });
});

const updateGameIndex = (gameId) => new Promise((resolve, reject) => {
    getGame(gameId).then(gameData => {
        console.log('need to post to elasticsearch');
        console.log(gameData);
        const gameBody = {
            id: gameData.id,
            description: gameData.description,
            name: gameData.name,
            created: gameData.created,
            developerId: gameData.developerId,
            thumbnail: gameData.thumbnail
        };
        elasticSearchPost('/games/_doc/' + gameId, gameBody).then(() => {
            console.log('cool!1!jsdfgkfsdg');
            resolve();
        });
    });
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
            });
        }

        //if (updateParams.published_state) {
        //    attributeUpdates.published_state = {
        //        Action: 'PUT',
        //        Value: {
        //            S: updateParams.published_state
        //        }
        //    };
        //}
    }
});

const listAssets = (developerId, query, limit = 10, offset = 0) => new Promise((resolve, reject) => {
    console.log('this is query ' + query);
    console.log('dfdsfdsf ' + limit);
    console.log(offset);
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
                    { assetId: { '$regex': query, $options: 'i' } }
                  ]
                }
              ]
            };
        } 
        collection.countDocuments(dbQuery).then((count) => {
            console.log('dsjfjsdfdsf');
            collection.find(dbQuery).limit(Number(limit)).skip(Number(offset)).sort({ created: -1 }).toArray().then(assets => {
                resolve({ assets, count });
            }).catch(reject);
        });
    }).catch(reject);
});

const createAssetRecord = (developerId, assetId, size, name, metadata, description) => new Promise((resolve, reject) => {
    if (DB_TYPE == 'mongo') {
        console.log('creating asset with id ' + assetId);
        createMongoAssetRecord(developerId, assetId, size, name, metadata, description).then(resolve).catch(reject);
    } else if (DB_TYPE == 'dynamo') {
        createRecord(developerId, assetId, size, name, metadata).then(resolve).catch(reject);
    }
});

const createMongoAssetRecord = (developerId, assetId, size, name, metadata, description) => new Promise((resolve, reject) => {
    getMongoCollection('assets').then(assetCollection => {
        assetCollection.insertOne({ created: Date.now(), developerId, assetId, size, name, metadata, description }).then(() => resolve({assetId})).catch(reject);
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
    getMongoCollection('publishRequests').then((collection) => {
        collection.find({ status: 'PENDING_PUBLISH_APPROVAL' }).toArray().then((results) => {
            resolve({ requests: results });
        });
    });
});

const adminAcknowledgeMessage = (messageId) => new Promise((resolve, reject) => {
    getMongoCollection('supportMessages').then((collection) => {
        collection.findOne({ id: messageId }).then(supportMessage => {
            console.log('found message');
            console.log(supportMessage);
            collection.updateOne({ id: messageId }, { "$set": { 'status': 'ACKNOWLEDGED' } }).then(resolve).catch(reject);
        });
    });
});

const adminListSupportMessages = (page, limit) => new Promise((resolve, reject) => {
    const actualLimit = limit || 10;
    const skip = ( page - 1 ) * actualLimit;
 
    getMongoCollection('supportMessages').then((collection) => {
        collection.find({ status: 'PENDING' }).skip(skip).limit(actualLimit).toArray().then((results) => {
            resolve({ requests: results });
        });
    });

});

const adminListFailedPublishRequests = () => new Promise((resolve, reject) => {
    getMongoCollection('publishRequests').then((collection) => {
        collection.find({ status: 'FAILED' }).toArray().then((results) => {
            resolve({ requests: results });
        });
    });
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
        });
    });

});

const listGamesForAuthor = (params) => new Promise((resolve, reject) => {
    mongoListGamesForAuthor(params).then(resolve).catch(reject);
});

const listPublicGamesForAuthor = (params) => new Promise((resolve, reject) => {
    console.log('fiufiufiufi elastic');
    console.log(params);
    const offset = params.offset|| 0;
    const limit = params.limit || 10;
    const ting = { 
        from: offset,
        size: limit,
        query: {
            'multi_match': { 
                query: params.author, 
                fields: ['developerId'] 
            }
        }
    };

    console.log('this is ting');
    console.log(JSON.stringify(ting));

    elasticSearchPost('/games/_search', ting).then((results) => {
        console.log("search results!');');");
        console.log(results);
        const totalResults = results.hits.total.value;
        const pageCount = Math.ceil(totalResults / limit);
        resolve({
            total: totalResults,
            games: results.hits.hits.map(h => mapElasticSearchGame(h)),
            pageCount
        })

    });
});

const mongoListGamesForAuthor = ({ author, page, limit }) => new Promise((resolve, reject) => {
    console.log("gonna list games");
    getMongoCollection('games').then(collection => {
        const actualLimit = limit || 10;
        const skip = ( page - 1 ) * actualLimit;
        console.log("DKKDSFKDSFK NEED TO MOVE THIS ??");
        console.log(skip);
        collection.find({ developerId: author }).limit(actualLimit).skip(skip).toArray().then(results => {//{ developerId: author }).then(results => {//.skip(skip).limit(actualLimit).then(results => {
           resolve(results.map(r => {
                return {
                    id: r.gameId,
                    name: r.name,
                    description: r.description,
                    createdBy: r.createdBy,
                    createdAt: r.createdAt
                }
           }));
        });
    });
});

const dynamoListGamesForAuthor = ({ author, page, limit }) => new Promise((resolve, reject) => {

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
    getMongoCollection('games').then(collection => {
        collection.findOne({ gameId }).then(gameResult => {
            if (gameResult == null) {
                reject('Game not found');
            } else {
                getMongoCollection('gameVersions').then(versionCollection => {
                    versionCollection.find({ gameId }).limit(10).sort({ publishedAt: -1 }).toArray().then(versions => {
                    console.log('versions!');
                    console.log(versions);
                        resolve({
                            game: {
                                name: gameResult.name,
                                description: gameResult.description,
                                created: gameResult.created,
                                developerId: gameResult.developerId,
                                thumbnail: gameResult.thumbnail,
                                id: gameResult.gameId
                            },
                            versions: versions.map(v => {
                                return {
                                    id: v.versionId,
                                    published: v.publishedAt,
                                    assetId: v.sourceAssetId
                                }
                            })
                        });
                    });
                });
            }
        });
    });
});

const assetResponse = (asset) => {
    console.log('ayo!');
    console.log(asset);
    return {
        id: asset.assetId,
        developerId: asset.developerId,
        name: asset.name,
        created: asset.created,
        description: asset.description,
        size: asset.size,
        type: asset.metadata?.['Content-Type'] || null
    }
};

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

const elasticSearchPost = (path, data) => new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    
    const options = {
        hostname: ELASTICSEARCH_HOST,
        port: ELASTICSEARCH_PORT,
        path,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };
    
    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            const parsed = JSON.parse(data);
            console.log('parsed"');
            console.log(parsed);
            resolve(parsed);
        });
    });

    req.on('error', (e) => {
        console.error(`problem with request: ${e.message}`);
    });

    req.write(body);
    req.end();
});


const search = (indexes, query, offset = 0, limit = 10) => new Promise((resolve, reject) => {
    const body = JSON.stringify({
        from: offset,
        size: limit,
        query: {
            bool: {
                should: [
                    {
                        "multi_match": {
                            "query": query,
                            "fields": ["developerId", "description", "name"],
	                     "fuzziness": "AUTO"
                        }
                    },
                    {
                        "wildcard": {
                            "name": {
                                value: `*${query}*`
                            }
                        }
                    },
                    {
                        "wildcard": {
                            "developerId": {
                                value: `*${query}*`
                            }
                        }
                    },
                    {
                        "wildcard": {
                            "description": {
                                value: `*${query}*`
                            }
                        }
                    }
                ]
            }
        }
    });
    
    const options = {
        hostname: ELASTICSEARCH_HOST,
        port: ELASTICSEARCH_PORT,
        path: `/${indexes}/_search`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };
    
    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            const parsed = JSON.parse(data);
            console.log('parsed"');
            console.log(parsed);
            resolve(parsed.hits);
        });
    });

    req.on('error', (e) => {
        console.error(`problem with request: ${e.message}`);
    });

    req.write(body);
    req.end();
});

const getIndexData = (indexes, limit, offset) => new Promise((resolve, reject) => {
    const body = JSON.stringify({
        from: offset,
        size: limit
    });
    
    const options = {
        hostname: ELASTICSEARCH_HOST,
        port: ELASTICSEARCH_PORT,
        path: `/${indexes}/_search`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };
    
    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            const parsed = JSON.parse(data);
            console.log('parsed"');
            console.log(parsed);
            resolve(parsed.hits);
        });
    });

    req.on('error', (e) => {
        console.error(`problem with request: ${e.message}`);
    });

    req.write(body);
    req.end();
});

// response model
const mapElasticSearchGame = (_game) => {
    const game = _game._source;
    return {
        id: game.gameId,
        ...game
    }
}

const mapBlogPost = (post, includeContent) => {
    const mapped = {
        id: post.id,
        publishedBy: post.publishedBy,
        created: post.created,
        title: post.title || ''
    }
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

const listGames = (limit = 6, offset = 0, sort = DEFAULT_GAME_ORDER, query = null, tags = []) => new Promise((resolve, reject) => {
//    if (gamesCache.timestamp && gamesCache.timestamp > Date.now() - (1 * 1000 * 60)) { //1 min
//        resolve(gamesCache.pages);
//    } else {
        if (query) {
            console.log('limit,fdsf ' + offset + ", " + limit);
            search([ELASTICSEARCH_GAME_INDEX], query, Math.max(0, offset), limit).then((results) => {
                console.log("RUERUESLUE");
                console.log(results);
                const totalResults = results.total.value;
                const pageCount = Math.ceil(totalResults / limit);
                resolve({
                    games: results.hits.map(h => mapElasticSearchGame(h)),
                    pageCount,
                    total: totalResults,
                });

            });
        } else { 
            console.log('sdjkfsdjkfh ' + limit);
            console.log(ELASTICSEARCH_GAME_INDEX);
            getIndexData([ELASTICSEARCH_GAME_INDEX], limit, offset).then((results) => {
                if (!results) {
                    resolve({ games: [], pageCount: 0 });
                } else {
                    console.log('got results');
                    console.log(results.total);
                    const totalResults = results.total.value;
//                    const currentPage = Math.floor(offset / limit);
                    const pageCount = Math.ceil(totalResults / limit);
//                    console.log(results.hits.map(f => f._source));
                    
                    resolve({
                        games: results.hits.map(h => mapElasticSearchGame(h)),
                        pageCount,
                        total: totalResults
                    });
                }
            });
        }
//    }
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

const adminPublishRequestAction = (requestId, action, message) => new Promise((resolve, reject) => {
    console.log('huh');
    console.log(requestId);
    console.log(action);
    console.log(message);
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
            publishRequests.updateOne({ requestId }, { "$set": { 'status': newStatus, adminMessage: message } }).catch(reject).then(() => resolve(gameId));
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
const adminListSupportMessagesRegex = '/admin/support_messages';
const adminAckRegex = '/admin/acknowledge';
const adminListPendingPublishRequestsRegex = '/admin/publish_requests';
const adminListFailedPublishRequestsRegex = '/admin/publish_requests/failed';
const assetsListRegex = '/assets';
const verifyPublishRequestRegex = '/verify_publish_request';
const listGamesRegex = '/games';
const listMyGamesRegex = '/my-games';
const podcastRegex = '/podcast';
const linkRegex = '/link';
const ipRegex = '/ip';
const servicesRegex = '/services';
const serviceRequestsRegex = '/service_requests/(\\S*)';
const loginRegex = '/auth/login';
const signupRegex = '/auth/signup';
const createBlogRegex = '/admin/blog';
const blogRegex = '/blog';
const blogDetailRegex = '/blog/(\\S*)';
const githubLinkRegex = '/github_link';

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
const certRequestRegex = '/request-cert';
const certStatusRegex = '/cert-status';
const assetsRegex = '/assets/(\\S*)';

const publishRequestMessage = (userId, gameId, assetId, requestId) => new Promise((resolve, reject) => {
    amqp.connect('amqp://localhost', (err, conn) => {
        console.log('erererer');
        console.log(err);
        console.log(conn);
        conn.createChannel((err1, channel) => {
            console.log('created channel');
            channel.assertQueue('publish_requests', {
                durable: false
            });

            channel.sendToQueue('homegames-jobs', Buffer.from(JSON.stringify({ type: 'PUBLISH_REQUEST', userId, gameId, assetId, requestId })));
            console.log('sent message');
            resolve();
        });
    });
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

const submitPublishRequest = (userId, gameId, fields, files) => new Promise((resolve, reject) => {
    const file = files.file?.[0];
    console.log("FIELS!");
    console.log(files);
    if (file.size > 2 * 1000 * 1000) {
        // accept 2mb max
        reject('too big');
    } else {
        console.log("need to put in doc");
        console.log('and send message');
        const assetId = generateId();

        createPublishRequestRecord(userId, assetId, gameId).then((requestRecord) => {
            const requestId = requestRecord.requestId;
            createAssetRecord(userId, assetId, file.size, `publish_request_${requestId}.zip`, {}).then((assetRecord) => {
                console.log('asset record ' );
                console.log(assetRecord);
                console.log('ofofofof');
                console.log(file);
                getMongoCollection('documents').then(documentCollection => {
                    documentCollection.insertOne({ developerId: userId, assetId, data: new Binary(fs.readFileSync(file)), fileSize: file.size, fileType: 'application/zip' }).then(() => {
                        publishRequestMessage(userId, gameId, assetId, requestId).then(resolve({ requestId })).catch(reject);
                    }).catch(reject);
                });
            });
        });
    }
});

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
        console.log('this is cert record');
        console.log(certRecord);
        if (certRecord) {
            body.certFound = true;
            body.certExpiration = certRecord.expiresAt;
            resolve(body);
        } else {
            resolve(body);
        }
    });
});

const getDnsRecord = (publicIp) => new Promise((resolve, reject) => {
    const name = `${getUserHash(publicIp)}.homegames.link`;
    const params = {
        HostedZoneId: AWS_ROUTE_53_HOSTED_ZONE_ID,
        StartRecordName: name,
        StartRecordType: 'A'
    };

    const aws = require('aws-sdk');

    const route53 = new aws.Route53();
    route53.listResourceRecordSets(params, (err, data) => {
        console.log('dsfkjhdshfjkdshfkdjs!!!');
        console.log(params);
        console.log(err);
        console.log(data);
        if (err) {
            console.error('error listing record sets');
            console.error(err);
            reject(err);
        } else {
            let found = false;
            for (const i in data.ResourceRecordSets) {
                const entry = data.ResourceRecordSets[i];
                if (entry.Name === name + '.') {
                    found = true;
                    resolve(entry.ResourceRecords[0].Value);
                }
            }
            if (!found) {
                resolve(null);
            }
        }
    });

});

const zipCert = (certData) => new Promise((resolve, reject) => {
    const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
    });
    
    const bufs = [];
    archive.on('data', (buf) => {
        bufs.push(buf);
    });

    archive.on('end', () => {
        const totalBuf = Buffer.from(Buffer.concat(bufs));
        resolve(totalBuf.toString('base64'));
    });

    archive.append(certData.key, { name: 'hg-certs/homegames.key' });

    archive.finalize();

});

const handleCertRequest = (publicIp) => new Promise((resolve, reject) => {
    if (!CERTS_ENABLED) {
        reject('Certs not available in this environment');
    } else {
        getCertStatus(publicIp).then(certInfo => {
            if (certInfo.certData && certInfo.certExpiration && certInfo.certExpiration > Date.now()) {
                reject('A valid cert has already been created for this IP (' + publicIp + ').  If you do not have access to your private key, reach out to support@homegames.io to generate a new one');
            } else {
                amqp.connect(`amqp://${QUEUE_HOST}`, (err, conn) => {
                    if (err) {
                        reject(err);
                    } else {
                        conn.createChannel((err1, channel) => {
                            if (err1) {
                                reject(err1);
                            } else {
                                console.log('created channel');
                                channel.assertQueue('homegames-jobs', {
                                    durable: false
                                });
                                acme.crypto.createPrivateKey().then(key => {
                                    const requestId = generateId();
                                    acme.crypto.createCsr({
                                        commonName: getUserHash(publicIp) + '.homegames.link'
                                    }).then(([certKey, certCsr]) => {
                                        console.log('ddddd');
                                        channel.sendToQueue('homegames-jobs', Buffer.from(JSON.stringify({ type: 'CERT_REQUEST', ip: publicIp, key, cert: certCsr })));
                                        console.log('sent message');
                                        console.log('this is key');
                                        console.log(certKey.toString());
                                        resolve({ key: certKey.toString() });
                                    });
                                });
                            }
                        });
                    }
                });
            }
        });
    }
});

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

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
                        updateProfileInfo(userId, body).then(() => {
                            res.writeHead(200, {
                                'Content-Type': 'application/json'
                            });
                            res.end('{}');
                        });
                    });
                }
            },
            [verifyDnsRegex]: {
                handle: () => {
                    res.end('ok');
                }
            },
            [adminAckRegex]: {
                requiresAuth: true,
                handle: (userId) => {
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
                }
            }, 
            [certRequestRegex]: {
                handle: () => {
                    console.log('need to request a cert');
                    handleCertRequest(requesterIp).then(response => {
                        const zippedB64 = zipCert(response);
                        zipCert(response).then((zippedB64) => {
                            res.writeHead(200, {
                                'Content-Type': 'application/octet-stream'
                            });
                            res.end(zippedB64);
                        });
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
                                res.end(err?.toString() || 'Error. Contact @homegamesio on twitter for support')
                            }
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
                            if (!fields.name || !fields.name.length || !fields.description || !fields.description.length || !files) {
                                res.end('creation requires name & description');
                            } else {
                                const gameId = generateId();

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
//                                    if (files.thumbnail?.length) {
//                                        console.log('need to do something with thumbnail');

//                                        createGameImagePublishRequest(userId, image, gameId);
    
                                        //uploadThumbnail(userId, gameId, files.thumbnail[0]).then((url) => {
                                        //}).catch(err => {
                                        //    console.log('failed to upload thumbnail');
                                        //    console.error(err);
                                        //});
//                                    }
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
                                    const description = fields?.description?.[0] || '';
                                    createAssetRecord(userId, assetId, f.size, f.originalFilename, {
                                        'Content-Type': f.headers['content-type']
                                    }, description).then(() => {
                                        uploadMongo(userId, assetId, f.path, f.originalFilename, f.size, f.headers['content-type']).then((assetId) => {
                                            
                                            res.writeHead(200, {
                                                'Content-Type': 'application/json'
                                            });
                                            res.end(JSON.stringify({
                                                assetId
                                            }));
                                        });
                                    });
                                }
                            });
                        }
                    });
                }

            },
            [gamePublishRegex]: {
                requiresAuth: true,
                handle: (userId, gameId) => {
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
                                });
                            } else {
                                res.writeHead(400);
                                res.end('Unknown type');
                            }
                        }
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
                                if (userId != game.developerId) {
                                    res.writeHead(400, {
                                        'Content-Type': 'text/plain'
                                    });
                                    res.end('You cannot modify a game that you didnt create');
                                } else {
                                    if (data.description != game.description) {
                                        updateGame(gameId, {description: data.description}).then((_game) => {
                                            res.end(JSON.stringify(_game));
                                        });
                                    } else {
                                        getGame(gameId).then((_game) => {
                                            res.end(JSON.stringify(_game));
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
                            res.writeHead(400, {
                                'Content-Type': 'text/plain'
                            });
                            res.end('No valid changes');
                        }
                    });
                }
            },
            [servicesRegex]: {
                handle: () => {
                    const requesterIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
                    console.log('requester ip ' + requesterIp);
                    
                    const supportedModels = {
                        'mistral-7b-instruct-v0.2': {
                            // not sure what to put here (if anything) yet. maybe model-specific config / safeguards
                        }
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

                    getReqBody(req, (_data) => {
                        const data = JSON.parse(_data);
                        const validationErr = validateServiceRequest(data);
                        if (validationErr) {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: validationErr } )); 
                        } else {
                            submitContentRequest(data, requesterIp).then(requestId => {
                                res.end(JSON.stringify({requestId}));
                            }).catch(err => {
                                console.error(err);
                                res.writeHead(400);
                                res.end(JSON.stringify(err));
                            });
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
                            updatePublishRequestState(requestId, requestData.game_id, requestData.source_info_hash, 'PENDING_PUBLISH_APPROVAL').then(() => {
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
            [createBlogRegex]: {
                requiresAuth: true,
                handle: (userId, a, b) => {
                    getUserRecord(userId).then(userData => {
                        if (!userData.isAdmin) {
                            res.writeHead(401);
                            res.end('Not an admin');
                        } else {
                            getReqBody(req, (_data) => {
                                createBlogPost(userId, JSON.parse(_data)).then(() => {
                                    res.writeHead(200, {
                                        'Content-Type': 'application/json'
                                    });
                                    res.end(_data);
                                });
                            });
                        }
                    });
                }
            },
            [signupRegex]: {
                handle: () => {
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
                }
            },
            [loginRegex]: {
                handle: () => {
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
                                res.writeHead(200, {
                                    'Content-Type': 'application/json'
                                });
                                res.end(JSON.stringify(tokenPayload));
                            });
                        }

                    });
                }
            },
            [requestActionRegex]: {
                requiresAuth: true,
                handle: (userId, requestId) => {
                    getUserRecord(userId).then(userData => {
                        if (userData.isAdmin) {
                            getReqBody(req, (_data) => {
                                const reqBody = JSON.parse(_data);
                                if (reqBody.action) {
                                    adminPublishRequestAction(requestId, reqBody.action, reqBody.message).then((gameId) => {

                                        if (reqBody.action === 'approve') {
                                            updateGameIndex(gameId).then(() => {
                                            });
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
            [certStatusRegex]: {
                handle: () => {
                    getCertStatus(requesterIp).then((certStatus) => {
                        console.log('cert status');
                        console.log(certStatus);
                        const body = certStatus;
                        getDnsRecord(requesterIp).then((dnsRecord) => {   
                            console.log('this is the dns record');
                            console.log(dnsRecord);
                            res.writeHead(200, {
                                'Content-Type': 'application/json'
                            }); 
                            body.dnsAlias = dnsRecord;
                            res.end(JSON.stringify(body));
                        });
                    });
                }
            },
            [assetsRegex]: {
                handle: (assetId) => {
                    getMongoAsset(assetId).then((assetData) => {
                        if (!assetData) {
                            res.writeHead(404);
                            res.end('Asset not found');
                        } else {
                            getMongoDocument(assetId).then((documentData) => {
                                if (documentData) {
                                    res.writeHead(200, {
                                        'Content-Disposition': `inline; filename=${assetData.name}`,
                                    });
                                    res.end(documentData.data.buffer);
                                } else {
                                    res.writeHead(404);
                                    res.end();
                                }
                            });
                        }
                    });
                }
            },
            [blogRegex]: {
                handle: () => {
                    const queryObject = url.parse(req.url, true).query;
                    const { limit, offset, sort, query, includeMostRecent } = queryObject;
 
                    listBlogPosts(limit || 1, offset || 0, sort || '', query || '', includeMostRecent === 'true').then((blogPosts) => {
                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });
                        res.end(JSON.stringify(blogPosts));
                    });
                }
            },
            [blogDetailRegex]: {
                handle: (blogId) => {
                    getBlogPost(blogId).then((blogPost) => {
                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });
                        res.end(JSON.stringify(blogPost));
                    }).catch(err => {
                        res.writeHead(500);
                        res.end(JSON.stringify({error: err}));
                    });
                }
            },

            [githubLinkRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    res.end('ayo');
                }
            },
            [podcastRegex]: {
                handle: () => {
                    const queryObject = url.parse(req.url, true).query;
                    const { limit, offset, sort } = queryObject;
                    getPodcastData(Number(offset || 0), Number(limit || 20), sort || 'desc').then(podcastData => {
                        res.end(JSON.stringify(podcastData));
                    });
                }
            },
            [serviceRequestsRegex]: {
                handle: (requestId) => {
                    const readClient = new aws.DynamoDB.DocumentClient({
                        region: 'us-west-2'
                    });

                    const params = {
                        TableName: 'content-requests',
                        ScanIndexForward: false,
                        Limit: 1,
                        KeyConditionExpression: '#request_id = :request_id',
                        ExpressionAttributeNames: {
                            '#request_id': 'request_id',
                        },
                        ExpressionAttributeValues: {
                            ':request_id': requestId
                        }
                    };

                    readClient.query(params, (err, results) => {
                        if (err) {
                            console.log(err);
                            res.end(err.toString());
                        } else {
                            if (results.Items.length) {
                                const response = {
                                    response: results.Items[0].response ? JSON.parse(results.Items[0].response) : null,
                                    createdAt: results.Items[0].created_at,
                                    requestId
                                };
                                res.end(JSON.stringify(response));
                            } else {
                                res.end("{}");
                            }
                        }
                    });
 
                }
            },
            [listMyGamesRegex]: {
                requiresAuth: true,
                handle: (userId) => {
                    const queryObject = url.parse(req.url, true).query;
                    let { query, offset, limit } = queryObject;
                    if (!offset) {
                        offset = 0;
                    }
                    if (!limit) {
                        limit = 10;
                    }
                    listMyGames(userId, limit, offset, query).then(results => {
                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });
                        res.end(JSON.stringify(
                            results
                        )); 
                    });
                }
            }, 
            [listGamesRegex]: {
                handle: () => {
                    const queryObject = url.parse(req.url, true).query;
                    let { query, author, offset, limit } = queryObject;
                    if (!offset) {
                        offset = 0;
                    }
                    if (!limit) {
                        limit = 10;
                    }
                    if (author) {
                        listPublicGamesForAuthor({ author, offset, limit }).then((data) => {
                            res.writeHead(200, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify(data));

                        }).catch(err => {
                            console.log('unable to list games for author');
                            console.log(err);
                            res.end('error');
                        });
                    } else {
                        listGames(limit, offset, null, query).then(results => {
                            res.writeHead(200, {
                                'Content-Type': 'application/json'
                            });
                            res.end(JSON.stringify(results));
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
                    const requesterIp = "::1";//headers['x-forwarded-for'] || req.connection.remoteAddress;
                    console.log(req.connection.remoteAddress);
                    console.log('requester ip');
                    console.log(requesterIp);
                    console.log(headers);
                    res.end(requesterIp);
                }
            },
            [linkRegex]: {
                handle: () => {
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
                                updatePublishRequestState(requestId, publishRequest.game_id, publishRequest.source_info_hash, 'CONFIRMED').then(() => {
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
                    const queryObject = url.parse(req.url, true).query;
                    let { limit, offset, sort, query } = queryObject; 
                    if (!offset) {
                        offset = 0;
                    }
                    if (!limit || limit > 100) {
                        limit = 10;
                    }
                    listAssets(userId, query, limit, offset).then(_assets => {
                        const { assets, count } = _assets;
                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });

                        res.end(JSON.stringify({
                            assets: assets.map(assetResponse),
                            count
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
                    getProfileInfo(userId).then(data => {
                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });
                        res.end(JSON.stringify(data));
                    });
                },
                requiresAuth: true
            },
            [publishRequestsRegex]: {
                handle: (userId, gameId) => {
                    listPublishRequests(gameId).then((publishRequests) => {
                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });
                        res.end(JSON.stringify(publishRequests));
                    });
                },
                requiresAuth: true  
            },
            [adminListSupportMessagesRegex]: {
                requiresAuth: true,
                handle: (userId) => {
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
                }

            },
            [adminListPendingPublishRequestsRegex]: {
                requiresAuth: true,
                handle: (userId) => {
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
                }
            },
            [adminListFailedPublishRequestsRegex]: {
                requiresAuth: true,
                handle: (userId) => {
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
        console.log('dsfsdf');
        res.writeHead(200);
        res.end();
    } else if (!requestHandlers[req.method]) {
        res.writeHead(400);
        res.end('Unsupported method: ' + req.method);
    } else {
        console.log('asduoa ' +req.method + " - "  + req.url);
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
                    const authHeader = req.headers.authorization;
    
                    if (!authHeader) {
                        res.end('API requires authorization');
                    } else {
                        verifyToken(authHeader).then((userInfo) => {
                            handlerInfo.handle(userInfo.userId, ...matchedParams);
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
                verifyToken(message.username, message.accessToken).then(() => {
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

server.listen(process.env.PORT || 80);
