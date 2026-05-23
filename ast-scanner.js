/**
 * AST-based source code scanner for game validation.
 *
 * Parses JavaScript with acorn and walks the AST to detect dangerous
 * patterns that regex-based scanning cannot reliably catch, such as:
 *   - require() with banned built-in modules
 *   - require() with non-literal (dynamic/computed) arguments
 *   - eval(), Function constructor, process.binding(), etc.
 *   - Access to process.mainModule, process.env, etc.
 *
 * Returns: { safe: true } or { safe: false, errors: [{ msg, line, col }] }
 */

const acorn = require('acorn');
const walk = require('acorn-walk');

// -------------------------------------------------------------------------
// Built-in modules that game code must never require directly.
// Relative paths (./foo) and the squish package are allowed.
// -------------------------------------------------------------------------
const BANNED_MODULES = new Set([
    'child_process',
    'fs', 'fs/promises',
    'net', 'tls', 'dns', 'dgram',
    'http', 'https', 'http2',
    'cluster', 'worker_threads',
    'vm',
    'os',
    'path',           // games shouldn't need raw path — squish handles assets
    'crypto',
    'module',
    'repl',
    'inspector',
    'perf_hooks',
    'trace_events',
    'v8',
    'process',
]);

// -------------------------------------------------------------------------
// Check whether a require argument string is allowed.
// -------------------------------------------------------------------------
const isAllowedRequire = (value) => {
    // Relative paths are fine — game's own files
    if (value.startsWith('./') || value.startsWith('../')) return true;
    // Squish packages (squish-135, squish-0631, etc.)
    if (/^squish-\d+$/.test(value)) return true;
    // Everything else (built-ins, npm packages) is not allowed
    return false;
};

// -------------------------------------------------------------------------
// Scan a single source string. Returns { safe, errors }.
// -------------------------------------------------------------------------
const scanSource = (source, filename) => {
    const errors = [];
    const addError = (msg, node) => {
        const loc = node.loc ? node.loc.start : { line: '?', column: '?' };
        errors.push({ msg, line: loc.line, col: loc.column, file: filename });
    };

    // Parse with acorn. If the file can't be parsed, flag it.
    let ast;
    try {
        ast = acorn.parse(source, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            locations: true,
            allowReturnOutsideFunction: true,
            allowHashBang: true,
        });
    } catch (parseErr) {
        // Try as script (CommonJS)
        try {
            ast = acorn.parse(source, {
                ecmaVersion: 'latest',
                sourceType: 'script',
                locations: true,
                allowReturnOutsideFunction: true,
                allowHashBang: true,
            });
        } catch (parseErr2) {
            return {
                safe: false,
                errors: [{ msg: `Failed to parse: ${parseErr2.message}`, line: parseErr2.loc?.line, col: parseErr2.loc?.column, file: filename }],
            };
        }
    }

    walk.simple(ast, {
        // -----------------------------------------------------------------
        // CallExpression — catches require(), eval(), Function(), 
        // process.binding(), process.dlopen(), etc.
        // -----------------------------------------------------------------
        CallExpression(node) {
            const callee = node.callee;

            // --- require(...) ---
            if (callee.type === 'Identifier' && callee.name === 'require') {
                const arg = node.arguments[0];
                if (!arg) return;

                if (arg.type === 'Literal' && typeof arg.value === 'string') {
                    // Static string argument — check against banned list
                    if (BANNED_MODULES.has(arg.value)) {
                        addError(`require("${arg.value}") is not allowed`, node);
                    } else if (!isAllowedRequire(arg.value)) {
                        addError(`require("${arg.value}") is not an allowed module`, node);
                    }
                } else if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0 && arg.quasis.length === 1) {
                    // Template literal with no interpolation: require(`fs`)
                    const value = arg.quasis[0].value.cooked;
                    if (BANNED_MODULES.has(value)) {
                        addError(`require(\`${value}\`) is not allowed`, node);
                    } else if (!isAllowedRequire(value)) {
                        addError(`require(\`${value}\`) is not an allowed module`, node);
                    }
                } else {
                    // Dynamic/computed require argument — flag it
                    addError('Dynamic require() is not allowed — argument must be a string literal', node);
                }
                return;
            }

            // --- eval(...) ---
            if (callee.type === 'Identifier' && callee.name === 'eval') {
                addError('eval() is not allowed', node);
                return;
            }

            // --- Function(...) as a call (not constructor) ---
            if (callee.type === 'Identifier' && callee.name === 'Function') {
                addError('Function() constructor is not allowed', node);
                return;
            }

            // --- setTimeout/setInterval with string argument ---
            if (callee.type === 'Identifier' && (callee.name === 'setTimeout' || callee.name === 'setInterval')) {
                const arg = node.arguments[0];
                if (arg && (arg.type === 'Literal' && typeof arg.value === 'string') ||
                    (arg && arg.type === 'TemplateLiteral')) {
                    addError(`${callee.name}() with a string argument is not allowed (implicit eval)`, node);
                }
                return;
            }

            // --- process.binding(...), process.dlopen(...), process._linkedBinding(...) ---
            if (callee.type === 'MemberExpression' && !callee.computed) {
                const obj = callee.object;
                const prop = callee.property;

                if (obj.type === 'Identifier' && obj.name === 'process') {
                    if (prop.name === 'binding' || prop.name === 'dlopen' || prop.name === '_linkedBinding') {
                        addError(`process.${prop.name}() is not allowed`, node);
                    }
                }
            }

            // --- process['binding'](...) (computed member) ---
            if (callee.type === 'MemberExpression' && callee.computed) {
                const obj = callee.object;
                const prop = callee.property;

                if (obj.type === 'Identifier' && obj.name === 'process' &&
                    prop.type === 'Literal' &&
                    (prop.value === 'binding' || prop.value === 'dlopen' || prop.value === '_linkedBinding')) {
                    addError(`process["${prop.value}"]() is not allowed`, node);
                }
            }

            // --- constructor.constructor(...) chain — Function constructor via prototype ---
            if (callee.type === 'MemberExpression' && !callee.computed &&
                callee.property.name === 'constructor') {
                // X.constructor(...) — could be used to get Function
                // Check if it's a chain like foo.constructor.constructor(...)
                const inner = callee.object;
                if (inner.type === 'MemberExpression' && !inner.computed &&
                    inner.property.name === 'constructor') {
                    addError('constructor.constructor() chain is not allowed (Function constructor escape)', node);
                }
            }
        },

        // -----------------------------------------------------------------
        // NewExpression — catches new Function(...)
        // -----------------------------------------------------------------
        NewExpression(node) {
            if (node.callee.type === 'Identifier' && node.callee.name === 'Function') {
                addError('new Function() is not allowed', node);
            }
        },

        // -----------------------------------------------------------------
        // MemberExpression — catches dangerous property access patterns
        // even when not called (e.g. assigning process.mainModule to a var)
        // -----------------------------------------------------------------
        MemberExpression(node) {
            const obj = node.object;
            const prop = node.property;

            if (obj.type === 'Identifier' && obj.name === 'process') {
                // process.mainModule
                if (!node.computed && prop.name === 'mainModule') {
                    addError('process.mainModule access is not allowed', node);
                }
                if (node.computed && prop.type === 'Literal' && prop.value === 'mainModule') {
                    addError('process["mainModule"] access is not allowed', node);
                }
            }

            // global.process, global.require, globalThis.require
            if (obj.type === 'Identifier' && (obj.name === 'global' || obj.name === 'globalThis')) {
                if (!node.computed && (prop.name === 'process' || prop.name === 'require')) {
                    addError(`${obj.name}.${prop.name} access is not allowed`, node);
                }
                if (node.computed && prop.type === 'Literal' &&
                    (prop.value === 'process' || prop.value === 'require')) {
                    addError(`${obj.name}["${prop.value}"] access is not allowed`, node);
                }
            }
        },

        // -----------------------------------------------------------------
        // ImportExpression — dynamic import()
        // -----------------------------------------------------------------
        ImportExpression(node) {
            addError('Dynamic import() is not allowed', node);
        },

        // -----------------------------------------------------------------
        // ImportDeclaration — static import from '...'
        // -----------------------------------------------------------------
        ImportDeclaration(node) {
            const source = node.source.value;
            if (BANNED_MODULES.has(source)) {
                addError(`import from "${source}" is not allowed`, node);
            } else if (!isAllowedRequire(source)) {
                addError(`import from "${source}" is not an allowed module`, node);
            }
        },
    });

    return errors.length === 0
        ? { safe: true }
        : { safe: false, errors };
};

module.exports = { scanSource, BANNED_MODULES };
