/**
 * Node labelling: action taxonomy, workspace-relative paths and the
 * one-line command shown in the detail panel.
 *
 * No model is involved: every label here is deterministic so the mechanical
 * tree is already readable.
 *
 * The tree used to flatten every tool into one "执行" bucket. The agent does
 * very different things — it reads, writes, searches, runs a command, loads a
 * skill, calls an MCP server, delegates to a sub-agent — so every tool is
 * mapped onto an *action kind*. That kind drives the glyph, the colour and
 * the label shown on the card.
 */
import path from 'node:path';

/**
 * The action taxonomy.
 *
 * `label` is the short Chinese name of the action, `glyph` is the single
 * character drawn on the card chip, and `tone` picks the colour set.
 */
export const ACTION_KINDS = {
  read: { label: '读取文件', glyph: '读', tone: 'read' },
  write: { label: '写入文件', glyph: '写', tone: 'write' },
  edit: { label: '编辑文件', glyph: '改', tone: 'edit' },
  search: { label: '搜索内容', glyph: '搜', tone: 'search' },
  find: { label: '查找文件', glyph: '找', tone: 'find' },
  list: { label: '列出目录', glyph: '列', tone: 'list' },
  exec: { label: '执行命令', glyph: '执', tone: 'exec' },
  web: { label: '访问网页', glyph: '网', tone: 'web' },
  browser: { label: '操作浏览器', glyph: '浏', tone: 'browser' },
  skill: { label: '加载技能', glyph: '技', tone: 'skill' },
  mcp: { label: '调用 MCP', glyph: '令', tone: 'mcp' },
  agent: { label: '委派子代理', glyph: '代', tone: 'agent' },
  plan: { label: '任务清单', glyph: '计', tone: 'plan' },
  ask: { label: '向用户提问', glyph: '问', tone: 'ask' },
  memory: { label: '记忆提醒', glyph: '忆', tone: 'memory' },
  deploy: { label: '发布站点', glyph: '发', tone: 'deploy' },
  app: { label: '操作小程序', glyph: '小', tone: 'app' },
  media: { label: '生成多媒体', glyph: '媒', tone: 'media' },
  other: { label: '执行工具', glyph: '其', tone: 'other' },
};

/** Tool name -> action kind. */
const TOOL_KINDS = {
  read: 'read',
  notebookread: 'read',
  write: 'write',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  apply_patch: 'edit',
  grep: 'search',
  search: 'search',
  ripgrep: 'search',
  glob: 'find',
  ls: 'list',
  list_dir: 'list',
  bash: 'exec',
  shell: 'exec',
  exec: 'exec',
  run_command: 'exec',
  web_fetch: 'web',
  web_search: 'web',
  mcp_browser: 'browser',
  browser: 'browser',
  skill: 'skill',
  task: 'agent',
  task_append: 'agent',
  task_output: 'agent',
  task_stop: 'agent',
  task_query: 'agent',
  todowrite: 'plan',
  todoread: 'plan',
  update_plan: 'plan',
  update_goal: 'plan',
  get_goal: 'plan',
  ask_user: 'ask',
  request_feature_enable: 'ask',
  self_reminder: 'memory',
  website_deploy: 'deploy',
  miniapp: 'app',
  mcp_invoke: 'mcp',
  tool_search: 'mcp',
  list_mcp_resources: 'mcp',
  list_mcp_resource_templates: 'mcp',
  read_mcp_resource: 'mcp',
};

/**
 * Labels that are more precise than the action kind's default wording.
 * Everything else falls back to `ACTION_KINDS[kind].label`.
 */
const TOOL_LABELS = {
  apply_patch: '修改文件',
  multiedit: '批量编辑文件',
  notebookedit: '编辑笔记本',
  todowrite: '更新任务清单',
  todoread: '读取任务清单',
  update_plan: '更新计划',
  update_goal: '更新目标',
  get_goal: '读取目标',
  web_fetch: '抓取网页',
  web_search: '搜索网页',
  request_feature_enable: '请求启用功能',
  list_mcp_resources: '列出 MCP 资源',
  list_mcp_resource_templates: '列出 MCP 资源模板',
  read_mcp_resource: '读取 MCP 资源',
  mcp_invoke: '调用 MCP 工具',
  tool_search: '检索可用工具',
  self_reminder: '设置提醒',
  task_append: '追加子代理任务',
  task_output: '读取子代理输出',
  task_stop: '停止子代理',
  task_query: '查询后台任务',
  miniapp: '操作小程序',
  website_deploy: '发布站点',
};

/** Tools whose primary argument is a file path. */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit', 'apply_patch']);

function isFileTool(tool) {
  if (FILE_TOOLS.has(tool)) return true;
  return /^mcp__.*__(read|write|edit|create|update)$/i.test(tool);
}

/* ------------------------------------------------------------------ */
/* MCP tools                                                           */
/* ------------------------------------------------------------------ */

/** Display names for the MCP servers this host is known to run. */
const MCP_SERVER_NAMES = {
  webnote: 'WebNote',
  lark: '飞书',
  feishu: '飞书',
  github: 'GitHub',
  notion: 'Notion',
};

/** Chinese words for the verbs and objects an MCP tool is named after. */
const MCP_WORDS = {
  create: '创建',
  add: '添加',
  list: '列出',
  get: '读取',
  read: '读取',
  fetch: '抓取',
  show: '查看',
  view: '查看',
  update: '更新',
  edit: '编辑',
  write: '写入',
  set: '设置',
  delete: '删除',
  remove: '删除',
  upload: '上传',
  download: '下载',
  search: '搜索',
  query: '查询',
  publish: '发布',
  schedule: '定时发布',
  cancel: '取消',
  move: '移动',
  revert: '退回',
  doctor: '自检',
  invoke: '调用',
  inspect: '检查',
  open: '打开',
  click: '点击',
  type: '输入',
  fill: '填写',
  navigate: '跳转',
  screenshot: '截图',
  export: '导出',
  import: '导入',
  run: '执行',
  start: '启动',
  stop: '停止',
  restart: '重启',
  to: '到',
  of: '的',
  and: '与',
  note: '笔记',
  notes: '笔记',
  image: '图片',
  images: '图片',
  asset: '资产',
  assets: '资产',
  file: '文件',
  files: '文件',
  calendar: '日程',
  event: '日程',
  task: '任务',
  tasks: '任务',
  message: '消息',
  messages: '消息',
  document: '文档',
  documents: '文档',
  page: '页面',
  site: '站点',
  website: '站点',
  tree: '思维链树',
  session: '会话',
  agent: '代理',
  tool: '工具',
  tools: '工具',
  resource: '资源',
  resources: '资源',
  group: '分组',
  tag: '标签',
  tags: '标签',
  browser: '浏览器',
  memory: '记忆',
  drive: '云盘',
  user: '用户',
  comment: '评论',
  repo: '仓库',
  branch: '分支',
  commit: '提交',
  pr: '合并请求',
  outline: '大纲',
  summary: '摘要',
  content: '内容',
  status: '状态',
  list_notes: '笔记列表',
};

/**
 * Split an MCP tool name into its server and its tool.
 *
 * `mcp__webnote__webnote_create_note` -> `{ server: 'webnote', name: 'webnote_create_note' }`
 */
export function parseMcpTool(tool) {
  if (!tool || typeof tool !== 'string') return null;
  if (!tool.startsWith('mcp__')) return null;
  const rest = tool.slice(5);
  const split = rest.indexOf('__');
  if (split < 0) return null;
  const server = rest.slice(0, split);
  const name = rest.slice(split + 2);
  if (!server || !name) return null;
  return { server, name };
}

/** A readable name for an MCP server, e.g. `webnote` -> `WebNote`. */
export function mcpDisplayName(server) {
  if (!server) return '';
  const known = MCP_SERVER_NAMES[server.toLowerCase()];
  if (known) return known;
  return server.charAt(0).toUpperCase() + server.slice(1);
}

/**
 * The Chinese action an MCP tool performs, e.g. `create_note` -> `创建笔记`.
 * Unknown words keep their English spelling.
 */
export function mcpActionText(name, server) {
  if (!name) return '';
  let bare = String(name).replace(/^mcp__/, '');
  // The tool usually repeats the server name: `webnote_create_note`.
  if (server) {
    const prefix = `${server}_`;
    if (bare.toLowerCase().startsWith(prefix.toLowerCase())) bare = bare.slice(prefix.length);
  }
  const words = bare.split(/[_\s]+/).filter(Boolean);
  if (!words.length) return '';
  const parts = words.map((word) => MCP_WORDS[word.toLowerCase()] ?? word);
  // Translated words are joined tightly, English ones keep their space.
  let out = '';
  for (const part of parts) {
    if (out && /[a-z0-9]$/i.test(out) && /^[a-z0-9]/i.test(part)) out += ' ';
    out += part;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Action resolution                                                   */
/* ------------------------------------------------------------------ */

/**
 * The action of a tool: `{ kind, label, glyph, tone }`.
 * MCP tools are always reported as `mcp` so a server call stays visible.
 */
export function toolAction(tool) {
  const name = tool || 'tool';
  const mcp = parseMcpTool(name);
  if (mcp) {
    const base = ACTION_KINDS.mcp;
    return { kind: 'mcp', label: base.label, glyph: base.glyph, tone: base.tone, mcp };
  }
  const kind = TOOL_KINDS[name] ?? TOOL_KINDS[name.toLowerCase()] ?? 'other';
  const base = ACTION_KINDS[kind] ?? ACTION_KINDS.other;
  const label = TOOL_LABELS[name] ?? TOOL_LABELS[name.toLowerCase()] ?? base.label;
  return { kind, label, glyph: base.glyph, tone: base.tone, mcp: null };
}

/** The Chinese label for a tool, with a readable fallback. */
export function toolLabel(tool) {
  return toolAction(tool).label;
}

/**
 * Render a path relative to the workspace root, in the `.\a\b` form.
 * Paths outside the workspace keep their absolute form.
 */
export function relativePath(target, workspaceRoot) {
  if (!target || typeof target !== 'string') return '';
  if (!workspaceRoot) return target;
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalized = path.resolve(normalizedRoot, target);
  const relative = path.relative(normalizedRoot, normalized);
  if (!relative) return '.';
  // Outside the workspace (or on another drive) the absolute path is kept.
  const outside = relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
  if (outside) return normalized;
  // A dot folder keeps its own dot: `.\.minimax-plugin\plugin.json`.
  return `.${path.sep}${relative}`;
}

function firstString(input, keys) {
  if (!input || typeof input !== 'object') return '';
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function fileArgOf(input) {
  return firstString(input, ['file_path', 'path', 'filePath', 'notebook_path', 'file']);
}

/* ------------------------------------------------------------------ */
/* Titles and commands                                                 */
/* ------------------------------------------------------------------ */

/**
 * The one-line full command for a tool call, e.g. `read: .\hello.txt`.
 * Returns an empty string when the tool takes no meaningful argument.
 */
export function formatCommand(tool, input, workspaceRoot) {
  const name = tool || 'tool';
  if (!input || typeof input !== 'object') return '';

  if (isFileTool(name)) {
    const file = fileArgOf(input);
    if (!file) return '';
    return `${name}: ${relativePath(file, workspaceRoot)}`;
  }

  const mcp = parseMcpTool(name);
  if (mcp) {
    const file = fileArgOf(input);
    if (file) return `${name}: ${relativePath(file, workspaceRoot)}`;
    return name;
  }

  switch (name) {
    case 'bash':
    case 'shell': {
      const command = firstString(input, ['command', 'script', 'cmd']);
      return command ? `${name}: ${command}` : '';
    }
    case 'glob': {
      const pattern = firstString(input, ['pattern']);
      const dir = firstString(input, ['path', 'dir']);
      if (!pattern) return '';
      return dir ? `${name}: ${relativePath(dir, workspaceRoot)}\\${pattern}` : `${name}: ${pattern}`;
    }
    case 'grep': {
      const pattern = firstString(input, ['pattern']);
      const dir = firstString(input, ['path', 'dir']);
      if (!pattern) return '';
      return dir ? `${name}: ${pattern} @ ${relativePath(dir, workspaceRoot)}` : `${name}: ${pattern}`;
    }
    case 'task': {
      const description = firstString(input, ['description', 'subagent_type']);
      return description ? `${name}: ${description}` : '';
    }
    case 'skill': {
      const skillName = firstString(input, ['name', 'skill', 'skill_name']);
      return skillName ? `${name}: ${skillName}` : name;
    }
    case 'web_fetch': {
      const url = firstString(input, ['url']);
      return url ? `${name}: ${url}` : name;
    }
    case 'web_search': {
      const query = firstString(input, ['query']);
      return query ? `${name}: ${query}` : name;
    }
    case 'mcp_browser': {
      const action = firstString(input, ['action']);
      return action ? `${name}: ${action}` : name;
    }
    case 'website_deploy': {
      const project = firstString(input, ['project_name', 'name']);
      return project ? `${name}: ${project}` : name;
    }
    case 'todowrite':
    case 'todoread':
    case 'update_plan':
    case 'update_goal':
    case 'get_goal':
    case 'request_feature_enable':
    case 'self_reminder':
    case 'tool_search':
    case 'mcp_invoke':
    case 'task_append':
    case 'task_output':
    case 'task_stop':
    case 'task_query':
    case 'miniapp':
      return name;
    default:
      return '';
  }
}

/**
 * The detailed Chinese title of an execution, e.g. `读取文件 .\a.txt`,
 * `加载技能：plugintree`, `调用 WebNote：创建笔记`.
 */
export function toolDetail(tool, input, workspaceRoot) {
  const name = tool || 'tool';
  const action = toolAction(name);
  const file = fileArgOf(input);

  // An MCP call always names the server and what it did there.
  if (action.mcp) {
    const server = mcpDisplayName(action.mcp.server);
    const did = mcpActionText(action.mcp.name, action.mcp.server);
    if (file) return `调用 ${server}：${did} ${relativePath(file, workspaceRoot)}`;
    return did ? `调用 ${server}：${did}` : `调用 ${server}`;
  }

  switch (action.kind) {
    case 'read':
    case 'write':
    case 'edit': {
      if (!file) return action.label;
      return `${action.label} ${relativePath(file, workspaceRoot)}`;
    }
    case 'exec': {
      const command = firstString(input, ['command', 'script', 'cmd']);
      if (!command) return action.label;
      const head = command.split(/\r?\n/).find((line) => line.trim()) ?? command;
      const flat = head.replace(/\s+/g, ' ').trim();
      return flat.length > 30 ? `${action.label}：${flat.slice(0, 30)}…` : `${action.label}：${flat}`;
    }
    case 'search':
    case 'find': {
      const pattern = firstString(input, ['pattern', 'query']);
      return pattern ? `${action.label}：${pattern}` : action.label;
    }
    case 'skill': {
      const skillName = firstString(input, ['name', 'skill', 'skill_name']);
      return skillName ? `${action.label}：${skillName}` : action.label;
    }
    case 'agent': {
      const description = firstString(input, ['description', 'prompt', 'subagent_type']);
      return description ? `${action.label}：${String(description).slice(0, 20)}` : action.label;
    }
    case 'plan': {
      const todos = Array.isArray(input?.todos) ? input.todos.length : 0;
      if (todos) return `${action.label}：${todos} 项`;
      const plan = firstString(input, ['plan', 'explanation']);
      return plan ? `${action.label}：${plan.slice(0, 18)}` : action.label;
    }
    case 'web': {
      const value = firstString(input, ['url', 'query']);
      return value ? `${action.label}：${value}` : action.label;
    }
    case 'browser': {
      const value = firstString(input, ['action', 'text']);
      return value ? `${action.label}：${value}` : action.label;
    }
    case 'ask': {
      const value = firstString(input, ['question', 'featureKey', 'title']);
      return value ? `${action.label}：${String(value).slice(0, 18)}` : action.label;
    }
    case 'memory': {
      const value = firstString(input, ['prompt', 'text']);
      return value ? `${action.label}：${String(value).slice(0, 18)}` : action.label;
    }
    case 'deploy': {
      const value = firstString(input, ['project_name', 'name']);
      return value ? `${action.label}：${value}` : action.label;
    }
    case 'app': {
      const value = firstString(input, ['action', 'pluginId']);
      return value ? `${action.label}：${value}` : action.label;
    }
    default:
      return action.label;
  }
}

/**
 * The short Chinese title for an execution node, e.g. `读取 .\hello.txt`.
 */
export function executionTitle(tool, input, workspaceRoot) {
  return toolDetail(tool, input, workspaceRoot);
}

/**
 * The title for a strategy node, derived from the actions it produced.
 * Falls back to the first sentence of the reasoning when it produced none.
 */
export function strategyTitle(childLabels, reasoningText) {
  const unique = [];
  for (const label of childLabels) {
    if (label && !unique.includes(label)) unique.push(label);
  }
  if (unique.length) {
    const shown = unique.slice(0, 2).join('、');
    return unique.length > 2 ? `策略：${shown} 等${unique.length}项` : `策略：${shown}`;
  }
  if (reasoningText) {
    const first = String(reasoningText).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    const flat = (first ?? '').replace(/\s+/g, ' ').trim();
    return flat ? `策略：${flat.slice(0, 22)}${flat.length > 22 ? '…' : ''}` : '策略：思考';
  }
  return '策略：思考';
}

/** Render a duration the way the node badge shows it. */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}
