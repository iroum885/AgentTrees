#!/usr/bin/env node
/**
 * Regenerate the sample export files under `exports/` from a stored tree.
 *
 *   node tools/export-sample.mjs [--turn <turnId>] [--workspace <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveWorkspaceRoot } from '../scripts/lib/paths.mjs';
import { listTrees, readTree } from '../scripts/lib/store.mjs';
import { treeToHtml, treeToMarkdown } from '../scripts/lib/export.mjs';

const args = process.argv.slice(2);
let workspace = null;
let turnId = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--workspace' || args[i] === '-w') workspace = args[++i];
  else if (args[i] === '--turn' || args[i] === '-t') turnId = args[++i];
}

const root = resolveWorkspaceRoot(workspace);
const trees = listTrees(root);
// A sample is meant to show the format, not to ship a whole session: prefer a
// mid-sized tree so the exported files stay small enough to open anywhere.
const chosen = turnId
  ? trees.find((t) => t.turnId === turnId)
  : trees.find((t) => t.nodeCount >= 12 && t.nodeCount <= 50)
    ?? trees.find((t) => t.nodeCount > 8)
    ?? trees[0];

if (!chosen) {
  process.stderr.write('no tree available\n');
  process.exit(1);
}

const tree = readTree(root, chosen.turnId);
if (!tree) {
  process.stderr.write(`tree not found: ${chosen.turnId}\n`);
  process.exit(1);
}

const outDir = path.resolve(root, 'exports');
fs.mkdirSync(outDir, { recursive: true });
const htmlFile = path.join(outDir, 'sample-tree.html');
const mdFile = path.join(outDir, 'sample-tree.md');
fs.writeFileSync(htmlFile, treeToHtml(tree), 'utf8');
fs.writeFileSync(mdFile, treeToMarkdown(tree), 'utf8');

process.stdout.write(`${JSON.stringify({
  turnId: chosen.turnId,
  question: (chosen.question ?? '').slice(0, 60),
  html: htmlFile,
  markdown: mdFile,
  htmlBytes: fs.statSync(htmlFile).size,
  markdownBytes: fs.statSync(mdFile).size,
}, null, 2)}\n`);
