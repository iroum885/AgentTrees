#!/usr/bin/env node
/**
 * Rebuild every stored tree from the recorded event logs.
 *
 *   node tools/rebuild.mjs [--workspace <dir>]
 *
 * Use this after the tree rules change: the event logs are the source of
 * truth, so the trees can always be regenerated from them.
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveWorkspaceRoot } from '../scripts/lib/paths.mjs';
import {
  ensureDataLayout,
  listSessions,
  readSessionEvents,
  writeTree,
  treeFile,
} from '../scripts/lib/store.mjs';
import { partitionTurns, buildMechanicalTree } from '../scripts/lib/tree.mjs';

const args = process.argv.slice(2);
let workspace = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--workspace' || args[i] === '-w') workspace = args[++i];
}
const root = resolveWorkspaceRoot(workspace);
ensureDataLayout(root);

/** Drop the tree copies left behind by an earlier layout of the plugin. */
function pruneLegacyTrees() {
  let removed = 0;
  const dir = path.join(root, '.plugintree', 'trees');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.mech.json')) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch {
      /* keep going */
    }
  }
  return removed;
}

const pruned = pruneLegacyTrees();
const report = {
  workspace: root,
  prunedTrees: pruned,
  sessions: 0,
  turns: 0,
  nodes: 0,
  dropped: 0,
  skipped: [],
};

for (const session of listSessions(root)) {
  const events = readSessionEvents(root, session.sessionId, session.origin);
  if (!events.length) continue;
  const turns = partitionTurns(events);
  for (const turn of turns) {
    if (!turn.events.some((e) => e.kind === 'user_prompt')) continue;
    const tree = buildMechanicalTree(turn, {
      sessionId: session.sessionId,
      origin: session.origin,
      workspaceRoot: session.cwd || root,
    });
    if (!tree) {
      // A turn without a real user message gets no tree at all.
      const file = treeFile(root, turn.turnId);
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
          report.dropped += 1;
        } catch {
          /* keep going */
        }
      }
      report.skipped.push({ turnId: turn.turnId, reason: 'no user message' });
      continue;
    }
    writeTree(root, tree);
    report.turns += 1;
    report.nodes += tree.nodes.length;
  }
  report.sessions += 1;
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
