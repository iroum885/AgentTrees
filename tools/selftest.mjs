#!/usr/bin/env node
/**
 * Self-test for the plugintree backend.
 *
 *   node tools/selftest.mjs
 *
 * Covers: the Chinese label mapping, the user-message extraction, the hook
 * collector against a synthetic transcript, tree construction, and the export
 * helpers. No model is involved anywhere in this path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveDataDir } from '../scripts/lib/paths.mjs';
import { readSessionEvents, readTree, listTrees } from '../scripts/lib/store.mjs';
import {
  partitionTurns,
  buildMechanicalTree,
  validateTree,
  extractUserMessage,
} from '../scripts/lib/tree.mjs';
import {
  executionTitle,
  formatCommand,
  formatDuration,
  mcpActionText,
  mcpDisplayName,
  parseMcpTool,
  relativePath,
  strategyTitle,
  toolAction,
  toolLabel,
} from '../scripts/lib/labels.mjs';
import {
  listRegisteredWorkspaces,
  registerWorkspace,
  workspaceLabel,
} from '../scripts/lib/registry.mjs';
import { parseSessionMessages } from '../scripts/lib/transcript.mjs';
import { treeToMarkdown, treeToHtml } from '../scripts/lib/export.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const COLLECT = path.join(ROOT, 'scripts', 'collect.mjs');

// The registry lives in the data dir, so the test gets a private one: a
// temporary workspace must never show up in the real workspace switcher.
const REGISTRY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'plugintree-registry-'));
process.env.MINIMAX_DATA_DIR = REGISTRY_HOME;
// The test workspace lives in the OS temp folder, which the registry ignores
// on purpose; this switch lets the test look at it anyway.
process.env.PLUGINTREE_ALLOW_TEMP_WORKSPACE = '1';

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// ------------------------------------------------------------------- labelling
section('Chinese labels');
check('read maps to 读取文件', toolLabel('read') === '读取文件', toolLabel('read'));
check('write maps to 写入文件', toolLabel('write') === '写入文件', toolLabel('write'));
check('bash maps to 执行命令', toolLabel('bash') === '执行命令', toolLabel('bash'));
check('an unknown tool still gets a Chinese label', /执行/.test(toolLabel('some_tool')), toolLabel('some_tool'));

check('a path inside the workspace becomes relative',
  relativePath('hello.txt', 'D:\\work') === '.\\hello.txt',
  relativePath('hello.txt', 'D:\\work'));
check('a nested path keeps its folder',
  relativePath('src/app.js', 'D:\\work') === '.\\src\\app.js',
  relativePath('src/app.js', 'D:\\work'));
check('a path outside the workspace stays absolute',
  relativePath('C:\\other\\x.txt', 'D:\\work').startsWith('C:'),
  relativePath('C:\\other\\x.txt', 'D:\\work'));
check('a dot folder keeps its own dot',
  relativePath('.minimax-plugin\\plugin.json', 'D:\\work') === '.\\.minimax-plugin\\plugin.json',
  relativePath('.minimax-plugin\\plugin.json', 'D:\\work'));
check('a folder that merely starts with dots is not treated as outside',
  relativePath('..foo\\x.txt', 'D:\\work') === '.\\..foo\\x.txt',
  relativePath('..foo\\x.txt', 'D:\\work'));

check('the command of a read is one line',
  formatCommand('read', { file_path: 'hello.txt' }, 'D:\\work') === 'read: .\\hello.txt',
  formatCommand('read', { file_path: 'hello.txt' }, 'D:\\work'));
check('the command of a write is one line',
  formatCommand('write', { file_path: 'a/b.txt' }, 'D:\\work') === 'write: .\\a\\b.txt',
  formatCommand('write', { file_path: 'a/b.txt' }, 'D:\\work'));
check('the command of a bash call carries the command',
  formatCommand('bash', { command: 'ls -la' }, 'D:\\work') === 'bash: ls -la',
  formatCommand('bash', { command: 'ls -la' }, 'D:\\work'));

check('the execution title is Chinese and relative',
  executionTitle('read', { file_path: 'hello.txt' }, 'D:\\work') === '读取文件 .\\hello.txt',
  executionTitle('read', { file_path: 'hello.txt' }, 'D:\\work'));

check('a strategy title lists the actions it produced',
  strategyTitle(['读取文件', '写入文件'], '') === '策略：读取文件、写入文件',
  strategyTitle(['读取文件', '写入文件'], ''));
check('a strategy title counts the extra actions',
  strategyTitle(['读取文件', '写入文件', '执行命令'], '') === '策略：读取文件、写入文件 等3项',
  strategyTitle(['读取文件', '写入文件', '执行命令'], ''));
check('a strategy without actions falls back to its reasoning',
  strategyTitle([], '先看一下目录结构。').startsWith('策略：先看一下目录结构'),
  strategyTitle([], '先看一下目录结构。'));

check('milliseconds are formatted as ms', formatDuration(120) === '120ms', formatDuration(120));
check('seconds are formatted with one decimal', formatDuration(1500) === '1.5s', formatDuration(1500));
check('minutes are formatted in 分秒', formatDuration(65000) === '1分05秒', formatDuration(65000));
check('a missing duration renders as empty', formatDuration(null) === '');

// ------------------------------------------------------------------ action classes
section('Action classes');
check('reading is a read action', toolAction('read').kind === 'read', toolAction('read').kind);
check('writing is a write action', toolAction('write').kind === 'write', toolAction('write').kind);
check('grep is a search action', toolAction('grep').kind === 'search', toolAction('grep').kind);
check('glob is a find action', toolAction('glob').kind === 'find', toolAction('glob').kind);
check('a command line is an exec action', toolAction('bash').kind === 'exec', toolAction('bash').kind);
check('loading a skill is a skill action', toolAction('skill').kind === 'skill', toolAction('skill').kind);
check('delegating is an agent action', toolAction('task').kind === 'agent', toolAction('task').kind);
check('an MCP tool is an MCP action', toolAction('mcp__webnote__webnote_create_note').kind === 'mcp',
  toolAction('mcp__webnote__webnote_create_note').kind);
check('an unknown tool falls back to a generic action', toolAction('some_tool').kind === 'other',
  toolAction('some_tool').kind);
check('every action has a glyph', ['read', 'write', 'grep', 'skill', 'mcp', 'task']
  .every((tool) => Boolean(toolAction(tool).glyph)));
check('the action label is Chinese', toolAction('grep').label === '搜索内容', toolAction('grep').label);

check('an MCP tool name is split into server and tool',
  parseMcpTool('mcp__webnote__webnote_create_note')?.server === 'webnote'
  && parseMcpTool('mcp__webnote__webnote_create_note')?.name === 'webnote_create_note',
  JSON.stringify(parseMcpTool('mcp__webnote__webnote_create_note')));
check('a plain tool is not an MCP tool', parseMcpTool('read') === null);
check('the MCP server gets a readable name', mcpDisplayName('webnote') === 'WebNote', mcpDisplayName('webnote'));
check('an MCP action is translated', mcpActionText('create_note') === '创建笔记', mcpActionText('create_note'));
check('an unknown MCP action keeps its spelling', mcpActionText('do_thing') === 'do thing',
  mcpActionText('do_thing'));

check('an MCP call names the server and what it did',
  executionTitle('mcp__webnote__webnote_create_note', {}, 'D:\\work') === '调用 WebNote：创建笔记',
  executionTitle('mcp__webnote__webnote_create_note', {}, 'D:\\work'));
check('a loaded skill is named',
  executionTitle('skill', { name: 'plugintree' }, 'D:\\work') === '加载技能：plugintree',
  executionTitle('skill', { name: 'plugintree' }, 'D:\\work'));
check('a delegated task shows its description',
  executionTitle('task', { description: '调查代码' }, 'D:\\work').startsWith('委派子代理：'),
  executionTitle('task', { description: '调查代码' }, 'D:\\work'));
check('a search shows its pattern',
  executionTitle('grep', { pattern: 'TODO' }, 'D:\\work') === '搜索内容：TODO',
  executionTitle('grep', { pattern: 'TODO' }, 'D:\\work'));
check('the command of a skill names the skill',
  formatCommand('skill', { name: 'plugintree' }, 'D:\\work') === 'skill: plugintree',
  formatCommand('skill', { name: 'plugintree' }, 'D:\\work'));
check('the command of an MCP call keeps the raw tool name',
  formatCommand('mcp__webnote__webnote_create_note', {}, 'D:\\work') === 'mcp__webnote__webnote_create_note',
  formatCommand('mcp__webnote__webnote_create_note', {}, 'D:\\work'));

// ----------------------------------------------------------- user message root
section('User message extraction');
const plain = extractUserMessage('请帮我改一下配置文件');
check('an ordinary message is kept as is', plain.kind === 'user' && plain.text === '请帮我改一下配置文件',
  JSON.stringify(plain));

const qa = extractUserMessage('Q: 第一个问题\nA: 第一个回答');
check('the answer side is the user message', qa.kind === 'user' && qa.text === '第一个回答',
  JSON.stringify(qa));
check('the question side is not shown as the user message',
  !extractUserMessage('Q: 第一个问题\nA: 第一个回答').text.includes('第一个问题'));

const multi = extractUserMessage('Q: 问题一\nA: 回答一\n\nQ: 问题二\nA: 回答二');
check('several answers merge into one root', multi.kind === 'user' && multi.text === '回答一\n回答二',
  JSON.stringify(multi));

const withReminder = extractUserMessage('<system-reminder>\n<agent-context>x</agent-context>\n</system-reminder>\n\n真正的提问');
check('runtime envelopes are stripped', withReminder.text === '真正的提问', JSON.stringify(withReminder));

const systemOnly = extractUserMessage('<system-reminder>\n只有系统通知\n</system-reminder>');
check('a message with no user text is a system turn', systemOnly.kind === 'system',
  JSON.stringify(systemOnly));

// ------------------------------------------------------------ hook collector
section('Hook collector (synthetic transcript)');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'plugintree-selftest-'));
const transcript = path.join(workspace, 'transcript.jsonl');

const lines = [
  {
    uuid: 'u1', parentUuid: null, sessionId: 'mvs_selftest', timestamp: '2026-10-29T08:00:00.000Z',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: JSON.stringify({ type: 'thinking', thinking: '第一步：先读取配置文件确认现状。' }) },
        { type: 'tool_use', id: 'call_read_1', name: 'read', input: { file_path: 'a.txt' } },
      ],
    },
  },
  {
    uuid: 'u2', parentUuid: 'u1', sessionId: 'mvs_selftest', timestamp: '2026-10-29T08:00:05.000Z',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: JSON.stringify({ type: 'thinking', thinking: '第二步：基于读到的内容，我选择方案 A 而不是方案 B。' }) },
        { type: 'tool_use', id: 'call_write_1', name: 'write', input: { file_path: 'b.txt', content: 'x' } },
      ],
    },
  },
];
fs.writeFileSync(transcript, `${JSON.stringify(lines[0])}\n`, 'utf8');

function fireHook(payload) {
  const result = spawnSync(process.execPath, [COLLECT], {
    input: JSON.stringify(payload),
    env: { ...process.env, MINIMAX_PROJECT_DIR: workspace },
    encoding: 'utf8',
  });
  return result;
}

const base = {
  session_id: 'mvs_selftest',
  turn_id: 'turn_selftest_1',
  cwd: workspace,
  transcript_path: transcript,
  model: 'test-model',
  permission_mode: 'bypassPermissions',
};

const r1 = fireHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '请把配置文件改一下' });
check('UserPromptSubmit exits 0', r1.status === 0, `status=${r1.status} ${r1.stderr}`);
check('UserPromptSubmit writes no stdout', (r1.stdout || '').trim() === '', JSON.stringify(r1.stdout));

// The tree must exist while the turn is still running, not only at the end.
const earlyTree = readTree(workspace, 'turn_selftest_1');
check('a tree is written while the turn is still running', !!earlyTree);
check('the live tree already shows the question',
  earlyTree?.nodes?.some((n) => n.type === 'question' && n.title === '请把配置文件改一下'),
  JSON.stringify(earlyTree?.nodes?.map((n) => n.title)));
check('the running tree is marked as running', earlyTree?.running === true, String(earlyTree?.running));

const r2 = fireHook({
  ...base,
  hook_event_name: 'PreToolUse',
  tool_name: 'read',
  tool_use_id: 'call_read_1',
  tool_input: { file_path: 'a.txt' },
});
check('PreToolUse exits 0', r2.status === 0, `status=${r2.status} ${r2.stderr}`);

// Append the second assistant message, then fire the second tool call.
fs.appendFileSync(transcript, `${JSON.stringify(lines[1])}\n`, 'utf8');

const r3 = fireHook({
  ...base,
  hook_event_name: 'PreToolUse',
  tool_name: 'write',
  tool_use_id: 'call_write_1',
  tool_input: { file_path: 'b.txt', content: 'x' },
});
check('second PreToolUse exits 0', r3.status === 0, r3.stderr);

const r4 = fireHook({
  ...base,
  hook_event_name: 'PostToolUse',
  tool_name: 'write',
  tool_use_id: 'call_write_1',
  tool_input: { file_path: 'b.txt' },
  tool_response: 'written',
});
check('PostToolUse exits 0', r4.status === 0, r4.stderr);

const r5 = fireHook({ ...base, hook_event_name: 'Stop' });
check('Stop exits 0', r5.status === 0, r5.stderr);

const events = readSessionEvents(workspace, 'mvs_selftest', 'live');
const kinds = events.map((e) => e.kind);
check('recorded a user_prompt', kinds.includes('user_prompt'));
check('recorded reasoning from the transcript', kinds.includes('reasoning'), kinds.join(','));
check('recorded tool calls', kinds.filter((k) => k === 'tool_call').length === 2);
check('recorded a tool result', kinds.includes('tool_result'));
check('recorded the turn stop', kinds.includes('stop'));
check('reasoning was captured once per assistant message', kinds.filter((k) => k === 'reasoning').length === 2,
  `count=${kinds.filter((k) => k === 'reasoning').length}`);
check('every event carries the turn id', events.every((e) => e.turn === 'turn_selftest_1'));

const tree = readTree(workspace, 'turn_selftest_1');
check('a tree was written for the turn', !!tree);
check('the tree validates', tree ? validateTree(tree).ok : false,
  tree ? validateTree(tree).errors.join('; ') : 'no tree');

const rootNode = tree?.nodes?.find((n) => n.type === 'question');
check('the root is the question node', !!rootNode);
check('the root carries the user message', rootNode?.title === '请把配置文件改一下', rootNode?.title);
check('the tree question is the user message', tree?.question === '请把配置文件改一下', tree?.question);
check('the tree contains strategy nodes', tree?.nodes?.some((n) => n.type === 'scheme'));
check('the tree contains execution nodes', tree?.nodes?.some((n) => n.type === 'execution'));
check('the tool result is attached to its execution',
  tree?.nodes?.some((n) => n.type === 'execution' && n.status === 'ok'));

const readNode = tree?.nodes?.find((n) => n.type === 'execution' && n.tool === 'read');
check('an execution title is Chinese', readNode?.title?.startsWith('读取文件'), readNode?.title);
check('an execution title uses a workspace relative path',
  readNode?.title === '读取文件 .\\a.txt', readNode?.title);
check('the detail of an execution is the full command',
  readNode?.detail === 'read: .\\a.txt', readNode?.detail);
check('the command is stored next to the detail',
  readNode?.command === 'read: .\\a.txt', readNode?.command);
check('an execution carries its action class', readNode?.actionKind === 'read', readNode?.actionKind);
check('an execution carries the Chinese action label', readNode?.action === '读取文件', readNode?.action);
check('an execution carries the glyph of its class', readNode?.actionGlyph === '读', readNode?.actionGlyph);

const writeNode = tree?.nodes?.find((n) => n.type === 'execution' && n.tool === 'write');
check('an execution records its duration', typeof writeNode?.durationMs === 'number'
  && writeNode.durationMs >= 0, String(writeNode?.durationMs));
check('a write is classified as a write', writeNode?.actionKind === 'write', writeNode?.actionKind);

const schemeNodes = tree?.nodes?.filter((n) => n.type === 'scheme') ?? [];
check('a strategy title is deterministic Chinese',
  schemeNodes.every((n) => String(n.title).startsWith('策略')), schemeNodes.map((n) => n.title).join('|'));
check('a strategy lists the actions it produced',
  schemeNodes.some((n) => Array.isArray(n.actions) && n.actions.length > 0),
  JSON.stringify(schemeNodes.map((n) => n.actions)));
check('the actions of a strategy name their class',
  schemeNodes.some((n) => (n.actions ?? []).some((a) => a.label === '读取文件')),
  JSON.stringify(schemeNodes.map((n) => n.actions)));

// ----------------------------------------------------------------- durations
section('Node durations');
check('every node carries a duration',
  tree.nodes.every((n) => typeof n.durationMs === 'number' && n.durationMs >= 0),
  JSON.stringify(tree.nodes.map((n) => [n.type, n.durationMs])));
const questionNode = tree.nodes.find((n) => n.type === 'question');
check('the question node is timed too', typeof questionNode?.durationMs === 'number',
  String(questionNode?.durationMs));
check('a strategy node is timed too (the model thinking is real waiting time)',
  schemeNodes.length > 0 && schemeNodes.every((n) => typeof n.durationMs === 'number'),
  schemeNodes.map((n) => n.durationMs).join(','));
check('an execution node is timed by its tool run',
  tree.nodes.some((n) => n.type === 'execution' && n.durationMs > 0),
  JSON.stringify(tree.nodes.filter((n) => n.type === 'execution').map((n) => n.durationMs)));

// --------------------------------------------------- reasoning merge & spans
section('Reasoning merge and timeline spans');
const spanEvents = [
  { kind: 'user_prompt', ts: 1000, data: { text: '继续' } },
  { kind: 'reasoning', ts: 1500, data: { channel: 'thinking', text: '想一想。' } },
  { kind: 'reasoning', ts: 1500, data: { channel: 'text', text: '好的。' } },
  { kind: 'tool_call', ts: 2000, data: { toolUseId: 'x1', tool: 'read', input: { file_path: 'a.txt' } } },
  { kind: 'tool_result', ts: 2400, data: { toolUseId: 'x1', ok: true, output: 'hi' } },
  { kind: 'stop', ts: 2500, data: {} },
];
const spanTree = buildMechanicalTree(
  { turnId: 'turn_span', events: spanEvents },
  { sessionId: 's', origin: 'live', workspaceRoot: 'D:\\work' },
);
const spanScheme = spanTree?.nodes?.find((n) => n.type === 'scheme');
const spanExecution = spanTree?.nodes?.find((n) => n.type === 'execution');
check('two blocks of one message become one strategy node',
  spanTree?.nodes?.filter((n) => n.type === 'scheme').length === 1,
  String(spanTree?.nodes?.filter((n) => n.type === 'scheme').length));
check('the merged strategy keeps both texts',
  spanScheme?.detail?.includes('想一想。') && spanScheme?.detail?.includes('好的。'), spanScheme?.detail);
check('the strategy owns the thinking time', spanScheme?.durationMs === 500, String(spanScheme?.durationMs));
check('the execution owns its tool run', spanExecution?.durationMs === 400, String(spanExecution?.durationMs));
check('the question owns the wait before the agent started',
  spanTree?.nodes?.find((n) => n.type === 'question')?.durationMs === 500,
  String(spanTree?.nodes?.find((n) => n.type === 'question')?.durationMs));
check('every node of the merged tree is timed',
  spanTree?.nodes?.every((n) => typeof n.durationMs === 'number'),
  JSON.stringify(spanTree?.nodes?.map((n) => n.durationMs)));

// A strategy that follows a tool run starts where that tool finished.
const gapEvents = [
  { kind: 'user_prompt', ts: 1000, data: { text: '继续' } },
  { kind: 'tool_call', ts: 1100, data: { toolUseId: 'g1', tool: 'read', input: { file_path: 'a.txt' } } },
  { kind: 'tool_result', ts: 1500, data: { toolUseId: 'g1', ok: true, output: 'hi' } },
  { kind: 'reasoning', ts: 1600, data: { channel: 'thinking', text: '想一下。' } },
  { kind: 'stop', ts: 2000, data: {} },
];
const gapTree = buildMechanicalTree(
  { turnId: 'turn_gap', events: gapEvents },
  { sessionId: 's', origin: 'live', workspaceRoot: 'D:\\work' },
);
check('the thinking after a tool run is not lost',
  gapTree?.nodes?.find((n) => n.type === 'scheme')?.durationMs === 500,
  String(gapTree?.nodes?.find((n) => n.type === 'scheme')?.durationMs));
check('the tool run itself is still timed',
  gapTree?.nodes?.find((n) => n.type === 'execution')?.durationMs === 400,
  String(gapTree?.nodes?.find((n) => n.type === 'execution')?.durationMs));

check('reasoning nodes form a chain (depth > 1)', (tree?.nodes?.length ?? 0) > 0
  && Math.max(...tree.nodes.map((n) => n.level)) >= 2,
  `maxLevel=${tree ? Math.max(...tree.nodes.map((n) => n.level)) : -1}`);

const listed = listTrees(workspace);
check('listTrees finds the turn', listed.some((t) => t.turnId === 'turn_selftest_1'));
check('listTrees does not report a generator any more',
  listed.every((t) => !('generator' in t) && !('llmError' in t)));
check('listTrees reports whether a turn is still running',
  listed.find((t) => t.turnId === 'turn_selftest_1')?.running === false,
  String(listed.find((t) => t.turnId === 'turn_selftest_1')?.running));

// ----------------------------------------------------------- workspace registry
section('Workspace registry');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// A scratch folder is not a workspace worth offering.
delete process.env.PLUGINTREE_ALLOW_TEMP_WORKSPACE;
check('a scratch workspace is kept out of the switcher',
  !listRegisteredWorkspaces().some((w) => samePath(w.root, workspace)),
  JSON.stringify(listRegisteredWorkspaces().map((w) => w.root)));
process.env.PLUGINTREE_ALLOW_TEMP_WORKSPACE = '1';

const registered = listRegisteredWorkspaces();
check('the collector registered the workspace it worked in',
  registered.some((w) => samePath(w.root, workspace)),
  JSON.stringify(registered.map((w) => w.root)));
const entry = registered.find((w) => samePath(w.root, workspace));
check('a registered workspace carries the newest activity', (entry?.lastEventTs ?? 0) > 0,
  String(entry?.lastEventTs));
check('a workspace gets a readable label', workspaceLabel(workspace) === path.basename(workspace),
  workspaceLabel(workspace));

const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'plugintree-other-'));
// A workspace only shows up once it holds something worth looking at.
fs.mkdirSync(path.join(otherWorkspace, '.plugintree', 'events'), { recursive: true });
fs.writeFileSync(path.join(otherWorkspace, '.plugintree', 'events', 'seed.jsonl'), '{}\n', 'utf8');
registerWorkspace(otherWorkspace, { eventTs: Date.now() + 1000 });
check('registering another workspace adds it to the list',
  listRegisteredWorkspaces().some((w) => samePath(w.root, otherWorkspace)));
check('the most recently active workspace comes first',
  samePath(listRegisteredWorkspaces()[0].root, otherWorkspace),
  JSON.stringify(listRegisteredWorkspaces().map((w) => w.root)));
fs.rmSync(otherWorkspace, { recursive: true, force: true });

// ------------------------------------------------------------------ exporters
section('Exporters');
const markdown = treeToMarkdown(tree);
check('markdown export contains the question', markdown.includes('请把配置文件改一下'));
check('markdown export contains node markers', markdown.includes('执行') || markdown.includes('策略'));
check('markdown export contains the full command', markdown.includes('`read: .\\a.txt`'),
  markdown.split('\n').find((l) => l.includes('命令')) ?? 'no command line');
check('markdown export contains the duration', /耗时：\d/.test(markdown),
  markdown.split('\n').find((l) => l.includes('耗时')) ?? 'no duration line');
check('markdown export names the action class instead of a flat execution',
  markdown.includes('**读取文件**'), markdown.split('\n').find((l) => l.includes('读取文件')) ?? 'no action line');
const html = treeToHtml(tree);
check('html export is a full document', html.startsWith('<!doctype html>'));
check('html export contains no external urls', !/https?:\/\/(?!127\.0\.0\.1)/.test(html));
check('html export contains the full command', html.includes('read: .\\a.txt'));
check('html export carries the action class', html.includes('act-read'), 'no act-read class');

// -------------------------------------------------------------- turn grouping
section('Turn grouping');
const turns = partitionTurns(events);
check('exactly one turn is detected', turns.length === 1, `turns=${turns.length}`);
check('the turn id is preserved', turns[0]?.turnId === 'turn_selftest_1');

const rebuilt = buildMechanicalTree(turns[0], { sessionId: 'mvs_selftest', origin: 'live', workspaceRoot: workspace });
check('rebuild is deterministic in node count', rebuilt.nodes.length === tree.nodes.length);

// ---------------------------------------------------------- toolResult schema
section('toolResult message parsing');
const toolSession = fs.mkdtempSync(path.join(os.tmpdir(), 'plugintree-toolres-'));
const toolFile = path.join(toolSession, 'messages.jsonl');
fs.writeFileSync(toolFile, [
  JSON.stringify({
    message_id: 'm1', turn_id: 't1',
    message: { role: 'user', timestamp: 1791971974000, content: [{ type: 'text', text: '跑个命令' }] },
  }),
  JSON.stringify({
    message_id: 'm2', turn_id: 't1',
    message: {
      role: 'assistant', timestamp: 1791971974600,
      content: [{ type: 'toolCall', id: 'call_x', name: 'bash', arguments: { command: 'ls' } }],
    },
  }),
  JSON.stringify({
    message_id: 'm3', turn_id: 't1',
    message: {
      role: 'toolResult', toolCallId: 'call_x', toolName: 'bash', isError: false,
      timestamp: 1791971984600,
      content: [{ type: 'text', text: 'fallback text' }],
      details: {
        description: 'list files',
        execution: { status: 'succeeded', exitCode: 0 },
        processOutput: { stdout: 'a.txt\nb.txt\n', stderr: '' },
      },
    },
  }),
].join('\n'), 'utf8');
const parsed = parseSessionMessages(toolFile, { sessionId: 's1', origin: 'history' });
check('parses the user prompt', parsed.some((e) => e.kind === 'user_prompt'));
check('parses the tool call', parsed.some((e) => e.kind === 'tool_call' && e.data.toolUseId === 'call_x'));
const result = parsed.find((e) => e.kind === 'tool_result');
check('parses the tool result message', !!result);
check('links the result to its call by toolCallId', result?.data.toolUseId === 'call_x');
check('reads stdout as the output', (result?.data.output ?? '').includes('a.txt'));
check('marks a successful call as ok', result?.data.ok === true);

// The historical turn must also produce a tree with a user-message root.
const historyTurns = partitionTurns(parsed);
const historyTree = buildMechanicalTree(historyTurns[0], {
  sessionId: 's1',
  origin: 'history',
  workspaceRoot: toolSession,
});
check('the history tree has a user-message root',
  historyTree?.nodes?.[0]?.title === '跑个命令', historyTree?.nodes?.[0]?.title);
check('the history tree records the command',
  historyTree?.nodes?.some((n) => n.type === 'execution' && n.detail === 'bash: ls'),
  JSON.stringify(historyTree?.nodes?.map((n) => n.detail)));
check('the history tree records the duration',
  historyTree?.nodes?.some((n) => n.type === 'execution' && typeof n.durationMs === 'number'),
  JSON.stringify(historyTree?.nodes?.map((n) => n.durationMs)));

fs.rmSync(toolSession, { recursive: true, force: true });
fs.rmSync(workspace, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
