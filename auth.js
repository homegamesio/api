const crypto = require('crypto');
const { AUTH_TYPE } = require('./config');
const { generateJwt, hashPassword } = require('./crypto');
const { getMongoCollection } = require('./db');
const { createForgejoUser } = require('./forgejo');

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
    console.log('adfjksdf');
    const client = require('./db').getMongoClient();
    const { DB_NAME } = require('./config');
    console.log('sdnjkfsdkjf');
    client.connect().then(() => {
        const db = client.db(DB_NAME);
        const collection = db.collection('users');
        collection.findOne({ userId }).then((userResponse) => {
            if (userResponse == null) {
                const passwordSalt = crypto.randomBytes(16).toString('hex');
                hashPassword(password, passwordSalt).then((passwordHash) => {
                    const finishSignup = (forgejoAccountCreated) => {
                        collection.insertOne({
                            userId,
                            passwordHash,
                            passwordSalt,
                            created: Date.now(),
                            forgejoAccountCreated: forgejoAccountCreated || false,
                        }).then(() => {
                            const token = generateJwt(userId);
                            resolve({ userId, token });
                        });
                    };

                    const forgejoEmail = `${userId}@homegames.local`;
                    const forgejoPass = crypto.randomBytes(32).toString('hex');

                    createForgejoUser(userId, forgejoEmail, forgejoPass)
                        .then(() => finishSignup(true))
                        .catch(err => {
                            console.error('Failed to create Forgejo user, continuing without it', err);
                            finishSignup(false);
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
