'use strict';
// Puente TV <-> celular/PC. La TV y los mandos se conectan hacia afuera por WebSocket,
// así no hay que abrir puertos en la casa.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const TOKEN = process.env.TOKEN || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
if (TOKEN.length < 8) {
  console.error('Define TOKEN (mín. 8 caracteres). Ej: TOKEN=$(openssl rand -hex 16) node server.js');
  process.exit(1);
}

const sameToken = (t) => {
  const a = Buffer.from(String(t || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ---- Biblioteca de clases (persistente) ----
let db = { library: [] };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* primera vez */ }
if (!Array.isArray(db.library)) db.library = [];
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

// ---- Estado ----
let tv = null;                 // socket de la TV (uno solo)
let lastState = {};
const ctls = new Set();        // mandos conectados
const watchers = new Set();    // mandos que piden ver la pantalla

const FORWARD = new Set(['open', 'nav', 'media', 'move', 'click', 'scroll', 'text', 'key', 'volume', 'ua']);

const sendJson = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (obj) => ctls.forEach((c) => sendJson(c, obj));
const sendTv = (obj) => { if (tv && tv.readyState === 1) { tv.send(JSON.stringify(obj)); return true; } return false; };
const updateWatch = () => sendTv({ type: 'watch', on: watchers.size > 0 });

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(u)) return 'https://' + u;
  return 'https://www.google.com/search?q=' + encodeURIComponent(u);
}

// ---- HTTP ----
const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
  if (sameToken(t)) return next();
  res.status(401).json({ error: 'unauthorized' });
};

// Para automatizar desde el PC: curl -H "Authorization: Bearer TOKEN" -d '{"url":"..."}' .../api/open
app.post('/api/open', auth, (req, res) => {
  const url = normalizeUrl(req.body && req.body.url);
  if (!url) return res.status(400).json({ error: 'url requerida' });
  res.json({ ok: sendTv({ type: 'open', url }), url });
});
app.post('/api/cmd', auth, (req, res) => {
  const msg = req.body || {};
  if (!FORWARD.has(msg.type)) return res.status(400).json({ error: 'tipo no permitido' });
  res.json({ ok: sendTv(msg) });
});
app.get('/api/state', auth, (req, res) => res.json({ tv: !!tv, state: lastState }));
app.get('/api/library', auth, (req, res) => res.json(db.library));
app.post('/api/library', auth, (req, res) => {
  const url = normalizeUrl(req.body && req.body.url);
  if (!url) return res.status(400).json({ error: 'url requerida' });
  const item = { id: crypto.randomUUID(), title: String(req.body.title || url).slice(0, 120), url };
  db.library.push(item); save(); broadcast({ type: 'library', items: db.library });
  res.json(item);
});
app.delete('/api/library/:id', auth, (req, res) => {
  db.library = db.library.filter((i) => i.id !== req.params.id);
  save(); broadcast({ type: 'library', items: db.library });
  res.json({ ok: true });
});

// ---- WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch { return socket.destroy(); }
  if (u.pathname !== '/ws' || !sameToken(u.searchParams.get('token'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.role = u.searchParams.get('role') === 'tv' ? 'tv' : 'ctl';
    wss.emit('connection', ws);
  });
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (ws.role === 'tv') {
    if (tv && tv !== ws) tv.terminate();
    tv = ws;
    broadcast({ type: 'tv', online: true });
    updateWatch();
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'state') { lastState = m; broadcast(m); }
      else if (m.type === 'frame') { watchers.forEach((c) => sendJson(c, m)); }
    });
    ws.on('close', () => {
      if (tv === ws) { tv = null; lastState = {}; broadcast({ type: 'tv', online: false }); }
    });
    return;
  }

  ctls.add(ws);
  sendJson(ws, { type: 'hello', tv: !!tv, state: lastState, library: db.library });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case 'watch':
        if (m.on) watchers.add(ws); else watchers.delete(ws);
        return updateWatch();
      case 'lib:add': {
        const url = normalizeUrl(m.url);
        if (!url) return;
        db.library.push({ id: crypto.randomUUID(), title: String(m.title || url).slice(0, 120), url });
        save(); return broadcast({ type: 'library', items: db.library });
      }
      case 'lib:del':
        db.library = db.library.filter((i) => i.id !== m.id);
        save(); return broadcast({ type: 'library', items: db.library });
      default:
        if (!FORWARD.has(m.type)) return;
        if (m.type === 'open') m.url = normalizeUrl(m.url);
        if (!sendTv(m)) sendJson(ws, { type: 'error', error: 'tv_offline' });
    }
  });
  ws.on('close', () => { ctls.delete(ws); watchers.delete(ws); updateWatch(); });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log(`TV Remote server en :${PORT}`));
