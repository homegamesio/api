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
    'blank': {
        label: "Blank",
        description: "An empty game with a minimal starting point.",
        files: {
            'index.js': `const { Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-142');

class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '142',
            author: 'Unknown',
            description: 'A new Homegames game'
        };
    }

    constructor() {
        super();
        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: Colors.COLORS.WHITE
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
    'click': {
        label: "Click",
        description: "Click anywhere to drop colored squares. Shapes, colors, and clicks.",
        files: {
            'index.js': `const { Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-142');
const COLORS = Colors.COLORS;

// Click anywhere to drop a randomly colored square. Demonstrates shapes,
// colors, click handling, and adding nodes to the scene at runtime.
class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '142',
            author: 'Unknown',
            description: 'Click anywhere to drop colored squares'
        };
    }

    constructor() {
        super();
        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: COLORS.WHITE,
            onClick: (playerId, x, y) => {
                const dot = new GameNode.Shape({
                    shapeType: Shapes.POLYGON,
                    coordinates2d: ShapeUtils.rectangle(x - 2, y - 2, 4, 4),
                    fill: Colors.randomColor()
                });
                // Adding a child notifies clients automatically.
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
        label: "Keyboard",
        description: "Move a square with arrow keys or WASD. Input plus a tick loop.",
        files: {
            'index.js': `const { Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-142');
const COLORS = Colors.COLORS;

// Move a square with the arrow keys or WASD. Demonstrates key input
// (handleKeyDown/handleKeyUp) and a tick loop for smooth movement.
class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '142',
            author: 'Unknown',
            description: 'Move a square with the arrow keys or WASD',
            // 15-30 is the sweet spot: every tick re-broadcasts the whole tree.
            tickRate: 30
        };
    }

    constructor() {
        super();
        this.keysDown = {};
        this.speed = 1;
        this.size = 10;

        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: COLORS.WHITE
        });

        this.player = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(45, 45, this.size, this.size),
            fill: COLORS.HG_BLUE
        });
        this.base.addChild(this.player);
    }

    handleKeyDown(playerId, key) {
        this.keysDown[key] = true;
    }

    handleKeyUp(playerId, key) {
        delete this.keysDown[key];
    }

    tick() {
        const coords = this.player.node.coordinates2d;
        let x = coords[0][0];
        let y = coords[0][1];

        if (this.keysDown['ArrowUp'] || this.keysDown['w']) y -= this.speed;
        if (this.keysDown['ArrowDown'] || this.keysDown['s']) y += this.speed;
        if (this.keysDown['ArrowLeft'] || this.keysDown['a']) x -= this.speed;
        if (this.keysDown['ArrowRight'] || this.keysDown['d']) x += this.speed;

        x = Math.max(0, Math.min(100 - this.size, x));
        y = Math.max(0, Math.min(100 - this.size, y));

        if (x !== coords[0][0] || y !== coords[0][1]) {
            this.player.node.coordinates2d = ShapeUtils.rectangle(x, y, this.size, this.size);
            this.player.node.onStateChange();
        }
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
    'multiplayer': {
        label: "Multiplayer",
        description: "Track players, give each a color, and show a live roster.",
        files: {
            'index.js': `const { Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-142');
const COLORS = Colors.COLORS;

// Tracks connected players, gives each a color, and shows a live roster.
// Clicking drops a dot in your own color. Demonstrates player lifecycle,
// per-player state, text, and per-player visibility (playerIds).
class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '142',
            author: 'Unknown',
            description: 'Tracks players and gives each their own color'
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
                    fill: player.color
                });
                this.base.addChild(dot);
            }
        });

        // Holds the roster of player badges/labels.
        this.rosterNode = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 0, 0)
        });
        this.base.addChild(this.rosterNode);
    }

    handleNewPlayer({ playerId, info }) {
        this.players[playerId] = {
            color: Colors.randomColor(),
            name: (info && info.name) || ('Player ' + playerId)
        };
        this.renderRoster();
    }

    handlePlayerDisconnect(playerId) {
        delete this.players[playerId];
        this.renderRoster();
    }

    renderRoster() {
        this.rosterNode.clearChildren();
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
                    text: p.name,
                    x: 7,
                    y: y + 0.5,
                    size: 1.2,
                    align: 'left',
                    color: COLORS.BLACK
                }
            });
            // Only the player it belongs to sees the "(you)" marker.
            const youMarker = new GameNode.Text({
                textInfo: {
                    text: '(you)',
                    x: 20,
                    y: y + 0.5,
                    size: 1.2,
                    align: 'left',
                    color: p.color
                },
                playerIds: [Number(id)]
            });
            this.rosterNode.addChildren(badge, label, youMarker);
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
    'text-input': {
        label: "Text Input",
        description: "Type into a box and show the text on screen.",
        files: {
            'index.js': `const { Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-142');
const COLORS = Colors.COLORS;

// Click the blue box and type — your text shows on screen. Demonstrates
// text rendering and a text input field (input: { type: 'text' }).
class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '142',
            author: 'Unknown',
            description: 'Type into a box and display the text'
        };
    }

    constructor() {
        super();
        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: COLORS.WHITE
        });

        this.label = new GameNode.Text({
            textInfo: {
                text: 'Click the box and type',
                x: 50,
                y: 60,
                size: 3,
                align: 'center',
                color: COLORS.BLACK
            }
        });

        this.inputBox = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(35, 20, 30, 15),
            fill: COLORS.HG_BLUE,
            input: {
                type: 'text',
                oninput: (playerId, text) => {
                    // The live field is node.text (textInfo is only the constructor arg).
                    this.label.node.text = Object.assign({}, this.label.node.text, {
                        text: text && text.length ? text : 'Click the box and type'
                    });
                    this.label.node.onStateChange();
                }
            }
        });

        this.base.addChild(this.label);
        this.base.addChild(this.inputBox);
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
    'image': {
        label: "Image Upload",
        description: "Upload an image from your device and display it.",
        files: {
            'index.js': `const { Asset, Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-142');
const COLORS = Colors.COLORS;

// Click the box to upload an image from your device, then it's drawn on
// screen. Demonstrates user-uploaded image assets via input: { type: 'file' }
// together with the addAsset() callback and getAssets().
class MyGame extends Game {
    constructor({ addAsset }) {
        super();
        this.addAsset = addAsset;
        // Holds assets the player uploads at runtime.
        this.assets = {};
        this.uploadCount = 0;
        this.imageNode = null;

        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: COLORS.WHITE
        });

        this.label = new GameNode.Text({
            textInfo: {
                text: 'Click the box to upload an image',
                x: 50,
                y: 12,
                size: 2.5,
                align: 'center',
                color: COLORS.BLACK
            }
        });

        this.uploadButton = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(40, 20, 20, 12),
            fill: COLORS.HG_BLUE,
            input: {
                type: 'file',
                oninput: (playerId, data) => {
                    const key = 'upload' + (++this.uploadCount);
                    // The second arg is the raw uploaded file data.
                    this.assets[key] = new Asset({ id: key, type: 'image' }, data);
                    // Register the asset, then draw it once it's available.
                    this.addAsset(key, this.assets[key]).then(() => {
                        if (this.imageNode) {
                            this.base.removeChild(this.imageNode.node.id);
                        }
                        this.imageNode = new GameNode.Asset({
                            coordinates2d: ShapeUtils.rectangle(30, 40, 40, 50),
                            assetInfo: {
                                [key]: {
                                    pos: { x: 30, y: 40 },
                                    size: { x: 40, y: 50 }
                                }
                            }
                        });
                        this.base.addChild(this.imageNode);
                    });
                }
            }
        });

        this.base.addChild(this.label);
        this.base.addChild(this.uploadButton);
    }

    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '142',
            author: 'Unknown',
            description: 'Upload an image and display it'
        };
    }

    handleNewPlayer({ playerId }) {
    }

    handlePlayerDisconnect(playerId) {
    }

    getLayers() {
        return [{ root: this.base }];
    }

    getAssets() {
        return this.assets;
    }
}

module.exports = MyGame;
`
        }
    },
    'animation': {
        label: "Animation",
        description: "A bouncing, color-cycling square driven by a tick loop.",
        files: {
            'index.js': `const { Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-142');
const COLORS = Colors.COLORS;

// A square bounces around the screen and pulses through colors every tick.
// Demonstrates a tick loop driving animation and onStateChange().
class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '142',
            author: 'Unknown',
            description: 'A bouncing, color-cycling square',
            tickRate: 30
        };
    }

    constructor() {
        super();
        this.size = 12;
        this.pos = { x: 20, y: 20 };
        this.vel = { x: 1.2, y: 0.9 };
        this.hue = 0;

        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: COLORS.WHITE
        });

        this.mover = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(this.pos.x, this.pos.y, this.size, this.size),
            fill: Colors.randomColor()
        });
        this.base.addChild(this.mover);
    }

    tick() {
        this.pos.x += this.vel.x;
        this.pos.y += this.vel.y;

        if (this.pos.x <= 0 || this.pos.x >= 100 - this.size) {
            this.vel.x *= -1;
            this.pos.x = Math.max(0, Math.min(100 - this.size, this.pos.x));
        }
        if (this.pos.y <= 0 || this.pos.y >= 100 - this.size) {
            this.vel.y *= -1;
            this.pos.y = Math.max(0, Math.min(100 - this.size, this.pos.y));
        }

        // Cycle the color smoothly through red/green/blue.
        this.hue = (this.hue + 4) % 360;
        const t = this.hue / 60;
        const r = Math.round(127 + 127 * Math.sin(t));
        const g = Math.round(127 + 127 * Math.sin(t + 2));
        const b = Math.round(127 + 127 * Math.sin(t + 4));

        this.mover.node.coordinates2d = ShapeUtils.rectangle(this.pos.x, this.pos.y, this.size, this.size);
        this.mover.node.fill = [r, g, b, 255];
        this.mover.node.onStateChange();
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
    'scroll': {
        label: "Scrolling World",
        description: "Pan a camera around a world larger than the screen.",
        files: {
            'index.js': 
`const { ViewableGame, GameNode, Colors, Shapes, ShapeUtils, ViewUtils, Asset } = require('squish-142');
const COLORS = Colors.COLORS;

// A world larger than the screen; each player pans their own camera with
// WASD. Demonstrates ViewableGame, a world plane, and per-player views.
class MyGame extends ViewableGame {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '142',
            author: 'Unknown',
            description: 'Scroll a camera around a large world with WASD',
            assets: {
              'fella': new Asset({ id: 'f6f6df5eb5daa2313485a543679e5b38', type: 'image' })
            }
        };
    }

    constructor() {
        // The world is 200x200; each player sees a 100x100 window into it.
        super(200);
        this.worldSize = 200;
        this.viewSize = 100;
        this.step = 2;
        this.playerViews = {};

        const worldBase = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, this.worldSize, this.worldSize),
            fill: COLORS.WHITE
        });

        // Scatter some landmarks so movement is visible.
        const colors = [COLORS.RED, COLORS.BLUE, COLORS.GREEN, COLORS.PURPLE, COLORS.HG_YELLOW];
        let i = 0;
        for (let x = 10; x < this.worldSize; x += 50) {
            for (let y = 10; y < this.worldSize; y += 50) {
                worldBase.addChild(new GameNode.Shape({
                    shapeType: Shapes.POLYGON,
                    coordinates2d: ShapeUtils.rectangle(x, y, 20, 20),
                    fill: colors[(i++) % colors.length]
                }));
            }
        }

        const image = new GameNode.Asset({
        coordinates2d: ShapeUtils.rectangle(150, 150, 40, 40),
          assetInfo: {
            'fella': { pos: { x: 150, y: 150 }, size: { x: 40, y: 40 } }
          }
        });
        
        worldBase.addChild(image);

        this.getPlane().addChild(worldBase);
    }

    handleNewPlayer({ playerId }) {
        const view = { x: 0, y: 0, w: this.viewSize, h: this.viewSize };

        // A stable per-player root that holds the current view slice.
        const viewRoot = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, this.viewSize, this.viewSize),
            fill: COLORS.WHITE,
            playerIds: [playerId]
        });

        const slice = ViewUtils.getView(this.getPlane(), view, [playerId]);
        slice.node.playerIds = [playerId];
        viewRoot.addChild(slice);

        this.playerViews[playerId] = { view, viewRoot };
        this.getViewRoot().addChild(viewRoot);
    }

    handleKeyDown(playerId, key) {
        const pv = this.playerViews[playerId];
        if (!pv) return;

        const view = Object.assign({}, pv.view);
        if (key === 'w' || key === 'ArrowUp') view.y = Math.max(0, view.y - this.step);
        if (key === 's' || key === 'ArrowDown') view.y = Math.min(this.worldSize - view.h, view.y + this.step);
        if (key === 'a' || key === 'ArrowLeft') view.x = Math.max(0, view.x - this.step);
        if (key === 'd' || key === 'ArrowRight') view.x = Math.min(this.worldSize - view.w, view.x + this.step);

        const slice = ViewUtils.getView(this.getPlane(), view, [playerId]);
        pv.view = view;
        pv.viewRoot.node.clearChildren();
        pv.viewRoot.node.addChild(slice);
        pv.viewRoot.node.onStateChange();
    }

    handlePlayerDisconnect(playerId) {
        const pv = this.playerViews[playerId];
        if (pv && pv.viewRoot) {
            this.getViewRoot().removeChild(pv.viewRoot.node.id);
        }
        delete this.playerViews[playerId];
    }
}

module.exports = MyGame;
`
        }
    },
    'buttons': {
        label: "Buttons",
        description: "Clickable buttons with labels, and showing/hiding via playerIds.",
        files: {
            'index.js': `const { Game, GameNode, Colors, Shapes, ShapeUtils } = require('squish-142');
const COLORS = Colors.COLORS;

// A button is a clickable Shape with a Text label on top (Text nodes can't
// receive clicks). Also shows hiding a node from everyone with
// playerIds = [0] and bringing it back with [] (empty = visible to all).
class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 16, y: 9 },
            squishVersion: '142',
            author: 'Unknown',
            description: 'Buttons: clickable shapes with text labels'
        };
    }

    constructor() {
        super();
        this.count = 0;

        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: COLORS.WHITE
        });

        this.counterText = new GameNode.Text({
            textInfo: { text: 'Clicks: 0', x: 50, y: 20, size: 4, align: 'center', color: COLORS.BLACK }
        });
        this.base.addChild(this.counterText);

        this.clickButton = this.makeButton('CLICK ME', 24, 50, 24, 16, COLORS.HG_BLUE, () => {
            this.count++;
            this.updateUi();
        });
        this.resetButton = this.makeButton('RESET', 52, 50, 24, 16, COLORS.CANDY_RED, () => {
            this.count = 0;
            this.updateUi();
        });
        this.base.addChildren(this.clickButton, this.resetButton);

        // Start with RESET hidden ([0] = visible to NOBODY).
        this.setVisible(this.resetButton, false);
    }

    makeButton(label, x, y, w, h, fill, onClick) {
        const bg = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(x, y, w, h),
            fill,
            onClick    // the SHAPE is what's clickable
        });
        bg.addChild(new GameNode.Text({
            textInfo: { text: label, x: x + w / 2, y: y + h / 2 - 1.8, size: 2, align: 'center', color: COLORS.WHITE }
        }));
        return bg;
    }

    // playerIds applies per node, so set it on the button AND its label.
    setVisible(button, visible) {
        const ids = visible ? [] : [0];
        button.node.playerIds = ids;
        button.node.children.forEach(child => { child.node.playerIds = ids; });
    }

    updateUi() {
        this.counterText.node.text = Object.assign({}, this.counterText.node.text, {
            text: 'Clicks: ' + this.count
        });
        this.setVisible(this.resetButton, this.count > 0);
        this.base.node.onStateChange();
    }

    getLayers() {
        return [{ root: this.base }];
    }
}

module.exports = MyGame;
`
        }
    },
    'glow': {
        label: "Glow & Fade",
        description: "Neon glow with effects.shadow, and fading via color alpha.",
        files: {
            'index.js': `const { Game, GameNode, Shapes, ShapeUtils } = require('squish-142');

// Glow comes from effects: { shadow: { color, blur } } on Shape/Asset nodes.
// Fading uses the color field's alpha (fill alpha renders all-or-nothing).
class MyGame extends Game {
    static metadata() {
        return {
            aspectRatio: { x: 1, y: 1 },
            squishVersion: '142',
            author: 'Unknown',
            description: 'Neon glow and fading shapes',
            tickRate: 20
        };
    }

    constructor() {
        super();
        this.t = 0;

        // Glow reads best on a dark background.
        this.base = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(0, 0, 100, 100),
            fill: [10, 10, 25, 255]
        });

        const glow = (color, blur) => ({ shadow: { color, blur } });

        // A steady glow.
        this.base.addChild(new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(15, 40, 18, 18),
            fill: [0, 255, 255, 255],
            effects: glow([0, 255, 255, 255], 12)
        }));

        // A pulsing glow (blur animated in tick()).
        this.pulse = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(41, 40, 18, 18),
            fill: [255, 0, 255, 255],
            effects: glow([255, 0, 255, 255], 10)
        });
        this.base.addChild(this.pulse);

        // A fading shape: color alpha is what actually fades a node on screen.
        this.ember = new GameNode.Shape({
            shapeType: Shapes.POLYGON,
            coordinates2d: ShapeUtils.rectangle(67, 40, 18, 18),
            fill: [255, 150, 40, 255],
            color: [255, 150, 40, 255]   // fade by animating THIS alpha
        });
        this.base.addChild(this.ember);
    }

    tick() {
        this.t++;

        // Pulse: oscillate the shadow blur.
        this.pulse.node.effects.shadow.blur = 10 + Math.round(8 * Math.sin(this.t / 4));

        // Fade out over 2 seconds, then reset.
        const frac = 1 - (this.t % 40) / 40;
        this.ember.node.color = [255, 150, 40, Math.round(255 * frac)];

        this.base.node.onStateChange();
    }

    getLayers() {
        return [{ root: this.base }];
    }
}

module.exports = MyGame;
`
        }
    },
};

// Normalize source so trivial whitespace/line-ending differences don't matter
// when comparing against the unmodified starter templates.
const normalizeSource = (s) => (s || '').replace(/\r\n/g, '\n').trim();

// Pre-computed set of every template's index.js, normalized, so we can cheaply
// detect a game whose code is still byte-identical to a starter template.
const STARTER_INDEX_SOURCES = new Set(
    Object.values(GAME_TEMPLATES)
        .map(t => t.files && t.files['index.js'])
        .filter(Boolean)
        .map(normalizeSource)
);

// True if the given index.js content is unchanged from one of the starter
// templates. Used to require at least one edit before a game can be published.
const isUnmodifiedStarterTemplate = (source) =>
    STARTER_INDEX_SOURCES.has(normalizeSource(source));

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

// Template file contents. Public — lets the Studio's guest mode load a
// template into the in-browser editor without an account.
const handleGetTemplateFiles = (req, res, templateId) => {
    const tmpl = GAME_TEMPLATES[templateId];
    if (!tmpl) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown template: ' + templateId }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: templateId, label: tmpl.label, files: tmpl.files }));
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

            const [owner, repo] = game.forgejoRepo.split('/');

            // Require at least one change from the starter template before
            // publishing — keeps blank/unmodified starter games out of the catalog.
            getFileContents(owner, repo, 'index.js', commitSha).then(fileData => {
                const source = Buffer.from(fileData.content, 'base64').toString('utf8');
                if (isUnmodifiedStarterTemplate(source)) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'This game is still the unmodified starter template. Make at least one change before publishing.' }));
                    return;
                }
                proceed();
            }).catch(err => {
                console.error('Failed to read index.js for template check', err);
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Could not read index.js for this version' }));
            });

            function proceed() {
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
            } // end proceed()
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
    const { AI_EDITS_ENABLED } = require('./config');
    if (!AI_EDITS_ENABLED) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'AI game editing is currently disabled' }));
        return;
    }

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

        // Optional mode: 'CREATE' means "write a new game from the starter
        // template" (used by the new-game flow); absent means an edit request.
        const mode = body.mode || undefined;
        if (mode && mode !== 'CREATE') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid mode' }));
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
                                if (mode) record.mode = mode;

                                collection.insertOne(record).then(() => {
                                    const amqp = require('amqplib/callback_api');
                                    const { QUEUE_HOST, JOB_QUEUE_NAME } = require('./config');

                                    let responded = false;
                                    const respond = (queued) => {
                                        if (responded) return;
                                        responded = true;
                                        res.writeHead(200, { 'Content-Type': 'application/json' });
                                        res.end(JSON.stringify({ requestId, status: 'PENDING', queued }));
                                    };

                                    // frameMax=0 keeps the broker's offered frame size; with
                                    // amqplib's 4096 default this broker ECONNRESETs mid-handshake
                                    // (see worker/index.js). The LLM source can be large, so this
                                    // matters here more than for the small cert/image publishes.
                                    amqp.connect(`amqp://${QUEUE_HOST}?frameMax=0`, (cErr, conn) => {
                                        if (cErr) {
                                            console.error('Failed to connect to queue', cErr);
                                            respond(false);
                                            return;
                                        }

                                        // Without this, a post-connect socket error throws unhandled.
                                        conn.on('error', (e) => { console.error('Queue connection error', e); respond(false); });

                                        // Confirm channel: the broker acks receipt, so we only
                                        // report queued:true and close once the message is durably
                                        // enqueued. The old fire-and-forget sendToQueue +
                                        // setTimeout(close, 500) silently dropped large messages
                                        // whose frames hadn't flushed before the connection closed.
                                        conn.createConfirmChannel((chErr, channel) => {
                                            if (chErr) {
                                                console.error('Failed to create channel', chErr);
                                                respond(false);
                                                try { conn.close(); } catch (e) {}
                                                return;
                                            }

                                            // LLM jobs ride the unified homegames-jobs queue as a
                                            // typed message; the consolidated worker dispatches on `type`.
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
                                                    mode,
                                                })),
                                                { persistent: true },
                                                (confErr) => {
                                                    if (confErr) {
                                                        console.error(`LLM publish NACKed for ${requestId}`, confErr);
                                                        respond(false);
                                                    } else {
                                                        console.log(`LLM request ${requestId} enqueued for ${gameId}`);
                                                        respond(true);
                                                    }
                                                    channel.close(() => { try { conn.close(); } catch (e) {} });
                                                }
                                            );
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
                // Results are committed to the repo on completion, so the list
                // (polled by the studio) doesn't carry the source blobs.
                res.end(JSON.stringify({ requests: requests.map(r => ({ ...project(r), result: undefined })) }));
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
// Cancel an in-flight LLM request. The queued job itself isn't recalled — the
// worker still runs it — but the record goes CANCELLED, so the result posted
// back later matches nothing in-flight and is discarded without committing.
// ---------------------------------------------------------------------------

const handleCancelLLMRequest = (req, res, userId, gameId) => {
    getReqBody(req, (_body, err) => {
        if (err) { res.writeHead(400); res.end('Error reading request'); return; }

        let body;
        try { body = JSON.parse(_body); } catch (e) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
        }

        const requestId = body.id;
        if (!requestId) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'id is required' }));
            return;
        }

        getGame(gameId).then(game => {
            if (game.developerId !== userId) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'Not your game' }));
                return;
            }

            getMongoCollection('llmRequests').then(collection => {
                collection.updateOne(
                    { requestId, gameId, status: { $in: ['PENDING', 'PROCESSING'] } },
                    { '$set': { status: 'CANCELLED', completedAt: Date.now() } }
                ).then(r => {
                    if (r.matchedCount === 0) {
                        res.writeHead(409);
                        res.end(JSON.stringify({ error: 'Request is not in progress' }));
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
        }).catch(() => {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Game not found' }));
        });
    });
};

// ---------------------------------------------------------------------------
// Result ingestion from the self-hosted MLX worker.
// Authenticated with the shared LLM_WORKER_SECRET, not a user JWT.
// A COMPLETED result is committed to the game's repo as a new version before
// the record is marked done — the user's prompt is the commit message, so the
// version history reads as what they asked for. The studio locks the editor
// while a request is open, so committing over HEAD is safe.
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
            // Only in-flight requests accept a result: a job the user cancelled
            // (or a duplicate delivery) matches nothing and is discarded.
            const finish = (update, done) => {
                collection.updateOne(
                    { requestId, status: { $in: ['PENDING', 'PROCESSING'] } },
                    { '$set': { ...update, completedAt: Date.now() } }
                ).then(r => done(null, r.matchedCount > 0)).catch(dbErr => done(dbErr));
            };
            const respond = (dbErr, matched) => {
                if (dbErr) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Database error' }));
                } else if (!matched) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'No in-flight request with that id' }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                }
            };

            if (status === 'FAILED') {
                finish({ status: 'FAILED', error: error || 'Unknown error' }, respond);
                return;
            }

            collection.findOne({ requestId, status: { $in: ['PENDING', 'PROCESSING'] } }).then(record => {
                if (!record) { respond(null, false); return; }

                getGame(record.gameId).then(game => {
                    if (!game.forgejoRepo) {
                        finish({ status: 'FAILED', result, error: 'Game has no repository' }, respond);
                        return;
                    }
                    const [owner, repo] = game.forgejoRepo.split('/');
                    // The update API needs the file's sha at HEAD (not
                    // record.baseSha), and index.js may not exist yet for a
                    // CREATE-mode game — null sha means "create it".
                    getFileContents(owner, repo, 'index.js')
                        .then(fileData => fileData.sha)
                        .catch(() => null)
                        .then(sha => createOrUpdateFile(owner, repo, 'index.js', result, record.prompt, sha))
                        .then(commitResult => {
                            // A cancel that races the commit leaves the record
                            // CANCELLED with the commit already landed; the user
                            // can restore the previous version.
                            finish({
                                status: 'COMPLETED',
                                result,
                                commitSha: commitResult?.commit?.sha || null,
                            }, respond);
                        })
                        .catch(commitErr => {
                            console.error(`Failed to commit LLM result for ${requestId}`, commitErr);
                            finish({ status: 'FAILED', result, error: 'The AI edit finished but saving it failed' }, respond);
                        });
                }).catch(() => {
                    finish({ status: 'FAILED', result, error: 'Game not found' }, respond);
                });
            }).catch(dbErr => respond(dbErr));
        }).catch(() => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Database error' }));
        });
    });
};

module.exports = {
    handleStudioCreateGame,
    handleGetTemplates,
    handleGetTemplateFiles,
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
    handleCancelLLMRequest,
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
