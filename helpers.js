const https = require('https');
const fs = require('fs');
const archiver = require('archiver');
const acme = require('acme-client');
const redis = require('redis');
const geoip = require('geoip-lite');
const { getUserHash } = require('homegames-common');
const { Binary } = require('mongodb');
const amqp = require('amqplib/callback_api');
const { CERT_DOMAIN, CERTS_ENABLED, QUEUE_HOST, JOB_QUEUE_NAME, AWS_ROUTE_53_HOSTED_ZONE_ID } = require('./config');
const { generateId } = require('./crypto');
const { getMongoCollection, createAssetRecord, getCertStatus } = require('./db');
const { publishRequestMessage } = require('./queue');

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

const getPublicIp = (req) => {
    const connection = req && req.connection;
    const socket = req && req.socket;
    return req.ip || connection && connection.remoteAddress || socket && socket.remoteAddress || null;
};

const downloadZip = (url) =>
  new Promise((resolve, reject) => {
    const outDir = `/tmp/${Date.now()}`;
    fs.mkdirSync(outDir);
    const zipPath = `${outDir}/data.zip`;

    const zipWriteStream = fs.createWriteStream(zipPath);

    zipWriteStream.on('close', () => {
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
    downloadZip(thing).then(resolve).catch(reject);
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
        const { createPublishRequestRecord } = require('./db');

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

const getDnsRecord = (publicIp) => new Promise((resolve, reject) => {
    const name = `${getUserHash(publicIp)}.${CERT_DOMAIN}`;
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

const deleteDnsRecord = (name) => new Promise((resolve, reject) => {
    getDnsRecord(name).then((value) => {
        const deleteDnsParams = {
            ChangeBatch: {
                Changes: [
                    {
                        Action: 'DELETE',
                        ResourceRecordSet: {
                            Name: name,
                            Type: 'TXT',
                            TTL: 300,
                            ResourceRecords: [
                                {
                                    Value: value,
                                }
                            ]
                        }
                    }
                ]
            },
            HostedZoneId: AWS_ROUTE_53_HOSTED_ZONE_ID
        };

        const aws = require('aws-sdk');
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
    }).catch(reject);
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

    const aws = require('aws-sdk');
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

const zipCert = (certData) => new Promise((resolve, reject) => {
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    const bufs = [];
    archive.on('data', (buf) => {
        bufs.push(buf);
    });

    archive.on('end', () => {
        const totalBuf = Buffer.from(Buffer.concat(bufs));
        resolve(totalBuf.toString('base64'));
    });

    archive.append(certData.key, { name: 'homegames.key' });

    archive.finalize();
});

const handleCertRequest = (publicIp) => new Promise((resolve, reject) => {
    if (!CERTS_ENABLED) {
        reject('Certs not available in this environment');
    } else {
        getCertStatus(publicIp).then(certInfo => {
            if (certInfo.cert && certInfo.certExpiration && certInfo.certExpiration > Date.now()) {
                reject('A valid cert has already been created for this IP (' + publicIp + ').  If you do not have access to your private key, contact us to generate a new one');
            } else {
                amqp.connect(`amqp://${QUEUE_HOST}`, (err, conn) => {
                    if (err) {
                        reject(err);
                    } else {
                        conn.createChannel((err1, channel) => {
                            if (err1) {
                                reject(err1);
                            } else {
                                channel.assertQueue(JOB_QUEUE_NAME, {
                                    durable: true
                                });
                                acme.crypto.createPrivateKey().then(key => {
                                    const requestId = generateId();
                                    acme.crypto.createCsr({
                                        commonName: `${getUserHash(publicIp)}.${CERT_DOMAIN}`
                                    }).then(([certKey, certCsr]) => {
                                        channel.sendToQueue(JOB_QUEUE_NAME, Buffer.from(JSON.stringify({ type: 'CERT_REQUEST', ip: publicIp, key, cert: certCsr })), { persistent: true });
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

const updateCachedMap = (CENTROIDS) => new Promise((resolve, reject) => {
    const redisClient = redis.createClient();
    const finalList = [];
    const countryMap = {};
    redisClient.on('connect', () => {
        redisClient.keys('*', (err, keys) => {
            let i = 0;
            const ting = () => {
                if (i < keys.length) {
                    const key = keys[i];
                    redisClient.get(key, (err, _data) => {
                        const data = JSON.parse(_data);
                        if (data.country && CENTROIDS[data.country]) {
                            if (!countryMap[data.country]) {
                                countryMap[data.country] = {
                                    total: 0,
                                    centroid: CENTROIDS[data.country]
                                };
                            }
                            countryMap[data.country].total = countryMap[data.country].total + 1;
                        }
                        i++;
                        ting();
                    });
                } else {
                    const entries = [];
                    for (let k in countryMap) {
                        entries.push({ centroid: countryMap[k].centroid, total: countryMap[k].total });
                    }
                    redisClient.end(true);
                    resolve(entries);
                }
            };
            ting();
        });
    });
});

const getCountryByIp = (ip) => {
    const geo = geoip.lookup(ip);
    if (geo && geo.country) {
        return geo.country;
    }
    return null;
};

const generateSocketId = () => {
    const { v4: uuidv4 } = require('uuid');
    return uuidv4();
};

const logSuccess = (funcName) => {
    console.error(`function ${funcName} succeeded`);
};

const logFailure = (funcName) => {
    console.error(`function ${funcName} failed`);
};

const getPodcastData = (() => {
    let s3Cache;

    const fillS3Cache = () => new Promise((resolve, reject) => {
        const aws = require('aws-sdk');
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
                    waitUntilDone(data.continuationToken).then(resolve).catch(reject);
                } else {
                    resolve();
                }
            }).catch(err => {
                console.error(err);
                reject(err);
            });
        });

        const { transformS3Response } = require('./models');
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

    return (offset = 0, limit = 20, sort = 'desc') => new Promise((resolve, reject) => {
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
})();

// Service request validation
const supportedModels = {
    'mistral-7b-v0.2': {}
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

module.exports = {
    getReqBody,
    getPublicIp,
    downloadZip,
    downloadFromGithub,
    submitPublishRequest,
    getDnsRecord,
    deleteDnsRecord,
    createDnsRecord,
    zipCert,
    handleCertRequest,
    updateCachedMap,
    getCountryByIp,
    generateSocketId,
    logSuccess,
    logFailure,
    getPodcastData,
    validateServiceRequest,
};
