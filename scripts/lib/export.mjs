import { nestNodes } from './tree.mjs';
import { truncate } from './util.mjs';
import { formatDuration } from './labels.mjs';

const TYPE_LABEL = {
  question: '提问',
  scheme: '策略',
  reasoning: '思考',
  execution: '执行',
  ask: '询问',
  subagent: '子代理',
  note: '说明',
};

const TYPE_ICON = {
  question: '❓',
  scheme: '💡',
  reasoning: '🧠',
  execution: '🔧',
  ask: '🙋',
  subagent: '🤖',
  note: '📎',
};

/**
 * The action classes the agent can perform.
 *
 * An execution is labelled by what it actually did — reading, writing,
 * searching, loading a skill, calling an MCP server — instead of a flat
 * "execution".
 */
const ACTION_LABEL = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  search: '搜索内容',
  find: '查找文件',
  list: '列出目录',
  exec: '执行命令',
  web: '访问网页',
  browser: '操作浏览器',
  skill: '加载技能',
  mcp: '调用 MCP',
  agent: '委派子代理',
  plan: '任务清单',
  ask: '向用户提问',
  memory: '记忆提醒',
  deploy: '发布站点',
  app: '操作小程序',
  media: '生成多媒体',
  other: '执行工具',
};

const ACTION_ICON = {
  read: '📖',
  write: '✏️',
  edit: '🛠',
  search: '🔍',
  find: '🗂',
  list: '📂',
  exec: '⚙️',
  web: '🌐',
  browser: '🧭',
  skill: '🧩',
  mcp: '🔌',
  agent: '🤖',
  plan: '📋',
  ask: '🙋',
  memory: '💡',
  deploy: '🚀',
  app: '📱',
  media: '🎨',
  other: '•',
};

/** The label of a node: its action class when it has one. */
function labelOf(node) {
  if (node.actionKind && ACTION_LABEL[node.actionKind]) return ACTION_LABEL[node.actionKind];
  return TYPE_LABEL[node.type] ?? node.type;
}

/** The icon of a node: its action class when it has one. */
function iconOf(node) {
  if (node.actionKind && ACTION_ICON[node.actionKind]) return ACTION_ICON[node.actionKind];
  return TYPE_ICON[node.type] ?? '•';
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The duration of a node, rendered the way the node badge shows it. */
function durationOf(node) {
  return formatDuration(node?.durationMs);
}

/** The one-line full command of an execution node. */
function commandOf(node) {
  if (node?.type !== 'execution') return '';
  return node.command || node.detail || '';
}

/** Render a nested node list as Markdown. */
export function treeToMarkdown(tree) {
  const roots = nestNodes(tree.nodes ?? []);
  const lines = [];

  lines.push(`# ${tree.question ? truncate(tree.question, 160) : '(无提问)'}`);
  lines.push('');
  lines.push(`- 回合 ID: \`${tree.turnId}\``);
  lines.push(`- 会话 ID: \`${tree.sessionId ?? '-'}\``);
  lines.push(`- 来源: ${tree.origin === 'history' ? '历史回填' : '实时采集'}`);
  lines.push(`- 时间: ${formatTime(tree.ts) || '-'}`);
  lines.push(`- 节点数: ${(tree.nodes ?? []).length}`);
  lines.push('');

  const walk = (nodes, depth) => {
    for (const node of nodes) {
      const icon = iconOf(node);
      const label = labelOf(node);
      const marks = [];
      if (node.selected === true) marks.push('已选中');
      if (node.selected === false) marks.push('未采纳');
      if (node.status) marks.push(node.status);
      const suffix = marks.length ? `  _(${marks.join(' / ')})_` : '';
      lines.push(`${'  '.repeat(depth)}- ${icon} **${label}**: ${node.title ?? ''}${suffix}`);

      const command = commandOf(node);
      if (command) {
        lines.push(`${'  '.repeat(depth)}  > 命令：\`${command}\``);
      }
      const duration = durationOf(node);
      if (duration) {
        lines.push(`${'  '.repeat(depth)}  > 耗时：${duration}`);
      }
      if (node.summary && node.summary !== node.title && !command) {
        lines.push(`${'  '.repeat(depth)}  > ${truncate(node.summary, 300)}`);
      }
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  lines.push('');
  return lines.join('\n');
}

/** Render a fully self-contained HTML page for one tree. */
export function treeToHtml(tree) {
  const roots = nestNodes(tree.nodes ?? []);
  const blocks = [];

  const walk = (nodes) => {
    for (const node of nodes) {
      const label = labelOf(node);
      const marks = [];
      if (node.selected === true) marks.push('<span class="tag sel">已选中</span>');
      if (node.selected === false) marks.push('<span class="tag unsel">未采纳</span>');
      if (node.status) marks.push(`<span class="tag st">${escapeHtml(node.status)}</span>`);

      const command = commandOf(node);
      const duration = durationOf(node);
      const commandBlock = command
        ? `<p class="cmd"><span class="cmd-label">命令</span><code>${escapeHtml(command)}</code></p>`
        : '';
      const durationBlock = duration
        ? `<p class="dur"><span class="dur-label">耗时</span>${escapeHtml(duration)}</p>`
        : '';
      const detail = node.detail && !command
        ? `<pre>${escapeHtml(node.detail)}</pre>`
        : '';
      const output = node.output ? `<pre class="out">${escapeHtml(node.output)}</pre>` : '';
      const actionList = Array.isArray(node.actions) && node.actions.length
        ? '<p class="acts-label">产生的动作</p><ul class="acts">'
          + node.actions
            .map((action) => `<li><span class="act-kind">${escapeHtml(action.label ?? '')}</span>`
              + `<span class="act-title">${escapeHtml(action.title ?? '')}</span></li>`)
            .join('')
          + '</ul>'
        : '';

      const classes = `node type-${escapeHtml(node.type)}`
        + (node.actionKind ? ` act-${escapeHtml(node.actionKind)}` : '');

      blocks.push(
        `<details class="${classes}"${node.level <= 1 ? ' open' : ''}>` +
          `<summary><span class="icon">${iconOf(node)}</span>` +
          `<span class="label">${escapeHtml(label)}</span>` +
          `<span class="title">${escapeHtml(node.title ?? '')}</span>` +
          marks.join('') +
          `</summary>` +
          commandBlock +
          durationBlock +
          (node.summary && node.summary !== node.title && !command
            ? `<p class="sum">${escapeHtml(node.summary)}</p>` : '') +
          detail +
          output +
          actionList +
          `</details>`,
      );
      walk(node.children ?? []);
    }
  };
  walk(roots);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(truncate(tree.question ?? 'plugintree', 120))}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; line-height: 1.6; background: #f7f8fa; color: #1c1e21; }
  @media (prefers-color-scheme: dark) { body { background: #16181c; color: #e6e6e6; } pre { background: #0e1013 !important; } details { background: #1d2026 !important; border-color: #2b2f37 !important; } }
  header { max-width: 1000px; margin: 0 auto 20px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .meta { font-size: 12px; opacity: .65; }
  .tree { max-width: 1000px; margin: 0 auto; }
  details.node { border: 1px solid #e2e5ea; border-radius: 8px; background: #fff; margin: 6px 0 6px 18px; padding: 8px 10px; }
  details.node.type-question { margin-left: 0; }
  summary { cursor: pointer; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  summary .label { font-size: 11px; opacity: .6; }
  summary .title { font-weight: 600; }
  .icon { font-size: 13px; }
  .tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid currentColor; opacity: .7; }
  .tag.sel { color: #1a7f37; } .tag.unsel { color: #9a6700; } .tag.st { color: #57606a; }
  .sum { margin: 6px 0 0; font-size: 13px; opacity: .8; }
  .cmd { margin: 8px 0 0; font-size: 13px; display: flex; gap: 8px; align-items: baseline; }
  .cmd-label { font-size: 10px; opacity: .55; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
  .cmd code { font-family: ui-monospace, Consolas, "Cascadia Mono", monospace; background: #eef2ff; padding: 2px 6px; border-radius: 4px; }
  @media (prefers-color-scheme: dark) { .cmd code { background: #22263a !important; } }
  .dur { margin: 6px 0 0; font-size: 12px; opacity: .6; display: flex; gap: 8px; align-items: baseline; }
  .dur-label { font-size: 10px; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f2f4f7; padding: 10px; border-radius: 6px; font-size: 12px; overflow-x: auto; }
  pre.out { background: #eef6ff; }
  .acts-label { margin: 10px 0 4px; font-size: 11px; opacity: .6; }
  ul.acts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  ul.acts li { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
  .act-kind { flex: none; font-size: 10px; border: 1px solid currentColor; border-radius: 999px; padding: 0 7px; opacity: .8; }
  .act-title { word-break: break-word; }
  details.node.act-read > summary .label { color: #1d4ed8; }
  details.node.act-write > summary .label { color: #15803d; }
  details.node.act-edit > summary .label { color: #0f766e; }
  details.node.act-search > summary .label { color: #0369a1; }
  details.node.act-find > summary .label { color: #4338ca; }
  details.node.act-exec > summary .label { color: #c2620a; }
  details.node.act-web > summary .label { color: #4338ca; }
  details.node.act-browser > summary .label { color: #7e22ce; }
  details.node.act-skill > summary .label { color: #be185d; }
  details.node.act-mcp > summary .label { color: #7e22ce; }
  details.node.act-agent > summary .label { color: #0f766e; }
  details.node.act-ask > summary .label { color: #b45309; }
  details.node.act-deploy > summary .label { color: #b91c1c; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(tree.question ?? '(无提问)')}</h1>
  <div class="meta">回合 <code>${escapeHtml(tree.turnId)}</code> · 会话 <code>${escapeHtml(tree.sessionId ?? '-')}</code> · ${escapeHtml(tree.origin === 'history' ? '历史回填' : '实时采集')} · ${escapeHtml(formatTime(tree.ts) || '-')}</div>
</header>
<div class="tree">
${blocks.join('\n')}
</div>
</body>
</html>
`;
}
