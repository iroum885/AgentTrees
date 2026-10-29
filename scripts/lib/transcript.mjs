import fs from 'node:fs';
import path from 'node:path';
import { truncate, toEpochMs } from './util.mjs';

/**
 * Transcript readers.
 *
 * Two on-disk shapes are supported:
 *
 *  1. Hook transcript (Claude-compatible), passed to hooks as `transcript_path`:
 *     `{ uuid, parentUuid, sessionId, timestamp, type, message }`.
 *     Assistant blocks: `{type:"text"}` (sometimes a JSON-encoded thinking
 *     payload), `{type:"tool_use", id, name, input}`.
 *
 *  2. Session transcript (`<dataDir>/v2/sessions/.../messages.jsonl`):
 *     `{ message_id, turn_id, message }` where `message.content` holds
 *     `{type:"thinking"|"text"|"toolCall"|"toolResult"}` blocks. Used for
 *     backfilling historical sessions, which carry an explicit turn id.
 */

/**
 * Read new lines from a transcript file starting at `offset`.
 * Returns the parsed records plus the new byte offset.
 */
export function readTranscriptSlice(file, offset) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { records: [], offset };
  }
  let start = offset;
  if (stat.size < start) start = 0; // rotated or truncated
  if (stat.size === start) return { records: [], offset: start };

  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const length = stat.size - start;
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(handle, buffer, 0, length, start);
    fs.closeSync(handle);
    const text = buffer.toString('utf8');
    const parts = text.split(/\r?\n/);
    // A file ending with a newline yields a trailing empty segment that must
    // not be counted, otherwise the offset overshoots and the next read
    // rewinds to zero and re-ingests every line.
    let tail = '';
    if (text.endsWith('\n')) parts.pop();
    else tail = parts.pop() ?? '';
    const records = [];
    let consumed = start;
    for (const line of parts) {
      consumed += Buffer.byteLength(line, 'utf8') + 1;
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* ignore an unparsable line */
      }
    }
    // The partial trailing line stays unconsumed so the next read retries it.
    return { records, offset: consumed };
  } catch (error) {
    try {
      if (handle !== undefined) fs.closeSync(handle);
    } catch {
      /* ignore */
    }
    return { records: [], offset: start };
  }
}

/** Decode a Claude-compatible text block, which may wrap a thinking payload. */
function decodeTextBlock(text) {
  const trimmed = (text ?? '').trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.type === 'thinking' && typeof parsed.thinking === 'string') {
        return { channel: 'thinking', text: parsed.thinking };
      }
    } catch {
      /* plain text that merely starts with a brace */
    }
  }
  return { channel: 'text', text: text ?? '' };
}

/**
 * Extract reasoning items from hook transcript records.
 * Tool calls are ignored here: the PreToolUse hook is authoritative for them.
 */
export function extractReasoning(records) {
  const out = [];
  for (const record of records) {
    if (!record || record.type !== 'assistant') continue;
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    // The transcript writes ISO strings; every timestamp leaves this reader
    // as epoch milliseconds so it can be compared with the hook timestamps.
    const ts = toEpochMs(record.timestamp);
    for (const block of content) {
      if (!block) continue;
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        out.push({ channel: 'thinking', text: block.thinking, ts });
      } else if (block.type === 'text') {
        const decoded = decodeTextBlock(block.text);
        if (decoded.text.trim()) {
          out.push({ channel: decoded.channel, text: decoded.text, ts });
        }
      }
    }
  }
  return out;
}

/** Pull the readable output out of a toolResult message. */
function toolResultOutput(message) {
  const details = message.details || {};
  const process = details.processOutput || {};
  const parts = [];
  if (process.stdout) parts.push(String(process.stdout));
  if (process.stderr) parts.push(String(process.stderr));
  if (!parts.length && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block && typeof block.text === 'string') parts.push(block.text);
    }
  }
  if (!parts.length && typeof message.content === 'string') parts.push(message.content);
  return parts.join('\n');
}

/**
 * Convert a session `messages.jsonl` file into normalized events.
 * `origin` marks the records as backfilled rather than live.
 */
export function parseSessionMessages(file, { sessionId, origin = 'history' } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  let seq = 0;

  const push = (turnId, kind, data, ts) => {
    seq += 1;
    events.push({
      v: 1,
      seq,
      ts: typeof ts === 'number' ? ts : null,
      session: sessionId ?? null,
      turn: turnId ?? null,
      kind,
      origin,
      data,
    });
  };

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const turnId = record?.turn_id ?? null;
    const message = record?.message ?? {};
    const role = message.role ?? record?.role ?? null;
    const content = message.content;
    const timestamp = record?.timestamp ?? message.timestamp ?? null;
    const ts = toEpochMs(timestamp);

    // A tool result is a whole message, not a block inside an assistant turn.
    if (role === 'toolResult') {
      const details = message.details || {};
      const execution = details.execution || {};
      push(
        turnId,
        'tool_result',
        {
          toolUseId: message.toolCallId ?? message.tool_call_id ?? null,
          tool: message.toolName ?? null,
          ok: message.isError !== true && execution.status !== 'error',
          output: toolResultOutput(message).slice(0, 8000),
          description: details.description ?? null,
          exitCode: execution.exitCode ?? null,
        },
        ts,
      );
      continue;
    }

    if (!Array.isArray(content)) {
      if (typeof content === 'string' && content.trim() && role === 'user') {
        push(turnId, 'user_prompt', { text: content }, ts);
      }
      continue;
    }

    for (const block of content) {
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        if (role === 'user') {
          push(turnId, 'user_prompt', { text: block.text }, ts);
        } else if (block.text.trim()) {
          push(turnId, 'reasoning', { channel: 'text', text: block.text }, ts);
        }
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        push(turnId, 'reasoning', { channel: 'thinking', text: block.thinking }, ts);
      } else if (block.type === 'toolCall') {
        push(
          turnId,
          'tool_call',
          {
            toolUseId: block.id ?? null,
            tool: block.name ?? 'unknown',
            input: block.arguments ?? block.input ?? null,
          },
          ts,
        );
      }
    }
  }
  return events;
}

/** Resolve the session directory that owns a given session id. */
export function findSessionDir(sessionsRoot, sessionId) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const stack = dirs.filter((d) => d.isDirectory()).map((d) => path.join(sessionsRoot, d.name));
  const found = [];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (entry.name.endsWith(`-${sessionId}`)) found.push(child);
      else if (/\d{4}$/.test(entry.name) || /^\d{2}-\d{2}-\d{2}/.test(entry.name)) stack.push(child);
    }
  }
  return found.sort().pop() ?? null;
}
