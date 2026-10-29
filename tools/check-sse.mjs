#!/usr/bin/env node
/**
 * Verify the SSE push path: connect to /api/stream, touch a stored tree so the
 * collector would have rewritten it, and confirm the server pushes the change.
 *
 *   node tools/check-sse.mjs [--port 47731] [--turn <turnId>]
 */
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : 47731);
const turnIndex = process.argv.indexOf('--turn');
const turnId = turnIndex !== -1 ? process.argv[turnIndex + 1] : null;

const base = `http://127.0.0.1:${port}`;
const received = [];

const controller = new AbortController();
const response = await fetch(`${base}/api/stream`, {
  headers: { Accept: 'text/event-stream' },
  signal: controller.signal,
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

const pump = (async () => {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      // eslint-disable-next-line no-cond-assign
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = chunk.match(/^event:\s*(.+)$/m);
        const data = chunk.match(/^data:\s*(.+)$/m);
        if (!event) continue;
        received.push({ event: event[1].trim(), data: data ? data[1] : '' });
      }
    }
  } catch {
    /* aborted */
  }
})();

await new Promise((r) => setTimeout(r, 800));

const listing = await (await fetch(`${base}/api/turns`)).json();
const workspace = listing.workspace;
const turns = listing.turns ?? [];
const candidate = turnId
  ? turns.find((t) => t.turnId === turnId)
  : (turns.find((t) => t.origin === 'live') || turns[0]);

if (!candidate || !workspace) {
  process.stdout.write('no turn available\n');
  controller.abort();
  process.exit(1);
}

const safeName = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'unknown';
const treeFile = path.join(workspace, '.plugintree', 'trees', `${safeName(candidate.turnId)}.json`);

if (!fs.existsSync(treeFile)) {
  process.stdout.write(`tree file not found: ${treeFile}\n`);
  controller.abort();
  process.exit(1);
}

const tree = JSON.parse(fs.readFileSync(treeFile, 'utf8'));
tree.updatedAt = Date.now();
const tmp = `${treeFile}.check.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(tree, null, 2)}\n`, 'utf8');
fs.renameSync(tmp, treeFile);
process.stdout.write(`touched ${candidate.turnId}\n`);

await new Promise((r) => setTimeout(r, 4000));
controller.abort();
await pump;

const names = received.map((r) => r.event);
process.stdout.write(`events received: ${names.join(', ')}\n`);
const hasHello = names.includes('hello');
const hasTree = names.includes('tree');
process.stdout.write(`hello push: ${hasHello ? 'yes' : 'no'}\n`);
process.stdout.write(`tree push: ${hasTree ? 'yes' : 'no'}\n`);
process.exit(hasHello && hasTree ? 0 : 1);
