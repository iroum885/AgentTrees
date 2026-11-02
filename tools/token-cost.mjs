#!/usr/bin/env node
/**
 * Attribute token cost to individual actions (reads, writes, searches, commands,
 * reasoning steps) instead of to whole model calls.
 *
 * Two numbers are produced per action:
 *
 *   回填 token  the tokens the action pushed into the context, i.e. the size of
 *               the tool result the model had to carry afterwards.
 *               Measured with the runtime identity
 *                 ctx[i+1] - ctx[i] - gen[i]   (ctx = input + cacheRead)
 *               where `gen` is what the model generated in call i.
 *   生成 token  the tokens the model spent emitting that action's arguments.
 *
 * Reasoning ("策略") gets the generation tokens of the thinking / spoken text
 * that was not spent on any tool call.
 *
 *   node tools/token-cost.mjs                       # current session
 *   node tools/token-cost.mjs --session <id>
 *   node tools/token-cost.mjs --session-dir <dir>
 *   node tools/token-cost.mjs --json
 *   node tools/token-cost.mjs --limit 15
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../scripts/lib/paths.mjs';
import { toolAction, ACTION_KINDS } from '../scripts/lib/labels.mjs';

const args = process.argv.slice(2);
let sessionId = null;
let sessionDir = null;
let asJson = false;
let limit = 0;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session' || args[i] === '-s') sessionId = args[++i];
  else if (args[i] === '--session-dir') sessionDir = args[++i];
  else if (args[i] === '--json') asJson = true;
  else if (args[i] === '--limit' || args[i] === '-n') limit = Number(args[++i]) || 0;
}

const dataDir = resolveDataDir();

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
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name.includes(needle)) return full;
        stack.push(full);
      }
    }
  }
  return null;
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

/** Rough token estimate for content the runtime has not measured yet. */
function estimateTokens(text) {
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

const dir = resolveSessionDir();
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
  if (msg && msg.role) rows.push(msg);
}

/** Model calls, in order, with their usage and their tool calls. */
const calls = [];
for (const msg of rows) {
  if (msg.role !== 'assistant' || !msg.usage) continue;
  const u = msg.usage;
  const parts = msg.content || [];
  const toolCalls = parts
    .filter((c) => c && c.type === 'toolCall')
    .map((c) => ({
      id: c.id,
      tool: c.name,
      argsText: JSON.stringify(c.arguments ?? {}),
    }));
  const thinkText = parts
    .filter((c) => c && c.type === 'thinking')
    .map((c) => c.thinking ?? '')
    .join('\n');
  const sayText = parts
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
  calls.push({
    turnId: msg.turn_id ?? null,
    timestamp: msg.timestamp ?? null,
    model: msg.model ?? null,
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    totalTokens: u.totalTokens ?? 0,
    toolCalls,
    thinkText,
    sayText,
    ctx: (u.input ?? 0) + (u.cacheRead ?? 0),
  });
}

/** Tool results, keyed by the tool call id they answer. */
const results = new Map();
for (const msg of rows) {
  if (msg.role !== 'toolResult') continue;
  const text = (msg.content || [])
    .map((c) => (c && c.type === 'text' ? c.text : ''))
    .join('\n');
  results.set(String(msg.toolCallId), {
    text,
    tokens: estimateTokens(text),
    ok: msg.isError !== true,
  });
}

/** Actions, one per tool call, carrying their attributed token cost. */
const actions = [];
const thinkings = [];

for (let i = 0; i < calls.length; i += 1) {
  const call = calls[i];
  const next = calls[i + 1];

  // Tokens this call's tool results added to the context.
  const resultTokens = call.toolCalls.reduce(
    (sum, tc) => sum + (results.get(String(tc.id))?.tokens ?? 0),
    0,
  );
  let injected = resultTokens;
  let measured = false;
  if (next) {
    const delta = next.ctx - call.ctx - call.output;
    if (delta >= 0) {
      injected = delta;
      measured = true;
    }
  }

  // Generation budget of this call, split between the reasoning text and the
  // arguments of each tool call, proportionally to their size.
  const thinkChars = call.thinkText.length + call.sayText.length;
  const argChars = call.toolCalls.reduce((sum, tc) => sum + tc.argsText.length, 0);
  const genTotal = call.output;
  const genPerChar = genTotal / Math.max(1, thinkChars + argChars);

  const argShares = call.toolCalls.map((tc) => tc.argsText.length * genPerChar);

  if (thinkChars > 0) {
    thinkings.push({
      seq: i + 1,
      timestamp: call.timestamp,
      title: (call.sayText || call.thinkText).replace(/\s+/g, ' ').trim().slice(0, 60) || '思考',
      thinkTokens: Math.round(thinkChars * genPerChar),
      callOutput: genTotal,
      toolCount: call.toolCalls.length,
    });
  }

  const total = injected;
  let remaining = total;
  for (let t = 0; t < call.toolCalls.length; t += 1) {
    const tc = call.toolCalls[t];
    const share = call.toolCalls.length
      ? total * ((results.get(String(tc.id))?.tokens ?? 0) / Math.max(1, resultTokens))
      : 0;
    const backfill = Math.round(share);
    remaining -= backfill;
    const action = toolAction(tc.tool);
    actions.push({
      seq: actions.length + 1,
      callSeq: i + 1,
      timestamp: call.timestamp,
      tool: tc.tool,
      kind: action.kind,
      label: action.label,
      target: tc.argsText.length > 0 ? tc.argsText.slice(0, 0) + summarize(tc.tool, tc.argsText) : '',
      backfillTokens: backfill,
      genTokens: Math.round(argShares[t]),
      totalTokens: backfill + Math.round(argShares[t]),
      measured,
      ok: results.get(String(tc.id))?.ok ?? null,
      resultChars: results.get(String(tc.id))?.text.length ?? 0,
    });
  }
  if (call.toolCalls.length && remaining !== 0 && actions.length) {
    actions[actions.length - 1].backfillTokens += remaining;
    actions[actions.length - 1].totalTokens += remaining;
  }
}

/** A one-line target for a tool call, e.g. `read: .\a.txt`. */
function summarize(tool, argsText) {
  let args = {};
  try {
    args = JSON.parse(argsText);
  } catch {
    return tool;
  }
  const pick = (keys) => {
    for (const key of keys) {
      if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim();
    }
    return '';
  };
  const file = pick(['file_path', 'path', 'filePath', 'notebook_path', 'file']);
  if (file) return file;
  const cmd = pick(['command', 'script', 'cmd']);
  if (cmd) return cmd.replace(/\s+/g, ' ').slice(0, 70);
  const pattern = pick(['pattern', 'query']);
  if (pattern) return pattern;
  const url = pick(['url']);
  if (url) return url;
  const desc = pick(['description', 'name']);
  if (desc) return desc;
  return tool;
}

/* ----------------------------- aggregation ---------------------------- */

const byKind = new Map();
for (const a of actions) {
  const row = byKind.get(a.kind) ?? { kind: a.kind, label: a.label, count: 0, backfill: 0, gen: 0 };
  row.count += 1;
  row.backfill += a.backfillTokens;
  row.gen += a.genTokens;
  byKind.set(a.kind, row);
}
const thinkTotal = thinkings.reduce((s, t) => s + t.thinkTokens, 0);
const actionTotal = actions.reduce((s, a) => s + a.totalTokens, 0);
const ctxTotal = calls.reduce((s, c) => s + c.ctx, 0);
const cacheTotal = calls.reduce((s, c) => s + c.cacheRead, 0);

if (asJson) {
  process.stdout.write(`${JSON.stringify({
    sessionDir: dir,
    calls: calls.length,
    actions,
    thinkings,
    byKind: [...byKind.values()],
    totals: {
      actions: actionTotal,
      thinking: thinkTotal,
      contextRead: ctxTotal,
      cacheRead: cacheTotal,
      modelOutput: calls.reduce((s, c) => s + c.output, 0),
    },
  }, null, 2)}\n`);
  process.exit(0);
}

const pad = (v, n) => String(v).padStart(n);
const kindOrder = [...byKind.values()].sort((a, b) => (b.backfill + b.gen) - (a.backfill + a.gen));

process.stdout.write(`session: ${path.basename(dir)}\n`);
process.stdout.write(`模型调用 ${calls.length} 次 / 动作 ${actions.length} 个 / 思考 ${thinkings.length} 段\n\n`);

process.stdout.write('按动作类型汇总\n');
process.stdout.write(`${pad('动作类型', 14)}${pad('次数', 6)}${pad('回填', 10)}${pad('生成', 10)}${pad('合计', 10)}  占比\n`);
const grand = actionTotal + thinkTotal || 1;
for (const row of kindOrder) {
  const sum = row.backfill + row.gen;
  process.stdout.write(
    `${pad(row.label, 14)}${pad(row.count, 6)}${pad(row.backfill, 10)}${pad(row.gen, 10)}${pad(sum, 10)}  ${((sum / grand) * 100).toFixed(1)}%\n`,
  );
}
process.stdout.write(
  `${pad('思考/策略', 14)}${pad(thinkings.length, 6)}${pad('-', 10)}${pad(thinkTotal, 10)}${pad(thinkTotal, 10)}  ${((thinkTotal / grand) * 100).toFixed(1)}%\n`,
);

process.stdout.write('\n动作明细\n');
const shown = limit > 0 ? actions.slice(-limit) : actions;
for (const a of shown) {
  const flag = a.measured ? '' : '~';
  process.stdout.write(
    `${pad(a.seq, 4)}${pad(a.label, 12)}${pad(`${a.backfillTokens}${flag}`, 9)}${pad(a.genTokens, 7)}${pad(a.totalTokens, 9)}  ${a.target.slice(0, 64)}\n`,
  );
}
process.stdout.write(
  `\n合计: 动作 ${actionTotal}  思考 ${thinkTotal}  上下文读取 ${ctxTotal} (其中缓存命中 ${cacheTotal})\n`,
);
process.stdout.write('注: 回填列带 ~ 的行表示该动作后面没有下一次模型调用，token 由结果文本估算。\n');
