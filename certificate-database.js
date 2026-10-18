'use strict';
function certificateDatabase(env = process.env) {
    let client;
    return {
        async collection(name) {
            if (!client) {
                const { MongoClient } = require('mongodb');
                client = new MongoClient(env.MONGODB_URI || `mongodb://${env.DB_HOST || 'localhost'}:${env.DB_PORT || 27017}`,
                    { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000,
                        maxPoolSize: 20, waitQueueTimeoutMS: 5000, timeoutMS: 15000,
                        writeConcern: { w: 'majority', wtimeoutMS: 10000 },
                        ...(env.DB_USERNAME ? { auth: { username: env.DB_USERNAME, password: env.DB_PASSWORD || '' }, authSource: env.DB_AUTH_SOURCE || 'admin' } : {}) });
            }
            await client.connect(); return client.db(env.DB_NAME || 'homegames').collection(name);
        },
        async close() { await client?.close(); },
    };
}
module.exports = { certificateDatabase };
