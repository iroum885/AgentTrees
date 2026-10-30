/* plugintree viewer — vanilla ES module front-end. No build step, no external assets. */

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------ */
/* layout constants                                                    */
/* ------------------------------------------------------------------ */
const NODE_W = 300;
const NODE_H = 88;
/** Horizontal distance between two lanes: the spine, then one lane per branch. */
const LANE_GAP = 330;
/** Vertical distance between two rows. */
const ROW_GAP = 54;
const TITLE_MAX_LINES = 2;
const TITLE_LINE_STEP = 15;
const TITLE_FONT_SIZE = 11;
const TITLE_PAD = 12;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
const LABEL_PAD = 24;

const TYPE_META = {
  question: { label: '提问', short: '问' },
  scheme: { label: '策略', short: '策' },
  reasoning: { label: '思考', short: '思' },
  execution: { label: '执行', short: '执' },
  ask: { label: '询问', short: '询' },
  subagent: { label: '子代理', short: '代' },
  note: { label: '说明', short: '注' },
};

/**
 * The action classes the agent can perform.
 *
 * A card shows the class of the action instead of a flat "执行", so reading /
 * writing / searching / a skill / an MCP call are told apart at a glance.
 * The backend sends the same classification with every node.
 */
const ACTION_META = {
  read: { glyph: '读', label: '读取文件' },
  write: { glyph: '写', label: '写入文件' },
  edit: { glyph: '改', label: '编辑文件' },
  search: { glyph: '搜', label: '搜索内容' },
  find: { glyph: '找', label: '查找文件' },
  list: { glyph: '列', label: '列出目录' },
  exec: { glyph: '执', label: '执行命令' },
  web: { glyph: '网', label: '访问网页' },
  browser: { glyph: '浏', label: '操作浏览器' },
  skill: { glyph: '技', label: '加载技能' },
  mcp: { glyph: '令', label: '调用 MCP' },
  agent: { glyph: '代', label: '委派子代理' },
  plan: { glyph: '计', label: '任务清单' },
  ask: { glyph: '问', label: '向用户提问' },
  memory: { glyph: '忆', label: '记忆提醒' },
  deploy: { glyph: '发', label: '发布站点' },
  app: { glyph: '小', label: '操作小程序' },
  media: { glyph: '媒', label: '生成多媒体' },
  other: { glyph: '其', label: '执行工具' },
};

const STATUS_LABEL = {
  ok: '完成',
  error: '错误',
  denied: '拒绝',
  asked: '待回应',
  pending: '等待中',
  running: '执行中',
  done: '完成',
};

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */
const state = {
  turns: [],
  sessions: [],
  workspace: '',
  workspaces: [],
  autoFollow: true,
  /** Only turns that are new or still running are shown (0 = show all). */
  sinceTs: 0,
  onlyNew: false,
  selectedTurnId: null,
  tree: null,
  treeError: null,
  selectedNodeId: null,
  layout: null,
  nodeEls: new Map(),
  filterText: '',
  originLive: true,
  originHistory: true,
  view: { scale: 1, tx: 0, ty: 0 },
  /** True while the viewer follows the newest turn on its own. */
  followLatest: true,
  /** Set once the user pans or zooms, so live updates stop moving the view. */
  viewPinned: false,
};

let els = {};
let stream = null;
let toastTimer = 0;
let dragState = null;
let suppressNextClick = false;
let liveTimer = 0;

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */
function byId(id) {
  return document.getElementById(id);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function truncateText(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

/** Render a duration the way the node badge shows it. */
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

function errorMessage(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return err.message ? String(err.message) : String(err);
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

async function fetchJSON(url, options) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const message = body && body.error ? String(body.error) : (response.statusText || `HTTP ${response.status}`);
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return body;
}

async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const holder = document.createElement('textarea');
  holder.value = value;
  holder.setAttribute('readonly', '');
  holder.style.position = 'fixed';
  holder.style.top = '-1000px';
  holder.style.opacity = '0';
  document.body.appendChild(holder);
  holder.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(holder);
  return ok;
}

/* ------------------------------------------------------------------ */
/* text measurement                                                    */
/* ------------------------------------------------------------------ */

/**
 * Title text is wrapped by its real width, not by a character count.
 *
 * A path such as `读取文件 .\.minimax-plugin\plugin.json` is mostly latin,
 * so a fixed "20 characters per line" rule wrapped it long before the card
 * was full. The estimate below is calibrated against the real font width,
 * so a line only breaks when it really runs out of room.
 */
const widthCache = new Map();
let measurer = null;

function charWidth(ch) {
  const code = ch.codePointAt(0);
  // CJK and full-width forms take a whole em.
  if ((code >= 0x2e80 && code <= 0x9fff)
    || (code >= 0x3000 && code <= 0x303f)
    || (code >= 0xff00 && code <= 0xffef)) return TITLE_FONT_SIZE;
  if (ch === ' ') return 3.1;
  if (ch >= 'A' && ch <= 'Z') return 7.3;
  if (ch >= 'a' && ch <= 'z') return 5.9;
  if (ch >= '0' && ch <= '9') return 6.2;
  return 3.8;
}

function estimateTextWidth(text) {
  let width = 0;
  for (const ch of String(text ?? '')) width += charWidth(ch);
  return width;
}

function ensureMeasurer() {
  if (measurer && measurer.isConnected) return measurer;
  // The measurer uses the title font, so the measured width matches what the
  // card will really show.
  measurer = svgEl('text', { class: 'pt-node-title pt-measure', x: '-9999', y: '-9999' });
  els.svg.appendChild(measurer);
  return measurer;
}

/** The real width of a string in the title font, cached per string. */
function measureText(text) {
  const key = String(text ?? '');
  if (!key) return 0;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;

  let width = 0;
  const node = ensureMeasurer();
  if (node) {
    try {
      node.textContent = key;
      const measured = node.getComputedTextLength();
      if (Number.isFinite(measured) && measured > 0) width = measured;
    } catch {
      /* the browser refused to measure: fall back to the estimate */
    }
  }
  if (!width) width = estimateTextWidth(key);
  if (widthCache.size > 4000) widthCache.clear();
  widthCache.set(key, width);
  return width;
}

/** Cut a line so that it plus an ellipsis still fits the available width. */
function fitWithEllipsis(line, maxWidth) {
  const chars = Array.from(line);
  let width = estimateTextWidth(chars.join('')) + 6;
  let cut = chars.length;
  while (cut > 0 && width > maxWidth) {
    cut -= 1;
    width = estimateTextWidth(chars.slice(0, cut).join('')) + 6;
  }
  return `${chars.slice(0, cut).join('')}…`;
}

/** Wrap by estimated width. */
function estimateWrap(text, maxWidth, maxLines) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chars = Array.from(clean);
  const lines = [];
  let index = 0;

  while (index < chars.length && lines.length < maxLines) {
    let width = 0;
    let breakAt = -1;
    let end = index;
    while (end < chars.length) {
      const next = charWidth(chars[end]);
      if (width + next > maxWidth && end > index) break;
      width += next;
      if (chars[end] === ' ') breakAt = end;
      end += 1;
    }
    let stop = end;
    if (end < chars.length && breakAt > index) stop = breakAt;
    const piece = chars.slice(index, stop).join('').trim();
    if (piece) lines.push(piece);
    index = stop;
    while (index < chars.length && chars[index] === ' ') index += 1;
  }

  if (index < chars.length && lines.length) {
    lines[lines.length - 1] = fitWithEllipsis(lines[lines.length - 1], maxWidth);
  }
  return lines;
}

/**
 * Wrap a title into at most `maxLines` lines that fit `maxWidth`.
 *
 * The first line is measured against the real font; when the font turns out
 * to be wider than the estimate, the text is wrapped again with the measured
 * ratio so nothing ever spills out of the card.
 */
function wrapTitle(text, maxWidth, maxLines) {
  const lines = estimateWrap(text, maxWidth, maxLines);
  if (!lines.length) return lines;
  const actual = measureText(lines[0]);
  const estimate = estimateTextWidth(lines[0]);
  if (actual > estimate * 1.03 && estimate > 0) {
    const corrected = estimateWrap(text, maxWidth * (estimate / actual), maxLines);
    if (corrected.length) return corrected;
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* tree layout                                                         */
/* ------------------------------------------------------------------ */

/**
 * The drawing is a spine with branches, not a pyramid.
 *
 * The main path — the question at the top and every strategy step below it —
 * runs down one straight vertical line through the middle of the canvas.
 * Everything that hangs off that line is a branch: a branch that leans
 * towards doing (an execution, a note) opens to the left, a branch that
 * leans towards thinking (a parallel strategy) opens to the right.
 *
 * Rows still follow the depth of the tree, so a branch leaves its parent and
 * lands on the same row as the node that follows the parent on the spine.
 */
/**
 * The node types that lean towards thinking rather than towards doing.
 *
 * A strategy, a question to the user and a delegated sub-agent are all
 * thoughts; an execution and a note are things the agent did.
 */
const THINKING_TYPES = new Set(['scheme', 'reasoning', 'ask', 'subagent']);

/** Does this node lean towards thinking rather than towards doing? */
function isThinking(node) {
  return THINKING_TYPES.has(node?.type);
}

/**
 * Build a centred-spine layout from a flat node list.
 *
 * Nodes are linked through `parentId` only (`children` is ignored).
 *
 * The spine is the chain of thinking: from the root the layout follows the
 * strategy that carries the run forward, so the main path is a single
 * vertical line at x = 0. Every other node becomes a branch of that spine:
 * the ones that do something are placed in lanes on the left, the ones that
 * think in lanes on the right, and a branch keeps its side as it grows.
 */
export function layoutTree(rawNodes) {
  const list = (Array.isArray(rawNodes) ? rawNodes : [])
    .filter((n) => n && typeof n === 'object' && n.id !== undefined && n.id !== null);

  const entries = [];
  const entryById = new Map();
  list.forEach((node, index) => {
    const id = String(node.id);
    if (entryById.has(id)) return;
    const entry = { id, node, index, children: [], parentId: null };
    entryById.set(id, entry);
    entries.push(entry);
  });

  // Detect parent cycles so a malformed tree still renders.
  const cyclic = new Set();
  for (const entry of entries) {
    const path = [];
    const seen = new Map();
    let cursor = entry;
    while (cursor) {
      if (seen.has(cursor.id)) {
        const start = seen.get(cursor.id);
        for (let i = start; i < path.length; i += 1) cyclic.add(path[i]);
        break;
      }
      seen.set(cursor.id, path.length);
      path.push(cursor.id);
      const pid = cursor.node.parentId;
      const parent = pid === undefined || pid === null ? null : entryById.get(String(pid));
      cursor = parent && parent !== cursor ? parent : null;
    }
  }

  const roots = [];
  for (const entry of entries) {
    const pid = entry.node.parentId;
    const parent = pid === undefined || pid === null ? null : entryById.get(String(pid));
    if (!parent || parent === entry || cyclic.has(entry.id)) {
      roots.push(entry);
    } else {
      entry.parentId = parent.id;
      parent.children.push(entry);
    }
  }

  // How deep is this node? The parent chain decides it.
  const depthMemo = new Map();
  const depthOf = (entry) => {
    const cached = depthMemo.get(entry.id);
    if (cached !== undefined) return cached;
    const parent = entry.parentId ? entryById.get(entry.parentId) : null;
    const depth = parent ? depthOf(parent) + 1 : 0;
    depthMemo.set(entry.id, depth);
    return depth;
  };

  // How tall is the subtree under this node? The tallest thinking branch
  // below a node is the one that carries the main path further down.
  const heightMemo = new Map();
  const heightOf = (entry) => {
    const cached = heightMemo.get(entry.id);
    if (cached !== undefined) return cached;
    let tallest = 0;
    for (const kid of entry.children) tallest = Math.max(tallest, heightOf(kid));
    const height = tallest + 1;
    heightMemo.set(entry.id, height);
    return height;
  };

  const spineChildOf = (entry) => {
    let best = null;
    for (const kid of entry.children) {
      if (!isThinking(kid.node)) continue;
      if (!best || heightOf(kid) > heightOf(best)) best = kid;
    }
    return best;
  };

  // The main path: the question at the top, then every strategy step.
  const mainRoot = roots.reduce(
    (best, root) => (heightOf(root) > heightOf(best) ? root : best),
    roots[0],
  );
  const spine = [];
  const continuation = new Map();
  let cursor = mainRoot;
  while (cursor) {
    spine.push(cursor);
    const next = spineChildOf(cursor);
    if (!next) break;
    continuation.set(cursor.id, next.id);
    cursor = next;
  }

  // Lane 0 is the spine. Negative lanes are on the left (doing), positive
  // lanes on the right (thinking).
  const laneOf = new Map();
  const sideOf = new Map();
  // The outermost lane already used at a given row and side, so two
  // branches never claim the same slot.
  const laneUse = new Map();
  for (const entry of spine) {
    laneOf.set(entry.id, 0);
    sideOf.set(entry.id, 'center');
  }

  /**
   * Place a branch node and everything below it.
   *
   * A branch keeps the side of the spine node it hangs off, and every step
   * further down moves one lane further out, so a branch never folds back
   * over the main path.
   */
  const placeBranch = (entry, side, lane) => {
    laneOf.set(entry.id, lane);
    sideOf.set(entry.id, side);
    const key = `${depthOf(entry) + 1}:${side}`;
    let magnitude = Math.max((laneUse.get(key) ?? 0) + 1, Math.abs(lane) + 1);
    for (const kid of entry.children) {
      const kidLane = side === 'left' ? -magnitude : magnitude;
      laneUse.set(key, magnitude);
      placeBranch(kid, side, kidLane);
      magnitude += 1;
    }
  };

  /**
   * Place the branches of one spine node: doing on the left, thinking on
   * the right, the first branch closest to the main path.
   */
  const placeBranches = (entry, children) => {
    const groups = [
      { side: 'left', list: children.filter((kid) => !isThinking(kid.node)) },
      { side: 'right', list: children.filter((kid) => isThinking(kid.node)) },
    ];
    for (const group of groups) {
      const key = `${depthOf(entry) + 1}:${group.side}`;
      let magnitude = (laneUse.get(key) ?? 0) + 1;
      for (const kid of group.list) {
        const lane = group.side === 'left' ? -magnitude : magnitude;
        laneUse.set(key, magnitude);
        placeBranch(kid, group.side, lane);
        magnitude += 1;
      }
    }
  };

  for (const entry of spine) {
    const nextId = continuation.get(entry.id);
    placeBranches(entry, entry.children.filter((kid) => kid.id !== nextId));
  }

  // A malformed tree can have more than one root: the extras hang off to
  // the left instead of sitting on top of the main path.
  const extraRoots = roots.filter((root) => root.id !== mainRoot.id);
  extraRoots.forEach((root) => {
    const key = `${depthOf(root)}:left`;
    const magnitude = (laneUse.get(key) ?? 0) + 1;
    laneUse.set(key, magnitude);
    placeBranch(root, 'left', -magnitude);
  });

  const records = [];
  const recordById = new Map();
  const build = (entry) => {
    const depth = depthOf(entry);
    const record = {
      id: entry.id,
      node: entry.node,
      x: (laneOf.get(entry.id) ?? 0) * LANE_GAP,
      y: depth * (NODE_H + ROW_GAP),
      depth,
      lane: laneOf.get(entry.id) ?? 0,
      side: sideOf.get(entry.id) ?? 'center',
      parentId: entry.parentId,
      childIds: [],
      siblingIds: [],
      siblingIndex: 0,
      /** Position among the siblings that share this side. */
      sideSlot: 0,
      /** How many siblings share this side. */
      sideCount: 1,
    };
    recordById.set(entry.id, record);
    records.push(record);
    entry.children.forEach((kid, index) => {
      const childRecord = build(kid);
      record.childIds.push(kid.id);
      childRecord.siblingIds = entry.children.map((k) => k.id);
      childRecord.siblingIndex = index;
    });
    // The branches of one node each get their own level in the gap between
    // the rows, so their lines never run on top of each other.
    const sides = new Map();
    for (const kid of entry.children) {
      const side = sideOf.get(kid.id) ?? 'center';
      if (!sides.has(side)) sides.set(side, []);
      sides.get(side).push(kid.id);
    }
    for (const [side, ids] of sides) {
      ids.forEach((id, slot) => {
        const record2 = recordById.get(id);
        if (!record2) return;
        record2.sideSlot = slot;
        record2.sideCount = ids.length;
      });
    }
    return record;
  };
  roots.forEach((root) => build(root));
  const rootIds = roots.map((r) => r.id);
  roots.forEach((root, index) => {
    const record = recordById.get(root.id);
    record.siblingIds = rootIds;
    record.siblingIndex = index;
  });

  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = 0;
  for (const record of records) {
    minX = Math.min(minX, record.x - NODE_W / 2);
    maxX = Math.max(maxX, record.x + NODE_W / 2);
    maxY = Math.max(maxY, record.y + NODE_H);
  }
  if (!records.length) {
    minX = 0;
    maxX = 0;
    maxY = 0;
  }
  const bounds = {
    minX: minX - LABEL_PAD,
    minY: -LABEL_PAD,
    maxX: maxX + LABEL_PAD,
    maxY: maxY + LABEL_PAD,
  };

  return {
    records,
    byId: recordById,
    bounds,
    /** The main path always runs down this x, so the view can centre it. */
    spineX: 0,
    /** The nodes of the main path, from the question downwards. */
    spineIds: spine.map((entry) => entry.id),
  };
}

/* ------------------------------------------------------------------ */
/* sidebar                                                             */
/* ------------------------------------------------------------------ */
function filteredTurns() {
  const needle = state.filterText.trim().toLowerCase();
  return state.turns.filter((turn) => {
    const origin = turn.origin === 'history' ? 'history' : 'live';
    if (origin === 'live' && !state.originLive) return false;
    if (origin === 'history' && !state.originHistory) return false;
    // After a workspace switch only the new and the still running rounds
    // matter: the ones that were already finished are left behind.
    if (state.sinceTs) {
      const stamp = turn.updatedAt ?? turn.ts ?? 0;
      if (!turn.running && stamp < state.sinceTs) return false;
    }
    if (!needle) return true;
    return String(turn.question ?? '').toLowerCase().includes(needle);
  });
}

function renderSidebar() {
  const list = els.turnList;
  const visible = filteredTurns();

  if (!state.turns.length) {
    els.turnCount.textContent = '0 个回合';
    list.replaceChildren();
    list.dataset.key = '';
    list.appendChild(el('li', 'turn-empty', '暂无回合记录'));
    return;
  }
  els.turnCount.textContent = visible.length === state.turns.length
    ? `${state.turns.length} 个回合`
    : `${visible.length} / ${state.turns.length} 个回合`;

  if (!visible.length) {
    list.replaceChildren();
    list.dataset.key = '';
    list.appendChild(el('li', 'turn-empty', '没有匹配的回合'));
    return;
  }

  // The rows are only rebuilt when the set of rounds changes. While a round is
  // running its node count keeps ticking, and rebuilding the whole list for
  // that alone would make the rows flicker and lose their place.
  const key = visible.map((t) => t.turnId).join('|');
  if (list.dataset.key === key) {
    for (const turn of visible) {
      const row = list.querySelector(`[data-turn-id="${CSS.escape(turn.turnId)}"]`);
      if (!row) continue;
      const counter = row.querySelector('.turn-count-badge');
      if (counter) counter.textContent = `${turn.nodeCount ?? 0} 节点`;
      const button = row.querySelector('.turn-row');
      if (button) {
        const active = turn.turnId === state.selectedTurnId;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-current', active ? 'true' : 'false');
      }
    }
    return;
  }

  list.replaceChildren();
  list.dataset.key = key;

  for (const turn of visible) {
    const item = document.createElement('li');
    item.dataset.turnId = turn.turnId;
    const button = el('button', 'turn-row');
    button.type = 'button';
    const active = turn.turnId === state.selectedTurnId;
    button.setAttribute('aria-current', active ? 'true' : 'false');
    if (active) button.classList.add('is-active');

    const question = el('p', 'turn-question', turn.question || '(无提问文本)');
    button.appendChild(question);

    const meta = el('div', 'turn-meta');
    const stamp = formatTime(turn.ts ?? turn.updatedAt) || '时间未知';
    const time = el('span', 'turn-time', stamp);
    time.title = stamp;
    meta.appendChild(time);

    const originBadge = el('span', `badge badge-origin badge-${turn.origin === 'history' ? 'history' : 'live'}`,
      turn.origin === 'history' ? '历史' : '实时');
    meta.appendChild(originBadge);

    if (turn.running) {
      meta.appendChild(el('span', 'badge badge-running', '进行中'));
    }

    const count = el('span', 'turn-count-badge', `${turn.nodeCount ?? 0} 节点`);
    meta.appendChild(count);
    button.appendChild(meta);

    button.addEventListener('click', () => {
      // Clicking the newest turn resumes following it; clicking an older one
      // pins the viewer to that turn.
      state.followLatest = turn.turnId === state.turns[0]?.turnId;
      selectTurn(turn.turnId);
    });
    item.appendChild(button);
    list.appendChild(item);
  }
}

/* ------------------------------------------------------------------ */
/* canvas / svg rendering                                              */
/* ------------------------------------------------------------------ */
function showCanvasMessage(title, body, actions) {
  const overlay = els.canvasOverlay;
  overlay.replaceChildren();
  overlay.hidden = false;
  const box = el('div', 'canvas-message');
  box.appendChild(el('h3', 'canvas-message-title', title));
  if (body) box.appendChild(el('p', 'canvas-message-body', body));
  if (actions && actions.length) {
    const row = el('div', 'canvas-message-actions');
    for (const action of actions) {
      const button = el('button', 'btn', action.label);
      button.type = 'button';
      button.addEventListener('click', action.onClick);
      row.appendChild(button);
    }
    box.appendChild(row);
  }
  overlay.appendChild(box);
}

function clearCanvasMessage() {
  els.canvasOverlay.replaceChildren();
  els.canvasOverlay.hidden = true;
}

function nodeMarkerText(node) {
  const markers = [];
  if (node.selected === true) markers.push('已选中');
  else if (node.selected === false) markers.push('未采纳');
  const status = node.status;
  if (status === 'error') markers.push('错误');
  else if (status === 'denied') markers.push('拒绝');
  else if (status) markers.push(STATUS_LABEL[status] || String(status));
  return markers.join(' · ');
}

function nodeHasError(node) {
  return node.status === 'error' || node.status === 'denied';
}

/**
 * The action class of a node: read / write / grep / skill / mcp / agent …
 * The backend classifies every tool, so the card can say what kind of work
 * it stands for instead of a flat "执行".
 */
function actionMeta(node) {
  const kind = node.actionKind && ACTION_META[node.actionKind] ? node.actionKind : 'other';
  const base = ACTION_META[kind];
  return {
    kind,
    glyph: node.actionGlyph || base.glyph,
    label: node.action || base.label,
    tone: node.actionTone || kind,
  };
}

function buildNodeElement(record) {
  const node = record.node;
  const type = TYPE_META[node.type] ? node.type : 'note';
  const meta = TYPE_META[type];
  // An execution shows its action class; a strategy shows the class of the
  // question it raised (asking the user, asking for permission, delegating).
  const action = node.actionKind ? actionMeta(node) : null;

  const group = svgEl('g', {
    class: `pt-node type-${type}${action ? ` act-${action.tone}` : ''} side-${record.side ?? 'center'}`,
    tabindex: '0',
    role: 'treeitem',
    'aria-level': String(record.depth + 1),
    'aria-selected': 'false',
  });
  group.dataset.nodeId = record.id;

  const x0 = record.x - NODE_W / 2;
  const y0 = record.y;

  group.appendChild(svgEl('rect', {
    class: 'pt-node-box',
    x: x0,
    y: y0,
    width: NODE_W,
    height: NODE_H,
    rx: 10,
    ry: 10,
  }));

  group.appendChild(svgEl('rect', {
    class: 'pt-node-chip',
    x: x0 + 10,
    y: y0 + 10,
    width: 22,
    height: 22,
    rx: 6,
    ry: 6,
  }));

  const glyph = svgEl('text', {
    class: 'pt-node-glyph',
    x: x0 + 21,
    y: y0 + 25,
    'text-anchor': 'middle',
  });
  glyph.textContent = action ? action.glyph : meta.short;
  group.appendChild(glyph);

  const label = svgEl('text', {
    class: 'pt-node-label',
    x: x0 + 40,
    y: y0 + 26,
  });
  label.textContent = action ? action.label : meta.label;
  group.appendChild(label);

  const markerText = nodeMarkerText(node);
  if (markerText) {
    const marker = svgEl('text', {
      class: `pt-node-marker ${node.selected === true ? 'mark-sel' : node.selected === false ? 'mark-unsel' : ''} ${nodeHasError(node) ? 'mark-err' : ''}`.trim(),
      x: x0 + NODE_W - 10,
      y: y0 + 26,
      'text-anchor': 'end',
    });
    marker.textContent = markerText;
    group.appendChild(marker);
  }

  // The title uses the whole width of the card before it wraps.
  const titleWidth = NODE_W - TITLE_PAD * 2;
  const lines = wrapTitle(node.title, titleWidth, TITLE_MAX_LINES);
  lines.forEach((line, index) => {
    const title = svgEl('text', {
      class: 'pt-node-title',
      x: x0 + TITLE_PAD,
      y: y0 + 48 + index * TITLE_LINE_STEP,
    });
    title.textContent = line;
    group.appendChild(title);
  });

  // Every card carries the time it took. The model thinking is real waiting
  // time too, so a strategy node shows its thinking span like any other node.
  const duration = formatDuration(node.durationMs);
  const durationText = svgEl('text', {
    class: 'pt-node-duration',
    x: x0 + TITLE_PAD,
    y: y0 + NODE_H - 10,
  });
  durationText.textContent = duration ? `耗时 ${duration}` : '耗时 —';
  group.appendChild(durationText);

  const tooltip = svgEl('title', {});
  tooltip.textContent = duration
    ? `${action ? action.label : meta.label}：${node.title ?? ''}（耗时 ${duration}）`
    : `${action ? action.label : meta.label}：${node.title ?? ''}`;
  group.appendChild(tooltip);

  if (node.selected === false) group.classList.add('is-unselected');
  if (nodeHasError(node)) group.classList.add('is-error');
  if (record.id === state.selectedNodeId) group.classList.add('is-selected');

  group.addEventListener('click', (event) => {
    event.stopPropagation();
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    selectNode(record.id);
  });
  group.addEventListener('keydown', (event) => onNodeKeydown(event, record.id));

  return group;
}

/**
 * The edge between a node and its child.
 *
 * The main path is a straight line: one strategy below the other, drawn a
 * little heavier so the spine of the drawing is easy to follow.
 *
 * A branch drops out of the bottom of its parent, travels sideways through
 * the gap between the two rows and enters the child from above. Each branch
 * of the same parent uses its own level inside that gap, so several
 * branches never draw over each other.
 */
function buildEdgeElement(parent, child) {
  const y1 = parent.y + NODE_H;
  const y2 = child.y;
  if (Math.abs(parent.x - child.x) < 1) {
    const path = svgEl('path', {
      class: 'pt-edge pt-edge-spine',
      d: `M ${parent.x} ${y1} L ${parent.x} ${y2}`,
    });
    return path;
  }
  const dir = child.x > parent.x ? 1 : -1;
  // Leave the parent at its bottom edge, a little towards the side the
  // branch goes to, so the line does not start in the middle of the card.
  const x0 = parent.x + dir * Math.min(60, NODE_W / 4);
  // The gap between the rows holds every line of this level; each branch
  // takes one band of it.
  const gap = Math.max(1, y2 - y1);
  const band = Math.max(3, Math.min(12, gap / Math.max(2, child.sideCount + 1)));
  const midY = y1 + Math.min(gap - 2, 6 + child.sideSlot * band);
  const d = `M ${x0} ${y1} L ${x0} ${midY} L ${child.x} ${midY} L ${child.x} ${y2}`;
  const path = svgEl('path', {
    class: `pt-edge pt-edge-branch pt-edge-${dir > 0 ? 'right' : 'left'}`,
    d,
  });
  return path;
}

function renderCanvas() {
  els.svg.replaceChildren();
  state.nodeEls = new Map();

  if (!state.selectedTurnId) {
    showCanvasMessage(
      '还没有回合',
      'plugintree 插件会从你的下一个问题开始记录。请在 MiniMax Code 中提问，记录出现后这里会显示对应的决策树。',
    );
    return;
  }
  if (state.treeError) {
    showCanvasMessage('无法加载决策树', state.treeError, [
      { label: '重试', onClick: () => loadTree() },
    ]);
    return;
  }
  if (!state.tree || !state.layout || !state.layout.records.length) {
    showCanvasMessage('该回合暂无节点', '树数据为空，或尚未生成决策节点。');
    return;
  }

  clearCanvasMessage();

  const defs = svgEl('defs', {});
  const marker = svgEl('marker', {
    id: 'pt-arrow',
    viewBox: '0 0 8 8',
    refX: '7',
    refY: '4',
    markerWidth: '7',
    markerHeight: '7',
    orient: 'auto-start-reverse',
  });
  marker.appendChild(svgEl('path', { class: 'pt-arrow-head', d: 'M 0 1 L 7 4 L 0 7 z' }));
  defs.appendChild(marker);
  els.svg.appendChild(defs);

  const viewport = svgEl('g', { class: 'pt-viewport' });
  els.svg.appendChild(viewport);

  const edges = svgEl('g', { class: 'pt-edges' });
  viewport.appendChild(edges);
  const nodes = svgEl('g', { class: 'pt-nodes' });
  viewport.appendChild(nodes);

  for (const record of state.layout.records) {
    if (!record.parentId) continue;
    const parent = state.layout.byId.get(record.parentId);
    if (!parent) continue;
    edges.appendChild(buildEdgeElement(parent, record));
  }

  for (const record of state.layout.records) {
    const group = buildNodeElement(record);
    nodes.appendChild(group);
    state.nodeEls.set(record.id, group);
  }

  applyView();
}

/* ------------------------------------------------------------------ */
/* pan / zoom                                                          */
/* ------------------------------------------------------------------ */
function applyView() {
  const viewport = els.svg.querySelector('.pt-viewport');
  if (viewport) {
    viewport.setAttribute(
      'transform',
      `translate(${state.view.tx.toFixed(2)} ${state.view.ty.toFixed(2)}) scale(${state.view.scale.toFixed(4)})`,
    );
  }
  els.zoomLabel.textContent = `${Math.round(state.view.scale * 100)}%`;
}

function zoomAt(clientX, clientY, factor) {
  const rect = els.svg.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  const previous = state.view.scale;
  const next = clamp(previous * factor, MIN_ZOOM, MAX_ZOOM);
  if (next === previous) return;
  const ratio = next / previous;
  state.view.tx = sx - (sx - state.view.tx) / ratio;
  state.view.ty = sy - (sy - state.view.ty) / ratio;
  state.view.scale = next;
  state.viewPinned = true;
  applyView();
}

/**
 * Show the whole drawing, with the main path still in the middle.
 *
 * The spine sits at x = 0, so the canvas is split in half around it: the
 * branches that reach out to the left and to the right get the same amount of
 * room. The scale is driven by whichever side reaches further, so nothing is
 * cut off and the main path stays exactly in the centre.
 */
function fitToWindow() {
  if (!state.layout || !state.layout.records.length) return;
  const wrap = els.canvasWrap;
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;
  if (!width || !height) return;
  const bounds = state.layout.bounds;
  const spineX = typeof state.layout.spineX === 'number' ? state.layout.spineX : 0;
  const leftReach = Math.max(1, spineX - bounds.minX);
  const rightReach = Math.max(1, bounds.maxX - spineX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  // The spine is in the middle, so both sides share the same half of the canvas.
  const halfWidth = width / 2 - 16;
  const scale = clamp(
    Math.min(halfWidth / Math.max(leftReach, rightReach), (height - 32) / contentHeight),
    MIN_ZOOM,
    1.6,
  );
  state.view.scale = scale;
  state.view.tx = width / 2 - spineX * scale;
  state.view.ty = (height - contentHeight * scale) / 2 - bounds.minY * scale;
  state.viewPinned = true;
  applyView();
}

/**
 * Put the root node in view at 100%, with the main path in the middle.
 *
 * A tree is read from its top down, so opening one starts at the question the
 * user asked, at natural size where every card is readable. The main path
 * runs down x = 0, so centring that line keeps the spine of the drawing
 * dead centre no matter how far the branches reach to the left or right.
 * The `适应窗口` button still zooms the whole tree out on demand.
 */
function resetViewToRoot() {
  if (!state.layout || !state.layout.records.length) return;
  const wrap = els.canvasWrap;
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;
  if (!width || !height) return;
  const root = state.layout.records.find((record) => !record.parentId)
    ?? state.layout.records[0];
  const spineX = typeof state.layout.spineX === 'number' ? state.layout.spineX : root.x;
  state.view.scale = 1;
  state.view.tx = width / 2 - spineX;
  state.view.ty = Math.max(LABEL_PAD, height * 0.05) - root.y;
  applyView();
}

function focusNode(nodeId) {
  const group = state.nodeEls.get(nodeId);
  if (group && typeof group.focus === 'function') group.focus();
}

function onNodeKeydown(event, nodeId) {
  const key = event.key;
  if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
    event.preventDefault();
    selectNode(nodeId);
    return;
  }
  if (!state.layout) return;
  const record = state.layout.byId.get(nodeId);
  if (!record) return;
  let target = null;
  if (key === 'ArrowDown') target = childInLane(record);
  else if (key === 'ArrowUp') target = record.parentId ?? null;
  else if (key === 'ArrowRight') target = neighbourInLane(record, 1);
  else if (key === 'ArrowLeft') target = neighbourInLane(record, -1);
  if (target) {
    event.preventDefault();
    focusNode(target);
    els.srStatus.textContent = `节点：${state.layout.byId.get(target)?.node?.title ?? ''}`;
  }
}

/**
 * The child straight below this node.
 *
 * On the main path that is the next strategy, so the arrow key walks down
 * the spine; on a branch it is simply the first child.
 */
function childInLane(record) {
  const layout = state.layout;
  if (!layout || !record.childIds.length) return null;
  let first = null;
  for (const id of record.childIds) {
    const child = layout.byId.get(id);
    if (!child) continue;
    if (child.lane === record.lane) return id;
    if (!first) first = id;
  }
  return first;
}

/**
 * The card next to this one in the drawing.
 *
 * The spine sits in the middle: the branches that do something open to the
 * left, the branches that think open to the right. So the left and right
 * arrow keys move between lanes instead of between siblings.
 */
function neighbourInLane(record, direction) {
  const layout = state.layout;
  if (!layout) return null;
  let best = null;
  for (const other of layout.records) {
    if (other.id === record.id || other.depth !== record.depth) continue;
    const delta = other.lane - record.lane;
    if (!delta || Math.sign(delta) !== direction) continue;
    if (!best || Math.abs(delta) < Math.abs(best.lane - record.lane)) best = other;
  }
  return best ? best.id : null;
}

/* ------------------------------------------------------------------ */
/* node selection / detail panel                                       */
/* ------------------------------------------------------------------ */
function selectNode(nodeId) {
  if (state.selectedNodeId === nodeId) {
    state.selectedNodeId = null;
    for (const [id, group] of state.nodeEls) {
      group.classList.toggle('is-selected', id === state.selectedNodeId);
      group.setAttribute('aria-selected', 'false');
    }
    renderDetail();
    setDetailCollapsed(true);
    return;
  }
  state.selectedNodeId = nodeId;
  for (const [id, group] of state.nodeEls) {
    const active = id === nodeId;
    group.classList.toggle('is-selected', active);
    group.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  renderDetail();
  setDetailCollapsed(false);
  const record = state.layout?.byId.get(nodeId);
  if (record) els.srStatus.textContent = `已选择节点：${record.node.title ?? ''}`;
}

function buildField(label, value) {
  const wrapper = el('div', 'detail-field');
  wrapper.appendChild(el('span', 'detail-field-label', label));
  wrapper.appendChild(el('span', 'detail-field-value', value ?? '—'));
  return wrapper;
}

function buildCopyButton(label, text) {
  const button = el('button', 'btn btn-copy', label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    const ok = await copyText(text ?? '');
    showToast(ok ? `已复制${label.replace(/^复制/, '')}` : '复制失败，请手动选择文本', ok ? 'ok' : 'error');
  });
  return button;
}

function renderDetail() {
  const body = els.detailBody;
  body.replaceChildren();
  const record = state.selectedNodeId && state.layout
    ? state.layout.byId.get(state.selectedNodeId)
    : null;

  if (!record) {
    els.detailTitle.textContent = '节点详情';
    els.detailKind.textContent = '';
    body.appendChild(el('p', 'detail-empty', '在画布中点击任意节点查看详情。'));
    return;
  }

  const node = record.node;
  const type = TYPE_META[node.type] ? node.type : 'note';
  const meta = TYPE_META[type];

  els.detailTitle.textContent = '节点详情';
  els.detailKind.className = `detail-kind kind-${type}`;
  els.detailKind.textContent = meta.label;

  const heading = el('h3', 'detail-node-title', node.title || '(无标题)');
  body.appendChild(heading);

  const fields = el('div', 'detail-fields');
  fields.appendChild(buildField('类型', meta.label));
  if (node.action) fields.appendChild(buildField('分类', node.action));
  fields.appendChild(buildField('状态', node.status ? (STATUS_LABEL[node.status] || node.status) : '—'));
  fields.appendChild(buildField('耗时', formatDuration(node.durationMs) || '—'));
  fields.appendChild(buildField('时间', formatTime(node.ts) || '—'));
  if (node.channel) {
    fields.appendChild(buildField('内容', node.channel === 'thinking' ? '思考' : '文本'));
  }
  if (node.tool) fields.appendChild(buildField('工具', node.tool));
  body.appendChild(fields);

  if (type === 'execution') {
    // An execution node shows one complete line: the full command.
    const command = node.command || node.detail || '';
    body.appendChild(el('h4', 'detail-section-title', '完整命令'));
    body.appendChild(el('code', 'detail-command', command || '(无命令)'));
    body.appendChild(buildCopyButton('复制命令', command));

    if (node.output) {
      body.appendChild(el('h4', 'detail-section-title', '输出'));
      body.appendChild(el('pre', 'detail-pre detail-output', node.output));
    }
  } else if (type === 'scheme') {
    // A strategy node shows the strategy text as it was written.
    body.appendChild(el('h4', 'detail-section-title', '策略原文'));
    body.appendChild(el('pre', 'detail-pre', node.detail || '(无内容)'));
    body.appendChild(buildCopyButton('复制策略原文', node.detail || ''));

    // The concrete actions this layer produced.
    if (Array.isArray(node.actions) && node.actions.length) {
      body.appendChild(el('h4', 'detail-section-title', '产生的动作'));
      const list = el('ul', 'detail-actions');
      for (const action of node.actions) {
        const item = el('li', 'detail-action');
        item.appendChild(el('span', 'detail-action-kind', action.label || '执行'));
        item.appendChild(el('span', 'detail-action-title', action.title || ''));
        list.appendChild(item);
      }
      body.appendChild(list);
    }
  } else {
    body.appendChild(el('h4', 'detail-section-title', '详情'));
    body.appendChild(el('pre', 'detail-pre', node.detail || '(无内容)'));
    body.appendChild(buildCopyButton('复制原始内容', node.detail || ''));
  }
}

/* ------------------------------------------------------------------ */
/* detail panel collapse                                               */
/* ------------------------------------------------------------------ */
function setDetailCollapsed(collapsed) {
  els.layout.classList.toggle('detail-collapsed', collapsed);
  els.btnDetail.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  els.btnDetail.classList.toggle('is-collapsed', collapsed);
}

/* ------------------------------------------------------------------ */
/* data loading                                                        */
/* ------------------------------------------------------------------ */
function sortTurns(turns) {
  return turns.slice().sort((a, b) => (b.ts ?? b.updatedAt ?? 0) - (a.ts ?? a.updatedAt ?? 0));
}

async function refreshTurns(options) {
  const opts = options || {};
  try {
    const data = await fetchJSON('/api/turns');
    state.turns = sortTurns(Array.isArray(data?.turns) ? data.turns : []);
    state.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    state.workspace = data?.workspace ? String(data.workspace) : '';
    els.workspaceLabel.textContent = state.workspace;
    if (state.workspace) els.workspaceLabel.title = state.workspace;
    renderSidebar();
    await syncSelection(opts);
  } catch (err) {
    showCanvasMessage('无法读取回合列表', errorMessage(err), [
      { label: '重试', onClick: () => refreshTurns({ reloadTree: true }) },
    ]);
  }
}

/**
 * The workspaces the collector has seen.
 *
 * Every workspace the agent worked in is registered globally, so the viewer
 * can be pointed at any of them — not only the one the server was started in.
 */
async function refreshWorkspaces() {
  try {
    const data = await fetchJSON('/api/workspaces');
    applyWorkspaces(data);
  } catch {
    /* the switcher keeps the last known list */
  }
}

function applyWorkspaces(data) {
  if (!data) return;
  const list = Array.isArray(data.workspaces) ? data.workspaces : [];
  state.workspaces = list;
  if (typeof data.autoFollow === 'boolean') state.autoFollow = data.autoFollow;
  if (els.autoFollow) els.autoFollow.checked = state.autoFollow;

  const current = data.current ? String(data.current) : state.workspace;
  if (current) state.workspace = current;

  const select = els.workspaceSelect;
  if (!select) return;
  select.replaceChildren();
  for (const workspace of list) {
    const option = document.createElement('option');
    option.value = workspace.root;
    option.textContent = workspace.label || workspace.root;
    option.title = workspace.root;
    select.appendChild(option);
  }
  if (!select.options.length && current) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = current;
    select.appendChild(option);
  }
  if (current) select.value = current;

  if (els.workspaceLabel) {
    els.workspaceLabel.textContent = current;
    if (current) els.workspaceLabel.title = current;
  }
}

/**
 * A different workspace became the active one.
 *
 * The rounds that were already finished there are left behind: from here on
 * only the new and the still running ones are monitored.
 */
function onWorkspaceChanged(data) {
  if (!data) return;
  if (data.workspace) state.workspace = String(data.workspace);
  if (typeof data.autoFollow === 'boolean') {
    state.autoFollow = data.autoFollow;
    if (els.autoFollow) els.autoFollow.checked = state.autoFollow;
  }

  state.sinceTs = Date.now();
  state.onlyNew = true;
  if (els.onlyNew) els.onlyNew.checked = true;
  state.turns = [];
  state.selectedTurnId = null;
  state.selectedNodeId = null;
  state.tree = null;
  state.treeError = null;
  state.layout = null;
  state.followLatest = true;

  renderSidebar();
  renderDetail();
  renderCanvas();
  refreshTurns({ reloadTree: true });
  refreshWorkspaces();
}

/**
 * Keep the canvas and the selection in sync with the turn list.
 *
 * While the viewer follows the newest turn it also follows a new question:
 * the tree of the turn in progress is opened as soon as it exists, and its
 * nodes appear one by one while the agent works.
 */
async function syncSelection(options) {
  const opts = options || {};
  try {
    if (!state.turns.length) {
      state.selectedTurnId = null;
      state.selectedNodeId = null;
      state.tree = null;
      state.treeError = null;
      state.layout = null;
      renderDetail();
      renderCanvas();
      return;
    }
    const newest = state.turns[0]?.turnId ?? null;
    if (state.followLatest && newest && newest !== state.selectedTurnId) {
      await selectTurn(newest);
      return;
    }
    if (!state.selectedTurnId) {
      await selectTurn(state.turns[0].turnId);
      return;
    }
    if (opts.reloadTree) await loadTree();
  } catch (err) {
    showToast(`加载回合失败：${errorMessage(err)}`, 'error');
  }
}

async function selectTurn(turnId) {
  if (!turnId) return;
  state.selectedTurnId = turnId;
  state.selectedNodeId = null;
  state.tree = null;
  state.treeError = null;
  renderSidebar();
  renderDetail();
  renderCanvas();
  await loadTree();
}

async function loadTree() {
  const turnId = state.selectedTurnId;
  if (!turnId) return;
  try {
    const tree = await fetchJSON(`/api/tree?turn=${encodeURIComponent(turnId)}`);
    if (state.selectedTurnId !== turnId) return;
    state.tree = tree;
    state.treeError = null;
    state.layout = layoutTree(tree?.nodes);
    if (state.selectedNodeId && !state.layout.byId.has(state.selectedNodeId)) {
      state.selectedNodeId = null;
    }
    renderCanvas();
    renderDetail();
    updateTreeHint();
    requestAnimationFrame(() => {
      resetViewToRoot();
      updateLiveBadge();
    });
  } catch (err) {
    if (state.selectedTurnId !== turnId) return;
    state.tree = null;
    state.layout = null;
    state.treeError = errorMessage(err);
    renderCanvas();
    renderDetail();
    updateTreeHint();
    updateLiveBadge();
  }
}

/**
 * Show how long the agent has been working on the turn that is still running.
 *
 * A thinking block does not fire any hook, so the tree stays quiet while the
 * model works. This badge counts the wait up, so the user can see it.
 */
function updateLiveBadge() {
  const badge = els.liveBadge;
  if (!badge) return;
  const running = Boolean(state.tree?.running);
  if (!running) {
    badge.hidden = true;
    badge.textContent = '';
    return;
  }
  const since = typeof state.tree?.lastEventTs === 'number' ? state.tree.lastEventTs : null;
  badge.hidden = false;
  const elapsed = since === null ? '' : ` · 已等待 ${formatDuration(Math.max(0, Date.now() - since))}`;
  badge.textContent = `Agent 正在思考${elapsed}`;
}

function updateTreeHint() {
  const hint = state.treeError ? state.treeError : '';
  els.treeHint.textContent = hint;
  els.treeHint.hidden = !hint;
}

/* ------------------------------------------------------------------ */
/* toolbar actions                                                     */
/* ------------------------------------------------------------------ */
function exportTree(format) {
  if (!state.selectedTurnId) {
    showToast('请先选择一个回合', 'warn');
    return;
  }
  const url = `/api/export?turn=${encodeURIComponent(state.selectedTurnId)}`
    + `&format=${encodeURIComponent(format)}`;
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/* ------------------------------------------------------------------ */
/* toast / status                                                      */
/* ------------------------------------------------------------------ */
function showToast(message, kind) {
  els.toast.textContent = message;
  els.toast.className = `toast${kind ? ` toast-${kind}` : ''}`;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, kind === 'error' ? 9000 : 4500);
}

function setConnection(connected) {
  els.connIndicator.dataset.state = connected ? 'online' : 'offline';
  els.connText.textContent = connected ? '已连接' : '连接断开，重连中';
}

/* ------------------------------------------------------------------ */
/* server sent events                                                  */
/* ------------------------------------------------------------------ */
function parseEventData(event) {
  try {
    const raw = event && typeof event.data === 'string' ? event.data : event?.data;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function connectStream() {
  if (typeof EventSource === 'undefined') return;
  try {
    stream = new EventSource('/api/stream');
  } catch {
    setConnection(false);
    return;
  }
  stream.addEventListener('hello', (event) => {
    const data = parseEventData(event);
    if (data && data.workspace) state.workspace = String(data.workspace);
    if (data && typeof data.autoFollow === 'boolean') {
      state.autoFollow = data.autoFollow;
      if (els.autoFollow) els.autoFollow.checked = state.autoFollow;
    }
    setConnection(true);
  });
  stream.addEventListener('workspaces', (event) => {
    const data = parseEventData(event);
    if (!data) return;
    applyWorkspaces(data);
  });
  stream.addEventListener('workspace', (event) => {
    const data = parseEventData(event);
    if (!data) return;
    onWorkspaceChanged(data);
  });
  stream.addEventListener('turns', (event) => {
    const data = parseEventData(event);
    if (!data || !Array.isArray(data.turns)) return;
    state.turns = sortTurns(data.turns);
    renderSidebar();
    syncSelection();
  });
  stream.addEventListener('tree', (event) => {
    const data = parseEventData(event);
    if (!data || !data.tree) return;
    const turnId = data.turnId;
    const tree = data.tree;
    const row = state.turns.find((turn) => turn.turnId === turnId);
    if (row) {
      row.updatedAt = tree.updatedAt ?? row.updatedAt;
      row.nodeCount = Array.isArray(tree.nodes) ? tree.nodes.length : row.nodeCount;
      renderSidebar();
    }
    if (turnId === state.selectedTurnId) {
      state.tree = tree;
      state.treeError = null;
      state.layout = layoutTree(tree.nodes);
      if (state.selectedNodeId && !state.layout.byId.has(state.selectedNodeId)) {
        state.selectedNodeId = null;
      }
      renderCanvas();
      renderDetail();
      updateTreeHint();
      // The tree grows while the agent works; keep the root where it is
      // unless the user took over the viewport.
      if (!state.viewPinned) resetViewToRoot();
      updateLiveBadge();
    }
  });
  stream.onerror = () => setConnection(false);
  stream.onopen = () => setConnection(true);
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */
function bindCanvasInteraction() {
  els.svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
  }, { passive: false });

  els.svg.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    dragState = {
      x: event.clientX,
      y: event.clientY,
      tx: state.view.tx,
      ty: state.view.ty,
      moved: false,
    };
  });

  window.addEventListener('mousemove', (event) => {
    if (!dragState) return;
    const dx = event.clientX - dragState.x;
    const dy = event.clientY - dragState.y;
    if (!dragState.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragState.moved = true;
      els.canvasWrap.classList.add('is-panning');
    }
    if (!dragState.moved) return;
    state.view.tx = dragState.tx + dx;
    state.view.ty = dragState.ty + dy;
    state.viewPinned = true;
    applyView();
  });

  window.addEventListener('mouseup', () => {
    if (dragState) {
      suppressNextClick = dragState.moved;
      dragState = null;
    }
    els.canvasWrap.classList.remove('is-panning');
  });
}

function bindControls() {
  els.filterInput.addEventListener('input', (event) => {
    state.filterText = event.target.value ?? '';
    renderSidebar();
  });
  els.originLive.addEventListener('change', (event) => {
    state.originLive = Boolean(event.target.checked);
    renderSidebar();
  });
  els.originHistory.addEventListener('change', (event) => {
    state.originHistory = Boolean(event.target.checked);
    renderSidebar();
  });
  els.onlyNew.addEventListener('change', (event) => {
    state.onlyNew = Boolean(event.target.checked);
    // Turning it on keeps the rounds that are new or still running.
    state.sinceTs = state.onlyNew ? Date.now() : 0;
    renderSidebar();
  });

  els.workspaceSelect.addEventListener('change', async (event) => {
    const target = event.target.value;
    if (!target) return;
    try {
      const data = await fetchJSON('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target, follow: false }),
      });
      applyWorkspaces(data);
    } catch (err) {
      showToast(`切换工作区失败：${errorMessage(err)}`, 'error');
      await refreshWorkspaces();
    }
  });

  els.autoFollow.addEventListener('change', async (event) => {
    const enabled = Boolean(event.target.checked);
    try {
      const data = await fetchJSON('/api/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      state.autoFollow = data?.autoFollow !== false;
      els.autoFollow.checked = state.autoFollow;
      showToast(state.autoFollow ? '已开启自动跟随工作区' : '已关闭自动跟随工作区', 'ok');
    } catch (err) {
      showToast(`切换跟随状态失败：${errorMessage(err)}`, 'error');
    }
  });

  els.btnFit.addEventListener('click', () => fitToWindow());
  els.btnRefresh.addEventListener('click', () => refreshTurns({ reloadTree: true }));
  els.btnExportHtml.addEventListener('click', () => exportTree('html'));
  els.btnExportMd.addEventListener('click', () => exportTree('md'));
  els.btnDetail.addEventListener('click', () => {
    setDetailCollapsed(!els.layout.classList.contains('detail-collapsed'));
  });
}

function collectElements() {
  els = {
    layout: byId('layout'),
    workspaceLabel: byId('workspace-label'),
    workspaceSelect: byId('workspace-select'),
    autoFollow: byId('auto-follow'),
    connIndicator: byId('conn-indicator'),
    connText: byId('conn-text'),
    toast: byId('toast'),
    filterInput: byId('filter-input'),
    originLive: byId('origin-live'),
    originHistory: byId('origin-history'),
    onlyNew: byId('only-new'),
    turnCount: byId('turn-count'),
    turnList: byId('turn-list'),
    treeHint: byId('tree-hint'),
    btnFit: byId('btn-fit'),
    btnRefresh: byId('btn-refresh'),
    btnExportHtml: byId('btn-export-html'),
    btnExportMd: byId('btn-export-md'),
    btnDetail: byId('btn-detail'),
    zoomLabel: byId('zoom-label'),
    canvasWrap: byId('canvas-wrap'),
    canvasOverlay: byId('canvas-overlay'),
    liveBadge: byId('live-badge'),
    svg: byId('tree-svg'),
    detailPanel: byId('detail-panel'),
    detailTitle: byId('detail-title'),
    detailKind: byId('detail-kind'),
    detailBody: byId('detail-body'),
    srStatus: byId('sr-status'),
  };
}

function init() {
  collectElements();
  bindControls();
  bindCanvasInteraction();
  renderSidebar();
  connectStream();
  refreshTurns();
  refreshWorkspaces();
  // The waiting badge counts up while the agent works on a live turn.
  liveTimer = setInterval(updateLiveBadge, 1000);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
