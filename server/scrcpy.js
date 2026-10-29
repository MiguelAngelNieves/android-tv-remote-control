'use strict';
// Modo fluido: video en tiempo real y control instantáneo usando el servidor de scrcpy
// (https://github.com/Genymobile/scrcpy, Apache 2.0). El archivo del servidor se descarga
// la primera vez desde la release oficial y se verifica con su SHA-256; no se incluye en el repo.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const VERSION = '5.0.1';
const JAR_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`;
const JAR_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';
const JAR_LOCAL = path.join(__dirname, 'vendor', `scrcpy-server-v${VERSION}`);
const JAR_REMOTE = '/data/local/tmp/tvremote-scrcpy.jar';
const PORT = Number(process.env.SCRCPY_PORT) || 27199;

// Códigos de tecla de Android (KeyEvent.KEYCODE_*)
const KEYCODES = {
  up: 19, down: 20, left: 21, right: 22, ok: 23, back: 4, home: 3, menu: 82,
  playpause: 85, next: 87, prev: 88, ff: 90, rew: 89, volup: 24, voldown: 25, mute: 164,
  del: 67, enter: 66, search: 84, settings: 176, wake: 224, sleep: 223, apps: 284
};

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  }).then((buf) => {
    if (typeof buf === 'undefined') return;
    if (!Buffer.isBuffer(buf)) return buf;
    const sum = crypto.createHash('sha256').update(buf).digest('hex');
    if (sum !== JAR_SHA256) throw new Error('El archivo de scrcpy no coincide con la firma oficial');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  });
}

class Scrcpy extends EventEmitter {
  constructor(adb) {
    super();
    this.adb = adb;
    this.state = 'off';       // off | starting | on | error
    this.error = '';
    this.proc = null; this.video = null; this.control = null;
    this.width = 0; this.height = 0;
    this.config = null;       // último paquete de configuración (SPS/PPS)
    this.viewers = 0; this.idleT = null; this.startP = null;
    this.fails = []; this.retryT = null;   // reintentos automáticos
  }

  setState(s, err = '') {
    // Si se corta mientras alguien mira, se reconecta solo; solo se reporta error si falla 3 veces en un minuto.
    if (s === 'error' && this.viewers > 0) {
      const now = Date.now();
      this.fails = this.fails.filter((t) => now - t < 60000).concat(now);
      console.log('[fluido] se cortó (' + err + '), reconectando… intento ' + this.fails.length);
      if (this.fails.length < 3) {
        clearTimeout(this.retryT);
        this.retryT = setTimeout(() => { if (this.viewers > 0) this.start(); }, 1500);
        s = 'starting'; err = '';
      }
    }
    if (s === 'on') this.fails = [];
    this.state = s; this.error = err;
    this.emit('state', { state: s, error: err, width: this.width, height: this.height });
  }
  get running() { return this.state === 'on' && this.control && !this.control.destroyed; }

  async ensureJar() {
    if (fs.existsSync(JAR_LOCAL)) return;
    console.log('[fluido] descargando scrcpy-server v' + VERSION + '…');
    await download(JAR_URL, JAR_LOCAL);
  }

  async pushJar() {
    const size = fs.statSync(JAR_LOCAL).size;
    const remote = ((await this.adb.sh(`stat -c %s ${JAR_REMOTE} 2>/dev/null`)) || '').trim();
    if (Number(remote) === size) return;
    const out = await this.adb.run(['-s', this.adb.serial, 'push', JAR_LOCAL, JAR_REMOTE], { timeout: 30000 });
    if (out === null) throw new Error('No se pudo copiar scrcpy a la TV');
  }

  start() {
    clearTimeout(this.retryT);
    if (this.state === 'on') return Promise.resolve(true);
    if (this.startP) return this.startP;
    this.startP = this._start().then(() => true, (e) => {
      console.error('[fluido]', e.message);
      this.stop(true);
      this.setState('error', e.message);
      return false;
    }).finally(() => { this.startP = null; });
    return this.startP;
  }

  async _start() {
    if (!this.adb.online) throw new Error('Sin conexión ADB con la TV');
    this.setState('starting');
    await this.ensureJar();
    await this.pushJar();
    const scid = (crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, '0');
    await this.adb.run(['-s', this.adb.serial, 'forward', '--remove', `tcp:${PORT}`]);
    const fwd = await this.adb.run(['-s', this.adb.serial, 'forward', `tcp:${PORT}`, `localabstract:scrcpy_${scid}`]);
    if (fwd === null) throw new Error('No se pudo abrir el túnel ADB');

    const args = [
      `scid=${scid}`, 'log_level=info', 'audio=false', 'control=true', 'tunnel_forward=true',
      'send_device_meta=false', 'video_codec=h264', 'max_size=1280', 'max_fps=30',
      'video_bit_rate=4000000', 'clipboard_autosync=false', 'power_on=false', 'cleanup=true'
    ].join(' ');
    const cmd = `CLASSPATH=${JAR_REMOTE} app_process / com.genymobile.scrcpy.Server ${VERSION} ${args}`;
    const p = spawn(this.adb.bin, ['-s', this.adb.serial, 'shell', cmd], { windowsHide: true });
    this.proc = p;
    p.stdout.on('data', (d) => { const s = String(d).trim(); if (s) console.log('[fluido]', s); });
    p.stderr.on('data', (d) => { const s = String(d).trim(); if (s) console.log('[fluido]', s); });
    p.on('exit', () => { if (this.proc === p) { this.proc = null; if (this.state !== 'off') { this.stop(true); this.setState('error', 'scrcpy se detuvo en la TV'); } } });

    this.video = await this.connectFirst();
    this.control = await this.connectSocket();
    this.control.on('data', () => {});           // mensajes del dispositivo: se ignoran
    this.control.on('error', () => {});
    this.control.on('close', () => { if (this.state === 'on') { this.stop(true); this.setState('error', 'Se cerró el canal de control'); } });
    this.parseVideo(this.video);
    this.setState('on');
  }

  connectSocket() {
    return new Promise((resolve, reject) => {
      const s = net.connect(PORT, '127.0.0.1');
      s.setNoDelay(true);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }

  // El primer socket recibe un "dummy byte" cuando el servidor ya está escuchando en la TV.
  async connectFirst() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const s = await this.connectSocket().catch(() => null);
      if (s) {
        const ok = await new Promise((resolve) => {
          const t = setTimeout(() => { cleanup(); resolve(false); }, 1200);
          const onData = (d) => { s.pause(); cleanup(); if (d.length > 1) s.unshift(d.subarray(1)); resolve(true); };
          const onEnd = () => { cleanup(); resolve(false); };
          function cleanup() { clearTimeout(t); s.removeListener('data', onData); s.removeListener('close', onEnd); s.removeListener('error', onEnd); }
          s.once('data', onData); s.once('close', onEnd); s.once('error', onEnd);
        });
        if (ok) return s;
        s.destroy();
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('scrcpy no respondió en la TV');
  }

  parseVideo(sock) {
    let buf = Buffer.alloc(0), codecRead = false, need = null;
    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (!codecRead) {
          if (buf.length < 4) return;
          const id = buf.readUInt32BE(0); buf = buf.subarray(4); codecRead = true;
          if (id !== 0x68323634) { this.stop(true); this.setState('error', 'Códec de video no soportado'); return; }
          continue;
        }
        if (!need) {
          if (buf.length < 12) return;
          const hi = buf[0];
          if (hi & 0x80) {                      // paquete de sesión: tamaño del video
            this.width = buf.readUInt32BE(4); this.height = buf.readUInt32BE(8);
            buf = buf.subarray(12);
            this.emit('state', { state: this.state, error: '', width: this.width, height: this.height });
            continue;
          }
          need = { config: !!(hi & 0x40), key: !!(hi & 0x20), size: buf.readUInt32BE(8) };
          buf = buf.subarray(12);
        }
        if (buf.length < need.size) return;
        const data = Buffer.from(buf.subarray(0, need.size));
        buf = buf.subarray(need.size);
        if (need.config) this.config = data;
        this.emit('packet', need.config, need.key, data);
        need = null;
      }
    });
    sock.on('close', () => { if (this.state === 'on') { this.stop(true); this.setState('error', 'Se cortó el video'); } });
    sock.on('error', () => {});
    sock.resume();
  }

  stop(silent) {
    clearTimeout(this.idleT);
    for (const s of [this.video, this.control]) { try { s && s.destroy(); } catch {} }
    this.video = this.control = null;
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    this.config = null;
    if (this.adb.serial) this.adb.run(['-s', this.adb.serial, 'forward', '--remove', `tcp:${PORT}`]);
    if (!silent) this.setState('off');
  }

  // Quien mira el video: se arranca al primer espectador y se apaga 20 s después del último.
  addViewer() { this.viewers++; clearTimeout(this.idleT); return this.start(); }
  removeViewer() {
    this.viewers = Math.max(0, this.viewers - 1);
    if (!this.viewers) { clearTimeout(this.idleT); this.idleT = setTimeout(() => { if (!this.viewers) this.stop(); }, 20000); }
  }
  // Pide un fotograma completo (para quien se acaba de unir)
  resetVideo() { if (this.running) this.control.write(Buffer.from([17])); }

  // ---- Control ----
  key(name) {
    const code = KEYCODES[name]; if (code == null || !this.running) return false;
    const msg = (action) => { const b = Buffer.alloc(14); b[0] = 0; b[1] = action; b.writeInt32BE(code, 2); b.writeInt32BE(0, 6); b.writeInt32BE(0, 10); return b; };
    this.control.write(Buffer.concat([msg(0), msg(1)]));
    return true;
  }
  text(t) {
    if (!this.running) return false;
    const data = Buffer.from(String(t).slice(0, 300), 'utf8');
    const b = Buffer.alloc(5); b[0] = 1; b.writeUInt32BE(data.length, 1);
    this.control.write(Buffer.concat([b, data]));
    return true;
  }
  tap(fx, fy) {
    if (!this.running || !this.width || !(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return false;
    const x = Math.round(fx * this.width), y = Math.round(fy * this.height);
    const msg = (action, pressure) => {
      const b = Buffer.alloc(32); b[0] = 2; b[1] = action;
      b.writeBigInt64BE(-2n, 2);                 // puntero de dedo genérico
      b.writeInt32BE(x, 10); b.writeInt32BE(y, 14);
      b.writeUInt16BE(this.width, 18); b.writeUInt16BE(this.height, 20);
      b.writeUInt16BE(pressure, 22); b.writeInt32BE(0, 24); b.writeInt32BE(0, 28);
      return b;
    };
    this.control.write(Buffer.concat([msg(0, 0xffff), msg(1, 0)]));
    return true;
  }
}

module.exports = { Scrcpy, KEYCODES };
