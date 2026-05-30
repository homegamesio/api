const tf = require('@tensorflow/tfjs-node');
const nsfw = require('nsfwjs');

let model = null;

const loadModel = async () => {
    if (!model) {
        model = await nsfw.load();
    }
    return model;
};

// Load model at startup
loadModel().then(() => {
    console.log('[nsfw] Model loaded');
}).catch(err => {
    console.error('[nsfw] Failed to load model:', err);
});

const classifyImage = async (buffer) => {
    const m = await loadModel();
    const image = tf.node.decodeImage(buffer, 3);
    try {
        const predictions = await m.classify(image);
        const nsfwScore = predictions
            .filter(p => p.className === 'Porn' || p.className === 'Hentai' || p.className === 'Sexy')
            .reduce((sum, p) => sum + p.probability, 0);
        return { nsfw: nsfwScore > 0.5, nsfwScore };
    } finally {
        image.dispose();
    }
};

module.exports = { classifyImage };
