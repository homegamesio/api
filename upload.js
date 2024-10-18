const fs = require('fs');
const { Binary, MongoClient } = require('mongodb');

const _filePath = process.argv[2].replace('--path=', '');
const _developerId = process.argv[3].replace('--developer=', '');
const _assetId = process.argv[4].replace('--id=', '');
const _fileName = process.argv[5].replace('--name=', '');
const _fileSize = process.argv[6].replace('--size=', '');
const _fileType = process.argv[7].replace('--type=', '');

const uploadMongo = (developerId, assetId, filePath, fileName, fileSize, fileType) => new Promise((resolve, reject) => {
    const uri = 'mongodb://localhost:27017/homegames';
    const client = new MongoClient(uri);
    client.connect().then(() => {
        const db = client.db('homegames');
        const collection = db.collection('asset');
        collection.findOne({ assetId }).then(asset => {
            console.log("found asset to upload");
            console.log(asset);
            const documentCollection = db.collection('document');
            documentCollection.insertOne({ developerId, assetId, data: new Binary(fs.readFileSync(filePath)), fileSize, fileType }).then(resolve);

            const users = db.collection('users');
            users.findOne({ userId: developerId }).then(userProfile => {
                console.log('confirmed person');
                console.log(userProfile);
                users.updateOne({ userId: developerId }, { "$set": { image: assetId } }).then(() => {
                    resolve();
                });

            });
        });
    }); 
});

uploadMongo(_developerId, _assetId, _filePath, _fileName, _fileSize, _fileType);
