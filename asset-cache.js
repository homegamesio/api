// ---------------------------------------------------------------------------
// In-memory LRU cache for served asset binaries, bounded by total bytes.
//
// Keyed by assetId; each entry holds the ready-to-serve payload (buffer +
// headers) so a cache hit in handleGetAsset avoids BOTH Mongo reads (the
// `assets` metadata lookup and the `documents` binary lookup). This offloads
// hot static-image traffic from the DB we share with the API.
//
// Bounded by TOTAL BYTES rather than item count: asset uploads can be up to
// MAX_SIZE (6MB), so a fixed "100 items" budget would have an unpredictable
// (and potentially huge) memory footprint. We also refuse to cache any single
// item larger than MAX_ITEM_BYTES so one big file can't evict many small ones.
//
// NOTE: this cache is per-process. If the API is ever scaled to multiple
// instances each keeps its own cache (lower aggregate hit rate, still correct).
// HTTP Cache-Control/ETag headers (set by the caller) help regardless.
// ---------------------------------------------------------------------------

const MAX_BYTES = 192 * 1024 * 1024;   // total cache budget (~192MB)
const MAX_ITEM_BYTES = 1 * 1024 * 1024; // never cache a single item over 1MB

// Map preserves insertion order, so we treat the first key as least-recently
// used and re-insert on read to mark an entry most-recently used.
const cache = new Map(); // assetId -> { buffer, contentType, name, etag, size }
let totalBytes = 0;

const get = (assetId) => {
    const entry = cache.get(assetId);
    if (!entry) return null;
    // Move to most-recently-used position.
    cache.delete(assetId);
    cache.set(assetId, entry);
    return entry;
};

const set = (assetId, entry) => {
    if (!entry || !entry.buffer) return;
    const size = entry.size != null ? entry.size : entry.buffer.length;
    if (size > MAX_ITEM_BYTES) return; // too big to be worth caching
    // Drop any existing entry's byte accounting before replacing it.
    const existing = cache.get(assetId);
    if (existing) {
        totalBytes -= existing.size;
        cache.delete(assetId);
    }
    entry.size = size;
    cache.set(assetId, entry);
    totalBytes += size;
    // Evict least-recently-used entries until we're back under budget.
    while (totalBytes > MAX_BYTES && cache.size > 0) {
        const oldestKey = cache.keys().next().value;
        totalBytes -= cache.get(oldestKey).size;
        cache.delete(oldestKey);
    }
};

const del = (assetId) => {
    const entry = cache.get(assetId);
    if (entry) {
        totalBytes -= entry.size;
        cache.delete(assetId);
    }
};

// Evict every entry matching a predicate (e.g. all of one developer's assets
// when that developer is deleted). Deleting during Map iteration is safe.
const evictBy = (predicate) => {
    for (const [assetId, entry] of cache) {
        if (predicate(entry)) {
            totalBytes -= entry.size;
            cache.delete(assetId);
        }
    }
};

const stats = () => ({ items: cache.size, totalBytes, maxBytes: MAX_BYTES });

module.exports = { get, set, del, evictBy, stats, MAX_BYTES, MAX_ITEM_BYTES };
