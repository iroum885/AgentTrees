#!/usr/bin/env node
/**
 * Inspect the trees stored in a workspace's .plugintree directory.
 *
 *   node tools/list-trees.mjs [--workspace <dir>] [--sort chars|nodes|ts]
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveWorkspaceRoot } from '../scripts/lib/paths.mjs';
import { listTrees, readTree } from '../scripts/lib/store.mjs';

const args = process.argv.slice(2);
let workspace = null;
let sort = 'ts';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--workspace' || args[i] === '-w') workspace = args[++i];
  else if (args[i] === '--sort') sort = args[++i];
}

const root = resolveWorkspaceRoot(workspace);
const trees = listTrees(root);

const rows = trees.map((summary) => {
  const tree = readTree(root, summary.turnId);
  const nodes = tree?.nodes ?? [];
  const strategies = nodes.filter((n) => n.type === 'scheme');
  const executions = nodes.filter((n) => n.type === 'execution');
  return {
    turnId: summary.turnId,
    origin: summary.origin,
    question: (summary.question || '').replace(/\s+/g, ' ').slice(0, 48),
    nodes: nodes.length,
    strategies: strategies.length,
    executions: executions.length,
    strategyChars: strategies.reduce((sum, n) => sum + (n.detail || '').length, 0),
    maxLevel: nodes.length ? Math.max(...nodes.map((n) => n.level ?? 0)) : 0,
  };
});

const key = sort === 'chars' ? 'strategyChars' : sort === 'nodes' ? 'nodes' : 'ts';
rows.sort((a, b) => (key === 'ts' ? (rows.indexOf(a) - rows.indexOf(b)) : a[key] - b[key]));

process.stdout.write(`${JSON.stringify({ workspace: root, count: rows.length, rows }, null, 2)}\n`);
