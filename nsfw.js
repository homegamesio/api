const tf = require('@tensorflow/tfjs-node');
const nsfw = require('nsfwjs');
const sharp = require('sharp');

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
    // Convert any supported image format to raw PNG for tfjs compatibility
    const pngBuffer = await sharp(buffer).png().toBuffer();
    const image = tf.node.decodeImage(pngBuffer, 3);
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
