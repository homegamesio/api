'use strict';
const { createHash, randomUUID } = require('crypto');
// A lease prevents concurrent callbacks/cancellation from racing a repository
// write. The saved output and base SHA recover a commit whose response was lost.
async function acceptResult(body, { getMongoCollection, getGame, getFileContents, createOrUpdateFile }) {
    const { requestId, status, result, error } = body || {};
    const response = (code, body, notify) => ({ code, body, notify });
    if (typeof requestId !== 'string' || !/^[\w-]{1,128}$/.test(requestId) || !['COMPLETED', 'FAILED'].includes(status)
        || (status === 'COMPLETED' && (typeof result !== 'string' || result.length > 2000000))) return response(400, { error: 'Invalid result' });
    const collection = await getMongoCollection('llmRequests');
    const record = await collection.findOne({ requestId });
    if (!record) return response(404, { error: 'Unknown request' });
    if (!['PENDING', 'PROCESSING'].includes(record.status)) return response(200, { ok: true, ignored: true });
    const hash = createHash('sha256').update(JSON.stringify({ status, result, error })).digest('hex');
    if (record.resultHash && record.resultHash !== hash) return response(422, { error: 'A different result is already being saved' });
    const owner = randomUUID(), now = Date.now();
    const claimed = await collection.findOneAndUpdate({ requestId, status: { $in: ['PENDING', 'PROCESSING'] },
        $and: [
            { $or: [{ commitLeaseUntil: { $exists: false } }, { commitLeaseUntil: { $lte: now } }] },
            { $or: [{ resultHash: { $exists: false } }, { resultHash: hash }] },
        ] }, { $set: { commitOwner: owner, commitLeaseUntil: now + 120000, resultHash: hash,
            ...(status === 'COMPLETED' ? { result } : {}), status: 'PROCESSING', processingStartedAt: now } },
    { returnDocument: 'after', includeResultMetadata: false });
    if (!claimed) return response(409, { error: 'Result is already being saved; retry shortly' });
    const finish = async update => {
        const r = await collection.updateOne({ requestId, commitOwner: owner }, {
            $set: { ...update, completedAt: Date.now() }, $unset: { commitOwner: '', commitLeaseUntil: '' },
        });
        if (!r.matchedCount) return response(409, { error: 'Save lease changed; retry shortly' });
        return response(200, { ok: true }, { ...claimed, ...update });
    };
    try {
        if (status === 'FAILED') return await finish({ status, error: String(error || 'Generation failed').slice(0, 1000) });
        const game = await getGame(claimed.gameId);
        if (!game?.forgejoRepo) return await finish({ status: 'FAILED', error: 'Game has no repository', result });
        const [repoOwner, repo] = game.forgejoRepo.split('/');
        let head;
        try { head = await getFileContents(repoOwner, repo, 'index.js'); }
        catch (err) { if (err.status !== 404) throw err; head = null; }
        if (head && Buffer.from(head.content, 'base64').toString() === result) {
            // Previous callback committed successfully but never marked the DB.
            return await finish({ status: 'COMPLETED', result, commitSha: null, recoveredCommit: true });
        }
        if ((head?.sha || null) !== (claimed.baseSha || null)) {
            return await finish({ status: 'FAILED', result, error: 'The game changed during generation. Your AI result was saved for review; it was not applied.' });
        }
        const commit = await createOrUpdateFile(repoOwner, repo, 'index.js', result, claimed.prompt, head?.sha || null);
        return await finish({ status: 'COMPLETED', result, commitSha: commit?.commit?.sha || null });
    } catch (err) {
        // Forgejo/network/DB failures are retryable. Retain the result and its
        // lease through the uncertainty window, then compare HEAD on retry.
        return response(503, { error: 'Saving temporarily unavailable; result retained for retry' });
    }
}
module.exports = { acceptResult };
