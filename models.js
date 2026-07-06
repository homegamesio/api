const mapElasticSearchGame = (_game) => {
    const game = _game._source;
    return {
        id: game.gameId,
        ...game
    };
};

const mapBlogPost = (post, includeContent) => {
    const mapped = {
        id: post.id,
        publishedBy: post.publishedBy,
        created: post.created,
        title: post.title || ''
    };
    if (includeContent) {
        mapped.content = post.content;
    }
    return mapped;
};

const mapMongoGame = (game) => {
    return {
        id: game.gameId,
        gameId: game.gameId,
        description: game.description || '',
        name: game.name || '',
        developerId: game.developerId,
        created: game.created,
        thumbnail: game.thumbnail,
        nsfw: !!game.nsfw,
    };
};

const mapGame = (game) => {
    return {
        createdBy: game.created_by && game.created_by.S ? game.created_by.S : game.created_by,
        createdAt: game.created_on && game.created_on.N ? game.created_on.N : game.created_on,
        id: game.game_id && game.game_id.S ? game.game_id.S : game.game_id,
        thumbnail: game.thumbnail && game.thumbnail.S ? game.thumbnail.S : game.thumbnail,
        name: game.name && game.name.S ? game.name.S : game.name,
        description: game.description && game.description.S ? game.description.S : game.description
    };
};

const inferAssetType = (contentType) => {
    if (!contentType) return 'other';
    const ct = String(contentType).toLowerCase();
    if (ct.startsWith('image/')) return 'image';
    if (ct.startsWith('audio/')) return 'audio';
    if (ct.startsWith('font/') || ct.includes('font')) return 'font';
    return 'other';
};

const assetResponse = (asset) => {
    const contentType = asset.metadata?.['Content-Type'] || null;
    return {
        id: asset.assetId,
        developerId: asset.developerId,
        name: asset.name,
        created: asset.created,
        description: asset.description || '',
        size: asset.size,
        type: contentType,
        assetType: asset.assetType || inferAssetType(contentType),
        public: !!asset.public,
        tags: asset.tags || [],
        nsfw: !!asset.nsfw,
    };
};

const transformS3Response = (s3Content) => {
    const episodeEntryRegex = new RegExp('episode_(\\d+)\.mp3|\.mp4$');
    const transformed = {};
    s3Content.filter(e => episodeEntryRegex.exec(e.Key)).forEach(e => {
        const baseKey = e.Key.substring(0, e.Key.length - 4);
        const ret = {
            key: baseKey
        };

        if (!transformed[baseKey]) {
            transformed[baseKey] = {
                episode: Number(episodeEntryRegex.exec(e.Key)[1])
            };
        }

        if (e.Key.endsWith('.mp3')) {
            transformed[baseKey].audio = `https://podcast.homegames.io/${e.Key}`;
        } else if (e.Key.endsWith('.mp4')) {
            transformed[baseKey].video = `https://podcast.homegames.io/${e.Key}`;
        }
    });

    const sortedKeys = Object.keys(transformed).sort((a, b) => {
        return transformed[a].episode - transformed[b].episode;
    });

    const retList = sortedKeys.map(k => {
        return transformed[k];
    });

    return retList;
};

module.exports = {
    mapElasticSearchGame,
    mapBlogPost,
    mapMongoGame,
    mapGame,
    inferAssetType,
    assetResponse,
    transformS3Response,
};
