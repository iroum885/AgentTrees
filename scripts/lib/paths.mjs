import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR_NAME = '.plugintree';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the installed plugin package root. */
export const PLUGIN_ROOT = path.resolve(here, '..', '..');

/** Absolute path of the MiniMax Code data dir (holds config.yaml). */
export function resolveDataDir() {
  const fromEnv =
    process.env.MINIMAX_DATA_DIR ||
    process.env.__MAVIS_PARENT_DATA_DIR ||
    process.env.MAVIS_DATA_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    const candidate = path.join(home, '.minimax');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(home, '.minimax');
}

/** Absolute path of the active workspace root. */
export function resolveWorkspaceRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  const env =
    process.env.MINIMAX_PROJECT_DIR ||
    process.env.__MAVIS_PARENT_PROJECT_DIR ||
    process.env.MAVIS_PROJECT_DIR;
  if (env) return path.resolve(env);
  return process.cwd();
}

export function dataDir(workspaceRoot) {
  return path.join(workspaceRoot, DATA_DIR_NAME);
}

export function eventsDir(workspaceRoot) {
  return path.join(dataDir(workspaceRoot), 'events');
}

export function historyEventsDir(workspaceRoot) {
  return path.join(dataDir(workspaceRoot), 'events-history');
}

export function treesDir(workspaceRoot) {
  return path.join(dataDir(workspaceRoot), 'trees');
}

export function stateDir(workspaceRoot) {
  return path.join(dataDir(workspaceRoot), 'state');
}

export function configPath(workspaceRoot) {
  return path.join(dataDir(workspaceRoot), 'config.json');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve a path under the plugin root, refusing anything that escapes it. */
export function pluginPath(...segments) {
  const target = path.resolve(PLUGIN_ROOT, ...segments);
  const rel = path.relative(PLUGIN_ROOT, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes plugin root: ${target}`);
  }
  return target;
}
