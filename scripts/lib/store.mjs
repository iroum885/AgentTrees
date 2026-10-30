import fs from 'node:fs';
import path from 'node:path';
import {
  appendJsonl,
  readJsonl,
  readJson,
  writeJsonAtomic,
  safeName,
} from './util.mjs';
import {
  eventsDir,
  historyEventsDir,
  treesDir,
  stateDir,
  configPath,
  dataDir,
  ensureDir,
} from './paths.mjs';

export const DEFAULT_CONFIG = {
  /** Local HTTP port for the tree viewer. 0 = pick a free port. */
  port: 47731,
  /** Maximum characters kept for a reasoning excerpt. */
  maxReasoningChars: 12000,
};

export function eventFile(workspaceRoot, sessionId, origin = 'live') {
  const dir = origin === 'history' ? historyEventsDir(workspaceRoot) : eventsDir(workspaceRoot);
  return path.join(dir, `${safeName(sessionId)}.jsonl`);
}

export function appendEvent(workspaceRoot, event) {
  const file = eventFile(workspaceRoot, event.session, event.origin ?? 'live');
  appendJsonl(file, event);
  return file;
}

export function readSessionEvents(workspaceRoot, sessionId, origin = 'live') {
  return readJsonl(eventFile(workspaceRoot, sessionId, origin));
}

/** Drop a session's stored events so a re-import does not duplicate them. */
export function resetSessionEvents(workspaceRoot, sessionId, origin = 'live') {
  const file = eventFile(workspaceRoot, sessionId, origin);
  try {
    fs.unlinkSync(file);
  } catch {
    /* nothing to remove */
  }
  return file;
}

/**
 * A summary of one file on disk, cached by its size and modification time.
 *
 * The turn list only needs a few fields per tree, but a tree file holds the
 * whole thinking transcript — megabytes each. Parsing every tree on every
 * poll made the viewer slow, so the summary is kept and only recomputed when
 * the file actually changed.
 */
const summaryCache = new Map();

/** The cached summary of a file, or null when it has to be read again. */
function cachedSummary(file, read) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    summaryCache.delete(file);
    return null;
  }
  const hit = summaryCache.get(file);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    return hit.value;
  }
  const value = read();
  summaryCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  return value;
}

export function listSessions(workspaceRoot) {
  const out = [];
  for (const [origin, dir] of [
    ['live', eventsDir(workspaceRoot)],
    ['history', historyEventsDir(workspaceRoot)],
  ]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -6);
      const file = path.join(dir, name);
      // The session list only needs the last event and how many there are,
      // so the whole event log is not read on every poll.
      const summary = cachedSummary(file, () => {
        const events = readJsonl(file);
        const last = events.length ? events[events.length - 1] : null;
        return {
          eventCount: events.length,
          lastTs: last?.ts ?? null,
          cwd: last?.cwd ?? null,
        };
      });
      out.push({ sessionId, origin, ...summary });
    }
  }
  return out;
}

export function treeFile(workspaceRoot, turnId) {
  return path.join(treesDir(workspaceRoot), `${safeName(turnId)}.json`);
}

export function writeTree(workspaceRoot, tree) {
  const file = treeFile(workspaceRoot, tree.turnId);
  writeJsonAtomic(file, tree);
  // The file changed, so the cached summary is stale.
  summaryCache.delete(file);
  return file;
}

export function readTree(workspaceRoot, turnId) {
  return readJson(treeFile(workspaceRoot, turnId), null);
}

export function listTrees(workspaceRoot) {
  let names = [];
  try {
    names = fs.readdirSync(treesDir(workspaceRoot));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.mech.json')) continue;
    const file = path.join(treesDir(workspaceRoot), name);
    // Only the few fields the turn list shows are needed, so the tree file
    // itself is parsed once and then reused until it changes on disk.
    const summary = cachedSummary(file, () => {
      const tree = readJson(file, null);
      if (!tree) return null;
      return {
        turnId: tree.turnId,
        sessionId: tree.sessionId ?? null,
        question: tree.question ?? '',
        origin: tree.origin ?? 'live',
        nodeCount: Array.isArray(tree.nodes) ? tree.nodes.length : 0,
        ts: tree.ts ?? null,
        updatedAt: tree.updatedAt ?? null,
        // The turn is still in flight when no `stop` event closed it yet.
        running: tree.running === true,
        lastEventTs: tree.lastEventTs ?? null,
      };
    });
    if (!summary) continue;
    out.push(summary);
  }
  return out.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}

export function readTranscriptState(workspaceRoot) {
  return readJson(path.join(stateDir(workspaceRoot), 'transcripts.json'), {});
}

export function writeTranscriptState(workspaceRoot, state) {
  writeJsonAtomic(path.join(stateDir(workspaceRoot), 'transcripts.json'), state);
}

export function readConfig(workspaceRoot) {
  const stored = readJson(configPath(workspaceRoot), {});
  return { ...DEFAULT_CONFIG, ...(stored && typeof stored === 'object' ? stored : {}) };
}

export function writeConfig(workspaceRoot, config) {
  writeJsonAtomic(configPath(workspaceRoot), { ...DEFAULT_CONFIG, ...config });
  return readConfig(workspaceRoot);
}

export function ensureDataLayout(workspaceRoot) {
  ensureDir(dataDir(workspaceRoot));
  ensureDir(eventsDir(workspaceRoot));
  ensureDir(treesDir(workspaceRoot));
  ensureDir(stateDir(workspaceRoot));
}
