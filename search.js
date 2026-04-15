const http = require('http');
const { ELASTICSEARCH_HOST, ELASTICSEARCH_PORT, ELASTICSEARCH_GAME_INDEX } = require('./config');
const { mapElasticSearchGame } = require('./models');

const elasticDeleteGame = (gameId) => new Promise((resolve, reject) => {
    const options = {
        hostname: ELASTICSEARCH_HOST,
        port: ELASTICSEARCH_PORT,
        path: `/games/_doc/${gameId}`,
        method: 'DELETE',
        headers: {}
    };

    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            const parsed = JSON.parse(data);
            resolve();
        });
    });

    req.on('error', (e) => {
        console.error(`problem with request: ${e.message}`);
        reject();
    });

    req.write('');
    req.end();
});

const updateGameSearch = (gameData) => new Promise((resolve, reject) => {
    console.log("STRINGIFYING");
    console.log(gameData);
    const body = JSON.stringify(gameData);

    const options = {
        hostname: ELASTICSEARCH_HOST,
        port: ELASTICSEARCH_PORT,
        path: `/games/_doc/${gameData.gameId}`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };

    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            const parsed = JSON.parse(data);
            resolve();
        });
    });

    req.on('error', (e) => {
        console.error(`problem with request: ${e.message}`);
        reject();
    });

    req.write(body);
    req.end();
});

const elasticSearchPost = (path, data) => new Promise((resolve, reject) => {
    const body = JSON.stringify(data);

    const options = {
        hostname: ELASTICSEARCH_HOST,
        port: ELASTICSEARCH_PORT,
        path,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };

    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            const parsed = JSON.parse(data);
            console.log('parsed"');
            console.log(parsed);
            resolve(parsed);
        });
    });

    req.on('error', (e) => {
        console.error(`problem with request: ${e.message}`);
    });

    req.write(body);
    req.end();
});

const search = (indexes, query, offset = 0, limit = 10) => new Promise((resolve, reject) => {
    const body = JSON.stringify({
        from: offset,
        size: limit,
        query: {
            bool: {
                should: [
                    {
                        "multi_match": {
                            "query": query,
                            "fields": ["developerId", "description", "name"],
                            "fuzziness": "AUTO"
                        }
                    },
                    {
                        "wildcard": {
                            "name": {
                                value: `*${query}*`
                            }
                        }
                    },
                    {
                        "wildcard": {
                            "developerId": {
                                value: `*${query}*`
                            }
                        }
                    },
                    {
                        "wildcard": {
                            "description": {
                                value: `*${query}*`
                            }
                        }
                    }
                ]
            }
        }
    });

    const options = {
        hostname: ELASTICSEARCH_HOST,
        port: ELASTICSEARCH_PORT,
        path: `/${indexes}/_search`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };

    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            const parsed = JSON.parse(data);
            console.log('parsed"');
            console.log(parsed);
            resolve(parsed.hits);
        });
    });

    req.on('error', (e) => {
        console.error(`problem with request: ${e.message}`);
    });

    req.write(body);
    req.end();
});

const getIndexData = (indexes, limit, offset) => new Promise((resolve, reject) => {
    const body = JSON.stringify({
        from: offset,
        size: limit
    });

    console.log('hfhfhfhf huh ' + ELASTICSEARCH_HOST + ' ::::: ' + ELASTICSEARCH_PORT);

    console.log('what is indexes ' + indexes);
    try {
        console.log(indexes);
        if (!indexes || !indexes.trim()) {
            indexes = 'games';
        }
    } catch (err) {
        console.warn(err);
    }
    console.log('dsjfkhdksjghdfg' + indexes);
    const options = {
        hostname: ELASTICSEARCH_HOST,
        port: ELASTICSEARCH_PORT,
        path: `/${indexes}/_search`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };

    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            const parsed = JSON.parse(data);
            console.log('parsed"');
            console.log(parsed);
            resolve(parsed.hits);
        });
    });

    req.on('error', (e) => {
        console.error(`problem with request: ${e.message}`);
    });

    req.write(body);
    req.end();
});

const DEFAULT_GAME_ORDER = {
    'game_name': {
        order: 'asc'
    }
};

const listGames = (limit = 6, offset = 0, sort = DEFAULT_GAME_ORDER, query = null, tags = []) => new Promise((resolve, reject) => {
    if (query) {
        search([ELASTICSEARCH_GAME_INDEX], query, Math.max(0, offset), limit).then((results) => {
            const totalResults = results.total.value;
            const pageCount = Math.ceil(totalResults / limit);
            resolve({
                games: results.hits.map(h => mapElasticSearchGame(h)),
                pageCount,
                total: totalResults,
            });
        }).catch(reject);
    } else {
        console.log('sdjkfsdjkfh ' + limit);
        console.log(ELASTICSEARCH_GAME_INDEX);
        getIndexData([ELASTICSEARCH_GAME_INDEX], limit, offset).then((results) => {
            if (!results) {
                resolve({ games: [], pageCount: 0 });
            } else {
                console.log('got results');
                console.log(results.total);
                const totalResults = results.total.value;
                const pageCount = Math.ceil(totalResults / limit);

                resolve({
                    games: results.hits.map(h => mapElasticSearchGame(h)),
                    pageCount,
                    total: totalResults
                });
            }
        }).catch(reject);
    }
});

const listPublicGamesForAuthor = (params) => new Promise((resolve, reject) => {
    console.log('fiufiufiufi elastic');
    console.log(params);
    const offset = params.offset || 0;
    const limit = params.limit || 10;
    const ting = {
        from: offset,
        size: limit,
        query: {
            'multi_match': {
                query: params.author,
                fields: ['developerId']
            }
        }
    };

    console.log('this is ting');
    console.log(JSON.stringify(ting));

    elasticSearchPost('/games/_search', ting).then((results) => {
        console.log("search results!');');");
        console.log(results);
        const totalResults = results.hits.total.value;
        const pageCount = Math.ceil(totalResults / limit);
        resolve({
            total: totalResults,
            games: results.hits.hits.map(h => mapElasticSearchGame(h)),
            pageCount
        });
    }).catch(reject);
});

const updateGameIndex = (gameId, getGame) => new Promise((resolve, reject) => {
    getGame(gameId).then(gameData => {
        console.log('need to post to elasticsearch');
        console.log(gameData);
        const gameBody = {
            id: gameData.id,
            description: gameData.description,
            name: gameData.name,
            created: gameData.created,
            developerId: gameData.developerId,
            thumbnail: gameData.thumbnail
        };
        elasticSearchPost('/games/_doc/' + gameId, gameBody).then(() => {
            resolve();
        }).catch(reject);
    }).catch(reject);
});

module.exports = {
    elasticDeleteGame,
    updateGameSearch,
    elasticSearchPost,
    search,
    getIndexData,
    listGames,
    listPublicGamesForAuthor,
    updateGameIndex,
};
