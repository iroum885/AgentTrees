#!/usr/bin/env node
/**
 * Print one tree as an outline, for inspecting the semantic structure.
 *
 *   node tools/show-tree.mjs <turnId> [--workspace <dir>]
 */
import { resolveWorkspaceRoot } from '../scripts/lib/paths.mjs';
import { readTree } from '../scripts/lib/store.mjs';
import { nestNodes } from '../scripts/lib/tree.mjs';
import { formatDuration } from '../scripts/lib/labels.mjs';

const args = process.argv.slice(2);
let workspace = null;
let turnId = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--workspace' || args[i] === '-w') workspace = args[++i];
  else if (!turnId) turnId = args[i];
}

const root = resolveWorkspaceRoot(workspace);
const tree = readTree(root, turnId);
if (!tree) {
  process.stderr.write(`tree not found: ${turnId}\n`);
  process.exit(1);
}

const LABEL = {
  question: '提问', scheme: '策略', reasoning: '思考', execution: '执行',
  ask: '询问', subagent: '子代理', note: '说明',
};

process.stdout.write(`turn ${tree.turnId}  nodes=${tree.nodes.length}\n`);
process.stdout.write(`question: ${(tree.question || '').slice(0, 120)}\n\n`);

const walk = (nodes, depth) => {
  for (const node of nodes) {
    const marks = [];
    if (node.status) marks.push(node.status);
    const duration = formatDuration(node.durationMs);
    if (duration) marks.push(duration);
    const mark = marks.length ? ` [${marks.join('/')}]` : '';
    process.stdout.write(`${'  '.repeat(depth)}${LABEL[node.type] ?? node.type}: ${(node.title || '').slice(0, 80)}${mark}\n`);
    if (node.type === 'execution' && node.command) {
      process.stdout.write(`${'  '.repeat(depth)}  命令: ${node.command}\n`);
    }
    walk(node.children ?? [], depth + 1);
  }
};
walk(nestNodes(tree.nodes), 0);
