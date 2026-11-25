/* Spaner server — serves the game and hosts private online tables.
 * No dependencies: plain Node http + Server-Sent Events. The server owns the clock,
 * spawns and rules for online games (the same engine the browser uses).
 *
 *   PORT=3000 node server.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const E = require('./public/engine.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const MAX_ROOMS = 5000;
const IDLE_MS = 30 * 60 * 1000;      // drop rooms nobody is watching after 30 min
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** @type {Map<string, any>} */
const rooms = new Map();

const newToken = () => crypto.randomBytes(16).toString('hex');
function newRoomId() {
  let id;
  do { id = Array.from(crypto.randomBytes(6), b => ALPHA[b % ALPHA.length]).join(''); } while (rooms.has(id));
  return id;
}
function cleanName(v, fallback) {
  const s = typeof v === 'string' ? v.replace(/[^\p{L}\p{N} _.\-']/gu, '').trim().slice(0, 16) : '';
  return s || fallback;
}
const sqArg = v => (Number.isInteger(v) && v >= 0 && v < 64 ? v : -1);

function seatOf(room, token) {
  if (!token) return null;
  if (room.seats.w && room.seats.w.token === token) return 'w';
  if (room.seats.b && room.seats.b.token === token) return 'b';
  return null;
}
function isOnline(room, c) {
  for (const cl of room.clients) if (seatOf(room, cl.token) === c) return true;
  return false;
}
function seatInfo(room) {
  const one = c => (room.seats[c] ? { name: room.seats[c].name, online: isOnline(room, c) } : null);
  return { w: one('w'), b: one('b') };
}
function maybeStart(room) {
  if (room.match.phase === 'ready' && room.seats.w && room.seats.b) room.match.start(Date.now(), 3000);
}

function send(cl, payload) {
  try { cl.res.write('data: ' + payload + '\n\n'); } catch (e) { /* client went away */ }
}
function broadcast(room) {
  if (!room.clients.size) return;
  const base = { now: Date.now(), room: room.id, seats: seatInfo(room), rematch: room.rematch, match: room.match.snapshot() };
  for (const cl of room.clients) {
    base.you = seatOf(room, cl.token);
    send(cl, JSON.stringify(base));
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function readBody(req) {
  return new Promise(resolve => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 16 * 1024) { req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') || {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// ---- API ---------------------------------------------------------------------
async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/health') return json(res, 200, { ok: true, rooms: rooms.size });

  if (p === '/api/rooms' && req.method === 'POST') {
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'The server is full right now. Try again later.' });
    const body = await readBody(req);
    const color = body.color === 'w' || body.color === 'b' ? body.color : (Math.random() < 0.5 ? 'w' : 'b');
    const id = newRoomId();
    const token = newToken();
    const room = {
      id,
      seats: { w: null, b: null },
      match: new E.Match(),
      clients: new Set(),
      rematch: { w: false, b: false },
      created: Date.now(),
      active: Date.now(),
    };
    room.seats[color] = { token, name: cleanName(body.name, color === 'w' ? 'White' : 'Black') };
    rooms.set(id, room);
    return json(res, 200, { room: id, token, color });
  }

  const m = p.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/(join|stream|action)$/);
  if (!m) return json(res, 404, { error: 'Not found.' });
  const room = rooms.get(m[1].toUpperCase());
  if (!room) return json(res, 404, { error: 'That table does not exist or has closed.' });
  room.active = Date.now();
  const op = m[2];

  if (op === 'join' && req.method === 'POST') {
    const body = await readBody(req);
    const seat = seatOf(room, body.token);
    if (seat) {
      if (body.name) room.seats[seat].name = cleanName(body.name, room.seats[seat].name);
      broadcast(room);
      return json(res, 200, { room: room.id, token: body.token, color: seat });
    }
    const free = !room.seats.w ? 'w' : !room.seats.b ? 'b' : null;
    if (!free) return json(res, 200, { room: room.id, token: null, color: null, spectator: true });
    const token = newToken();
    room.seats[free] = { token, name: cleanName(body.name, free === 'w' ? 'White' : 'Black') };
    maybeStart(room);
    broadcast(room);
    return json(res, 200, { room: room.id, token, color: free });
  }

  if (op === 'stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const cl = { res, token: url.searchParams.get('token') || '' };
    room.clients.add(cl);
    broadcast(room);
    req.on('close', () => {
      room.clients.delete(cl);
      room.active = Date.now();
      broadcast(room);
    });
    return undefined;
  }

  if (op === 'action' && req.method === 'POST') {
    const body = await readBody(req);
    const seat = seatOf(room, body.token);
    if (!seat) return json(res, 403, { error: 'You are not seated at this table.' });
    const now = Date.now();
    const match = room.match;
    let r = { ok: true };
    switch (body.type) {
      case 'move': {
        const promo = E.PROMOS.indexOf(body.promo) >= 0 ? body.promo : null;
        r = match.move(seat, { from: sqArg(body.from), to: sqArg(body.to), promo }, now);
        break;
      }
      case 'place':
        r = match.place(seat, sqArg(body.sq), now);
        break;
      case 'resign':
        r = match.resign(seat, now);
        break;
      case 'rematch':
        if (match.phase !== 'over') { r = { ok: false, error: 'The game is still running.' }; break; }
        room.rematch[seat] = true;
        if (room.rematch.w && room.rematch.b) {
          const w = room.seats.w;
          room.seats.w = room.seats.b; // swap colours for the next game
          room.seats.b = w;
          room.match = new E.Match();
          room.rematch = { w: false, b: false };
          maybeStart(room);
        }
        break;
      default:
        r = { ok: false, error: 'Unknown action.' };
    }
    broadcast(room);
    return json(res, r.ok ? 200 : 400, r);
  }

  return json(res, 405, { error: 'Method not allowed.' });
}

// ---- static files ------------------------------------------------------------
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return json(res, 400, { error: 'Bad request.' }); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Forbidden.' });
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
  return undefined;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error.' });
    else res.end();
  }
});

// Clocks and spawns run on the server for online games.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const ph = room.match.phase;
    if ((ph === 'countdown' || ph === 'play') && room.match.tick(now)) broadcast(room);
  }
}, 100);

// Keep SSE connections alive through proxies, and drop abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    for (const cl of room.clients) { try { cl.res.write(': ping\n\n'); } catch (e) { /* ignore */ } }
    const idle = !room.clients.size && now - room.active > IDLE_MS;
    if (idle || now - room.created > MAX_AGE_MS) {
      for (const cl of room.clients) { try { cl.res.end(); } catch (e) { /* ignore */ } }
      rooms.delete(id);
    }
  }
}, 20000);

server.listen(PORT, HOST, () => {
  console.log('\n  Spaner is running\n');
  console.log('  Local:    http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log('  Network:  http://' + a.address + ':' + PORT + '   (friends on the same Wi-Fi)');
    }
  }
  console.log('');
});

const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
