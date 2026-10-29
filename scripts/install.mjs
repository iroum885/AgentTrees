#!/usr/bin/env node
/**
 * Install (or refresh) this project as a local MiniMax Code plugin.
 *
 *   node scripts/install.mjs [--target <dir>] [--dry-run]
 *
 * The plugin package is copied into `<dataDir>/plugins/plugintree/`. Runtime
 * data is never copied: it lives in each workspace's `.plugintree/` folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataDir, PLUGIN_ROOT } from './lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(HERE, '..');

const EXCLUDED_TOP = new Set(['.plugintree', 'node_modules', '.git', 'tools']);
const EXCLUDED_FILES = new Set(['README.md', 'install.mjs', '.gitignore']);

function parseArgs(argv) {
  const args = { target: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--target' || flag === '-t') args.target = argv[++i];
    else if (flag === '--dry-run') args.dryRun = true;
  }
  return args;
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      if (rel.split(path.sep).some((segment) => EXCLUDED_TOP.has(segment))) continue;
      walk(full, base, out);
    } else if (entry.isFile()) {
      if (EXCLUDED_FILES.has(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const target = path.resolve(
  args.target || path.join(resolveDataDir(), 'plugins', 'plugintree'),
);

const files = walk(SOURCE_ROOT);
const copied = [];

if (!args.dryRun) {
  for (const file of files) {
    const rel = path.relative(SOURCE_ROOT, file);
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    copied.push(rel);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  dryRun: args.dryRun,
  source: SOURCE_ROOT,
  pluginRoot: PLUGIN_ROOT,
  target,
  files: files.length,
  copied: copied.length,
  sample: (copied.length ? copied : files).map((f) => path.relative(SOURCE_ROOT, f)).slice(0, 16),
}, null, 2)}\n`);
