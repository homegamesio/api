const http = require('http');
const { FORGEJO_URL, FORGEJO_ADMIN_TOKEN } = require('./config');

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
    return forgejoRequest('POST', `/admin/users/${ownerUsername}/repos`, {
        name: repoName,
        description: `Homegames game: ${repoName}`,
        private: false,
        auto_init: true,
        default_branch: 'main',
    });
};

const createWebhook = (owner, repo, webhookUrl) => {
    return forgejoRequest('POST', `/repos/${owner}/${repo}/hooks`, {
        type: 'forgejo',
        active: true,
        config: {
            url: webhookUrl,
            content_type: 'json',
        },
        events: ['push'],
    });
};

const deleteRepo = (owner, repo) => {
    return forgejoRequest('DELETE', `/repos/${owner}/${repo}`);
};

// ---------------------------------------------------------------------------
// File operations (all via admin token)
// ---------------------------------------------------------------------------

const getFileTree = (owner, repo, branch) => {
    return forgejoRequest('GET', `/repos/${owner}/${repo}/git/trees/${branch}?recursive=true`);
};

const getFileContents = (owner, repo, filepath, ref) => {
    const refParam = ref ? `?ref=${ref}` : '';
    return forgejoRequest('GET', `/repos/${owner}/${repo}/contents/${filepath}${refParam}`);
};

const createOrUpdateFile = (owner, repo, filepath, content, message, sha) => {
    const body = {
        content: Buffer.from(content).toString('base64'),
        message: message || `Update ${filepath}`,
    };
    if (sha) {
        // Update existing file — requires sha for optimistic concurrency
        body.sha = sha;
        return forgejoRequest('PUT', `/repos/${owner}/${repo}/contents/${filepath}`, body);
    } else {
        // Create new file
        return forgejoRequest('POST', `/repos/${owner}/${repo}/contents/${filepath}`, body);
    }
};

const deleteFile = (owner, repo, filepath, sha, message) => {
    return forgejoRequest('DELETE', `/repos/${owner}/${repo}/contents/${filepath}`, {
        sha,
        message: message || `Delete ${filepath}`,
    });
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
    return forgejoRequest('GET', `/repos/${owner}/${repo}/commits${params}`);
};

const getRepoInfo = (owner, repo) => {
    return forgejoRequest('GET', `/repos/${owner}/${repo}`);
};

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
};
