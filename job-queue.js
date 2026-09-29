'use strict';
// Shared confirmed publisher for the three self-hosted worker job types.
const publishWorkerJob = async (type, data) => {
    const amqp = require('amqplib');
    const { QUEUE_URL, CERT_QUEUE_NAME, LLM_QUEUE_NAME, DOCS_QUEUE_NAME } = require('./config');
    const queues = { CERT_REQUEST: CERT_QUEUE_NAME, LLM_REQUEST: LLM_QUEUE_NAME, DOCS_QUESTION: DOCS_QUEUE_NAME };
    if (!queues[type]) throw new Error('Unknown worker job type');
    const connection = await amqp.connect(QUEUE_URL, { timeout: 10000 });
    let timer, rejectFailure;
    const failure = new Promise((_, reject) => { rejectFailure = reject; });
    connection.on('error', rejectFailure);
    connection.on('close', () => rejectFailure(new Error('Queue connection closed before confirmation')));
    try {
        const send = (async () => {
            const channel = await connection.createConfirmChannel();
            channel.on('error', rejectFailure);
            channel.on('close', () => rejectFailure(new Error('Queue channel closed before confirmation')));
            await channel.assertQueue(queues[type], { durable: true });
            await new Promise((resolve, reject) => channel.sendToQueue(queues[type], Buffer.from(JSON.stringify({ ...data, type })),
                { persistent: true, messageId: data.requestId }, err => err ? reject(err) : resolve()));
        })();
        timer = setTimeout(() => rejectFailure(new Error('Queue confirmation timed out')), 15000);
        await Promise.race([send, failure]);
    } finally { clearTimeout(timer); await connection.close().catch(() => {}); }
};
module.exports = { publishWorkerJob };
