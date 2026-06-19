const http = require('http');
const fs = require('fs');
const { FORGEJO_URL } = require('./config');

const CREDENTIALS_DIR = process.env.CREDENTIALS_DIRECTORY;
if (!CREDENTIALS_DIR) {
    throw new Error('CREDENTIALS_DIRECTORY environment variable is not set');
}

const FORGEJO_ADMIN_TOKEN = fs.readFileSync(`${CREDENTIALS_DIR}/forgejo-admin-token`, 'utf-8').replace(/[\r\n]+/g, '').trim();
if (!FORGEJO_ADMIN_TOKEN) {
    throw new Error('forgejo-admin-token credential file is empty');
}

const FORGEJO_USER_SECRET = fs.readFileSync(`${CREDENTIALS_DIR}/forgejo-user-secret`, 'utf-8').replace(/[\r\n]+/g, '').trim();
if (!FORGEJO_USER_SECRET) {
    throw new Error('forgejo-user-secret credential file is empty');
}

// Parse FORGEJO_URL into host/port for http.request
const parseForgejoUrl = () => {
    const url = new URL(FORGEJO_URL);
    return {
        hostname: url.hostname,
        port: url.port || 80,
    };
};

// opts.sudo: username — use Sudo header to act as that user (requires admin token)
const forgejoRequest = (method, path, body, opts) => new Promise((resolve, reject) => {
    const { hostname, port } = parseForgejoUrl();
    const bodyStr = body ? JSON.stringify(body) : '';

    const options = {
        hostname,
        port,
        path: `/api/v1${path}`,
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `token ${FORGEJO_ADMIN_TOKEN}`,
        },
    };

    if (opts && opts.sudo) {
        options.headers['Sudo'] = opts.sudo;
    }

    if (body) {
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                    resolve(data ? JSON.parse(data) : {});
                } catch (e) {
                    resolve(data);
                }
            } else {
                reject({ status: res.statusCode, body: data });
            }
        });
    });

    req.on('error', (e) => {
        reject({ message: e.message });
    });

    if (body) {
        req.write(bodyStr);
    }
    req.end();
});

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

const createForgejoUser = (username, email, password) => {
    return forgejoRequest('POST', '/admin/users', {
        username,
        email,
        password,
        must_change_password: false,
        visibility: 'public',
    });
};

// ---------------------------------------------------------------------------
// Repository management (admin creates repos on behalf of users)
// ---------------------------------------------------------------------------

const createRepo = (ownerUsername, repoName) => {
    // Use the user's own repo creation endpoint, with Sudo to act as them.
    // The admin endpoint (/admin/users/:user/repos) rejects Sudo since
    // the impersonated user isn't an admin.
    return forgejoRequest('POST', `/user/repos`, {
        name: repoName,
        description: `Homegames game: ${repoName}`,
        private: false,
        auto_init: true,
        default_branch: 'main',
    }, { sudo: ownerUsername });
};

const createWebhook = (owner, repo, webhookUrl, secret) => {
    const config = {
        url: webhookUrl,
        content_type: 'json',
    };
    if (secret) {
        config.secret = secret;
    }
    return forgejoRequest('POST', `/repos/${owner}/${repo}/hooks`, {
        type: 'forgejo',
        active: true,
        config,
        events: ['push'],
    }, { sudo: owner });
};

const deleteRepo = (owner, repo) => {
    return forgejoRequest('DELETE', `/repos/${owner}/${repo}`, null, { sudo: owner });
};

// ---------------------------------------------------------------------------
// File operations (all via admin token)
// ---------------------------------------------------------------------------

const getFileTree = (owner, repo, branch) => {
    return forgejoRequest('GET', `/repos/${owner}/${repo}/git/trees/${branch}?recursive=true`, null, { sudo: owner });
};

const getFileContents = (owner, repo, filepath, ref) => {
    const refParam = ref ? `?ref=${ref}` : '';
    return forgejoRequest('GET', `/repos/${owner}/${repo}/contents/${filepath}${refParam}`, null, { sudo: owner });
};

const createOrUpdateFile = (owner, repo, filepath, content, message, sha) => {
    const body = {
        content: Buffer.from(content).toString('base64'),
        message: message || `Update ${filepath}`,
    };
    if (sha) {
        // Update existing file — requires sha for optimistic concurrency
        body.sha = sha;
        return forgejoRequest('PUT', `/repos/${owner}/${repo}/contents/${filepath}`, body, { sudo: owner });
    } else {
        // Create new file
        return forgejoRequest('POST', `/repos/${owner}/${repo}/contents/${filepath}`, body, { sudo: owner });
    }
};

const deleteFile = (owner, repo, filepath, sha, message) => {
    return forgejoRequest('DELETE', `/repos/${owner}/${repo}/contents/${filepath}`, {
        sha,
        message: message || `Delete ${filepath}`,
    }, { sudo: owner });
};

// ---------------------------------------------------------------------------
// Admin user management
// ---------------------------------------------------------------------------

const adminEditUser = (username, fields) => {
    // fields can include: password, email, must_change_password, etc.
    return forgejoRequest('PATCH', `/admin/users/${username}`, fields);
};

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

const listCommits = (owner, repo, branch, limit, page) => {
    const params = `?sha=${branch || 'main'}&limit=${limit || 10}&page=${page || 1}`;
    return forgejoRequest('GET', `/repos/${owner}/${repo}/commits${params}`, null, { sudo: owner });
};

const getRepoInfo = (owner, repo) => {
    return forgejoRequest('GET', `/repos/${owner}/${repo}`, null, { sudo: owner });
};

// ---------------------------------------------------------------------------
// Download repo archive as a tar.gz buffer
// Uses Forgejo's /repos/{owner}/{repo}/archive/{ref}.tar.gz endpoint
// ---------------------------------------------------------------------------
const downloadArchive = (owner, repo, ref) => new Promise((resolve, reject) => {
    const { hostname, port } = parseForgejoUrl();

    const options = {
        hostname,
        port,
        path: `/api/v1/repos/${owner}/${repo}/archive/${ref}.tar.gz`,
        method: 'GET',
        headers: {
            'Authorization': `token ${FORGEJO_ADMIN_TOKEN}`,
        },
    };

    const req = http.request(options, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
            // Follow redirect (Forgejo sometimes redirects archive downloads)
            const redirectUrl = res.headers.location;
            const redirectModule = redirectUrl.startsWith('https') ? require('https') : http;
            redirectModule.get(redirectUrl, (redirectRes) => {
                const bufs = [];
                redirectRes.on('data', (chunk) => bufs.push(chunk));
                redirectRes.on('end', () => resolve(Buffer.concat(bufs)));
            }).on('error', reject);
            return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => reject({ status: res.statusCode, body }));
            return;
        }

        const bufs = [];
        res.on('data', (chunk) => bufs.push(chunk));
        res.on('end', () => resolve(Buffer.concat(bufs)));
    });

    req.on('error', reject);
    req.end();
});

module.exports = {
    forgejoRequest,
    createForgejoUser,
    adminEditUser,
    createRepo,
    createWebhook,
    deleteRepo,
    getFileTree,
    getFileContents,
    createOrUpdateFile,
    deleteFile,
    listCommits,
    getRepoInfo,
    downloadArchive,
    FORGEJO_USER_SECRET,
};
