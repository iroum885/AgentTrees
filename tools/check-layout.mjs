#!/usr/bin/env node
/**
 * Check the viewer's layout against every tree in the workspace.
 *
 * The drawing is a centred spine with branches on either side, so a few
 * invariants have to hold for every tree or the picture breaks:
 *
 *  - the main path runs down one vertical line (x = 0);
 *  - a node that leans towards doing sits on the left, one that leans
 *    towards thinking sits on the right;
 *  - no two cards on the same row overlap;
 *  - the spine reaches the deepest thinking node of the tree.
 *
 *   node tools/check-layout.mjs [--workspace <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { resolveWorkspaceRoot } from '../scripts/lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(HERE, '..', 'ui');

const args = process.argv.slice(2);
let workspace = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--workspace' || args[i] === '-w') workspace = args[++i];
}

const root = resolveWorkspaceRoot(workspace);

/**
 * Load `layoutTree` out of the browser bundle.
 *
 * The viewer is an ES module for the browser; it only needs a `document` for
 * the parts this check does not touch, so the layout code can be imported
 * here as it is.
 */
async function loadLayout() {
  const source = fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugintree-layout-'));
  const file = path.join(dir, 'layout.mjs');
  fs.writeFileSync(file, source, 'utf8');
  try {
    const module = await import(`file://${file.replace(/\\/g, '/')}`);
    return module.layoutTree;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CARD_W = 300;

const layoutTree = await loadLayout();

const treesDir = path.join(root, '.plugintree', 'trees');
let names = [];
try {
  names = fs.readdirSync(treesDir);
} catch {
  process.stderr.write(`no trees directory: ${treesDir}\n`);
  process.exit(1);
}

const problems = [];
let checked = 0;
let maxLane = 0;
let deepestSpine = 0;

for (const name of names) {
  if (!name.endsWith('.json') || name.includes('.tmp')) continue;
  let tree;
  try {
    tree = JSON.parse(fs.readFileSync(path.join(treesDir, name), 'utf8'));
  } catch {
    continue;
  }
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  if (!nodes.length) continue;
  checked += 1;

  const layout = layoutTree(nodes);
  const records = layout.records;
  const fail = (message) => problems.push(`${name}: ${message}`);

  // 1. the spine is one vertical line, and every branch keeps its side
  const spine = records.filter((record) => record.side === 'center');
  for (const record of spine) {
    if (Math.abs(record.x) > 0.001) fail(`spine node ${record.id} sits at x=${record.x}`);
  }
  for (const record of records) {
    if (record.side === 'left' && record.lane >= 0) fail(`left branch ${record.id} has lane ${record.lane}`);
    if (record.side === 'right' && record.lane <= 0) fail(`right branch ${record.id} has lane ${record.lane}`);
    if (record.side === 'center' && record.lane !== 0) fail(`spine node ${record.id} has lane ${record.lane}`);
    maxLane = Math.max(maxLane, Math.abs(record.lane));
  }

  // 2. the cards of one row never overlap
  const byRow = new Map();
  for (const record of records) {
    if (!byRow.has(record.depth)) byRow.set(record.depth, []);
    byRow.get(record.depth).push(record);
  }
  for (const [depth, row] of byRow) {
    const sorted = row.slice().sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = sorted[i].x - sorted[i - 1].x;
      if (gap < CARD_W) {
        fail(`row ${depth}: ${sorted[i - 1].id} and ${sorted[i].id} are only ${gap}px apart`);
      }
    }
  }

  // 3. one spine node per row at most
  const spinePerRow = new Map();
  for (const record of spine) {
    spinePerRow.set(record.depth, (spinePerRow.get(record.depth) ?? 0) + 1);
  }
  for (const [depth, count] of spinePerRow) {
    if (count > 1) fail(`row ${depth} holds ${count} spine nodes`);
  }

  // 4. the spine reaches the deepest thinking node
  const maxDepth = Math.max(...records.map((record) => record.depth));
  const spineDepth = Math.max(...spine.map((record) => record.depth));
  deepestSpine = Math.max(deepestSpine, spineDepth);
  if (spineDepth !== maxDepth && spineDepth !== maxDepth - 1) {
    fail(`spine ends at depth ${spineDepth}, the tree goes to ${maxDepth}`);
  }

  // 5. the executions sit on the left, the thoughts on the right
  for (const record of records) {
    const type = record.node.type;
    if (type === 'execution' && record.side !== 'left') {
      fail(`execution ${record.id} sits on the ${record.side}`);
    }
    if ((type === 'scheme' || type === 'reasoning') && record.side !== 'center' && record.side !== 'right') {
      fail(`strategy ${record.id} sits on the ${record.side}`);
    }
  }
}

process.stdout.write(`checked ${checked} trees\n`);
process.stdout.write(`widest lane: ${maxLane}, deepest spine: ${deepestSpine}\n`);
if (problems.length) {
  for (const problem of problems) process.stdout.write(`  FAIL ${problem}\n`);
  process.stdout.write(`${problems.length} problem(s)\n`);
  process.exit(1);
}
process.stdout.write('layout holds for every tree\n');
