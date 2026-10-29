import { truncate, firstLine, toEpochMs } from './util.mjs';
import {
  executionTitle,
  formatCommand,
  relativePath,
  strategyTitle,
  toolAction,
  toolLabel,
} from './labels.mjs';

/**
 * Tree construction.
 *
 * Layout rules:
 *  - The root node is the message the user sent.
 *  - Reasoning steps form a layered chain: each strategy node is the child of
 *    the previous one.
 *  - Tool executions that ran between two strategy nodes become the evidence
 *    children of the *later* strategy node, i.e. "the commands executed at
 *    this layer aggregate into the next layer's scheme node".
 *  - A question the Agent asked the user (ask_user / permission request) is
 *    itself a strategy node, not an execution.
 *
 * There is no model in this path: every label is deterministic.
 */

/** Runtime-injected envelopes that are not a user message. */
const SYSTEM_TAGS = [
  'system-reminder',
  'agent-context',
  'mcode-tools-master-reminder',
  'async-audit',
  'environment-context',
  'browser-context',
  'in-app-browser-context',
  'background-task-finished',
  'background-task-notification',
  'task-notification',
  'user-message-locators',
  'question-answer',
];

/** Split a session event log into turns. */
export function partitionTurns(events) {
  const turns = [];
  const byId = new Map();

  const get = (id) => {
    let turn = byId.get(id);
    if (!turn) {
      turn = { turnId: id, startTs: null, endTs: null, events: [], order: turns.length };
      byId.set(id, turn);
      turns.push(turn);
    }
    return turn;
  };

  let currentId = null;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event) continue;
    const ts = toEpochMs(event.ts);

    if (event.kind === 'user_prompt') {
      currentId = event.turn || `turn-${i}`;
      const turn = get(currentId);
      if (turn.startTs === null || (ts ?? Infinity) < turn.startTs) turn.startTs = ts;
      turn.events.push(event);
      continue;
    }

    if (event.turn) {
      const turn = get(event.turn);
      if (event.kind === 'stop') turn.endTs = ts ?? turn.endTs;
      if (event.kind === 'user_prompt' && turn.startTs === null) turn.startTs = ts;
      turn.events.push(event);
      if (event.kind !== 'stop') currentId = event.turn;
      continue;
    }

    const owner = findTurnByTime(turns, ts);
    if (owner) owner.events.push(event);
    else if (currentId) get(currentId).events.push(event);
  }

  return turns;
}

function findTurnByTime(turns, ts) {
  if (typeof ts !== 'number') return null;
  let match = null;
  for (const turn of turns) {
    const start = turn.startTs ?? -Infinity;
    const end = turn.endTs ?? Infinity;
    if (ts >= start && ts <= end) match = turn;
  }
  return match;
}

let nodeCounter = 0;
function nextId() {
  nodeCounter += 1;
  return `n${nodeCounter}`;
}

/**
 * Extract the message the user actually sent.
 *
 * The runtime wraps user input in envelopes and, for a questionnaire, stores
 * the exchange as `Q: <agent question> / A: <user answer>` pairs inside one
 * user-role message. Only the `A` side belongs to the user.
 *
 * Returns `{ text, kind }` where kind is 'user' or 'system'.
 */
export function extractUserMessage(raw) {
  if (!raw) return { text: '', kind: 'system' };
  let text = String(raw);

  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  text = text.replace(/<questionnaire-response>[\s\S]*?<\/questionnaire-response>/g, '');
  text = text.replace(/<agent-context>[\s\S]*?<\/agent-context>/g, '');
  text = text.replace(/<mcode-tools-master-reminder>[\s\S]*?<\/mcode-tools-master-reminder>/g, '');

  // A leftover runtime envelope means this was not a user message.
  const leftover = text.match(/<\s*([a-z][a-z0-9-]*)\s*>/i);
  if (leftover && SYSTEM_TAGS.includes(leftover[1].toLowerCase())) {
    return { text: '', kind: 'system' };
  }

  const answers = [];
  const pairPattern = /(?:^|\n)Q:\s*([\s\S]*?)\nA:\s*([\s\S]*?)(?=\n\s*\nQ:|$)/g;
  let match = pairPattern.exec(text);
  let sawPair = false;
  while (match !== null) {
    sawPair = true;
    const answer = match[2].trim();
    if (answer) answers.push(answer);
    match = pairPattern.exec(text);
  }
  if (sawPair) {
    return { text: answers.join('\n'), kind: answers.length ? 'user' : 'system' };
  }

  const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return { text: '', kind: 'system' };
  return { text: cleaned, kind: 'user' };
}

/** Extract the question text of an ask_user style tool call. */
export function extractAgentQuestion(input) {
  if (!input || typeof input !== 'object') return '';
  const parts = [];
  if (Array.isArray(input.steps)) {
    for (const step of input.steps) {
      const question = step && typeof step.question === 'string' ? step.question : '';
      if (question) parts.push(question);
    }
  }
  for (const key of ['question', 'prompt', 'title']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) parts.push(value);
  }
  return parts.join('\n');
}

/**
 * Group a turn's events into timeline units.
 *
 * Two reasoning events that carry the same timestamp belong to one assistant
 * message (the `thinking` block and the `text` block of the same reply), so
 * they are merged into a single unit and become one strategy node instead of
 * two look-alike twins.
 */
function buildUnits(events) {
  const units = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const ts = toEpochMs(event.ts);
    const prev = units[units.length - 1];
    if (prev
      && prev.kind === 'reasoning'
      && event.kind === 'reasoning'
      && ts !== null
      && prev.ts !== null
      && ts === prev.ts) {
      prev.events.push(event);
      prev.texts.push(event.data?.text ?? '');
      continue;
    }
    units.push({
      kind: event.kind,
      ts,
      event,
      events: [event],
      texts: event.kind === 'reasoning' ? [event.data?.text ?? ''] : [],
    });
  }
  return units;
}

/**
 * Give every unit a usable timestamp: a unit without one inherits the
 * closest known time, so a missing timestamp never breaks the timeline.
 */
function resolveTimestamps(units) {
  const out = new Array(units.length).fill(null);
  let last = null;
  for (let i = 0; i < units.length; i += 1) {
    if (typeof units[i].ts === 'number') {
      last = units[i].ts;
      out[i] = units[i].ts;
    } else {
      out[i] = last;
    }
  }
  let next = null;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (typeof out[i] === 'number') next = out[i];
    else if (next !== null) out[i] = next;
  }
  return out;
}

/**
 * Give every node a duration.
 *
 * The turn's timeline is split into spans: an execution owns the time its
 * tool actually ran, a strategy node owns the time the model spent thinking,
 * and the question owns the wait before the agent started. A strategy node
 * begins where the previous action finished, so the thinking time between two
 * tool calls is never lost.
 */
function assignDurations(entries, turnEndTs) {
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const next = entries[i + 1];
    const node = entry.node;

    let start = entry.ts;
    if (entry.kind === 'reasoning') {
      const prev = entries[i - 1];
      if (prev && typeof prev.closeTs === 'number') start = prev.closeTs;
    }

    let end;
    if (typeof entry.closeTs === 'number') end = entry.closeTs;
    else if (next && typeof next.ts === 'number') end = next.ts;
    else end = turnEndTs;

    if (typeof start !== 'number' || typeof end !== 'number') continue;
    if (end < start) end = start;
    node.durationMs = end - start;
  }
}

/**
 * Build the mechanical tree for one turn.
 * Returns null when the turn carries no real user message.
 */
export function buildMechanicalTree(turn, {
  sessionId,
  origin = 'live',
  events: providedEvents,
  workspaceRoot,
} = {}) {
  nodeCounter = 0;
  const events = providedEvents ?? turn.events ?? [];
  const root = workspaceRoot
    || events.find((e) => e.cwd)?.cwd
    || null;

  const units = buildUnits(events);
  const stamps = resolveTimestamps(units);

  const promptIndex = units.findIndex((u) => u.kind === 'user_prompt');
  if (promptIndex < 0) return null;
  const promptUnit = units[promptIndex];

  const userMessage = extractUserMessage(promptUnit.event.data?.text ?? '');
  if (userMessage.kind !== 'user' || !userMessage.text) return null;

  // Closing events: a tool result closes its call, a stop closes the turn.
  const resultTsByToolUseId = new Map();
  const stopTsByAgentId = new Map();
  let stopTs = null;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    const data = unit.event.data ?? {};
    if (unit.kind === 'tool_result' && data.toolUseId !== null && data.toolUseId !== undefined) {
      resultTsByToolUseId.set(String(data.toolUseId), stamps[i]);
    }
    if (unit.kind === 'subagent_stop' && data.agentId !== null && data.agentId !== undefined) {
      stopTsByAgentId.set(String(data.agentId), stamps[i]);
    }
    if (unit.kind === 'stop') stopTs = stamps[i];
  }

  const nodes = [];
  /** One entry per node, in creation order; drives the duration spans. */
  const entries = [];
  const addNode = (node, meta = {}) => {
    nodes.push(node);
    entries.push({
      node,
      // The unit kind, not the node type: a strategy node comes from a
      // reasoning unit and is timed like one.
      kind: meta.kind ?? node.type,
      ts: typeof node.ts === 'number' ? node.ts : null,
      closeTs: meta.closeTs ?? null,
    });
    return node;
  };

  const questionNode = addNode({
    id: nextId(),
    parentId: null,
    type: 'question',
    title: truncate(userMessage.text, 120),
    summary: truncate(userMessage.text, 400),
    detail: userMessage.text,
    status: null,
    selected: null,
    ts: stamps[promptIndex],
    level: 0,
  });

  let lastStrategyId = null;
  let pendingExecutionIds = [];
  let pendingPermissionId = null;
  const strategyStack = [];
  const executionByToolUseId = new Map();
  const strategyNodes = [];

  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    const event = unit.event;
    const data = event.data ?? {};
    const ts = stamps[i];
    switch (unit.kind) {
      case 'reasoning': {
        const text = unit.texts.filter((part) => part && part.trim()).join('\n\n');
        if (!text.trim()) break;
        const node = addNode({
          id: nextId(),
          parentId: lastStrategyId ?? questionNode.id,
          type: 'scheme',
          title: '策略',
          summary: truncate(text, 400),
          detail: text,
          status: null,
          selected: null,
          ts,
          level: 0,
          channel: unit.events[0].data?.channel ?? 'text',
          source: unit.events[0].data?.source ?? null,
          sourceTs: unit.events[0].data?.sourceTs ?? null,
        }, { kind: 'reasoning' });
        for (const executionId of pendingExecutionIds) {
          const execution = executionByToolUseId.get(executionId);
          if (execution) execution.parentId = node.id;
        }
        pendingExecutionIds = [];
        pendingPermissionId = null;
        lastStrategyId = node.id;
        strategyNodes.push(node);
        break;
      }

      case 'tool_call': {
        const tool = data.tool ?? 'tool';
        const input = data.input ?? null;

        // A question the Agent asked the user is a strategy, not an execution.
        if (tool === 'ask_user') {
          const question = extractAgentQuestion(input);
          const action = toolAction(tool);
          const node = addNode({
            id: nextId(),
            parentId: lastStrategyId ?? questionNode.id,
            type: 'scheme',
            title: '策略：向用户提问',
            summary: truncate(question, 400),
            detail: question || JSON.stringify(input ?? {}, null, 2),
            status: null,
            selected: null,
            ts,
            level: 0,
            agentQuestion: true,
            action: action.label,
            actionKind: action.kind,
            actionGlyph: action.glyph,
            actionTone: action.tone,
          });
          for (const executionId of pendingExecutionIds) {
            const execution = executionByToolUseId.get(executionId);
            if (execution) execution.parentId = node.id;
          }
          pendingExecutionIds = [];
          pendingPermissionId = null;
          lastStrategyId = node.id;
          strategyNodes.push(node);
          break;
        }

        const closeTs = data.toolUseId !== null && data.toolUseId !== undefined
          ? resultTsByToolUseId.get(String(data.toolUseId)) ?? null
          : null;
        const action = toolAction(tool);
        const node = addNode({
          id: nextId(),
          parentId: pendingPermissionId ?? lastStrategyId ?? questionNode.id,
          type: 'execution',
          title: executionTitle(tool, input, root),
          summary: truncate(toolLabel(tool), 200),
          detail: formatCommand(tool, input, root),
          command: formatCommand(tool, input, root),
          status: 'pending',
          selected: null,
          ts,
          level: 0,
          tool,
          // The action class drives the glyph, the colour and the label of
          // the card: read / write / grep / skill / mcp / agent …
          action: action.label,
          actionKind: action.kind,
          actionGlyph: action.glyph,
          actionTone: action.tone,
          toolUseId: data.toolUseId ?? null,
          durationMs: null,
        }, { closeTs });
        if (data.toolUseId) executionByToolUseId.set(data.toolUseId, node);
        pendingExecutionIds.push(node.id);
        pendingPermissionId = null;
        break;
      }

      case 'tool_result': {
        const node = data.toolUseId ? executionByToolUseId.get(data.toolUseId) : null;
        if (node) {
          node.status = data.ok === false ? 'error' : 'ok';
          node.output = data.output ?? '';
        }
        break;
      }

      case 'permission': {
        const action = toolAction(data.tool);
        const node = addNode({
          id: nextId(),
          parentId: lastStrategyId ?? questionNode.id,
          type: 'scheme',
          title: '策略：请求授权',
          summary: truncate(formatCommand(data.tool, data.input, root), 300),
          detail: formatCommand(data.tool, data.input, root)
            || JSON.stringify(data.input ?? {}, null, 2),
          status: 'asked',
          selected: null,
          ts,
          level: 0,
          action: action.label,
          actionKind: action.kind,
          actionGlyph: action.glyph,
          actionTone: action.tone,
        });
        for (const executionId of pendingExecutionIds) {
          const execution = executionByToolUseId.get(executionId);
          if (execution) execution.parentId = node.id;
        }
        pendingExecutionIds = [];
        pendingPermissionId = node.id;
        lastStrategyId = node.id;
        strategyNodes.push(node);
        break;
      }

      case 'subagent_start': {
        const closeTs = data.agentId !== null && data.agentId !== undefined
          ? stopTsByAgentId.get(String(data.agentId)) ?? null
          : null;
        const action = toolAction('task');
        const node = addNode({
          id: nextId(),
          parentId: lastStrategyId ?? questionNode.id,
          type: 'scheme',
          title: `策略：委派子代理 ${data.agentType ?? ''}`.trim(),
          summary: truncate(data.agentType ?? '', 200),
          detail: JSON.stringify(data, null, 2),
          status: 'running',
          selected: null,
          ts,
          level: 0,
          action: action.label,
          actionKind: action.kind,
          actionGlyph: action.glyph,
          actionTone: action.tone,
          agentId: data.agentId ?? null,
          agentType: data.agentType ?? null,
        }, { closeTs });
        strategyStack.push({ nodeId: node.id, previousStrategyId: lastStrategyId });
        lastStrategyId = node.id;
        strategyNodes.push(node);
        break;
      }

      case 'subagent_stop': {
        const frame = strategyStack.pop();
        const node = nodes.find((n) => n.id === frame?.nodeId);
        if (node) {
          node.status = 'done';
          if (data.message) {
            node.detail = `${node.detail}\n\n--- 结束消息 ---\n${data.message}`;
          }
          const entry = entries.find((e) => e.node === node);
          if (entry && typeof entry.closeTs !== 'number') entry.closeTs = ts;
        }
        lastStrategyId = frame ? frame.previousStrategyId : lastStrategyId;
        break;
      }

      case 'compact': {
        addNode({
          id: nextId(),
          parentId: lastStrategyId ?? questionNode.id,
          type: 'note',
          title: `说明：上下文压缩${data.phase === 'pre' ? '开始' : '结束'}`,
          summary: truncate(data.trigger ?? '', 200),
          detail: JSON.stringify(data, null, 2),
          status: null,
          selected: null,
          ts,
          level: 0,
        });
        break;
      }

      default:
        break;
    }
  }

  // Strategy titles come from the actions they produced.
  const childrenByParent = new Map();
  for (const node of nodes) {
    const key = node.parentId ?? '__root__';
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(node);
  }
  for (const node of strategyNodes) {
    const children = childrenByParent.get(node.id) ?? [];
    const executions = children.filter((child) => child.type === 'execution');
    // The title names the *classes* of action ("读取文件、搜索内容"), while
    // `actions` keeps the concrete ones for the detail panel.
    const labels = executions.map((child) => child.action ?? toolLabel(child.tool));
    node.title = strategyTitle(labels, node.detail);
    node.actions = executions.map((child) => ({
      label: child.action ?? toolLabel(child.tool),
      title: child.title ?? '',
      tool: child.tool ?? '',
    }));
  }

  // Every node carries the time it took: the tool that ran, the thinking that
  // happened, or the wait before the agent started.
  const turnEndTs = typeof stopTs === 'number'
    ? stopTs
    : (origin === 'live' ? Date.now() : stamps[stamps.length - 1]);
  assignDurations(entries, turnEndTs);

  // Depth levels for rendering.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const levelOf = (node) => {
    let level = 0;
    let cursor = node;
    const seen = new Set();
    while (cursor && cursor.parentId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentId);
      level += 1;
      if (level > 500) break;
    }
    return level;
  };
  for (const node of nodes) node.level = levelOf(node);

  return {
    version: 1,
    turnId: turn.turnId,
    sessionId: sessionId ?? null,
    origin,
    generator: 'mechanical',
    workspaceRoot: root,
    question: userMessage.text,
    ts: promptUnit.ts ?? stamps[promptIndex] ?? null,
    updatedAt: Date.now(),
    running: typeof stopTs !== 'number',
    lastEventTs: stamps[stamps.length - 1] ?? null,
    nodes,
  };
}

/** Convert a flat node list into a nested structure (used by exporters). */
export function nestNodes(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, { ...n, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId).children.push(node);
    else roots.push(node);
  }
  const sort = (list) => {
    list.sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    for (const item of list) sort(item.children);
  };
  sort(roots);
  return roots;
}

/** Validate a tree object; returns { ok, errors }. */
export function validateTree(tree) {
  const errors = [];
  if (!tree || typeof tree !== 'object') return { ok: false, errors: ['tree is not an object'] };
  if (!tree.turnId) errors.push('missing turnId');
  if (!Array.isArray(tree.nodes) || tree.nodes.length === 0) {
    errors.push('missing nodes');
    return { ok: false, errors };
  }
  const ids = new Set();
  for (const node of tree.nodes) {
    if (!node || typeof node !== 'object') {
      errors.push('node is not an object');
      continue;
    }
    if (!node.id) errors.push('node missing id');
    else if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    else ids.add(node.id);
    if (!node.type) errors.push(`node ${node.id} missing type`);
    if (node.parentId && !ids.has(node.parentId)) {
      const parent = tree.nodes.find((n) => n.id === node.parentId);
      if (!parent) errors.push(`node ${node.id} has unknown parent ${node.parentId}`);
    }
  }
  const roots = tree.nodes.filter((n) => !n.parentId);
  if (roots.length !== 1) errors.push(`expected exactly one root node, got ${roots.length}`);
  return { ok: errors.length === 0, errors };
}

export { relativePath, formatCommand, executionTitle, strategyTitle, toolLabel, firstLine };
