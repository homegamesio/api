/**
 * Local play support: lets published single-player games run entirely in the
 * player's browser (via homegames-client's LocalSession) with no game server.
 *
 * Pure logic only — no Mongo/Forgejo access — so it can be tested in
 * isolation. The handlers in handlers.js glue this to storage:
 *   - parseGameSourceMetadata: statically extract metadata() facts from game
 *     source (no code execution on the API, ever)
 *   - packAssetBundle: build the binary type-1 asset bundle, byte-identical
 *     to what squish's Squisher.initialize() sends a connected client
 *   - buildLocalHtml: compose a self-contained offline-playable HTML file
 */

const acorn = require('acorn');

// ---------------------------------------------------------------------------
// Static metadata extraction
// ---------------------------------------------------------------------------

const _walk = (node, visit) => {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) {
                if (child && typeof child.type === 'string') _walk(child, visit);
            }
        } else if (value && typeof value.type === 'string') {
            _walk(value, visit);
        }
    }
};

const _propName = (prop) => {
    if (!prop.key) return null;
    return prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
};

const _literal = (node) => (node && node.type === 'Literal') ? node.value : undefined;

/**
 * Extracts { squishVersion, name, services, assets } from a game's entry
 * source by finding `static metadata()` and reading literal values out of its
 * returned object. Values that aren't static literals are simply omitted.
 * Returns { error } if the source doesn't parse or has no metadata method.
 */
const parseGameSourceMetadata = (source) => {
    let ast;
    try {
        ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    } catch (e) {
        try {
            ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
        } catch (e2) {
            return { error: 'Source does not parse: ' + e2.message };
        }
    }

    let metadataReturn = null;
    _walk(ast, (node) => {
        if (metadataReturn) return;
        if (node.type === 'MethodDefinition' && node.static && node.key
            && (node.key.name === 'metadata' || node.key.value === 'metadata')) {
            _walk(node.value, (inner) => {
                if (!metadataReturn && inner.type === 'ReturnStatement'
                    && inner.argument && inner.argument.type === 'ObjectExpression') {
                    metadataReturn = inner.argument;
                }
            });
        }
    });

    if (!metadataReturn) {
        return { error: 'No static metadata() returning an object literal found' };
    }

    const meta = { squishVersion: null, name: null, services: [], assets: [] };

    for (const prop of metadataReturn.properties) {
        const key = _propName(prop);
        if (key === 'squishVersion') {
            meta.squishVersion = _literal(prop.value) || null;
        } else if (key === 'name') {
            meta.name = _literal(prop.value) || null;
        } else if (key === 'services' && prop.value.type === 'ArrayExpression') {
            meta.services = prop.value.elements.map(_literal).filter(Boolean);
        } else if (key === 'assets' && prop.value.type === 'ObjectExpression') {
            // Keyed map, not array: duplicate keys in the object literal must
            // resolve last-wins, matching what the runtime object holds.
            const assetsByKey = {};
            for (const assetProp of prop.value.properties) {
                const assetKey = _propName(assetProp);
                const v = assetProp.value;
                if (v && v.type === 'NewExpression' && v.arguments && v.arguments[0]
                    && v.arguments[0].type === 'ObjectExpression') {
                    const info = {};
                    for (const infoProp of v.arguments[0].properties) {
                        info[_propName(infoProp)] = _literal(infoProp.value);
                    }
                    if (assetKey && info.id) {
                        assetsByKey[assetKey] = { key: assetKey, id: info.id, type: info.type || 'image' };
                    }
                }
            }
            meta.assets = Object.values(assetsByKey);
        }
    }

    return meta;
};

/**
 * Whether a game is eligible to run client-side. Games are single-player by
 * default; declaring a service the local runtime can't provide opts out.
 */
const checkLocalPlayable = (meta) => {
    if (meta.error) return { playable: false, reason: meta.error };
    if (meta.services.includes('multiplayer')) {
        return { playable: false, reason: 'Game requires multiplayer' };
    }
    if (meta.services.includes('contentGenerator')) {
        return { playable: false, reason: 'Game requires the contentGenerator service' };
    }
    return { playable: true };
};

// Downloads are more permissive than instant play: multiplayer games may be
// downloaded (they run as a solo local session — the UI notes that
// multiplayer features won't work), but games that structurally can't run
// (parse failures, services with no local fallback) may not.
const checkDownloadable = (meta) => {
    if (meta.error) return { downloadable: false, reason: meta.error };
    if (meta.services.includes('contentGenerator')) {
        return { downloadable: false, reason: 'Game requires the contentGenerator service' };
    }
    return { downloadable: true };
};

// ---------------------------------------------------------------------------
// Asset bundle packing — must stay byte-identical to Squisher.initialize()
// in squish (src/Squisher.js): per asset a 44-byte header
// [1, typeByte, 10-byte base36 length of (data+32), 32-byte key] + data.
// ---------------------------------------------------------------------------

const ASSET_TYPE_BYTES = { image: 1, audio: 2, font: 3 };

const packAssetBundle = (entries) => {
    const perAsset = entries.map(({ key, type, data }) => {
        const assetKeyLength = 32;
        const encodedMaxLength = 10;
        const headerLength = 2 + encodedMaxLength + assetKeyLength;
        const assetBuf = Buffer.alloc(headerLength + data.length);

        assetBuf[0] = 1;
        assetBuf[1] = ASSET_TYPE_BYTES[type] || ASSET_TYPE_BYTES.image;

        const encodedLength = (data.length + assetKeyLength).toString(36);
        const padLen = encodedMaxLength - encodedLength.length;
        for (let i = 0; i < padLen; i++) {
            assetBuf[2 + i] = 48; // '0'
        }
        for (let i = 0; i < encodedLength.length; i++) {
            assetBuf[2 + padLen + i] = encodedLength.charCodeAt(i);
        }

        const keyWriteLen = Math.min(assetKeyLength, key.length);
        for (let i = 0; i < keyWriteLen; i++) {
            assetBuf[2 + encodedMaxLength + i] = key.charCodeAt(i);
        }

        data.copy(assetBuf, headerLength);
        return assetBuf;
    });

    return Buffer.concat(perAsset);
};

// ---------------------------------------------------------------------------
// Single-file HTML composition
// ---------------------------------------------------------------------------

// </script> (and friends) inside JSON would terminate the inline script tag;
// < is the JSON-safe universal escape.
const _jsonForInlineScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const buildLocalHtml = ({ name, files, entryPoint, assetBundleBase64, clientBundleSource }) => {
    const payload = _jsonForInlineScript({
        name: name || 'Homegames',
        files,
        entryPoint,
        assetBundleBase64: assetBundleBase64 || null,
    });

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${(name || 'Homegames').replace(/</g, '&lt;')}</title>
<style>
html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
#homegames-main { width: 100vw; height: 100vh; }
</style>
</head>
<body>
<div id="homegames-main"></div>
<script>
${clientBundleSource}
</script>
<script>
window.__HG_LOCAL_GAME__ = ${payload};
</script>
<script>
(function() {
    var payload = window.__HG_LOCAL_GAME__;
    var assetBundle = null;
    if (payload.assetBundleBase64) {
        var bin = atob(payload.assetBundleBase64);
        assetBundle = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) assetBundle[i] = bin.charCodeAt(i);
    }
    var session = new HomegamesClient.LocalSession({
        containerId: 'homegames-main',
        files: payload.files,
        entryPoint: payload.entryPoint,
        assetBundle: assetBundle,
        onError: function(err) {
            console.error(err);
            var el = document.createElement('div');
            el.style.cssText = 'position:absolute;top:0;width:100%;text-align:center;color:#fff;font:16px monospace;padding:20px;';
            el.textContent = 'Error: ' + ((err && err.message) || err);
            document.body.appendChild(el);
        }
    });
    session.start();
})();
</script>
</body>
</html>`;
};

module.exports = {
    parseGameSourceMetadata,
    checkLocalPlayable,
    checkDownloadable,
    packAssetBundle,
    buildLocalHtml,
};
