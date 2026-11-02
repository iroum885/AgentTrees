import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './paths.mjs';

/**
 * Token accounting for a session.
 *
 * The runtime keeps one log per session under
 * `<dataDir>/v2/sessions/<yyyy>/<mm>/<dd>/<stamp>-session_<base64>/messages.jsonl`.
 * Every assistant message in that log carries a `usage` block, so the exact
 * cost of every model call is known — and every tool call in that message is
 * known too.
 *
 * Two numbers are attributed to an action:
 *
 *   回填 (backfill)  the tokens the action pushed into the context. The tool
 *                    result has to be carried by every later call, so it is
 *                    measured with the runtime identity
 *                      ctx[i+1] - ctx[i] - gen[i]
 *                    where `ctx = input + cacheRead` and `gen` is what the
 *                    model produced in call i. When there is no later call the
 *                    size of the result text is estimated instead.
 *   生成 (gen)       the tokens the model spent writing the arguments of the
 *                    action. The generation budget of a call is split between
 *                    the reasoning text and the arguments by their size.
 *
 * A strategy node owns the reasoning text of its call, so it carries the
 * thinking tokens of that call.
 *
 * Everything here fails open: a missing or unreadable log means "no token
 * information", never an error.
 */

/** Rough token estimate for text the runtime has not measured. */
export function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  let cjk = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
  }
  const rest = value.length - cjk;
  return Math.round(cjk * 1.05 + rest / 3.6);
}

function base64Of(id) {
  return Buffer.from(String(id), 'utf8').toString('base64').replace(/=+$/, '');
}

/** Where the runtime keeps the session logs. */
function sessionsRoot() {
  return path.join(resolveDataDir(), 'v2', 'sessions');
}

/** Cached lookup of a session's log directory. */
const sessionDirCache = new Map();

function findSessionDir(sessionId) {
  if (!sessionId) return null;
  const cached = sessionDirCache.get(sessionId);
  if (cached) {
    try {
      if (fs.existsSync(cached)) return cached;
    } catch {
      /* fall through and look again */
    }
    sessionDirCache.delete(sessionId);
  }

  const root = sessionsRoot();
  const needle = `session_${base64Of(sessionId)}`;
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
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.includes(needle)) {
        sessionDirCache.set(sessionId, full);
        return full;
      }
      // The log lives at <root>/<yyyy>/<mm>/<dd>/<session>.
      if (dir === root || dir.split(path.sep).length <= root.split(path.sep).length + 3) {
        stack.push(full);
      }
    }
  }
  return null;
}

/**
 * The parsed session log, kept per file.
 *
 * The log is append-only and grows while the agent works, so it is parsed
 * incrementally: only the bytes that were added since the last read are
 * parsed again. Re-reading a multi-megabyte log on every poll would keep the
 * server busy all the time.
 */
const logCache = new Map();

/**
 * Parse one JSONL line into the call / result collections.
 *
 * Returns false when the line could not be parsed, which means it is most
 * likely a half-written line: the caller keeps it for the next read.
 */
function absorbLine(line, calls, results) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const msg = obj && typeof obj.message === 'object' && obj.message ? obj.message : obj;
  if (!msg || !msg.role) return;

  if (msg.role === 'assistant' && msg.usage) {
    const u = msg.usage;
    const parts = Array.isArray(msg.content) ? msg.content : [];
    const toolCalls = parts
      .filter((c) => c && c.type === 'toolCall')
      .map((c) => ({
        id: c.id ? String(c.id) : null,
        tool: c.name ?? 'tool',
        argsText: JSON.stringify(c.arguments ?? {}),
      }));
    const thinkChars = parts
      .filter((c) => c && c.type === 'thinking')
      .reduce((sum, c) => sum + String(c.thinking ?? '').length, 0);
    const sayChars = parts
      .filter((c) => c && c.type === 'text')
      .reduce((sum, c) => sum + String(c.text ?? '').length, 0);
    calls.push({
      ts: typeof msg.timestamp === 'number' ? msg.timestamp : null,
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      totalTokens: u.totalTokens ?? 0,
      model: msg.model ?? null,
      toolCalls,
      thinkChars,
      sayChars,
      ctx: (u.input ?? 0) + (u.cacheRead ?? 0),
    });
  } else if (msg.role === 'toolResult') {
    const text = (Array.isArray(msg.content) ? msg.content : [])
      .map((c) => (c && c.type === 'text' ? String(c.text ?? '') : ''))
      .join('\n');
    results.set(String(msg.toolCallId), {
      text,
      tokens: estimateTokens(text),
      ok: msg.isError !== true,
    });
  }
}

function readSessionLog(sessionId) {
  const dir = findSessionDir(sessionId);
  if (!dir) return null;
  const file = path.join(dir, 'messages.jsonl');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const cached = logCache.get(file);
  // The log only ever grows, so the bytes that were already read stay valid.
  // A file that shrank was replaced: start over.
  if (cached && cached.size > stat.size) {
    logCache.delete(file);
  }
  const state = cached && cached.size <= stat.size
    ? cached
    : { size: 0, mtimeMs: stat.mtimeMs, calls: [], results: new Map(), carry: '' };

  if (state.size === stat.size) {
    state.mtimeMs = stat.mtimeMs;
    logCache.set(file, state);
    return { calls: state.calls, results: state.results };
  }

  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const length = stat.size - state.size;
    if (length > 0) {
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, state.size);
      const chunk = state.carry + buffer.slice(0, read).toString('utf8');
      const lines = chunk.split(/\r?\n/);
      const tail = lines.pop() ?? '';
      for (const line of lines) absorbLine(line, state.calls, state.results);
      // The tail is either a complete line whose newline has not arrived yet,
      // or a half-written line that has to wait for the next read.
      state.carry = absorbLine(tail, state.calls, state.results) ? '' : tail;
      state.size = state.size + read;
    }
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  state.mtimeMs = stat.mtimeMs;
  const value = { calls: state.calls, results: state.results };
  logCache.set(file, state);
  return value;
}

/**
 * The token cost of every action of a session.
 *
 * Returns a map keyed by tool call id plus the totals of the whole session.
 */
export function readSessionUsage(sessionId) {
  const log = readSessionLog(sessionId);
  if (!log) return null;
  const { calls, results } = log;

  const byToolUseId = new Map();
  const byCallTs = new Map();
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    billable: 0,
    actions: 0,
    modelCalls: calls.length,
  };

  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const next = calls[i + 1];

    const resultTokens = call.toolCalls.reduce(
      (sum, tc) => sum + (tc.id ? (results.get(tc.id)?.tokens ?? 0) : 0),
      0,
    );

    // The tokens the tool results of this call added to the context.
    let injected = resultTokens;
    let measured = false;
    if (next) {
      const delta = next.ctx - call.ctx - call.output;
      if (delta >= 0) {
        injected = delta;
        measured = true;
      }
    }

    const argChars = call.toolCalls.reduce((sum, tc) => sum + tc.argsText.length, 0);
    const textChars = call.thinkChars + call.sayChars;
    const genTotal = call.output;
    const genPerChar = genTotal / Math.max(1, textChars + argChars);

    const thinkTokens = Math.round(textChars * genPerChar);

    let remaining = injected;
    call.toolCalls.forEach((tc, index) => {
      if (!tc.id) return;
      const share = resultTokens > 0
        ? injected * ((results.get(tc.id)?.tokens ?? 0) / resultTokens)
        : injected / Math.max(1, call.toolCalls.length);
      const backfill = index === call.toolCalls.length - 1
        ? remaining
        : Math.round(share);
      remaining -= backfill;
      byToolUseId.set(tc.id, {
        tool: tc.tool,
        backfill: Math.max(0, Math.round(backfill)),
        gen: Math.round(tc.argsText.length * genPerChar),
        measured,
        resultTokens: results.get(tc.id)?.tokens ?? 0,
        ok: results.get(tc.id)?.ok ?? null,
      });
      totals.actions += 1;
    });

    if (call.ts !== null) {
      byCallTs.set(call.ts, { thinkTokens, call });
    }

    totals.input += call.input;
    totals.output += call.output;
    totals.cacheRead += call.cacheRead;
    totals.cacheWrite += call.cacheWrite;
    totals.totalTokens += call.totalTokens || (call.input + call.output + call.cacheRead + call.cacheWrite);
    totals.billable += call.input + call.output;
  }

  return { byToolUseId, byCallTs, totals };
}

/** The time window a turn covers, taken from the tree's own nodes. */
function turnWindow(tree) {
  let start = null;
  let end = null;
  for (const node of tree.nodes || []) {
    if (typeof node.ts !== 'number') continue;
    const finish = node.ts + (typeof node.durationMs === 'number' ? node.durationMs : 0);
    if (start === null || node.ts < start) start = node.ts;
    if (end === null || finish > end) end = finish;
  }
  return { start, end };
}

/**
 * Attach the token cost of every action to the tree.
 *
 * The tree is modified in place and returned. When the session log is not
 * available the tree is returned untouched: the viewer then simply shows no
 * token numbers.
 */
export function decorateTreeWithUsage(tree, sessionId) {
  if (!tree || !Array.isArray(tree.nodes)) return tree;
  const usage = readSessionUsage(sessionId || tree.sessionId);
  if (!usage) return tree;

  const { start, end } = turnWindow(tree);
  const windowStart = start === null ? null : start - 3000;
  const windowEnd = end === null ? null : end + 3000;
  const inWindow = (ts) => {
    if (ts === null || ts === undefined) return false;
    if (windowStart !== null && ts < windowStart) return false;
    if (windowEnd !== null && ts > windowEnd) return false;
    return true;
  };

  let actionTokens = 0;
  let actionCount = 0;
  let thinkTokens = 0;

  // Execution nodes: the cost of the tool call they stand for.
  for (const node of tree.nodes) {
    if (!node.toolUseId) continue;
    const entry = usage.byToolUseId.get(String(node.toolUseId));
    if (!entry) continue;
    const total = entry.backfill + entry.gen;
    node.tokens = {
      backfill: entry.backfill,
      gen: entry.gen,
      total,
      estimated: !entry.measured,
    };
    actionTokens += total;
    actionCount += 1;
  }

  // Strategy nodes: the thinking of the model call they came from.
  const thinkByTs = new Map();
  for (const [ts, entry] of usage.byCallTs) {
    thinkByTs.set(ts, entry.thinkTokens);
  }
  const thinkHits = new Map();
  for (const node of tree.nodes) {
    if (node.type !== 'scheme' && node.type !== 'reasoning') continue;
    let best = null;
    let bestDistance = Infinity;
    for (const ts of thinkByTs.keys()) {
      if (!inWindow(ts)) continue;
      const distance = Math.abs(ts - (node.ts ?? ts));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = ts;
      }
    }
    if (best === null || bestDistance > 4000) continue;
    const hit = (thinkHits.get(best) ?? 0) + 1;
    thinkHits.set(best, hit);
    const share = Math.round(thinkByTs.get(best) / hit);
    node.tokens = { think: share, total: share };
    thinkTokens += share;
  }

  // The totals of this turn.
  let turnInput = 0;
  let turnOutput = 0;
  let turnCacheRead = 0;
  let turnCacheWrite = 0;
  let turnTotal = 0;
  let modelCalls = 0;
  for (const [, entry] of usage.byCallTs) {
    const call = entry.call;
    if (!inWindow(call.ts)) continue;
    modelCalls += 1;
    turnInput += call.input;
    turnOutput += call.output;
    turnCacheRead += call.cacheRead;
    turnCacheWrite += call.cacheWrite;
    turnTotal += call.totalTokens || (call.input + call.output + call.cacheRead + call.cacheWrite);
  }

  const nodeDurations = (tree.nodes || []).reduce(
    (sum, node) => sum + (typeof node.durationMs === 'number' ? node.durationMs : 0),
    0,
  );

  tree.totals = {
    tokens: {
      input: turnInput,
      output: turnOutput,
      cacheRead: turnCacheRead,
      cacheWrite: turnCacheWrite,
      total: turnTotal,
      billable: turnInput + turnOutput,
      actionTokens,
      actionCount,
      thinking: thinkTokens,
    },
    durationMs: start !== null && end !== null ? Math.max(0, end - start) : 0,
    nodeDurationMs: nodeDurations,
    modelCalls,
    nodeCount: Array.isArray(tree.nodes) ? tree.nodes.length : 0,
  };

  return tree;
}
