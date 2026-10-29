import fs from 'node:fs';
import path from 'node:path';

/** Read a JSONL file into an array, skipping malformed lines. */
export function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a partially flushed line */
    }
  }
  return out;
}

/** Append one JSON record to a JSONL file, creating parent dirs as needed. */
export function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically (temp file + rename) so readers never see a partial file. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function fileExists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Collapse whitespace and cut to `max` characters. */
export function truncate(text, max = 200) {
  if (text === null || text === undefined) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/** First meaningful line of a text block, cut to `max` characters. */
export function firstLine(text, max = 120) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return truncate(lines[0] ?? '', max);
}

/** Strip characters that are unsafe in a file name. */
export function safeName(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'unknown';
}

/** Current epoch milliseconds. */
export function now() {
  return Date.now();
}

/**
 * Normalise a timestamp to epoch milliseconds.
 *
 * The hook transcript writes ISO strings while the hook payload writes epoch
 * numbers, so every timestamp has to be converted before it can be compared
 * or subtracted. Returns null when the value carries no usable time.
 */
export function toEpochMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
