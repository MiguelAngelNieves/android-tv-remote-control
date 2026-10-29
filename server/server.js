'use strict';
// Puente TV <-> celular/PC. La TV y los mandos se conectan hacia afuera por WebSocket,
// así no hay que abrir puertos en la casa.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const tvAdb = require('./adb');
const { Scrcpy, LOG: FLUID_LOG } = require('./scrcpy');
const fluid = new Scrcpy(tvAdb);

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
if (!db.settings || typeof db.settings !== 'object') db.settings = {};
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

// ---- Estado ----
let tv = null;                 // socket de la TV (uno solo)
let lastState = {};
const ctls = new Set();        // mandos conectados
const watchers = new Map();    // mandos que piden ver la pantalla → ¿alta calidad?

const FORWARD = new Set(['open', 'nav', 'media', 'move', 'click', 'scroll', 'text', 'key', 'volume', 'ua', 'settings', 'tap']);

const sendJson = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (obj) => ctls.forEach((c) => sendJson(c, obj));
const sendTv = (obj) => { if (tv && tv.readyState === 1) { tv.send(JSON.stringify(obj)); return true; } return false; };
const updateWatch = () => sendTv({ type: 'watch', on: watchers.size > 0, hq: [...watchers.values()].some(Boolean) });

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
// Reproductor de video del modo fluido (jmuxer, MIT)
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'jmuxer', 'dist')));

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
// ---- TV completa (ADB) ----
app.get('/api/tv/screen', auth, async (req, res) => {
  const shot = await tvAdb.screenshot();
  if (!shot) return res.status(503).json({ error: 'adb_offline' });
  res.set('Cache-Control', 'no-store').type(shot.type).send(shot.data);
});
app.post('/api/tv/key', auth, (req, res) => res.json({ ok: tvAdb.key(String(req.body && req.body.key)) }));
app.post('/api/tv/power', auth, async (req, res) => res.json({ ok: await tvAdb.power(String((req.body && req.body.mode) || 'toggle')) }));
app.post('/api/tv/app', auth, (req, res) => res.json({ ok: tvAdb.launch(String(req.body && req.body.pkg)) }));
app.get('/api/fluid/log', auth, (req, res) => res.json({ ...fluidInfo(), viewers: fluid.viewers, log: FLUID_LOG }));
app.get('/api/tv/info', auth, (req, res) => res.json({ info: tvAdb.info, apps: tvAdb.apps }));

app.get('/api/library', auth,(req, res) => res.json(db.library));
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
      else if (m.type === 'frame') { watchers.forEach((_hq, c) => sendJson(c, m)); }
    });
    ws.on('close', () => {
      if (tv === ws) { tv = null; lastState = {}; broadcast({ type: 'tv', online: false }); }
    });
    return;
  }

  ctls.add(ws);
  tvAdb.active = true;
  sendJson(ws, { type: 'hello', tv: !!tv, state: lastState, library: db.library, tvinfo: tvAdb.info, apps: tvAdb.apps, fluid: fluidInfo() });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case 'watch':
        if (m.on) watchers.set(ws, !!m.hq); else watchers.delete(ws);
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
      // --- TV completa por ADB ---
      case 'tv:key': if (!fluid.key(String(m.key)) && !tvAdb.key(String(m.key))) sendJson(ws, { type: 'error', error: 'adb_offline' }); return;
      case 'tv:text': if (!fluid.text(m.text) && !tvAdb.text(m.text)) sendJson(ws, { type: 'error', error: 'adb_offline' }); return;
      case 'tv:app': if (!tvAdb.launch(String(m.pkg))) sendJson(ws, { type: 'error', error: 'adb_offline' }); return;
      case 'tv:power': tvAdb.power(String(m.mode || 'toggle')); return;
      case 'tv:apps': tvAdb.loadApps(); return;
      case 'tv:tap': if (!fluid.tap(Number(m.x), Number(m.y))) tvAdb.tap(Number(m.x), Number(m.y)); return;
      // --- Modo fluido (scrcpy) ---
      case 'fluid:set':
        db.settings.fluid = !!m.on; save();
        if (!db.settings.fluid) { ctls.forEach((c) => { c.streaming = false; }); fluid.viewers = 0; fluid.stop(); }
        return broadcast({ type: 'fluid', ...fluidInfo() });
      case 'stream':
        if (m.on && db.settings.fluid && !ws.streaming) {
          ws.streaming = true; ws.waitKey = true;
          // Sin reiniciar el codificador (en el Chromecast eso cortaba el video): hay un fotograma clave cada 2 s
          fluid.addViewer().then((ok) => { if (ok && fluid.config) sendFrame(ws, 1, fluid.config); });
        } else if (!m.on && ws.streaming) { ws.streaming = false; fluid.removeViewer(); }
        return;
      case 'stream:key': if (ws.streaming) ws.waitKey = true; return;
      case 'ping': return sendJson(ws, { type: 'pong', t: m.t });
      default:
        if (!FORWARD.has(m.type)) return;
        if (m.type === 'open') m.url = normalizeUrl(m.url);
        if (!sendTv(m)) sendJson(ws, { type: 'error', error: 'tv_offline' });
    }
  });
  ws.on('close', () => { ctls.delete(ws); watchers.delete(ws); updateWatch(); tvAdb.active = ctls.size > 0; if (ws.streaming) { ws.streaming = false; fluid.removeViewer(); } });
});

tvAdb.on('info', (info) => broadcast({ type: 'tvinfo', info }));
tvAdb.on('apps', (apps) => broadcast({ type: 'apps', apps }));
tvAdb.start();

// ---- Modo fluido: reparte el video H.264 a quien lo esté viendo ----
function fluidInfo() { return { on: !!db.settings.fluid, state: fluid.state, error: fluid.error, width: fluid.width, height: fluid.height }; }
// Mensaje binario: [banderas][datos]  banderas: 1 = configuración (SPS/PPS), 2 = fotograma clave
function sendFrame(ws, flags, data) {
  if (ws.readyState !== 1) return;
  const head = Buffer.from([flags]);
  ws.send(Buffer.concat([head, data]), { binary: true });
}
fluid.on('packet', (config, key, data) => {
  const flags = (config ? 1 : 0) | (key ? 2 : 0);
  // Cada fotograma clave lleva su configuración (SPS/PPS): así cualquiera puede empezar a decodificar desde ahí
  if (key && fluid.config) data = Buffer.concat([fluid.config, data]);
  ctls.forEach((c) => {
    if (!c.streaming || c.readyState !== 1) return;
    // Si el celular va atrasado (red lenta), se descartan fotogramas hasta el siguiente fotograma clave
    if (c.bufferedAmount > 1.5 * 1024 * 1024) { c.waitKey = true; return; }
    if (c.waitKey && !config && !key) return;
    if (key) c.waitKey = false;
    sendFrame(c, flags, data);
  });
});
fluid.on('state', () => broadcast({ type: 'fluid', ...fluidInfo() }));

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log(`TV Remote server en :${PORT}`));
