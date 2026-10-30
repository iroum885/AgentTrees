import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { resolveDataDir, ensureDir, eventsDir, historyEventsDir, treesDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './util.mjs';

/**
 * A global registry of the workspaces the collector has seen.
 *
 * The collector runs inside whichever workspace the agent is working in, so
 * it writes its data to `<workspace>/.plugintree/`. The viewer, however, has
 * to be able to point at *any* of them — a global registry is what makes the
 * other workspaces visible in the switcher.
 *
 * Every workspace owns its own file, so two collectors writing at the same
 * time never overwrite each other's entry.
 */

/** The directory holding one marker file per known workspace. */
export function registryDir() {
  return path.join(resolveDataDir(), 'plugintree', 'workspaces');
}

/** The marker file of one workspace. */
export function registryFile(root) {
  const resolved = path.resolve(root);
  const digest = crypto.createHash('sha1').update(resolved.toLowerCase()).digest('hex').slice(0, 10);
  const name = resolved.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return path.join(registryDir(), `${name}.${digest}.json`);
}

/** A short display name for a workspace, e.g. `sora`. */
export function workspaceLabel(root) {
  const resolved = path.resolve(root || '');
  const base = path.basename(resolved);
  return base || resolved;
}

/**
 * Record that a workspace is active.
 *
 * `eventTs` is the timestamp of the newest event seen there, which lets the
 * viewer tell which workspace the agent is actually working in.
 */
export function registerWorkspace(root, info = {}) {
  if (!root) return null;
  const resolved = path.resolve(root);
  const file = registryFile(resolved);
  const previous = readJson(file, null);
  const now = Date.now();
  const eventTs = typeof info.eventTs === 'number' && Number.isFinite(info.eventTs)
    ? info.eventTs
    : null;

  const entry = {
    root: resolved,
    label: workspaceLabel(resolved),
    firstSeen: typeof previous?.firstSeen === 'number' ? previous.firstSeen : now,
    lastSeen: now,
    lastEventTs: Math.max(previous?.lastEventTs ?? 0, eventTs ?? 0) || null,
    sessionId: info.sessionId ?? previous?.sessionId ?? null,
  };
  try {
    ensureDir(registryDir());
    writeJsonAtomic(file, entry);
    pruneDeadWorkspaces();
  } catch {
    // The registry is a convenience: failing to write it must never break a
    // hook, so the entry is simply dropped.
    return null;
  }
  return entry;
}

/**
 * Is this a throwaway folder in the OS temp directory?
 *
 * Test runs and one-off scripts work there; such a workspace is scratch
 * space, never a project the user wants to monitor.
 */
export function isTemporaryWorkspace(root) {
  if (!root) return false;
  // The self-test runs in a scratch folder and needs to see it.
  if (process.env.PLUGINTREE_ALLOW_TEMP_WORKSPACE === '1') return false;
  let temp = '';
  try {
    temp = path.resolve(os.tmpdir());
  } catch {
    return false;
  }
  const resolved = path.resolve(root);
  const relative = path.relative(temp, resolved);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Does this workspace hold anything worth showing?
 *
 * A workspace that recorded no turn has nothing to switch to, so it stays
 * out of the list.
 */
export function hasRecords(root) {
  if (!root) return false;
  for (const dir of [eventsDir(root), historyEventsDir(root), treesDir(root)]) {
    try {
      if (fs.readdirSync(dir).length) return true;
    } catch {
      /* the folder does not exist */
    }
  }
  return false;
}

/**
 * Drop the entries of workspaces that are gone or hold nothing.
 *
 * The registry is a cache of places the agent worked in; a temporary folder
 * that was deleted should not stay in the switcher forever.
 */
export function pruneDeadWorkspaces() {
  let names = [];
  try {
    names = fs.readdirSync(registryDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(registryDir(), name);
    const entry = readJson(file, null);
    if (!entry || typeof entry.root !== 'string' || !entry.root) continue;
    let alive = false;
    try {
      alive = fs.existsSync(entry.root);
    } catch {
      alive = false;
    }
    if (alive && hasRecords(entry.root) && !isTemporaryWorkspace(entry.root)) continue;
    try {
      fs.unlinkSync(file);
    } catch {
      /* another process may have cleaned it up already */
    }
  }
}

/** Every workspace the collector has seen, most recently active first. */
export function listRegisteredWorkspaces() {
  let names = [];
  try {
    names = fs.readdirSync(registryDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const entry = readJson(path.join(registryDir(), name), null);
    if (!entry || typeof entry.root !== 'string' || !entry.root) continue;
    if (!hasRecords(entry.root)) continue;
    if (isTemporaryWorkspace(entry.root)) continue;
    out.push({
      root: entry.root,
      label: entry.label || workspaceLabel(entry.root),
      firstSeen: entry.firstSeen ?? null,
      lastSeen: entry.lastSeen ?? null,
      lastEventTs: entry.lastEventTs ?? null,
    });
  }
  out.sort((a, b) => {
    const byEvent = (b.lastEventTs ?? 0) - (a.lastEventTs ?? 0);
    if (byEvent) return byEvent;
    return (b.lastSeen ?? 0) - (a.lastSeen ?? 0);
  });
  return out;
}
