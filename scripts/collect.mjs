#!/usr/bin/env node
/**
 * plugintree hook collector.
 *
 * One synchronous command handler serves every hook event. It:
 *   1. tails the hook transcript to pick up the assistant's reasoning
 *      (thinking / text) that the hook payload itself does not carry;
 *   2. records the hook event itself;
 *   3. on turn end, writes the mechanical tree for that turn.
 *
 * The collector is strictly side-effect only: it writes nothing to stdout and
 * always exits 0, so a failure can never block the agent's turn.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWorkspaceRoot, stateDir, ensureDir } from './lib/paths.mjs';
import { registerWorkspace } from './lib/registry.mjs';
import {
  appendEvent,
  readSessionEvents,
  writeTree,
  readTranscriptState,
  writeTranscriptState,
  ensureDataLayout,
} from './lib/store.mjs';
import { readTranscriptSlice, extractReasoning } from './lib/transcript.mjs';
import { partitionTurns, buildMechanicalTree } from './lib/tree.mjs';
import { decorateTreeWithUsage } from './lib/usage.mjs';
import { now, truncate, readJson, writeJsonAtomic } from './lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MAX_TEXT = 20000;
const MAX_OUTPUT = 8000;
const LOCK_TIMEOUT_MS = 3000;
const LOCK_STALE_MS = 10000;

/** Acquire a simple cross-process lock so parallel hook invocations do not race. */
function withLock(lockPath, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let handle;
    try {
      handle = fs.openSync(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Break a stale lock left behind by a killed process.
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) return fn();
      sleep(20);
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        fs.closeSync(handle);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  }
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait is acceptable here: the window is a few milliseconds.
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function sessionsStatePath(workspaceRoot) {
  return path.join(stateDir(workspaceRoot), 'sessions.json');
}

function readSessionsState(workspaceRoot) {
  return readJson(sessionsStatePath(workspaceRoot), {});
}

function writeSessionsState(workspaceRoot, state) {
  writeJsonAtomic(sessionsStatePath(workspaceRoot), state);
}

/** Tail the transcript and record any new reasoning as events. */
function flushReasoning(workspaceRoot, { transcriptPath, sessionId, turnId }) {
  if (!transcriptPath || !turnId) return;
  const states = readTranscriptState(workspaceRoot);
  const offset = states[transcriptPath] ?? 0;
  const { records, offset: nextOffset } = readTranscriptSlice(transcriptPath, offset);
  if (records.length) {
    for (const item of extractReasoning(records)) {
      const text = String(item.text ?? '');
      if (!text.trim()) continue;
      appendEvent(workspaceRoot, {
        v: 1,
        seq: now(),
        ts: item.ts ?? now(),
        session: sessionId,
        turn: turnId,
        kind: 'reasoning',
        origin: 'live',
        data: {
          channel: item.channel,
          text: text.slice(0, MAX_TEXT),
          source: transcriptPath,
          sourceTs: item.ts ?? null,
        },
      });
    }
  }
  if (nextOffset !== offset) {
    states[transcriptPath] = nextOffset;
    writeTranscriptState(workspaceRoot, states);
  }
}

/**
 * Build and persist the tree for the turn that just changed.
 *
 * This runs after every hook event, not only at the end of the turn, so the
 * viewer grows the tree while the agent is still working: every thought and
 * every tool call shows up as a node right away.
 */
function finalizeTurn(workspaceRoot, { sessionId, turnId }) {
  if (!turnId) return;
  const events = readSessionEvents(workspaceRoot, sessionId, 'live');
  const turns = partitionTurns(events);
  const turn = turns.find((t) => t.turnId === turnId);
  if (!turn) return;
  const tree = buildMechanicalTree(turn, { sessionId, origin: 'live', workspaceRoot });
  if (!tree) return;
  // The token cost of every action is read from the runtime's session log, so
  // the stored tree carries the numbers the viewer shows. A missing log only
  // means the tree has no token information.
  try {
    decorateTreeWithUsage(tree, sessionId);
  } catch {
    /* the tree is still worth keeping without token numbers */
  }
  writeTree(workspaceRoot, tree);
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const eventName = payload.hook_event_name || '';
  const sessionId = payload.session_id || null;
  const workspaceRoot = resolveWorkspaceRoot(payload.cwd);
  const turnId = payload.turn_id || null;
  const transcriptPath = payload.transcript_path || null;

  ensureDataLayout(workspaceRoot);
  const lockPath = path.join(ensureDir(stateDir(workspaceRoot)), 'collect.lock');

  withLock(lockPath, () => {
    const state = readSessionsState(workspaceRoot);
    const session = (sessionId && state[sessionId]) || { currentTurn: null, lastStopTurn: null };
    let currentTurn = session.currentTurn ?? null;

    if (eventName === 'UserPromptSubmit') {
      // Flush anything the previous turn wrote after its Stop hook fired.
      flushReasoning(workspaceRoot, { transcriptPath, sessionId, turnId: currentTurn });
      currentTurn = turnId ?? currentTurn;
    } else if (turnId) {
      currentTurn = turnId;
      flushReasoning(workspaceRoot, { transcriptPath, sessionId, turnId: currentTurn });
    } else {
      flushReasoning(workspaceRoot, { transcriptPath, sessionId, turnId: currentTurn });
    }

    const data = buildEventData(eventName, payload);
    if (data !== null) {
      appendEvent(workspaceRoot, {
        v: 1,
        seq: now(),
        ts: now(),
        session: sessionId,
        turn: currentTurn,
        kind: data.kind,
        origin: 'live',
        cwd: payload.cwd ?? null,
        data: data.payload,
      });
    }

    if (eventName === 'Stop') {
      session.lastStopTurn = currentTurn;
    }

    // The tree is rewritten after every event so the viewer can follow the
    // turn live. A tree failure must never break the agent's turn.
    try {
      finalizeTurn(workspaceRoot, { sessionId, turnId: currentTurn });
    } catch {
      /* fail open: never surface an error to the agent */
    }

    // Announce this workspace to the global registry so the viewer can offer
    // it in the workspace switcher, even when it runs somewhere else.
    try {
      registerWorkspace(workspaceRoot, { eventTs: now(), sessionId });
    } catch {
      /* the registry is a convenience, never a hard dependency */
    }

    session.currentTurn = currentTurn;
    if (sessionId) {
      state[sessionId] = session;
      writeSessionsState(workspaceRoot, state);
    }
  });
}

function buildEventData(eventName, payload) {
  switch (eventName) {
    case 'SessionStart':
      return { kind: 'session_start', payload: { source: payload.source ?? null } };
    case 'SessionEnd':
      return { kind: 'session_end', payload: { reason: payload.reason ?? null } };
    case 'UserPromptSubmit':
      return {
        kind: 'user_prompt',
        payload: { text: String(payload.prompt ?? '').slice(0, MAX_TEXT) },
      };
    case 'PreToolUse':
      return {
        kind: 'tool_call',
        payload: {
          toolUseId: payload.tool_use_id ?? null,
          tool: payload.tool_name ?? 'unknown',
          input: payload.tool_input ?? null,
        },
      };
    case 'PostToolUse':
      return {
        kind: 'tool_result',
        payload: {
          toolUseId: payload.tool_use_id ?? null,
          tool: payload.tool_name ?? 'unknown',
          ok: payload.tool_response ? !isErrorResponse(payload.tool_response) : true,
          output: stringifyOutput(payload.tool_response).slice(0, MAX_OUTPUT),
        },
      };
    case 'PermissionRequest':
      return {
        kind: 'permission',
        payload: { tool: payload.tool_name ?? 'unknown', input: payload.tool_input ?? null },
      };
    case 'SubagentStart':
      return {
        kind: 'subagent_start',
        payload: { agentId: payload.agent_id ?? null, agentType: payload.agent_type ?? null },
      };
    case 'SubagentStop':
      return {
        kind: 'subagent_stop',
        payload: {
          agentId: payload.agent_id ?? null,
          agentType: payload.agent_type ?? null,
          message: truncate(payload.last_assistant_message ?? '', 2000),
        },
      };
    case 'Stop':
      return { kind: 'stop', payload: {} };
    case 'PreCompact':
      return { kind: 'compact', payload: { phase: 'pre', trigger: payload.trigger ?? null } };
    case 'PostCompact':
      return { kind: 'compact', payload: { phase: 'post', trigger: payload.trigger ?? null } };
    default:
      return null;
  }
}

function isErrorResponse(response) {
  if (!response) return false;
  if (typeof response === 'object') {
    if (response.isError === true || response.status === 'error') return true;
    if (typeof response.success === 'boolean') return !response.success;
  }
  return false;
}

function stringifyOutput(response) {
  if (response === null || response === undefined) return '';
  if (typeof response === 'string') return response;
  try {
    return JSON.stringify(response, null, 2);
  } catch {
    return String(response);
  }
}

try {
  main();
} catch {
  /* fail open: never surface an error to the agent */
}
process.exit(0);
