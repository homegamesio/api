/**
 * Game search / listing — backed by MongoDB.
 *
 * A game appears in public listings only if it has at least one
 * gameVersions record with `published: true`.
 */

const { getMongoCollection } = require('./db');

// ---------------------------------------------------------------------------
// List games (public catalog)
// ---------------------------------------------------------------------------

const listGames = (limit = 6, offset = 0, sort = null, query = null, featured = null, includeNsfw = false) => new Promise((resolve, reject) => {
    // First find all gameIds that have at least one published version
    getMongoCollection('gameVersions').then(versionCollection => {
        versionCollection.distinct('gameId', { published: true }).then(publishedGameIds => {
            if (publishedGameIds.length === 0) {
                resolve({ games: [], pageCount: 0, total: 0 });
                return;
            }

            getMongoCollection('games').then(gameCollection => {
                let dbQuery = { gameId: { $in: publishedGameIds } };

                if (!includeNsfw) {
                    dbQuery.nsfw = { $ne: true };
                }

                if (featured) {
                    dbQuery.featured = true;
                }

                if (query) {
                    const textFilter = {
                        $or: [
                            { name: { $regex: query, $options: 'i' } },
                            { description: { $regex: query, $options: 'i' } },
                            { developerId: { $regex: query, $options: 'i' } },
                        ]
                    };
                    dbQuery = { $and: [dbQuery, textFilter] };
                }

                gameCollection.countDocuments(dbQuery).then(total => {
                    const pageCount = Math.ceil(total / limit);
                    // Featured listings order by when the admin featured the
                    // game, newest first. Games featured before featuredAt
                    // existed have no timestamp and sort after, by creation.
                    const sortOrder = featured ? { featuredAt: -1, created: -1 } : { created: -1 };
                    gameCollection.find(dbQuery)
                        .sort(sortOrder)
                        .skip(Number(offset))
                        .limit(Number(limit))
                        .toArray()
                        .then(games => {
                            resolve({
                                games: games.map(mapGame),
                                pageCount,
                                total,
                            });
                        }).catch(reject);
                }).catch(reject);
            }).catch(reject);
        }).catch(reject);
    }).catch(reject);
});

// ---------------------------------------------------------------------------
// List published games for a specific author
// ---------------------------------------------------------------------------

const listPublicGamesForAuthor = (params) => new Promise((resolve, reject) => {
    const { author, offset = 0, limit = 10, includeNsfw = false } = params;

    getMongoCollection('gameVersions').then(versionCollection => {
        versionCollection.distinct('gameId', { published: true }).then(publishedGameIds => {
            if (publishedGameIds.length === 0) {
                resolve({ games: [], pageCount: 0, total: 0 });
                return;
            }

            getMongoCollection('games').then(gameCollection => {
                const dbQuery = {
                    gameId: { $in: publishedGameIds },
                    developerId: author,
                };

                if (!includeNsfw) {
                    dbQuery.nsfw = { $ne: true };
                }

                gameCollection.countDocuments(dbQuery).then(total => {
                    const pageCount = Math.ceil(total / limit);
                    gameCollection.find(dbQuery)
                        .sort({ created: -1 })
                        .skip(Number(offset))
                        .limit(Number(limit))
                        .toArray()
                        .then(games => {
                            resolve({
                                games: games.map(mapGame),
                                pageCount,
                                total,
                            });
                        }).catch(reject);
                }).catch(reject);
            }).catch(reject);
        }).catch(reject);
    }).catch(reject);
});

// ---------------------------------------------------------------------------
// Delete game from search (now just a no-op since Mongo handles it)
// ---------------------------------------------------------------------------

const deleteGame = (gameId) => new Promise((resolve) => {
    // Deleting from the games collection is handled in db.js.
    // This function exists for API compatibility.
    resolve();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mapGame = (game) => ({
    id: game.gameId,
    gameId: game.gameId,
    name: game.name || '',
    description: game.description || '',
    developerId: game.developerId,
    created: game.created,
    thumbnail: game.thumbnail,
    featured: game.featured || false,
    featuredAt: game.featuredAt || null,
    nsfw: !!game.nsfw,
    // Play capabilities captured at publish time. null multiplayer = published
    // before these were recorded (and not yet backfilled) — no inline play UI.
    multiplayer: game.multiplayer == null ? null : !!game.multiplayer,
    localPlayable: !!game.localPlayable,
    latestPublishedSha: game.latestPublishedSha || null,
});

module.exports = {
    listGames,
    listPublicGamesForAuthor,
    deleteGame,
};
