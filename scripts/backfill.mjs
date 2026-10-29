#!/usr/bin/env node
/**
 * Backfill historical sessions into plugintree trees.
 *
 *   node scripts/backfill.mjs [--workspace <dir>] [--sessions 20] [--all]
 *
 * Historical sessions carry an explicit turn id in `messages.jsonl`, so each
 * user question becomes exactly one tree. Only the free mechanical tree is
 * built here; the LLM semantic rewrite runs on demand.
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveWorkspaceRoot, resolveDataDir, treesDir } from './lib/paths.mjs';
import {
  ensureDataLayout,
  appendEvent,
  resetSessionEvents,
  writeTree,
} from './lib/store.mjs';
import { parseSessionMessages } from './lib/transcript.mjs';
import { partitionTurns, buildMechanicalTree } from './lib/tree.mjs';

function parseArgs(argv) {
  const args = { workspace: null, sessions: 20, all: false };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--workspace' || flag === '-w') args.workspace = argv[++i];
    else if (flag === '--sessions' || flag === '-n') args.sessions = Number.parseInt(argv[++i], 10);
    else if (flag === '--all') args.all = true;
  }
  return args;
}

/** Collect session directories, oldest first (paths are timestamp-ordered). */
function collectSessionDirs(sessionsRoot) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      // A session directory is identified by its manifest, not by its name:
      // the directory is named "<HH-mm-ss-mmm>-session_<id>".
      if (fs.existsSync(path.join(child, 'manifest.json'))
        && fs.existsSync(path.join(child, 'messages.jsonl'))) {
        found.push(child);
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(sessionsRoot, 0);
  return found.sort();
}

function readSessionId(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return manifest.sessionId ?? null;
  } catch {
    return null;
  }
}

/** Remove tree copies left behind by an earlier layout of the plugin. */
function pruneLegacyTrees() {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(treesDir(workspaceRoot));
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.mech.json')) continue;
    try {
      fs.unlinkSync(path.join(treesDir(workspaceRoot), name));
      removed += 1;
    } catch {
      /* keep going */
    }
  }
  return removed;
}

const args = parseArgs(process.argv);
const workspaceRoot = resolveWorkspaceRoot(args.workspace);
ensureDataLayout(workspaceRoot);

const prunedTrees = pruneLegacyTrees();

const sessionsRoot = path.join(resolveDataDir(), 'v2', 'sessions');
const allDirs = collectSessionDirs(sessionsRoot);
const selected = args.all ? allDirs : allDirs.slice(-Math.max(1, args.sessions));

const report = { workspace: workspaceRoot, sessions: 0, turns: 0, nodes: 0, prunedTrees, skipped: [] };

for (const dir of selected) {
  const messagesFile = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(messagesFile)) {
    report.skipped.push({ dir, reason: 'no messages.jsonl' });
    continue;
  }
  const sessionId = readSessionId(dir) ?? path.basename(dir);
  const events = parseSessionMessages(messagesFile, { sessionId, origin: 'history' });
  if (!events.length) {
    report.skipped.push({ dir, reason: 'no parsable messages' });
    continue;
  }

  // Replace rather than append, so re-running the backfill is idempotent.
  resetSessionEvents(workspaceRoot, sessionId, 'history');
  for (const event of events) appendEvent(workspaceRoot, event);

  const turns = partitionTurns(events);
  for (const turn of turns) {
    if (!turn.events.some((e) => e.kind === 'user_prompt')) continue;
    const tree = buildMechanicalTree(turn, {
      sessionId,
      origin: 'history',
      workspaceRoot,
    });
    if (!tree) continue;
    writeTree(workspaceRoot, tree);
    report.turns += 1;
    report.nodes += tree.nodes.length;
  }
  report.sessions += 1;
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
