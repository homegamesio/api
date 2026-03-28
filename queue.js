const amqp = require('amqplib/callback_api');
const { QUEUE_HOST, JOB_QUEUE_NAME } = require('./config');

const createGameImagePublishRequest = (userId, assetId, gameId) => new Promise((resolve, reject) => {
    console.log('connecting to thing!');
    amqp.connect(`amqp://${QUEUE_HOST}`, (err, conn) => {
        console.log('cocnocncnetc!');
        console.log(err);
        if (err) {
            reject(err);
        } else {
            conn.createChannel((err1, channel) => {
                if (err1) {
                    reject(err1);
                } else {
                    console.log('created channel');
                    channel.assertQueue(JOB_QUEUE_NAME, {
                        durable: true
                    });

                    channel.sendToQueue(JOB_QUEUE_NAME, Buffer.from(JSON.stringify({ type: 'GAME_IMAGE_APPROVAL_REQUEST', userId, assetId, gameId })), { persistent: true });
                    console.log('sent message');
                    resolve();
                }
            });
        }
    });
});

const createContentRequest = (req) => new Promise((resolve, reject) => {
    amqp.connect(`amqp://${QUEUE_HOST}`, (err, conn) => {
        if (err) {
            reject(err);
        } else {
            conn.createChannel((err1, channel) => {
                if (err1) {
                    reject(err1);
                } else {
                    console.log('created channel');
                    channel.assertQueue(JOB_QUEUE_NAME, {
                        durable: true
                    });

                    channel.sendToQueue(JOB_QUEUE_NAME, Buffer.from(JSON.stringify({ type: 'CONTENT_REQUEST', data: req })), { persistent: true });
                    console.log('sent message');
                    resolve();
                }
            });
        }
    });
});

const createProfileImageTask = (userId, assetId) => new Promise((resolve, reject) => {
    amqp.connect(`amqp://${QUEUE_HOST}`, (err, conn) => {
        if (err) {
            reject(err);
        } else {
            conn.createChannel((err1, channel) => {
                if (err1) {
                    reject(err1);
                } else {
                    console.log('created channel');
                    channel.assertQueue(JOB_QUEUE_NAME, {
                        durable: true
                    });

                    channel.sendToQueue(JOB_QUEUE_NAME, Buffer.from(JSON.stringify({ type: 'PROFILE_IMAGE_APPROVAL_REQUEST', userId, assetId })), { persistent: true });
                    console.log('sent message');
                    resolve();
                }
            });
        }
    });
});

const publishRequestMessage = (userId, gameId, assetId, requestId) => new Promise((resolve, reject) => {
    amqp.connect('amqp://localhost', (err, conn) => {
        console.log('erererer');
        console.log(err);
        console.log(conn);
        conn.createChannel((err1, channel) => {
            console.log('created channel');
            channel.assertQueue('publish_requests', {
                durable: true
            });

            channel.sendToQueue(JOB_QUEUE_NAME, Buffer.from(JSON.stringify({ type: 'PUBLISH_REQUEST', userId, gameId, assetId, requestId })), { persistent: true } );
            console.log('sent message');
            resolve();
        });
    });
});

module.exports = {
    createGameImagePublishRequest,
    createContentRequest,
    createProfileImageTask,
    publishRequestMessage,
};
