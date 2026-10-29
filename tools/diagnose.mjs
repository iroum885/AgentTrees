#!/usr/bin/env node
/**
 * Diagnostics for the stored trees: how many turns carry a real user message,
 * how many executions exist, and how many of them recorded a duration.
 *
 *   node tools/diagnose.mjs [--workspace <dir>]
 */
import path from 'node:path';
import { resolveWorkspaceRoot } from '../scripts/lib/paths.mjs';
import { readTree, listTrees, readSessionEvents } from '../scripts/lib/store.mjs';

const args = process.argv.slice(2);
let workspace = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--workspace' || args[i] === '-w') workspace = args[++i];
}
const root = resolveWorkspaceRoot(workspace);

const trees = listTrees(root);
let withQuestion = 0;
let withExecutions = 0;
let withDuration = 0;
const samples = [];

for (const summary of trees) {
  const tree = readTree(root, summary.turnId);
  if (!tree) continue;
  const hasQuestion = !/^\(无提问文本\)$/.test((tree.question || '').trim());
  const nodes = tree.nodes ?? [];
  const executions = nodes.filter((n) => n.type === 'execution');
  const prompts = nodes.filter((n) => n.type === 'question');
  const timed = executions.filter((n) => typeof n.durationMs === 'number');
  if (hasQuestion) withQuestion += 1;
  if (executions.length) withExecutions += 1;
  if (timed.length) withDuration += 1;
  if (samples.length < 8 && (!hasQuestion || executions.length === 0)) {
    samples.push({
      turnId: summary.turnId,
      hasQuestion,
      question: (tree.question || '').slice(0, 60),
      nodes: nodes.length,
      questions: prompts.length,
      executions: executions.length,
      timed: timed.length,
      sessionId: summary.sessionId,
    });
  }
}

process.stdout.write(`${JSON.stringify({
  workspace: root,
  totalTrees: trees.length,
  withQuestion,
  withExecutions,
  withDuration,
  samples,
}, null, 2)}\n`);

// Inspect the raw events of one session to see how user prompts are stored.
const first = trees[0];
if (first?.sessionId) {
  const events = readSessionEvents(root, first.sessionId, 'history');
  const kinds = {};
  for (const event of events) kinds[event.kind] = (kinds[event.kind] || 0) + 1;
  process.stdout.write(`\nsample session ${first.sessionId} kinds: ${JSON.stringify(kinds)}\n`);
  const prompt = events.find((e) => e.kind === 'user_prompt');
  process.stdout.write(`first prompt: ${JSON.stringify((prompt?.data?.text ?? '').slice(0, 100))}\n`);
}
