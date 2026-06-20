const https = require('https');
const fs = require('fs');
const archiver = require('archiver');
const acme = require('acme-client');
const { Binary } = require('mongodb');
const amqp = require('amqplib/callback_api');
const { CERT_DOMAIN, CERTS_ENABLED, QUEUE_HOST, JOB_QUEUE_NAME, AWS_ROUTE_53_HOSTED_ZONE_ID } = require('./config');
const { generateId, getHash } = require('./crypto');
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

const submitPublishRequest = (userId, gameId, fields, files) => new Promise((resolve, reject) => {
    const file = files.file?.[0];
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
    const name = `${getHash(publicIp)}.${CERT_DOMAIN}`;
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

// The client generates the cert keypair locally and sends us only the CSR
// (public key) — the TLS private key never leaves the client. We still generate
// the ACME *account* key here (it only authenticates to Let's Encrypt; it is not
// the cert's key) and hand it to the worker along with the client's CSR.
const handleCertRequest = (publicIp, csr) => new Promise((resolve, reject) => {
    if (!CERTS_ENABLED) {
        reject('Certs not available in this environment');
    } else if (!csr) {
        reject('Missing CSR');
    } else {
        // SECURITY: the requester picks the CSR's common name, but a network may
        // only obtain a cert for the subdomain bound to its (trusted) source IP.
        // Reject any CSR whose CN doesn't match, otherwise a client could request
        // a valid cert for another network's subdomain.
        const expectedCommonName = `${getHash(publicIp)}.${CERT_DOMAIN}`;
        let csrCommonName;
        try {
            csrCommonName = acme.crypto.readCsrDomains(csr).commonName;
        } catch (parseErr) {
            return reject('Invalid CSR');
        }
        if (csrCommonName !== expectedCommonName) {
            return reject(`CSR common name (${csrCommonName}) does not match the domain assigned to this network (${expectedCommonName})`);
        }

        getCertStatus(publicIp).then(certInfo => {
            if (certInfo.cert && certInfo.certExpiration && certInfo.certExpiration > Date.now()) {
                reject('A valid cert has already been created for this IP (' + publicIp + ').');
            } else {
                amqp.connect(`amqp://${QUEUE_HOST}`, (err, conn) => {
                    if (err) {
                        reject(err);
                    } else {
                        conn.createChannel((err1, channel) => {
                            if (err1) {
                                // Close the connection so a channel-creation failure
                                // doesn't leak it.
                                conn.close();
                                reject(err1);
                            } else {
                                channel.assertQueue(JOB_QUEUE_NAME, {
                                    durable: true
                                });
                                acme.crypto.createPrivateKey().then(key => {
                                    // Queue the CSR as a Buffer so it serializes to the
                                    // same {type:'Buffer',data:[...]} shape the worker
                                    // already reads via data.cert.data.
                                    channel.sendToQueue(JOB_QUEUE_NAME, Buffer.from(JSON.stringify({ type: 'CERT_REQUEST', ip: publicIp, key, cert: Buffer.from(csr) })), { persistent: true });
                                    // Gracefully close the channel (the close
                                    // handshake flushes the publish frame) then the
                                    // connection, so we don't leak one per request.
                                    channel.close(() => {
                                        conn.close();
                                        resolve({ submitted: true });
                                    });
                                }).catch(acmeErr => {
                                    // ACME account-key generation failed — close the
                                    // connection and reject instead of hanging + leaking.
                                    conn.close();
                                    reject(acmeErr);
                                });
                            }
                        });
                    }
                });
            }
        });
    }
});

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
    submitPublishRequest,
    getDnsRecord,
    deleteDnsRecord,
    createDnsRecord,
    zipCert,
    handleCertRequest,
    generateSocketId,
    logSuccess,
    logFailure,
    validateServiceRequest,
};
