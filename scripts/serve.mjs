#!/usr/bin/env node
/**
 * plugintree local viewer server.
 *
 * Serves the tree viewer over HTTP on the loopback interface and pushes live
 * updates over SSE. There is no model in this path: the collector writes the
 * tree, the server only watches it and broadcasts what changed.
 *
 *   node scripts/serve.mjs [--workspace <dir>] [--port <n>]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWorkspaceRoot, PLUGIN_ROOT } from './lib/paths.mjs';
import { listRegisteredWorkspaces, workspaceLabel } from './lib/registry.mjs';
import {
  listTrees,
  readTree,
  readConfig,
  writeConfig,
  readSessionEvents,
  listSessions,
  ensureDataLayout,
} from './lib/store.mjs';
import { partitionTurns } from './lib/tree.mjs';
import { treeToHtml, treeToMarkdown } from './lib/export.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(HERE, '..', 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function parseArgs(argv) {
  const args = { workspace: null, port: null };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--workspace' || flag === '-w') args.workspace = argv[++i];
    else if (flag === '--port' || flag === '-p') args.port = Number.parseInt(argv[++i], 10);
  }
  return args;
}

const args = parseArgs(process.argv);

/**
 * The workspace the viewer is currently looking at.
 *
 * The collector writes every workspace it sees into that workspace's own
 * `.plugintree/` folder, so the viewer can point at any of them. Switching is
 * explicit: the UI asks for it, or the server follows the workspace the agent
 * is actually working in.
 */
let currentWorkspace = resolveWorkspaceRoot(args.workspace);
let autoFollow = true;
ensureDataLayout(currentWorkspace);
let config = readConfig(currentWorkspace);

/** Connected SSE clients. */
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

/** Gather the raw events belonging to a turn. */
function collectTurnEvents(workspace, tree) {
  const sessionId = tree.sessionId;
  if (!sessionId) return [];
  const origin = tree.origin === 'history' ? 'history' : 'live';
  const events = readSessionEvents(workspace, sessionId, origin);
  const turns = partitionTurns(events);
  const turn = turns.find((t) => t.turnId === tree.turnId);
  return turn ? turn.events : events.filter((e) => e.turn === tree.turnId);
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/** The workspace list as the UI needs it. */
function workspacePayload() {
  let workspaces = [];
  try {
    workspaces = listRegisteredWorkspaces();
  } catch {
    workspaces = [];
  }
  // A workspace that is gone (a temporary folder, an unmounted disk) is not
  // worth offering.
  workspaces = workspaces.filter((w) => {
    try {
      return fs.existsSync(w.root);
    } catch {
      return false;
    }
  });
  // The workspace being viewed always shows up, even before it was ever
  // registered by a hook.
  if (!workspaces.some((w) => sameRoot(w.root, currentWorkspace))) {
    workspaces.unshift({
      root: currentWorkspace,
      label: workspaceLabel(currentWorkspace),
      firstSeen: null,
      lastSeen: null,
      lastEventTs: null,
    });
  }
  return { workspaces, current: currentWorkspace, autoFollow };
}

function sameRoot(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Point the viewer at another workspace.
 *
 * The turn list and the tree of the new workspace are pushed right away, so
 * the page shows the new workspace without a reload.
 */
function switchWorkspace(next, reason) {
  const resolved = path.resolve(next);
  if (sameRoot(resolved, currentWorkspace)) return false;
  currentWorkspace = resolved;
  try {
    ensureDataLayout(resolved);
    config = readConfig(resolved);
  } catch {
    /* an unreadable workspace simply shows an empty list */
  }
  seenTrees.clear();
  firstPoll = true;
  poll.signature = '';
  broadcast('workspace', {
    workspace: currentWorkspace,
    reason: reason || 'manual',
    autoFollow,
    at: Date.now(),
  });
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;
  // The workspace can change while a request is in flight, so each request
  // works against the workspace it was routed to.
  const ws = currentWorkspace;

  try {
    if (route === '/' || route === '/index.html') {
      serveStatic(res, path.join(UI_DIR, 'index.html'));
      return;
    }
    if (route === '/app.js' || route === '/style.css') {
      serveStatic(res, path.join(UI_DIR, route.slice(1)));
      return;
    }

    if (route === '/api/workspaces') {
      sendJson(res, 200, workspacePayload());
      return;
    }

    if (route === '/api/workspace') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const target = body.path || body.workspace || body.root;
        if (!target) {
          sendJson(res, 400, { error: 'path is required' });
          return;
        }
        const resolved = path.resolve(String(target));
        if (!fs.existsSync(resolved)) {
          sendJson(res, 404, { error: `workspace not found: ${resolved}` });
          return;
        }
        // An explicit choice wins over following the agent elsewhere.
        if (body.follow === false) autoFollow = false;
        switchWorkspace(resolved, 'manual');
        sendJson(res, 200, workspacePayload());
        return;
      }
      sendJson(res, 200, workspacePayload());
      return;
    }

    if (route === '/api/follow') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        autoFollow = body.enabled !== false;
        sendJson(res, 200, workspacePayload());
        return;
      }
      sendJson(res, 200, { autoFollow });
      return;
    }

    if (route === '/api/turns') {
      const turns = listTrees(ws);
      const sessions = listSessions(ws);
      sendJson(res, 200, { turns, sessions, workspace: ws });
      return;
    }

    if (route === '/api/tree') {
      const turnId = url.searchParams.get('turn');
      if (!turnId) {
        sendJson(res, 400, { error: 'turn is required' });
        return;
      }
      const tree = readTree(ws, turnId);
      if (!tree) {
        sendJson(res, 404, { error: 'tree not found' });
        return;
      }
      sendJson(res, 200, tree);
      return;
    }

    if (route === '/api/events') {
      const turnId = url.searchParams.get('turn');
      const tree = readTree(ws, turnId);
      if (!tree) {
        sendJson(res, 404, { error: 'tree not found' });
        return;
      }
      sendJson(res, 200, { events: collectTurnEvents(ws, tree) });
      return;
    }

    if (route === '/api/config') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        config = writeConfig(ws, body);
        sendJson(res, 200, config);
        return;
      }
      sendJson(res, 200, config);
      return;
    }

    if (route === '/api/export') {
      const turnId = url.searchParams.get('turn');
      const format = url.searchParams.get('format') || 'html';
      const tree = readTree(ws, turnId);
      if (!tree) {
        sendJson(res, 404, { error: 'tree not found' });
        return;
      }
      const stamp = String(tree.ts ?? Date.now());
      if (format === 'md') {
        const markdown = treeToMarkdown(tree);
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="plugintree-${stamp}.md"`,
        });
        res.end(markdown);
        return;
      }
      const html = treeToHtml(tree);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="plugintree-${stamp}.html"`,
      });
      res.end(html);
      return;
    }

    if (route === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({
        workspace: currentWorkspace,
        autoFollow,
      })}\n\n`);
      clients.add(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(': keep-alive\n\n');
        } catch {
          /* ignore */
        }
      }, 20000);
      req.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (error) {
    sendJson(res, 500, { error: String(error?.message ?? error) });
  }
});

/**
 * Poll the data directory so the viewer reflects live captures.
 * A tree whose content changed is pushed straight to the page.
 */
const seenTrees = new Map();
let firstPoll = true;
function poll() {
  // The registry tells the viewer which other workspaces exist and which one
  // the agent is working in right now.
  let workspaces = [];
  try {
    workspaces = listRegisteredWorkspaces();
  } catch {
    workspaces = [];
  }
  const workspaceSignature = workspaces
    .map((w) => `${w.root}:${w.lastEventTs ?? 0}:${w.lastSeen ?? 0}`)
    .join('|');
  if (workspaceSignature !== poll.workspaceSignature) {
    poll.workspaceSignature = workspaceSignature;
    broadcast('workspaces', workspacePayload());
  }

  // Following moves the viewer to the workspace with the newest activity.
  if (autoFollow && workspaces.length) {
    const active = workspaces.find((w) => (w.lastEventTs ?? 0) > 0);
    const current = workspaces.find((w) => sameRoot(w.root, currentWorkspace));
    const currentTs = current?.lastEventTs ?? 0;
    if (active && (active.lastEventTs ?? 0) > currentTs && !sameRoot(active.root, currentWorkspace)) {
      // Never jump to a workspace that is not there any more.
      let alive = false;
      try {
        alive = fs.existsSync(active.root);
      } catch {
        alive = false;
      }
      if (alive) switchWorkspace(active.root, 'auto');
    }
  }

  let turns = [];
  try {
    turns = listTrees(currentWorkspace);
  } catch {
    return;
  }

  const signature = turns.map((t) => `${t.turnId}:${t.updatedAt ?? 0}`).join('|');
  if (signature !== poll.signature) {
    poll.signature = signature;
    broadcast('turns', { turns });
  }

  for (const turn of turns) {
    const stamp = turn.updatedAt ?? 0;
    if (seenTrees.get(turn.turnId) === stamp) continue;
    seenTrees.set(turn.turnId, stamp);
    // The first sweep only seeds the cache; the page already loads the trees.
    if (firstPoll) continue;
    const tree = readTree(currentWorkspace, turn.turnId);
    if (tree) broadcast('tree', { turnId: turn.turnId, tree });
  }
  firstPoll = false;
}
poll.signature = '';
poll.workspaceSignature = '';

function listen(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

const desiredPort = Number.isFinite(args.port) ? args.port : config.port ?? 47731;
let actualPort = desiredPort;
try {
  actualPort = await listen(desiredPort);
} catch {
  actualPort = await listen(0);
}

const url = `http://127.0.0.1:${actualPort}/`;
process.stdout.write(`${JSON.stringify({
  ok: true,
  url,
  port: actualPort,
  workspace: currentWorkspace,
  pluginRoot: PLUGIN_ROOT,
})}\n`);

poll();
const timer = setInterval(poll, 800);

function shutdown() {
  clearInterval(timer);
  for (const res of clients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
