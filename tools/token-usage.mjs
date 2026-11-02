#!/usr/bin/env node
/**
 * Print per-action token usage for a session.
 *
 * One "action" = one assistant model call recorded in the runtime session log.
 * Each such record carries a usage block (input / output / cacheRead / cacheWrite).
 *
 *   node tools/token-usage.mjs                       # current session (auto-detect)
 *   node tools/token-usage.mjs --session <id>        # explicit session id
 *   node tools/token-usage.mjs --session-dir <dir>    # explicit messages.jsonl dir
 *   node tools/token-usage.mjs --latest              # most recent runtime session
 *   node tools/token-usage.mjs --json                # machine readable
 *   node tools/token-usage.mjs --limit 20
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../scripts/lib/paths.mjs';

const args = process.argv.slice(2);
let sessionId = null;
let sessionDir = null;
let asJson = false;
let latest = false;
let limit = 0;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session' || args[i] === '-s') sessionId = args[++i];
  else if (args[i] === '--session-dir') sessionDir = args[++i];
  else if (args[i] === '--latest') latest = true;
  else if (args[i] === '--json') asJson = true;
  else if (args[i] === '--limit' || args[i] === '-n') limit = Number(args[++i]) || 0;
}

const dataDir = resolveDataDir();

/** Runtime session dirs are named `<stamp>-session_<base64(sessionId)>`. */
function base64Of(id) {
  return Buffer.from(id, 'utf8').toString('base64').replace(/=+$/, '');
}

function findSessionDir(id) {
  const needle = `session_${base64Of(id)}`;
  const roots = [path.join(dataDir, 'v2', 'sessions'), path.join(dataDir, 'sessions')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name.includes(needle)) return path.join(dir, entry.name);
          stack.push(path.join(dir, entry.name));
        }
      }
    }
  }
  return null;
}

/** Most recently modified session dir that holds a messages.jsonl. */
function findLatestSessionDir() {
  const roots = [path.join(dataDir, 'v2', 'sessions'), path.join(dataDir, 'sessions')];
  let best = null;
  let bestTime = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.name === 'messages.jsonl') {
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {
            mtime = 0;
          }
          if (mtime > bestTime) {
            bestTime = mtime;
            best = path.dirname(full);
          }
        }
      }
    }
  }
  return best;
}

function resolveSessionDir() {
  if (sessionDir) return path.resolve(sessionDir);
  if (sessionId) {
    const found = findSessionDir(sessionId);
    if (!found) {
      process.stderr.write(`session not found: ${sessionId}\n`);
      process.exit(1);
    }
    return found;
  }
  if (latest) {
    const found = findLatestSessionDir();
    if (!found) {
      process.stderr.write('no runtime session found\n');
      process.exit(1);
    }
    return found;
  }
  const envId =
    process.env.MAVIS_SESSION_ID ||
    process.env.__MAVIS_PARENT_SESSION_ID ||
    process.env.MINIMAX_SESSION_ID;
  if (envId) {
    const found = findSessionDir(envId);
    if (found) return found;
  }
  process.stderr.write('cannot detect current session; pass --session <id>\n');
  process.exit(1);
  return null;
}

function readMessages(dir) {
  const file = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(file)) {
    process.stderr.write(`messages.jsonl not found in ${dir}\n`);
    process.exit(1);
  }
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const msg = obj && typeof obj.message === 'object' && obj.message ? obj.message : obj;
    if (msg && msg.role) rows.push({ msg, turnId: obj.turn_id ?? null });
  }
  return rows;
}

const dir = resolveSessionDir();
const rows = readMessages(dir);

const actions = [];
for (const { msg, turnId } of rows) {
  if (msg.role !== 'assistant' || !msg.usage) continue;
  const u = msg.usage || {};
  const tools = (msg.content || [])
    .filter((c) => c && c.type === 'toolCall')
    .map((c) => c.name);
  actions.push({
    seq: actions.length + 1,
    turnId,
    timestamp: msg.timestamp ?? null,
    model: msg.model ?? null,
    provider: msg.provider ?? null,
    stopReason: msg.stopReason ?? null,
    tools,
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    totalTokens: u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
    cost: u.cost?.total ?? 0,
  });
}

const shown = limit > 0 ? actions.slice(-limit) : actions;
const totals = actions.reduce(
  (acc, a) => {
    acc.input += a.input;
    acc.output += a.output;
    acc.cacheRead += a.cacheRead;
    acc.cacheWrite += a.cacheWrite;
    acc.totalTokens += a.totalTokens;
    acc.cost += a.cost;
    return acc;
  },
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
);

if (asJson) {
  process.stdout.write(`${JSON.stringify({ sessionDir: dir, actions: shown, totals }, null, 2)}\n`);
  process.exit(0);
}

const pad = (v, n) => String(v).padStart(n);
const time = (ts) => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) : '-');

process.stdout.write(`session: ${path.basename(dir)}\n`);
process.stdout.write(`actions: ${actions.length}\n\n`);
process.stdout.write(
  `${pad('#', 4)}${pad('input', 9)}${pad('output', 9)}${pad('cacheRd', 10)}${pad('cacheWr', 10)}${pad('total', 10)}  tools / time\n`,
);
for (const a of shown) {
  const tools = a.tools.length ? a.tools.join(',') : (a.stopReason || '-');
  process.stdout.write(
    `${pad(a.seq, 4)}${pad(a.input, 9)}${pad(a.output, 9)}${pad(a.cacheRead, 10)}${pad(a.cacheWrite, 10)}${pad(a.totalTokens, 10)}  ${tools}  ${time(a.timestamp)}\n`,
  );
}
process.stdout.write(
  `\nTOTAL  input=${totals.input}  output=${totals.output}  cacheRead=${totals.cacheRead}  cacheWrite=${totals.cacheWrite}  totalTokens=${totals.totalTokens}  cost=${totals.cost}\n`,
);
process.stdout.write(`billable(no cache) = input+output = ${totals.input + totals.output}\n`);
