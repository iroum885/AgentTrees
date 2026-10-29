#!/usr/bin/env node
/**
 * Static validation of the plugintree plugin package against the local
 * MiniMax Code Plugin V1 contract.
 *
 *   node tools/validate-package.mjs [--dir <package root>]
 *
 * Checks: JSON well-formedness (no BOM, no duplicate keys, no comments, no
 * trailing commas), manifest field contract, manifest-referenced file
 * existence, hook document shape, and path safety.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
let packageRoot = ROOT;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--dir' || args[i] === '-d') packageRoot = path.resolve(args[++i]);
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}\n`);
  }
};

/**
 * Find duplicate keys inside the same JSON object.
 * JSON.parse accepts duplicates (the last one wins), so a dedicated scanner
 * is needed to reject them.
 */
function findDuplicateKeys(text) {
  const duplicates = [];
  const s = text;
  let i = 0;

  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i += 1;
  };

  const readString = () => {
    if (s[i] !== '"') throw new Error(`expected a string at ${i}`);
    i += 1;
    let out = '';
    while (i < s.length) {
      if (s[i] === '\\') {
        out += s[i] + (s[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (s[i] === '"') {
        i += 1;
        return out;
      }
      out += s[i];
      i += 1;
    }
    throw new Error('unterminated string');
  };

  const readValue = (scope) => {
    skipWs();
    const c = s[i];
    if (c === '{') return readObject(scope);
    if (c === '[') return readArray(scope);
    if (c === '"') {
      readString();
      return;
    }
    const start = i;
    while (i < s.length && !/[,\]}\s]/.test(s[i])) i += 1;
    if (i === start) throw new Error(`unexpected token at ${i}`);
  };

  const readObject = (scope) => {
    i += 1;
    const keys = new Set();
    skipWs();
    if (s[i] === '}') {
      i += 1;
      return;
    }
    for (;;) {
      skipWs();
      const key = readString();
      if (keys.has(key)) duplicates.push(`${scope}.${key}`);
      keys.add(key);
      skipWs();
      if (s[i] !== ':') throw new Error(`expected a colon at ${i}`);
      i += 1;
      readValue(`${scope}.${key}`);
      skipWs();
      if (s[i] === ',') {
        i += 1;
        continue;
      }
      if (s[i] === '}') {
        i += 1;
        return;
      }
      throw new Error(`expected a comma or closing brace at ${i}`);
    }
  };

  const readArray = (scope) => {
    i += 1;
    skipWs();
    if (s[i] === ']') {
      i += 1;
      return;
    }
    let index = 0;
    for (;;) {
      readValue(`${scope}[${index}]`);
      index += 1;
      skipWs();
      if (s[i] === ',') {
        i += 1;
        continue;
      }
      if (s[i] === ']') {
        i += 1;
        return;
      }
      throw new Error(`expected a comma or closing bracket at ${i}`);
    }
  };

  try {
    readValue('$');
  } catch {
    // JSON.parse reports the real syntax error; duplicates are all we need.
    return duplicates;
  }
  return duplicates;
}

/** Parse JSON while rejecting duplicate keys, comments and trailing commas. */
function parseStrictJson(text, label) {
  const errors = [];
  try {
    JSON.parse(text);
  } catch (error) {
    errors.push(`invalid JSON: ${error.message}`);
  }
  for (const key of findDuplicateKeys(text)) errors.push(`duplicate key ${key}`);
  if (errors.length) {
    process.stdout.write(`  FAIL  ${label} is not strict JSON - ${errors.join('; ')}\n`);
    failed += 1;
    return null;
  }
  passed += 1;
  process.stdout.write(`  PASS  ${label} is strict JSON\n`);
  return JSON.parse(text);
}

process.stdout.write('JSON files\n');
const jsonFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.plugintree' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.json')) jsonFiles.push(full);
  }
};
walk(packageRoot);

const parsed = new Map();
for (const file of jsonFiles) {
  const rel = path.relative(packageRoot, file).split(path.sep).join('/');
  const buffer = fs.readFileSync(file);
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    failed += 1;
    process.stdout.write(`  FAIL  ${rel} has a UTF-8 BOM\n`);
    continue;
  }
  const value = parseStrictJson(buffer.toString('utf8'), rel);
  if (value) parsed.set(rel, value);
}

process.stdout.write('\nManifest\n');
const manifestPath = '.minimax-plugin/plugin.json';
const manifest = parsed.get(manifestPath);
check('manifest exists', !!manifest);
if (manifest) {
  check('schemaVersion is 1', manifest.schemaVersion === 1, String(manifest.schemaVersion));
  check('name is kebab-case', /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(manifest.name || ''), manifest.name);
  check('name matches the directory name', manifest.name === path.basename(packageRoot),
    `${manifest.name} vs ${path.basename(packageRoot)}`);
  check('version is SemVer', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version || ''), manifest.version);
  check('description is non-empty', !!manifest.description);
  check('author is non-empty', !!manifest.author);
  check('category is valid', ['Office', 'Studio', 'Design & Sites', 'Code', 'Business', 'Sales',
    'Productivity', 'Science & Healthcare', 'Education', 'Other'].includes(manifest.category),
  manifest.category);
  check('exampleQueries is a non-empty array of non-empty strings',
    Array.isArray(manifest.exampleQueries) && manifest.exampleQueries.length > 0
    && manifest.exampleQueries.every((q) => typeof q === 'string' && q.trim()));
  check('apps is an empty array', Array.isArray(manifest.apps) && manifest.apps.length === 0);
  check('mcpServers is an array', Array.isArray(manifest.mcpServers));
  check('skills is an array', Array.isArray(manifest.skills));
  check('at least one effective capability',
    (Array.isArray(manifest.mcpServers) && manifest.mcpServers.length > 0)
    || (Array.isArray(manifest.skills) && manifest.skills.length > 0)
    || (Array.isArray(manifest.agents) && manifest.agents.length > 0)
    || (Array.isArray(manifest.hooks) && manifest.hooks.length > 0));

  check('icon file exists', !!manifest.icon && fs.existsSync(path.join(packageRoot, manifest.icon)));
  if (manifest.darkIcon) {
    check('darkIcon file exists', fs.existsSync(path.join(packageRoot, manifest.darkIcon)));
  }

  const referenced = [
    ...(manifest.skills || []),
    ...(manifest.agents || []),
    ...(manifest.hooks || []),
    ...(manifest.mcpServers || []),
    ...(manifest.icon ? [manifest.icon] : []),
    ...(manifest.darkIcon ? [manifest.darkIcon] : []),
  ];
  for (const rel of referenced) {
    check(`referenced file exists: ${rel}`, fs.existsSync(path.join(packageRoot, rel)));
    check(`reference is relative and portable: ${rel}`,
      !path.isAbsolute(rel) && !rel.includes('\\') && !rel.split('/').includes('..'));
    for (const segment of rel.split('/')) {
      check(`path segment is safe: ${rel} ${segment}`,
        /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..');
    }
  }

  for (const skillRel of manifest.skills || []) {
    const text = fs.readFileSync(path.join(packageRoot, skillRel), 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    check(`${skillRel} has frontmatter`, !!match);
    if (match) {
      const lines = match[1].split(/\r?\n/);
      const nameLine = lines.find((l) => l.startsWith('name:'));
      const dirName = path.basename(path.dirname(skillRel));
      check(`${skillRel} frontmatter name matches the directory`,
        !!nameLine && nameLine.slice('name:'.length).trim() === dirName, nameLine);
      const descriptionLine = lines.find((l) => l.startsWith('description:'));
      check(`${skillRel} has a non-empty description`,
        !!descriptionLine && descriptionLine.slice('description:'.length).trim().length > 0);
    }
  }
}

process.stdout.write('\nHook documents\n');
const HOOK_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact', 'PostCompact',
]);
for (const rel of (manifest && manifest.hooks) || []) {
  const doc = parsed.get(rel);
  check(`${rel} parsed`, !!doc);
  if (!doc) continue;
  check(`${rel} has a hooks object`, !!doc.hooks && typeof doc.hooks === 'object');
  let handlerCount = 0;
  for (const [event, groups] of Object.entries(doc.hooks || {})) {
    check(`${rel}: event "${event}" is supported`, HOOK_EVENTS.has(event));
    if (!Array.isArray(groups)) {
      check(`${rel}: event "${event}" groups is an array`, false);
      continue;
    }
    for (const group of groups) {
      if (group.matcher !== undefined) {
        check(`${rel}: "${event}" matcher is a plain string`,
          typeof group.matcher === 'string' && group.matcher.length <= 256);
        check(`${rel}: "${event}" matcher has no look-around`,
          !/\(\?=|\(\?!|\(\?<|\\1/.test(group.matcher));
      }
      for (const handler of group.hooks || []) {
        handlerCount += 1;
        check(`${rel}: "${event}" handler is a synchronous command`,
          handler.type === 'command' && typeof handler.command === 'string' && handler.command.length > 0);
        check(`${rel}: "${event}" handler has no unsupported fields`,
          Object.keys(handler).every((k) => ['type', 'command', 'commandWindows', 'timeout'].includes(k)),
          Object.keys(handler).join(','));
        check(`${rel}: "${event}" timeout is 1-10s`,
          handler.timeout === undefined || (Number.isInteger(handler.timeout) && handler.timeout >= 1 && handler.timeout <= 10),
          String(handler.timeout));
        const script = handler.commandWindows || handler.command;
        const match = script.match(/\$\{PLUGIN_ROOT\}\\?[/\\]scripts\\?[/\\]([\w.-]+)/);
        check(`${rel}: "${event}" command points at a package script`, !!match, script);
        if (match) {
          check(`${rel}: script ${match[1]} exists`,
            fs.existsSync(path.join(packageRoot, 'scripts', match[1])));
        }
      }
    }
  }
  check(`${rel} declares at most 64 handlers`, handlerCount <= 64, String(handlerCount));
  check(`${rel} declares at least one handler`, handlerCount >= 1);
}

process.stdout.write('\nPackage limits\n');
let fileCount = 0;
let byteCount = 0;
const countEntries = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.plugintree' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    fileCount += 1;
    if (entry.isDirectory()) countEntries(full);
    else if (entry.isFile()) {
      const size = fs.statSync(full).size;
      byteCount += size;
      check(`file under 16 MiB: ${path.relative(packageRoot, full)}`, size <= 16 * 1024 * 1024);
    }
  }
};
countEntries(packageRoot);
check('package has at most 1024 files', fileCount <= 1024, String(fileCount));
check('package totals at most 64 MiB', byteCount <= 64 * 1024 * 1024, String(byteCount));

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
