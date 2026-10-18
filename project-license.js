'use strict';
const fs = require('node:fs');
const path = require('node:path');
const normalize = text => text.replace(/\r\n?/g, '\n').trim();
const gpl = normalize(fs.readFileSync(path.join(__dirname, 'gpl-3.0.txt'), 'utf8'));
const mit = fs.readFileSync(path.join(__dirname, 'LICENSE.md'), 'utf8');
const permission = 'Permission is hereby granted, free of charge';
const mitBody = normalize(mit.slice(mit.indexOf(permission)));

// Retained hosted publishing accepts its existing GPL projects and new MIT
// projects. This recognizes complete license text; it never rewrites a project
// or verifies whether its author owns the submitted source/media.
function supportedProjectLicense(text) {
    if (typeof text !== 'string' || text.length > 65536) return false;
    const value = normalize(text);
    if (value === gpl) return true;
    const start = value.indexOf(permission);
    return start > 0 && /^MIT License\s+Copyright\s+[^\n]+\s*$/i.test(value.slice(0, start))
        && normalize(value.slice(start)) === mitBody;
}
module.exports = { supportedProjectLicense };
