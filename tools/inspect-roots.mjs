#!/usr/bin/env node
/**
 * Inspect the root node of every tree: what text does it carry, does it match
 * the user's message, and which turns have no root question at all.
 *
 *   node tools/inspect-roots.mjs [--workspace <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveWorkspaceRoot } from '../scripts/lib/paths.mjs';
import { listTrees, readTree, readSessionEvents } from '../scripts/lib/store.mjs';

const args = process.argv.slice(2);
let workspace = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--workspace' || args[i] === '-w') workspace = args[++i];
}
const root = resolveWorkspaceRoot(workspace);

const trees = listTrees(root);
const rows = [];

for (const summary of trees) {
  const tree = readTree(root, summary.turnId);
  if (!tree) continue;
  const rootNode = tree.nodes.find((n) => n.type === 'question');
  const question = tree.question ?? '';

  // The raw user messages recorded for this turn.
  const origin = tree.origin === 'history' ? 'history' : 'live';
  const events = readSessionEvents(root, tree.sessionId, origin)
    .filter((e) => e.turn === tree.turnId && e.kind === 'user_prompt');
  const rawPrompts = events.map((e) => e.data?.text ?? '');

  const looksEmpty = /^\(无提问文本\)$/.test(question.trim());
  const startsWithReminder = question.trimStart().startsWith('<');
  const rawFirst = rawPrompts[0] ?? '';

  rows.push({
    turnId: summary.turnId,
    origin: tree.origin,
    rootType: rootNode ? rootNode.type : 'MISSING',
    rootTitle: (rootNode?.title ?? '').replace(/\s+/g, ' ').slice(0, 60),
    question: question.replace(/\s+/g, ' ').slice(0, 60),
    rawPromptCount: rawPrompts.length,
    rawPromptHead: rawFirst.replace(/\s+/g, ' ').slice(0, 70),
    empty: looksEmpty,
    startsWithTag: startsWithReminder,
  });
}

const empty = rows.filter((r) => r.empty);
const tagged = rows.filter((r) => r.startsWithTag);
const missing = rows.filter((r) => r.rootType === 'MISSING');

process.stdout.write(`${JSON.stringify({
  workspace: root,
  total: rows.length,
  emptyRoot: empty.length,
  rootStartsWithXmlTag: tagged.length,
  missingRoot: missing.length,
  emptySamples: empty.slice(0, 6),
  taggedSamples: tagged.slice(0, 4),
  normalSamples: rows.filter((r) => !r.empty && !r.startsWithTag).slice(0, 5),
}, null, 2)}\n`);
