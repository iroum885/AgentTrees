import path from 'node:path';

import { relativePath } from './labels.mjs';
import { truncate } from './util.mjs';

/**
 * Decision evidence.
 *
 * Two questions the viewer asks about every action:
 *
 *   1. Why was this action taken?      -> the agent's own words: the sentence
 *                                         of its reasoning that names the
 *                                         action's subject, or the one-line
 *                                         intent it spoke before acting.
 *   2. Which piece of information decided it?
 *                                      -> the concrete line that pointed at
 *                                         it: a grep hit, a path in a file
 *                                         listing, a line of the user
 *                                         request.
 *
 * No model is involved: every answer is read out of the recorded transcript
 * by fixed rules, so the same tree always yields the same wording.
 */

/** Words that mark a sentence as an intention rather than an observation. */
const INTENT_MARKERS =
  /\b(let me|let's|now|next|first|then|should|need to|want to|going to|to find|to check|to read|to see|to look)\b|先|再|然后|接下来|需要|应该|打算|准备|为了|现在|下一步/i;

/** How long a "why" may get before it is cut. */
const WHY_MAX = 180;

/** How long a piece of deciding evidence may get. */
const BASIS_MAX = 200;

/* ------------------------------------------------------------------ */
/* text helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Split text into sentences.
 *
 * Chinese terminators always end a sentence; a Latin one only does so when
 * a space or the end of the text follows, so `app.js` stays in one piece.
 */
export function splitSentences(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A bullet or a heading is one unit on its own.
    if (/^(?:[-*>#]|\d+[.)])\s/.test(trimmed)) {
      out.push(trimmed);
      continue;
    }
    out.push(...splitByTerminator(trimmed));
  }
  return out;
}

function splitByTerminator(text) {
  const out = [];
  const re = /[。！？；]|[.!?](?=\s|$)/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    const piece = text.slice(last, match.index + match[0].length).trim();
    if (piece) out.push(piece);
    last = match.index + match[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) out.push(tail);
  return out;
}

/** Split text into non-empty lines. */
export function splitLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Case-insensitive "does the haystack contain the needle". */
function containsToken(haystack, needle) {
  if (!needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Does the line talk about this target?
 *
 * A bare file name has to match as a whole name: `tree.mjs` may sit in
 * `scripts\lib\tree.mjs`, but not in `show-tree.mjs`.
 */
function matchesTarget(line, target) {
  if (!containsToken(line, target.text)) return false;
  if (!target.word) return true;
  return matchesAsFileName(line, target.text);
}

/** Find the target in the line as a stand-alone file name. */
function matchesAsFileName(line, needle) {
  const haystack = line.toLowerCase();
  const wanted = needle.toLowerCase();
  const beforeOk = /[\s"'`([{=,:;>|\\/]/;
  const afterBad = /[A-Za-z0-9_.\-/\\]/;
  let index = haystack.indexOf(wanted);
  while (index !== -1) {
    const before = index === 0 ? '' : line[index - 1];
    const after = line[index + needle.length] ?? '';
    const leftOk = before === '' || beforeOk.test(before);
    const rightOk = after === '' || !afterBad.test(after);
    if (leftOk && rightOk) return true;
    index = haystack.indexOf(wanted, index + 1);
  }
  return false;
}

/**
 * Pull the readable text out of a stored tool output.
 *
 * A tool response is stored as JSON, so its payload sits in
 * `content[].text`. Three shapes have to be handled:
 *
 *   - a complete JSON envelope - the usual case;
 *   - an envelope that was cut short by the size limit - the JSON no longer
 *     parses, so the text value is taken as far as it goes;
 *   - a payload that was encoded twice - the text itself is another JSON
 *     envelope, so it is unwrapped again.
 *
 * The result is always plain text with real line breaks, so a line of output
 * can be pointed at.
 */
export function extractOutputText(output) {
  if (!output) return '';
  let raw = String(output);
  for (let depth = 0; depth < 4; depth += 1) {
    const next = unwrapOnce(raw, depth === 0);
    if (next === null) break;
    raw = next;
  }
  return raw;
}

/**
 * One unwrapping step.
 *
 * `tolerant` allows the cut-short case, where only the start of the text
 * value is left. It is switched off for deeper levels so that the *content*
 * of a file is never mistaken for an envelope.
 */
function unwrapOnce(raw, tolerant) {
  const trimmed = raw.trim();
  if (/^[{[]/.test(trimmed) || trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        // Encoded twice: the payload is another JSON document.
        return unwrapOnce(parsed, false);
      }
      if (parsed && typeof parsed === 'object') {
        const chunks = collectChunks(parsed);
        if (chunks.length) return chunks.join('\n');
      }
      return null;
    } catch {
      /* truncated or not JSON - fall through to the raw scan */
    }
  }
  if (!tolerant) return null;
  // The JSON was cut short: take the text value as far as it goes.
  const embedded = raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (embedded) return unescapeJsonString(embedded[1]);
  return null;
}

/** The readable chunks of a parsed output envelope. */
function collectChunks(parsed) {
  const chunks = [];
  if (Array.isArray(parsed.content)) {
    for (const block of parsed.content) {
      if (block && typeof block.text === 'string') chunks.push(block.text);
      else if (block && typeof block.content === 'string') chunks.push(block.content);
    }
  }
  for (const key of ['stdout', 'stderr', 'text', 'output']) {
    if (typeof parsed[key] === 'string') chunks.push(parsed[key]);
  }
  return chunks;
}

function unescapeJsonString(text) {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/* ------------------------------------------------------------------ */
/* the subject of an action                                           */
/* ------------------------------------------------------------------ */

function pickString(input, keys) {
  if (!input || typeof input !== 'object') return '';
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/**
 * The strings that identify what an action is about.
 *
 * A "strong" target is a path: when it shows up in a line of output, that
 * line really is about this action. A "weak" target is a bare name or a
 * search pattern: it points at the action, but a line could also mention it
 * in passing.
 */
export function actionTargets(tool, input, workspaceRoot) {
  const targets = [];
  const add = (value, strong, word = false) => {
    const text = String(value ?? '').trim();
    if (!text || text.length < 3) return;
    if (targets.some((target) => target.text === text)) return;
    targets.push({ text, strong, word });
  };

  const file = pickString(input, ['file_path', 'path', 'filePath', 'notebook_path', 'file']);
  if (file) {
    const relative = relativePath(file, workspaceRoot);
    const windows = relative;
    const posix = relative.replace(/\\/g, '/');
    const bareWindows = windows.replace(/^\.[\\/]/, '');
    const barePosix = posix.replace(/^\.\//, '');
    add(windows, true);
    add(posix, true);
    add(bareWindows, true, !/[\\/]/.test(bareWindows));
    add(barePosix, true, !/[\\/]/.test(barePosix));
    // The bare name is the weakest hint: it has to match as a whole name.
    add(path.basename(windows), false, true);
  }

  const pattern = pickString(input, ['pattern', 'query', 'regex']);
  if (pattern) {
    for (const alternative of String(pattern).split('|')) {
      add(alternative, false);
      // A regex written as `node\.detail` shows up in the output as
      // `node.detail`, so the escaped form is searched too.
      add(alternative.replace(/\\([.*+?^${}()|[\]\\])/g, '$1'), false);
    }
  }

  const url = pickString(input, ['url']);
  if (url) {
    add(url, true);
    add(url.replace(/^https?:\/\//, ''), false);
  }

  const query = pickString(input, ['query', 'question']);
  if (query) {
    for (const word of String(query).split(/\s+/)) {
      if (word.length >= 4) add(word, false);
    }
  }

  const command = pickString(input, ['command', 'script', 'cmd']);
  if (command) {
    for (const match of String(command).matchAll(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g)) {
      const full = match[0];
      add(full, true);
      const tail = full.split(/[\\/]/).slice(-2).join('\\');
      add(tail, true);
      add(path.basename(full), false, true);
    }
  }

  const skillName = pickString(input, ['name', 'skill', 'skill_name']);
  if (skillName) add(skillName, true);

  const mcpTool = pickString(input, ['tool', 'tool_name']);
  if (mcpTool) add(mcpTool, false);

  return targets;
}

/* ------------------------------------------------------------------ */
/* why                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The agent's own explanation of the action.
 *
 * The reasoning already says why, so the answer is the sentence of it that
 * names the action's subject. The wordings are tried in this order:
 *
 *   1. a sentence that both names the subject and states an intention;
 *   2. the one-line intent the agent spoke before acting;
 *   3. a sentence that names the subject, even without intent wording;
 *   4. the opening sentence of the reasoning.
 */
export function deriveWhy({ thinking = '', spoken = '', targets = [] } = {}) {
  const thought = splitSentences(thinking).map((text) => ({
    text,
    // A question the agent asked itself ("Let me use the skill?") is not a
    // statement of what it is about to do.
    intent: INTENT_MARKERS.test(text) && !/[?？]\s*$/.test(text.trim()),
    channel: 'thinking',
  }));
  const said = splitSentences(spoken)
    .map((text) => ({ text, intent: true, channel: 'spoken' }));

  const hitsOf = (sentence) => {
    let hits = 0;
    for (const target of targets) {
      if (!matchesTarget(sentence.text, target)) continue;
      hits += target.strong ? 2 : 1;
    }
    return hits;
  };
  // Naming the subject wins; inside one wording the later sentence wins,
  // because it was the thought that was live when the action ran.
  const better = (candidate, current) => {
    if (!current) return true;
    if (candidate.hits !== current.hits) return candidate.hits > current.hits;
    if (candidate.channel !== current.channel) return candidate.channel === 'thinking';
    return true;
  };

  let best = null;
  for (const sentence of [...thought, ...said]) {
    const hits = hitsOf(sentence);
    if (!hits || !sentence.intent) continue;
    const candidate = { ...sentence, hits };
    if (better(candidate, best)) best = candidate;
  }
  if (best) return truncate(best.text, WHY_MAX);

  if (said.length) return truncate(said[0].text, WHY_MAX);

  best = null;
  for (const sentence of thought) {
    const hits = hitsOf(sentence);
    if (!hits) continue;
    const candidate = { ...sentence, hits };
    if (better(candidate, best)) best = candidate;
  }
  if (best) return truncate(best.text, WHY_MAX);

  const fallback = thought.find((sentence) => sentence.intent) ?? thought[0] ?? said[0] ?? null;
  return fallback ? truncate(fallback.text, WHY_MAX) : '';
}

/* ------------------------------------------------------------------ */
/* the deciding piece of information                                   */
/* ------------------------------------------------------------------ */

/**
 * The line that decided the action.
 *
 * Sources arrive in order of proximity to the decision: the output of the
 * action that ran just before, then the outputs of the actions before that,
 * and last the user request. The first source that carries a hit wins, and
 * inside one source a line holding a strong target (a path) beats a line
 * holding only a weak one (a bare name).
 */
export function deriveBasis({ targets = [], sources = [] } = {}) {
  if (!sources.length) return null;

  for (const source of sources) {
    const hit = matchLine(source.lines, targets, true)
      ?? matchLine(source.lines, targets, false);
    if (hit) {
      return {
        text: truncate(hit, BASIS_MAX),
        kind: source.kind ?? 'execution',
        label: source.label ?? '',
        nodeId: source.nodeId ?? null,
      };
    }
  }

  // Nothing in the recorded output names the action: the request itself is
  // then the information that decided it.
  const request = sources.find((source) => source.kind === 'question');
  if (!request) return null;
  const sentences = splitSentences((request.lines ?? []).join('\n'));
  if (!sentences.length) return null;
  let best = sentences[0];
  let bestHits = 0;
  for (const sentence of sentences) {
    let hits = 0;
    for (const target of targets) {
      if (target.strong) continue;
      if (matchesTarget(sentence, target)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = sentence;
    }
  }
  return {
    text: truncate(best, BASIS_MAX),
    kind: 'question',
    label: request.label ?? '用户提问',
    nodeId: request.nodeId ?? null,
  };
}

function matchLine(lines, targets, strong) {
  if (!Array.isArray(lines)) return null;
  for (const line of lines) {
    for (const target of targets) {
      if (target.strong !== strong) continue;
      if (matchesTarget(line, target)) return line;
    }
  }
  return null;
}
