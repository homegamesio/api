const crypto = require('crypto');
const { AUTH_TYPE } = require('./config');
const { generateJwt, hashPassword } = require('./crypto');
const { getMongoCollection } = require('./db');

const login = (request) => new Promise((resolve, reject) => {
    const { username, password } = request;

    const client = require('./db').getMongoClient();
    const { DB_NAME } = require('./config');
    client.connect().then(() => {
        const db = client.db(DB_NAME);
        const collection = db.collection('users');
        collection.findOne({ userId: username }).then((usernameResponse) => {
            if (usernameResponse == null) {
                reject('user doesnt exist');
            } else {
                const passwordSalt = usernameResponse.passwordSalt;
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
                }).catch(reject);
            }
        }).catch(reject);
    }).catch(reject);
});

const mongoSignup = (userId, password) => new Promise((resolve, reject) => {
    const client = require('./db').getMongoClient();
    const { DB_NAME } = require('./config');
    client.connect().then(() => {
        const db = client.db(DB_NAME);
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
    }).catch(reject);
});

const signup = (request) => new Promise((resolve, reject) => {
    const { username, password } = request;
    if (!username || !password) {
        reject('signup requires username & password');
    } else {
        if (AUTH_TYPE === 'mongo') {
            mongoSignup(username, password).then(resolve).catch((err) => {
                reject(err);
            });
        }
    }
});

module.exports = {
    login,
    mongoSignup,
    signup,
};
