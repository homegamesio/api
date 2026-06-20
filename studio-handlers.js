const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { API_PUBLIC_URL, FORGEJO_WEBHOOK_SECRET } = require('./config');
const { generateId } = require('./crypto');
const {
    getUserRecord, getGame, getGameDetails, getMongoCollection, getMongoAsset,
} = require('./db');

const {
    createRepo, createWebhook, getFileTree, getFileContents,
    createOrUpdateFile, deleteFile, listCommits, getRepoInfo,
    createForgejoUser, adminEditUser,
    FORGEJO_USER_SECRET,
} = require('./forgejo');
const { getReqBody } = require('./helpers');

// ---------------------------------------------------------------------------
// Derive a deterministic Forgejo password for a user.
// No storage needed — recomputed from a server-side secret every time.
// ---------------------------------------------------------------------------

const deriveForgejoPassword = (userId) => {
    return crypto.createHmac('sha256', FORGEJO_USER_SECRET).update(userId).digest('hex');
};

// ---------------------------------------------------------------------------
// Ensure the user has a Forgejo account (for repo ownership).
// All API operations use the admin token — no per-user tokens needed.
// ---------------------------------------------------------------------------

const ensureForgejoUser = (userId) => new Promise((resolve, reject) => {
    getUserRecord(userId).then(user => {
        if (user.forgejoAccountCreated) {
            resolve();
            return;
        }

        console.log(`Provisioning Forgejo account for user: ${userId}`);
        const forgejoEmail = `${userId}@homegames.local`;
        const forgejoPass = deriveForgejoPassword(userId);

        const markCreated = () => {
            getMongoCollection('users').then(users => {
                users.updateOne({ userId }, { '$set': { forgejoAccountCreated: true } })
                    .then(() => resolve())
                    .catch(() => resolve());
            }).catch(() => resolve());
        };

        createForgejoUser(userId, forgejoEmail, forgejoPass)
            .then(() => markCreated())
            .catch(err => {
                console.log(err);
                if (err && err.status === 422) {
                    console.log(`Forgejo user ${userId} already exists`);
                    markCreated();
                } else {
                    console.error('Failed to create Forgejo user for ' + userId, err);
                    reject('Failed to set up development account');
                }
            });
    }).catch(reject);
});

// ---------------------------------------------------------------------------
// Ensure a legacy user's Forgejo password is synced to the derived value.
// Only needs to run once per legacy user — sets a flag so subsequent calls
// are a no-op. No password is stored, just a boolean sync marker.
// ---------------------------------------------------------------------------

const syncForgejoPassword = (userId) => new Promise((resolve, reject) => {
    getUserRecord(userId).then(user => {
        if (user.forgejoPasswordSynced) {
            resolve();
            return;
        }

        console.log(`Syncing Forgejo password for legacy user: ${userId}`);
        const derivedPass = deriveForgejoPassword(userId);

        adminEditUser(userId, {
            password: derivedPass,
            must_change_password: false,
            login_name: userId,
            source_id: 0,
        }).then(() => {
            getMongoCollection('users').then(users => {
                users.updateOne({ userId }, { '$set': { forgejoPasswordSynced: true } })
                    .then(() => resolve())
                    .catch(() => resolve());
            }).catch(() => resolve());
        }).catch(err => {
            console.error('Failed to sync Forgejo password for ' + userId, err);
            reject('Failed to set up clone credentials');
        });
    }).catch(reject);
});

// ---------------------------------------------------------------------------
// Game templates
// ---------------------------------------------------------------------------

const GAME_TEMPLATES = {
    'click': {
        label: 'Click Game',
        description: 'A simple game where clicking changes colors. Good starting point.',
        files: {
            'index.js': `const { Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-1010');

class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '1010',
            author: 'Unknown',
            description: 'A new Homegames game'
        };
    }

    constructor() {
        super();
        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: Colors.COLORS.WHITE,
            onClick: (playerId, x, y) => {
                const color = Colors.randomColor();
                const dot = new GameNode.Shape({
                    shapeType: Shapes.POLYGON,
                    coordinates2d: ShapeUtils.rectangle(x - 2, y - 2, 4, 4),
                    fill: color
                });
                this.base.addChild(dot);
            }
        });
    }

    handleNewPlayer({ playerId }) {
    }

    handlePlayerDisconnect(playerId) {
    }

    getLayers() {
        return [{ root: this.base }];
    }
}

module.exports = MyGame;
`
        }
    },
    'keyboard': {
        label: 'Keyboard Game',
        description: 'A game with a movable character using arrow keys or WASD.',
        files: {
            'index.js': `const { Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-1010');
const COLORS = Colors.COLORS;

class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '1010',
            author: 'Unknown',
            description: 'A new Homegames game',
            tickRate: 60
        };
    }

    constructor() {
        super();
        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: COLORS.WHITE
        });

        this.player = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(45, 45, 10, 10),
            fill: COLORS.BLUE
        });

        this.base.addChild(this.player);
        this.speed = 0.5;
    }

    handleNewPlayer({ playerId }) {
    }

    handlePlayerDisconnect(playerId) {
    }

    handleKeyDown(playerId, key) {
        const coords = this.player.node.coordinates2d;
        let x = coords[0][0];
        let y = coords[0][1];

        if (key === 'ArrowUp' || key === 'w') y = Math.max(0, y - this.speed);
        if (key === 'ArrowDown' || key === 's') y = Math.min(90, y + this.speed);
        if (key === 'ArrowLeft' || key === 'a') x = Math.max(0, x - this.speed);
        if (key === 'ArrowRight' || key === 'd') x = Math.min(90, x + this.speed);

        this.player.node.coordinates2d = ShapeUtils.rectangle(x, y, 10, 10);
    }

    getLayers() {
        return [{ root: this.base }];
    }
}

module.exports = MyGame;
`
        }
    },
    'multiplayer': {
        label: 'Multiplayer Game',
        description: 'A game that tracks players with per-player colored squares.',
        files: {
            'index.js': `const { Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-1010');
const COLORS = Colors.COLORS;

class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '1010',
            author: 'Unknown',
            description: 'A new Homegames game'
        };
    }

    constructor() {
        super();
        this.players = {};
        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: COLORS.WHITE,
            onClick: (playerId, x, y) => {
                const player = this.players[playerId];
                if (!player) return;
                const dot = new GameNode.Shape({
                    shapeType: Shapes.POLYGON,
                    coordinates2d: ShapeUtils.rectangle(x - 2, y - 2, 4, 4),
                    fill: player.color,
                    playerIds: [playerId]
                });
                this.base.addChild(dot);
            }
        });

        this.playerListNode = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 0, 0)
        });
        this.base.addChild(this.playerListNode);
    }

    handleNewPlayer({ playerId, info }) {
        const color = Colors.randomColor();
        this.players[playerId] = { info, color };
        this.renderPlayerList();
    }

    handlePlayerDisconnect(playerId) {
        delete this.players[playerId];
        this.renderPlayerList();
    }

    renderPlayerList() {
        this.playerListNode.clearChildren();
        let y = 2;
        for (const id in this.players) {
            const p = this.players[id];
            const badge = new GameNode.Shape({
                shapeType: Shapes.POLYGON,
                coordinates2d: ShapeUtils.rectangle(2, y, 3, 3),
                fill: p.color
            });
            const label = new GameNode.Text({
                textInfo: {
                    text: p.info?.name || ('Player ' + id),
                    x: 7, y: y + 0.5,
                    size: 1.2, color: COLORS.BLACK, align: 'left'
                }
            });
            this.playerListNode.addChildren(badge, label);
            y += 5;
        }
    }

    getLayers() {
        return [{ root: this.base }];
    }
}

module.exports = MyGame;
`
        }
    },
    'assets': {
        label: 'Asset Game',
        description: 'A game that demonstrates image assets. Click to move the image.',
        files: {
            'index.js': `const { Asset, Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-1010');
const COLORS = Colors.COLORS;

class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '1010',
            author: 'Unknown',
            description: 'A game with image assets'
        };
    }

    constructor() {
        super();
        this.imagePos = { x: 40, y: 30 };
        this.imageSize = { x: 20, y: 20 };

        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: COLORS.WHITE,
            onClick: (playerId, x, y) => {
                this.imagePos = { x: x - this.imageSize.x / 2, y: y - this.imageSize.y / 2 };
                this.updateImage();
            }
        });

        this.imageNode = new GameNode.Asset({
            coordinates2d: ShapeUtils.rectangle(this.imagePos.x, this.imagePos.y, this.imageSize.x, this.imageSize.y),
            assetInfo: {
                'myImage': {
                    pos: { ...this.imagePos },
                    size: { ...this.imageSize }
                }
            }
        });

        this.base.addChild(this.imageNode);

        this.label = new GameNode.Text({
            textInfo: {
                text: 'Click anywhere to move the image',
                x: 50, y: 5,
                size: 1.5, color: COLORS.BLACK, align: 'center'
            }
        });

        this.base.addChild(this.label);
    }

    updateImage() {
        this.imageNode.node.coordinates2d = ShapeUtils.rectangle(
            this.imagePos.x, this.imagePos.y, this.imageSize.x, this.imageSize.y
        );
        const newAsset = this.imageNode.node.asset;
        newAsset.myImage.pos = { ...this.imagePos };
        newAsset.myImage.size = { ...this.imageSize };
        this.imageNode.node.asset = newAsset;
    }

    handleNewPlayer({ playerId }) {}
    handlePlayerDisconnect(playerId) {}

    getLayers() {
        return [{ root: this.base }];
    }

    getAssets() {
        return {
            'myImage': new Asset({
                id: '1715f020b60ee74c53a1d8a311ce2622',
                type: 'image'
            })
        };
    }
}

module.exports = MyGame;
`
        }
    }
};

// ---------------------------------------------------------------------------
// Game creation (with Forgejo repo)
// ---------------------------------------------------------------------------

const handleStudioCreateGame = (req, res, userId) => {
    getReqBody(req, (_body, err) => {
        if (err) {
            res.writeHead(400);
            res.end('Error reading request');
            return;
        }

        let body;
        try {
            body = JSON.parse(_body);
        } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }

        const { name, description, template } = body;
        if (!name) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Game name is required' }));
            return;
        }

        // Validate template if provided
        if (template && !GAME_TEMPLATES[template]) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Unknown template: ' + template }));
            return;
        }

        const repoName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (!repoName) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid game name' }));
            return;
        }

        // Commit initial files to the repo after creation (LICENSE + template files)
        const commitInitialFiles = (owner, repo) => new Promise((resolve, reject) => {
            // Always include GPLv3 LICENSE
            const gplText = fs.readFileSync(path.join(__dirname, 'gpl-3.0.txt'), 'utf-8');
            const filesToCommit = [{ path: 'LICENSE', content: gplText }];

            // Add template files if a template was selected
            if (template && GAME_TEMPLATES[template]) {
                const templateFiles = GAME_TEMPLATES[template].files;
                for (const filePath of Object.keys(templateFiles)) {
                    filesToCommit.push({ path: filePath, content: templateFiles[filePath] });
                }
            }

            const commitNext = (i) => {
                if (i >= filesToCommit.length) { resolve(); return; }
                const file = filesToCommit[i];
                createOrUpdateFile(owner, repo, file.path, file.content, `Add ${file.path}`, null)
                    .then(() => commitNext(i + 1))
                    .catch(err => {
                        console.error(`Failed to commit file ${file.path}`, err);
                        resolve(); // Don't fail game creation over initial files
                    });
            };
            commitNext(0);
        });

        // Create game record in MongoDB and respond
        const finishGameCreation = () => {
            const gameId = generateId();
            const gameData = {
                gameId,
                name,
                description: description || '',
                developerId: userId,
                created: Date.now(),
                forgejoRepo: `${userId}/${repoName}`,
                featured: false,
            };

            getMongoCollection('games').then(collection => {
                collection.insertOne(gameData).then(() => {
                    commitInitialFiles(userId, repoName).then(() => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            id: gameId,
                            name,
                            description: description || '',
                            forgejoRepo: `${userId}/${repoName}`,
                        }));
                    });
                }).catch(err => {
                    console.error('Failed to create game record', err);
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to create game' }));
                });
            }).catch(err => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Database error' }));
            });
        };

        ensureForgejoUser(userId).then(() => {
            createRepo(userId, repoName).then(repo => {
                const webhookUrl = `${API_PUBLIC_URL}/webhook/push`;
                createWebhook(userId, repoName, webhookUrl, FORGEJO_WEBHOOK_SECRET)
                    .then(() => finishGameCreation())
                    .catch(err => {
                        console.error('Failed to create webhook', err);
                        // Repo was created but webhook failed — still continue
                        finishGameCreation();
                    });
            }).catch(err => {
                console.error('Failed to create Forgejo repo', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to create repository' }));
            });
        }).catch(err => {
            console.error('Failed to ensure Forgejo account', err);
            res.writeHead(500);
            res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Failed to set up development account' }));
        });
    });
};

// ---------------------------------------------------------------------------
// List available templates
// ---------------------------------------------------------------------------

const handleGetTemplates = (req, res) => {
    const templates = Object.entries(GAME_TEMPLATES).map(([key, tmpl]) => ({
        id: key,
        label: tmpl.label,
        description: tmpl.description,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ templates }));
};

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

const handleGetFiles = (req, res, userId, gameId) => {
    getGame(gameId).then(game => {
        if (!game.forgejoRepo) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Game has no repository' }));
            return;
        }

        ensureForgejoUser(userId).then(() => {
            const [owner, repo] = game.forgejoRepo.split('/');
            getFileTree(owner, repo, 'main').then(tree => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(tree));
            }).catch(err => {
                console.error('Failed to get file tree', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to get files' }));
            });
        }).catch(err => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Account setup failed' }));
        });
    }).catch(err => {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Game not found' }));
    });
};

const handleGetFileContent = (req, res, userId, gameId) => {
    const queryObject = url.parse(req.url, true).query;
    const { path: filepath, ref } = queryObject;

    if (!filepath) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'path parameter is required' }));
        return;
    }

    getGame(gameId).then(game => {
        if (!game.forgejoRepo) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Game has no repository' }));
            return;
        }

        ensureForgejoUser(userId).then(() => {
            const [owner, repo] = game.forgejoRepo.split('/');
            getFileContents(owner, repo, filepath, ref).then(fileData => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(fileData));
            }).catch(err => {
                console.error('Failed to get file content', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to get file' }));
            });
        }).catch(err => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Account setup failed' }));
        });
    }).catch(err => {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Game not found' }));
    });
};

// ---------------------------------------------------------------------------
// Save version (commit files)
// ---------------------------------------------------------------------------

const handleSaveVersion = (req, res, userId, gameId) => {
    getReqBody(req, (_body, err) => {
        if (err) {
            res.writeHead(400);
            res.end('Error reading request');
            return;
        }

        let body;
        try {
            body = JSON.parse(_body);
        } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }

        const { files, message } = body;
        // files: [{ path, content, sha (if updating existing) }]

        if (!files || !Array.isArray(files) || files.length === 0) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'files array is required' }));
            return;
        }

        getGame(gameId).then(game => {
            if (!game.forgejoRepo) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Game has no repository' }));
                return;
            }

            if (game.developerId !== userId) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Not your game' }));
                return;
            }

            ensureForgejoUser(userId).then(() => {
                const [owner, repo] = game.forgejoRepo.split('/');
                const commitMessage = message || `Update ${files.length} file(s)`;

                // Commit files sequentially (Forgejo API does one file per request)
                const committedFiles = [];
                const commitNext = (index) => {
                    if (index >= files.length) {
                        // All files committed — the webhook will handle build triggering
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            filesCommitted: files.length,
                            message: commitMessage,
                            files: committedFiles,
                        }));
                        return;
                    }

                    const file = files[index];
                    const fileMessage = index === 0 ? commitMessage : `${commitMessage} (${index + 1}/${files.length})`;

                    createOrUpdateFile(owner, repo, file.path, file.content, fileMessage, file.sha)
                        .then(result => {
                            committedFiles.push({
                                path: file.path,
                                sha: result?.content?.sha || null,
                            });
                            commitNext(index + 1);
                        })
                        .catch(err => {
                            console.error(`Failed to commit file ${file.path}`, err);
                            res.writeHead(500);
                            res.end(JSON.stringify({
                                error: `Failed to save file: ${file.path}`,
                                filesCommitted: index,
                            }));
                        });
                };

                commitNext(0);
            }).catch(err => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Account setup failed' }));
            });
        }).catch(err => {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Game not found' }));
        });
    });
};

// ---------------------------------------------------------------------------
// Versions (commits) list
// ---------------------------------------------------------------------------

const handleGetVersions = (req, res, userId, gameId) => {
    const queryObject = url.parse(req.url, true).query;
    const page = Number(queryObject.page) || 1;
    const limit = Number(queryObject.limit) || 20;

    getGame(gameId).then(game => {
        if (!game.forgejoRepo) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Game has no repository' }));
            return;
        }

        const [owner, repo] = game.forgejoRepo.split('/');
        listCommits(owner, repo, 'main', limit, page).then(commits => {
            const versions = commits.map(c => ({
                sha: c.sha,
                message: c.commit?.message?.trim() || '',
                author: c.commit?.author?.name || '',
                date: c.commit?.author?.date || c.commit?.committer?.date || '',
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ versions, page, limit }));
        }).catch(err => {
            console.error('Failed to list commits', err);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to list versions' }));
        });
    }).catch(err => {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Game not found' }));
    });
};

// ---------------------------------------------------------------------------
// Get file tree at a specific version (commit sha)
// ---------------------------------------------------------------------------

const handleGetVersionFiles = (req, res, userId, gameId, commitSha) => {
    getGame(gameId).then(game => {
        if (!game.forgejoRepo) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Game has no repository' }));
            return;
        }

        const [owner, repo] = game.forgejoRepo.split('/');
        getFileTree(owner, repo, commitSha).then(tree => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(tree));
        }).catch(err => {
            console.error('Failed to get file tree at commit', err);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to get version files' }));
        });
    }).catch(err => {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Game not found' }));
    });
};

// ---------------------------------------------------------------------------
// Restore a version: overwrite current files to match a given commit
// ---------------------------------------------------------------------------

const handleRestoreVersion = (req, res, userId, gameId) => {
    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end('Error reading request'); return; }

        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
        }

        const { commitSha } = body;
        if (!commitSha) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'commitSha is required' }));
            return;
        }

        getGame(gameId).then(game => {
            if (!game.forgejoRepo) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Game has no repository' }));
                return;
            }

            if (game.developerId !== userId) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Not your game' }));
                return;
            }

            ensureForgejoUser(userId).then(() => {
                const [owner, repo] = game.forgejoRepo.split('/');

                // Get file tree at the target commit
                getFileTree(owner, repo, commitSha).then(oldTree => {
                    const oldFiles = (oldTree.tree || []).filter(e => e.type === 'blob');

                    // Get current file tree
                    getFileTree(owner, repo, 'main').then(currentTree => {
                        const currentFiles = (currentTree.tree || []).filter(e => e.type === 'blob');

                        // For each file in the old commit, fetch its content and overwrite current
                        // Also need to delete files that exist now but didn't exist in the old commit
                        const oldPaths = new Set(oldFiles.map(f => f.path));
                        const currentMap = {};
                        currentFiles.forEach(f => { currentMap[f.path] = f; });

                        // Fetch all file contents from the old commit
                        const fetchOldContents = () => new Promise((resolve, reject) => {
                            const results = [];
                            const fetchNext = (i) => {
                                if (i >= oldFiles.length) { resolve(results); return; }
                                getFileContents(owner, repo, oldFiles[i].path, commitSha).then(data => {
                                    results.push({
                                        path: oldFiles[i].path,
                                        content: data.content ? Buffer.from(data.content, 'base64').toString() : '',
                                        currentSha: currentMap[oldFiles[i].path]?.sha || null,
                                    });
                                    fetchNext(i + 1);
                                }).catch(reject);
                            };
                            fetchNext(0);
                        });

                        fetchOldContents().then(filesToWrite => {
                            // Write/update each file sequentially
                            const committedFiles = [];
                            const writeNext = (i) => {
                                if (i >= filesToWrite.length) {
                                    // Now delete files that exist in current but not in old commit
                                    const toDelete = currentFiles.filter(f => !oldPaths.has(f.path));
                                    const deleteNext = (j) => {
                                        if (j >= toDelete.length) {
                                            res.writeHead(200, { 'Content-Type': 'application/json' });
                                            res.end(JSON.stringify({
                                                success: true,
                                                restoredTo: commitSha,
                                                filesWritten: committedFiles.length,
                                                filesDeleted: toDelete.length,
                                                files: committedFiles,
                                            }));
                                            return;
                                        }
                                        deleteFile(owner, repo, toDelete[j].path, toDelete[j].sha, `Restore: delete ${toDelete[j].path}`)
                                            .then(() => deleteNext(j + 1))
                                            .catch(err => {
                                                console.error(`Failed to delete ${toDelete[j].path}`, err);
                                                deleteNext(j + 1); // continue anyway
                                            });
                                    };
                                    deleteNext(0);
                                    return;
                                }

                                const f = filesToWrite[i];
                                const msg = i === 0 ? `Restore to ${commitSha.substring(0, 7)}` : `Restore to ${commitSha.substring(0, 7)} (${i + 1}/${filesToWrite.length})`;
                                createOrUpdateFile(owner, repo, f.path, f.content, msg, f.currentSha)
                                    .then(result => {
                                        committedFiles.push({ path: f.path, sha: result?.content?.sha || null });
                                        writeNext(i + 1);
                                    })
                                    .catch(err => {
                                        console.error(`Failed to write ${f.path} during restore`, err);
                                        res.writeHead(500);
                                        res.end(JSON.stringify({ error: `Failed to restore file: ${f.path}` }));
                                    });
                            };
                            writeNext(0);
                        }).catch(err => {
                            console.error('Failed to fetch old file contents', err);
                            res.writeHead(500);
                            res.end(JSON.stringify({ error: 'Failed to read version files' }));
                        });
                    }).catch(err => {
                        console.error('Failed to get current file tree', err);
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Failed to get current files' }));
                    });
                }).catch(err => {
                    console.error('Failed to get old file tree', err);
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to get version files' }));
                });
            }).catch(err => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Account setup failed' }));
            });
        }).catch(err => {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Game not found' }));
        });
    });
};

// ---------------------------------------------------------------------------
// Webhook handler (Forgejo push)
// ---------------------------------------------------------------------------

const handleWebhookPush = (req, res) => {
    getReqBody(req, (_body, err) => {
        if (err) {
            res.writeHead(400);
            res.end('Error reading request');
            return;
        }

        // Verify webhook signature
        if (FORGEJO_WEBHOOK_SECRET) {
            const signature = req.headers['x-forgejo-signature'];
            if (!signature) {
                res.writeHead(403);
                res.end('Missing signature');
                return;
            }
            const expected = crypto.createHmac('sha256', FORGEJO_WEBHOOK_SECRET)
                .update(_body)
                .digest('hex');
            if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
                res.writeHead(403);
                res.end('Invalid signature');
                return;
            }
        }

        let payload;
        try {
            payload = JSON.parse(_body);
        } catch (e) {
            res.writeHead(400);
            res.end('Invalid JSON');
            return;
        }

        const repoFullName = payload.repository?.full_name;
        const commits = payload.commits || [];
        const headCommit = commits.length > 0 ? commits[commits.length - 1] : null;

        if (!repoFullName || !headCommit) {
            res.writeHead(200);
            res.end('No actionable commits');
            return;
        }

        const commitSha = headCommit.id;

        // Find the game by forgejoRepo
        getMongoCollection('games').then(gamesCollection => {
            gamesCollection.findOne({ forgejoRepo: repoFullName }).then(game => {
                if (!game) {
                    console.log('Webhook received for unknown repo: ' + repoFullName);
                    res.writeHead(200);
                    res.end('Unknown repo');
                    return;
                }

                // Create a build record
                const buildId = generateId();
                const buildRecord = {
                    buildId,
                    gameId: game.gameId,
                    commitSha,
                    commitMessage: headCommit.message || '',
                    triggeredBy: game.developerId,
                    status: 'BUILDING',
                    error: null,
                    created: Date.now(),
                    completed: null,
                };

                getMongoCollection('builds').then(buildsCollection => {
                    buildsCollection.insertOne(buildRecord).then(() => {
                        // Enqueue build job
                        const amqp = require('amqplib/callback_api');
                        const { QUEUE_HOST, JOB_QUEUE_NAME } = require('./config');

                        amqp.connect(`amqp://${QUEUE_HOST}`, (err, conn) => {
                            if (err) {
                                console.error('Failed to connect to queue', err);
                                res.writeHead(200);
                                res.end('Queue connection failed');
                                return;
                            }

                            conn.createChannel((err1, channel) => {
                                if (err1) {
                                    console.error('Failed to create channel', err1);
                                    res.writeHead(200);
                                    res.end('Queue channel failed');
                                    return;
                                }

                                channel.assertQueue(JOB_QUEUE_NAME, { durable: true });

                                const jobPayload = {
                                    type: 'BUILD_GAME',
                                    buildId,
                                    gameId: game.gameId,
                                    forgejoRepo: repoFullName,
                                    commitSha,
                                    userId: game.developerId,
                                };

                                channel.sendToQueue(
                                    JOB_QUEUE_NAME,
                                    Buffer.from(JSON.stringify(jobPayload)),
                                    { persistent: true }
                                );

                                console.log(`Build ${buildId} enqueued for ${repoFullName}@${commitSha}`);

                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ buildId, status: 'BUILDING' }));
                            });
                        });
                    }).catch(err => {
                        console.error('Failed to create build record', err);
                        res.writeHead(500);
                        res.end('Failed to create build');
                    });
                });
            }).catch(err => {
                res.writeHead(500);
                res.end('Database error');
            });
        }).catch(err => {
            res.writeHead(500);
            res.end('Database error');
        });
    });
};

// ---------------------------------------------------------------------------
// Build status
// ---------------------------------------------------------------------------

const handleGetBuilds = (req, res, userId, gameId) => {
    const queryObject = url.parse(req.url, true).query;
    const limit = Number(queryObject.limit) || 10;
    const offset = Number(queryObject.offset) || 0;

    getMongoCollection('builds').then(collection => {
        collection.countDocuments({ gameId }).then(count => {
            collection.find({ gameId })
                .sort({ created: -1 })
                .skip(offset)
                .limit(limit)
                .toArray()
                .then(builds => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        builds: builds.map(b => ({
                            buildId: b.buildId,
                            commitSha: b.commitSha,
                            commitMessage: b.commitMessage,
                            status: b.status,
                            error: b.error,
                            created: b.created,
                            completed: b.completed,
                        })),
                        count,
                    }));
                }).catch(err => {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to list builds' }));
                });
        });
    }).catch(err => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Database error' }));
    });
};

// ---------------------------------------------------------------------------
// Featured toggle (admin)
// ---------------------------------------------------------------------------

const handleToggleFeatured = (req, res, userId, gameId) => {
    getUserRecord(userId).then(userData => {
        if (!userData.isAdmin) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Not an admin' }));
            return;
        }

        getMongoCollection('games').then(collection => {
            collection.findOne({ gameId }).then(game => {
                if (!game) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Game not found' }));
                    return;
                }

                const newFeatured = !game.featured;
                collection.updateOne({ gameId }, { '$set': { featured: newFeatured } }).then(() => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ gameId, featured: newFeatured }));
                }).catch(err => {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to update' }));
                });
            });
        });
    }).catch(err => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to get user record' }));
    });
};

// ---------------------------------------------------------------------------
// List user's games for studio
// ---------------------------------------------------------------------------

const handleStudioListGames = (req, res, userId) => {
    getMongoCollection('games').then(collection => {
        collection.find({ developerId: userId })
            .sort({ created: -1 })
            .toArray()
            .then(games => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    games: games.map(g => ({
                        id: g.gameId,
                        name: g.name,
                        description: g.description,
                        forgejoRepo: g.forgejoRepo,
                        featured: g.featured || false,
                        created: g.created,
                        thumbnail: g.thumbnail || null,
                    })),
                }));
            });
    }).catch(err => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to list games' }));
    });
};

// ---------------------------------------------------------------------------
// Clone info (for CLI users)
// ---------------------------------------------------------------------------

const handleGetCloneInfo = (req, res, userId, gameId) => {
    getGame(gameId).then(game => {
        if (!game.forgejoRepo) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Game has no repository' }));
            return;
        }

        // Verify this is the game owner
        if (game.developerId !== userId) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'Not your game' }));
            return;
        }

        const { FORGEJO_URL } = require('./config');

        ensureForgejoUser(userId).then(() => {
            syncForgejoPassword(userId).then(() => {
                const forgejoPass = deriveForgejoPassword(userId);
                const cloneUrl = `${FORGEJO_URL}/${game.forgejoRepo}.git`;
                const parsed = new URL(cloneUrl);
                parsed.username = userId;
                parsed.password = forgejoPass;

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    cloneUrl,
                    authenticatedUrl: parsed.toString(),
                    repo: game.forgejoRepo,
                }));
            }).catch(err => {
                console.error('Failed to sync Forgejo password', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Failed to generate clone credentials' }));
            });
        }).catch(err => {
            console.error('Failed to ensure Forgejo account', err);
            res.writeHead(500);
            res.end(JSON.stringify({ error: typeof err === 'string' ? err : 'Failed to set up development account' }));
        });
    }).catch(err => {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Game not found' }));
    });
};

// ---------------------------------------------------------------------------
// Submit publish request
// ---------------------------------------------------------------------------

const handleSubmitPublishRequest = (req, res, userId, gameId) => {
    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end('Error reading request'); return; }

        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
        }

        const { commitSha } = body;
        if (!commitSha) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'commitSha is required' }));
            return;
        }

        getGame(gameId).then(game => {
            if (!game.forgejoRepo) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Game has no repository' }));
                return;
            }

            if (game.developerId !== userId) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Not your game' }));
                return;
            }

            if (!game.description || !game.description.trim()) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Game must have a description before publishing' }));
                return;
            }

            if (!game.thumbnail) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Game must have a thumbnail set before publishing' }));
                return;
            }

            getMongoCollection('publishRequests').then(collection => {
                // Rate limit: 1 publish request per 10 minutes per user
                const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
                collection.findOne(
                    { userId, created: { $gt: tenMinutesAgo } },
                    { sort: { created: -1 } }
                ).then(recent => {
                    if (recent) {
                        const waitSecs = Math.ceil((recent.created + 10 * 60 * 1000 - Date.now()) / 1000);
                        const waitMins = Math.ceil(waitSecs / 60);
                        res.writeHead(429, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: `Publish limit: 1 request per 10 minutes. Try again in ${waitMins} minute${waitMins === 1 ? '' : 's'}.`,
                        }));
                        return;
                    }

                // Check for existing pending/processing request for same game+commit
                collection.findOne({
                    gameId,
                    commitSha,
                    status: { $in: ['PENDING', 'PROCESSING'] }
                }).then(existing => {
                    if (existing) {
                        res.writeHead(409);
                        res.end(JSON.stringify({
                            error: 'A publish request for this version is already pending',
                            requestId: existing.requestId,
                        }));
                        return;
                    }

                    const requestId = generateId();
                    const record = {
                        requestId,
                        userId,
                        gameId,
                        commitSha,
                        status: 'PENDING',
                        created: Date.now(),
                    };

                    collection.insertOne(record).then(() => {
                        // Enqueue to RabbitMQ
                        const amqp = require('amqplib/callback_api');
                        const { QUEUE_HOST } = require('./config');
                        const QUEUE_NAME = 'publish_requests';

                        amqp.connect(`amqp://${QUEUE_HOST}`, (err, conn) => {
                            if (err) {
                                console.error('Failed to connect to queue', err);
                                // Record was created — worker can pick it up later
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ requestId, status: 'PENDING', queued: false }));
                                return;
                            }

                            conn.createChannel((err1, channel) => {
                                if (err1) {
                                    console.error('Failed to create channel', err1);
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ requestId, status: 'PENDING', queued: false }));
                                    return;
                                }

                                channel.assertQueue(QUEUE_NAME, { durable: true });
                                channel.sendToQueue(
                                    QUEUE_NAME,
                                    Buffer.from(JSON.stringify({
                                        requestId,
                                        gameId,
                                        commitSha,
                                        userId,
                                    })),
                                    { persistent: true }
                                );

                                console.log(`Publish request ${requestId} enqueued for ${gameId}@${commitSha.substring(0, 7)}`);

                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ requestId, status: 'PENDING', queued: true }));

                                // Close connection after a short delay
                                setTimeout(() => { try { conn.close(); } catch (e) {} }, 500);
                            });
                        });
                    }).catch(err => {
                        console.error('Failed to create publish request record', err);
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Failed to create publish request' }));
                    });
                });
                }); // end rate limit check
            }).catch(err => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Database error' }));
            });
        }).catch(err => {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Game not found' }));
        });
    });
};

// ---------------------------------------------------------------------------
// Get publish request statuses for a game
// ---------------------------------------------------------------------------

const handleGetPublishStatuses = (req, res, userId, gameId) => {
    getMongoCollection('publishRequests').then(collection => {
        collection.find({ gameId })
            .sort({ created: -1 })
            .limit(100)
            .toArray()
            .then(requests => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    requests: requests.map(r => ({
                        requestId: r.requestId,
                        commitSha: r.commitSha,
                        status: r.status,
                        error: r.error || null,
                        created: r.created,
                        completedAt: r.completedAt || null,
                    })),
                }));
            })
            .catch(err => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to get publish statuses' }));
            });
    }).catch(err => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Database error' }));
    });
};

// ---------------------------------------------------------------------------
// Submit an LLM "modify my game" request.
// Fetches the game's current index.js, then enqueues a job containing the
// source + the user's prompt for the self-hosted MLX worker to process.
// ---------------------------------------------------------------------------

const handleSubmitLLMRequest = (req, res, userId, gameId) => {
    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end('Error reading request'); return; }

        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
        }

        const prompt = (body.prompt || '').trim();
        if (!prompt) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'prompt is required' }));
            return;
        }
        if (prompt.length > 2000) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'prompt must be 2000 characters or fewer' }));
            return;
        }

        getGame(gameId).then(game => {
            if (!game.forgejoRepo) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Game has no repository' }));
                return;
            }
            if (game.developerId !== userId) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Not your game' }));
                return;
            }

            ensureForgejoUser(userId).then(() => {
                const [owner, repo] = game.forgejoRepo.split('/');
                getFileContents(owner, repo, 'index.js').then(fileData => {
                    const sourceContent = Buffer.from(fileData.content, 'base64').toString('utf8');
                    const baseSha = fileData.sha;

                    getMongoCollection('llmRequests').then(collection => {
                        // Rate limit: 1 request per 2 minutes per user
                        const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
                        collection.findOne(
                            { userId, created: { $gt: twoMinutesAgo } },
                            { sort: { created: -1 } }
                        ).then(recent => {
                            if (recent) {
                                const waitSecs = Math.ceil((recent.created + 2 * 60 * 1000 - Date.now()) / 1000);
                                res.writeHead(429, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    error: `AI edit limit: 1 request per 2 minutes. Try again in ${waitSecs} second${waitSecs === 1 ? '' : 's'}.`,
                                }));
                                return;
                            }

                            // Reject if one is already in flight for this game
                            collection.findOne({
                                gameId,
                                status: { $in: ['PENDING', 'PROCESSING'] }
                            }).then(existing => {
                                if (existing) {
                                    res.writeHead(409);
                                    res.end(JSON.stringify({
                                        error: 'An AI edit for this game is already in progress',
                                        requestId: existing.requestId,
                                    }));
                                    return;
                                }

                                const requestId = generateId();
                                const record = {
                                    requestId,
                                    userId,
                                    gameId,
                                    prompt,
                                    baseSha,
                                    status: 'PENDING',
                                    created: Date.now(),
                                };

                                collection.insertOne(record).then(() => {
                                    const amqp = require('amqplib/callback_api');
                                    const { QUEUE_HOST, JOB_QUEUE_NAME } = require('./config');

                                    amqp.connect(`amqp://${QUEUE_HOST}`, (cErr, conn) => {
                                        if (cErr) {
                                            console.error('Failed to connect to queue', cErr);
                                            res.writeHead(200, { 'Content-Type': 'application/json' });
                                            res.end(JSON.stringify({ requestId, status: 'PENDING', queued: false }));
                                            return;
                                        }

                                        conn.createChannel((chErr, channel) => {
                                            if (chErr) {
                                                console.error('Failed to create channel', chErr);
                                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                                res.end(JSON.stringify({ requestId, status: 'PENDING', queued: false }));
                                                return;
                                            }

                                            // LLM jobs now ride the unified homegames-jobs
                                            // queue as a typed message; the consolidated
                                            // worker dispatches on `type`.
                                            channel.assertQueue(JOB_QUEUE_NAME, { durable: true });
                                            channel.sendToQueue(
                                                JOB_QUEUE_NAME,
                                                Buffer.from(JSON.stringify({
                                                    type: 'LLM_REQUEST',
                                                    requestId,
                                                    gameId,
                                                    userId,
                                                    prompt,
                                                    baseSha,
                                                    source: sourceContent,
                                                })),
                                                { persistent: true }
                                            );

                                            console.log(`LLM request ${requestId} enqueued for ${gameId}`);

                                            res.writeHead(200, { 'Content-Type': 'application/json' });
                                            res.end(JSON.stringify({ requestId, status: 'PENDING', queued: true }));

                                            setTimeout(() => { try { conn.close(); } catch (e) {} }, 500);
                                        });
                                    });
                                }).catch(insErr => {
                                    console.error('Failed to create LLM request record', insErr);
                                    res.writeHead(500);
                                    res.end(JSON.stringify({ error: 'Failed to create AI edit request' }));
                                });
                            });
                        });
                    }).catch(() => {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Database error' }));
                    });
                }).catch(fcErr => {
                    console.error('Failed to fetch index.js', fcErr);
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Could not read game source' }));
                });
            }).catch(auErr => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: typeof auErr === 'string' ? auErr : 'Account setup failed' }));
            });
        }).catch(() => {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Game not found' }));
        });
    });
};

// ---------------------------------------------------------------------------
// Get LLM request status. With ?id=<requestId> returns that request;
// otherwise returns the most recent requests for the game.
// ---------------------------------------------------------------------------

const handleGetLLMStatus = (req, res, userId, gameId) => {
    const { id } = url.parse(req.url, true).query;

    getMongoCollection('llmRequests').then(collection => {
        const project = (r) => ({
            requestId: r.requestId,
            status: r.status,
            prompt: r.prompt,
            result: r.status === 'COMPLETED' ? r.result : undefined,
            error: r.error || null,
            created: r.created,
            completedAt: r.completedAt || null,
        });

        if (id) {
            collection.findOne({ requestId: id, gameId }).then(r => {
                if (!r) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Request not found' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ request: project(r) }));
            }).catch(() => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Database error' }));
            });
            return;
        }

        collection.find({ gameId })
            .sort({ created: -1 })
            .limit(20)
            .toArray()
            .then(requests => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ requests: requests.map(project) }));
            })
            .catch(() => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Failed to get AI edit statuses' }));
            });
    }).catch(() => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Database error' }));
    });
};

// ---------------------------------------------------------------------------
// Result ingestion from the self-hosted MLX worker.
// Authenticated with the shared LLM_WORKER_SECRET, not a user JWT.
// ---------------------------------------------------------------------------

const handleLLMResult = (req, res) => {
    const { LLM_WORKER_SECRET } = require('./config');

    const auth = req.headers.authorization || '';
    if (!LLM_WORKER_SECRET || auth !== `Bearer ${LLM_WORKER_SECRET}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }

    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end('Error reading request'); return; }

        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
        }

        const { requestId, status, result, error } = body;
        if (!requestId || !['COMPLETED', 'FAILED'].includes(status)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'requestId and a valid status are required' }));
            return;
        }
        if (status === 'COMPLETED' && typeof result !== 'string') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'result is required for COMPLETED status' }));
            return;
        }

        getMongoCollection('llmRequests').then(collection => {
            const update = { status, completedAt: Date.now() };
            if (status === 'COMPLETED') update.result = result;
            if (status === 'FAILED') update.error = error || 'Unknown error';

            collection.updateOne(
                { requestId, status: { $in: ['PENDING', 'PROCESSING'] } },
                { '$set': update }
            ).then(r => {
                if (r.matchedCount === 0) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'No in-flight request with that id' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            }).catch(() => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Database error' }));
            });
        }).catch(() => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Database error' }));
        });
    });
};

module.exports = {
    handleStudioCreateGame,
    handleGetTemplates,
    handleGetFiles,
    handleGetFileContent,
    handleSaveVersion,
    handleGetVersions,
    handleGetVersionFiles,
    handleRestoreVersion,
    handleWebhookPush,
    handleGetBuilds,
    handleToggleFeatured,
    handleStudioListGames,
    handleGetCloneInfo,
    handleSubmitPublishRequest,
    handleGetPublishStatuses,
    handleSetGameThumbnail,
    handleSubmitLLMRequest,
    handleGetLLMStatus,
    handleLLMResult,
};

// ---------------------------------------------------------------------------
// Set game thumbnail
// ---------------------------------------------------------------------------

function handleSetGameThumbnail(req, res, userId, gameId) {
    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end('Error reading request'); return; }

        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
        }

        const { assetId } = body;
        if (!assetId) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'assetId is required' }));
            return;
        }

        getGame(gameId).then(game => {
            if (game.developerId !== userId) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Not your game' }));
                return;
            }

            getMongoCollection('games').then(collection => {
                const updates = { thumbnail: assetId };

                getMongoAsset(assetId).then(asset => {
                    if (asset && asset.nsfw) {
                        updates.nsfw = true;
                    } else {
                        // Thumbnail is clean — check if latest published version is NSFW
                        return getMongoCollection('gameVersions').then(versionCollection => {
                            return versionCollection.find({ gameId, published: true })
                                .sort({ publishedAt: -1 })
                                .limit(1)
                                .toArray()
                                .then(versions => {
                                    updates.nsfw = versions.length > 0 && !!versions[0].nsfw;
                                });
                        });
                    }
                }).catch(() => {
                    // Asset lookup failed — don't change nsfw status
                }).then(() => {
                    collection.updateOne({ gameId }, { $set: updates }).then(() => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ gameId, thumbnail: assetId }));
                    }).catch(err => {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Failed to update thumbnail' }));
                    });
                });
            });
        }).catch(err => {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Game not found' }));
        });
    });
}
