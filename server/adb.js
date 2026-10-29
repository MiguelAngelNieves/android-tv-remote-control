'use strict';
// Control de la TV completa (cualquier app) por ADB.
// Variables de entorno:
//   ADB_PATH  ruta a adb (Windows: D:\dev\Android\Sdk\platform-tools\adb.exe; Linux: adb)
//   TV_ADB    opcional, IP:puerto fijo. Si no se da, se descubre solo por mDNS (_adb-tls-connect).
//   TV_IP     opcional, IP de la TV para elegir entre varios dispositivos descubiertos.
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');

const ADB = process.env.ADB_PATH || 'adb';
const FIXED = process.env.TV_ADB || '';
const TV_IP = process.env.TV_IP || (FIXED ? FIXED.split(':')[0] : '');

let sharp = null;
try { sharp = require('sharp'); } catch { /* opcional: captura en PNG si no está */ }

const KEYS = {
  up: 'DPAD_UP', down: 'DPAD_DOWN', left: 'DPAD_LEFT', right: 'DPAD_RIGHT', ok: 'DPAD_CENTER',
  back: 'BACK', home: 'HOME', menu: 'MENU', playpause: 'MEDIA_PLAY_PAUSE', next: 'MEDIA_NEXT',
  prev: 'MEDIA_PREVIOUS', ff: 'MEDIA_FAST_FORWARD', rew: 'MEDIA_REWIND', volup: 'VOLUME_UP',
  voldown: 'VOLUME_DOWN', mute: 'VOLUME_MUTE', del: 'DEL', enter: 'ENTER', search: 'SEARCH',
  settings: 'SETTINGS', wake: 'WAKEUP', sleep: 'SLEEP', apps: 'ALL_APPS'
};

// Nombres amigables de apps conocidas
const LABELS = {
  'com.netflix.ninja': 'Netflix', 'com.google.android.youtube.tv': 'YouTube',
  'com.disney.disneyplus': 'Disney+', 'com.amazon.amazonvideo.livingroom': 'Prime Video',
  'com.wbd.stream': 'Max', 'com.hbo.hbonow': 'HBO Max', 'com.spotify.tv.android': 'Spotify',
  'com.miguel.tvremote': 'TV Control', 'com.google.android.youtube.tvmusic': 'YouTube Music',
  'com.google.android.apps.youtube.kids': 'YouTube Kids', 'com.google.android.tvlauncher': 'Inicio',
  'com.google.android.apps.tv.launcherx': 'Inicio', 'com.android.tv.settings': 'Ajustes',
  'com.google.android.videos': 'Google TV', 'tv.pluto.android': 'Pluto TV', 'com.plexapp.android': 'Plex',
  'com.paramountplus.android': 'Paramount+', 'com.crunchyroll.crunchyroid': 'Crunchyroll',
  'com.twitch.android.app': 'Twitch', 'org.xbmc.kodi': 'Kodi', 'com.apple.atve.androidtv.appletv': 'Apple TV',
  'com.android.vending': 'Play Store'
};
const label = (pkg) => LABELS[pkg] || (pkg.split('.').pop() || pkg).replace(/^\w/, (c) => c.toUpperCase());

class TvAdb extends EventEmitter {
  constructor() {
    super();
    this.serial = FIXED || '';
    this.online = false;
    this.shell = null;
    this.queue = [];
    this.flushT = null;
    this.apps = [];          // [{pkg, comp, label}]
    this.info = { adb: false, app: '', label: '', awake: null };
    this.shotCache = null; this.shotAt = 0; this.shotBusy = null;
  }

  run(args, { timeout = 8000, buffer = false } = {}) {
    return new Promise((resolve) => {
      execFile(ADB, args, { timeout, maxBuffer: 32 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8', windowsHide: true },
        (err, out) => resolve(err ? null : out));
    });
  }
  sh(cmd, opts) { return this.serial ? this.run(['-s', this.serial, 'shell', cmd], opts) : Promise.resolve(null); }

  async discover() {
    const out = await this.run(['mdns', 'services']);
    if (!out) return '';
    const found = [...out.matchAll(/_adb-tls-connect\._tcp\.?\s+(\d+\.\d+\.\d+\.\d+:\d+)/g)].map((m) => m[1]);
    return found.find((a) => !TV_IP || a.startsWith(TV_IP + ':')) || '';
  }

  async ensure() {
    const devs = (await this.run(['devices'])) || '';
    const ok = (s) => s && new RegExp('^' + s.replace(/[.:]/g, '\\$&') + '\\s+device$', 'm').test(devs);
    if (!ok(this.serial)) {
      let target = FIXED || this.serial;
      if (!target || !(await this.connect(target))) {
        target = await this.discover();
        if (target) await this.connect(target);
      }
    }
    const devs2 = (await this.run(['devices'])) || '';
    const now = !!this.serial && new RegExp('^' + this.serial.replace(/[.:]/g, '\\$&') + '\\s+device$', 'm').test(devs2);
    if (now !== this.online) {
      this.online = now;
      if (!now) this.killShell();
      else this.loadApps();
    }
    this.info.adb = this.online;
    return this.online;
  }

  async connect(addr) {
    const out = (await this.run(['connect', addr], { timeout: 6000 })) || '';
    if (/connected to/.test(out)) { this.serial = addr; return true; }
    return false;
  }

  // Sesión de shell persistente: evita arrancar adb en cada tecla (mucho más rápido).
  ensureShell() {
    if (this.shell || !this.online) return this.shell;
    const p = spawn(ADB, ['-s', this.serial, 'shell'], { windowsHide: true });
    p.stdout.on('data', () => {}); p.stderr.on('data', () => {});
    p.on('exit', () => { if (this.shell === p) this.shell = null; });
    p.on('error', () => { if (this.shell === p) this.shell = null; });
    this.shell = p;
    return p;
  }
  killShell() { if (this.shell) { try { this.shell.kill(); } catch {} this.shell = null; } }
  raw(line) { const s = this.ensureShell(); if (s) s.stdin.write(line + '\n'); return !!s; }
  // Cualquier comando primero envía las teclas pendientes, así se respeta el orden.
  write(line) { this.flushKeys(); return this.raw(line); }
  flushKeys() {
    if (this.flushT) { clearTimeout(this.flushT); this.flushT = null; }
    const ks = this.queue.splice(0);
    if (ks.length) this.raw('input keyevent ' + ks.join(' '));
  }

  // Teclas: se agrupan las que llegan juntas en un solo "input keyevent" (una invocación = menos retraso).
  key(name) {
    const code = KEYS[name]; if (!code || !this.online) return false;
    this.queue.push('KEYCODE_' + code);
    if (!this.flushT) this.flushT = setTimeout(() => this.flushKeys(), 25);
    return true;
  }

  text(t) {
    if (!this.online) return false;
    const clean = String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ñ/g, 'n').replace(/Ñ/g, 'N')
      .replace(/[^\x20-\x7e]/g, '').slice(0, 300);
    if (!clean) return false;
    const esc = clean.split('').map((c) => (c === ' ' ? '%s' : /[A-Za-z0-9._,:/=@+-]/.test(c) ? c : '\\' + c)).join('');
    return this.write('input text ' + esc);
  }

  async power(mode) {
    if (!this.online) return false;
    if (mode === 'toggle') {
      await this.refreshInfo();
      mode = this.info.awake ? 'off' : 'on';
    }
    return this.key(mode === 'off' ? 'sleep' : 'wake');
  }

  async loadApps() {
    const out = await this.sh('cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER');
    if (!out) return;
    const seen = new Map();
    out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w.]+\/[\w.$]+$/.test(l)).forEach((comp) => {
      const pkg = comp.split('/')[0];
      if (!seen.has(pkg)) seen.set(pkg, { pkg, comp, label: label(pkg) });
    });
    this.apps = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
    this.emit('apps', this.apps);
  }

  launch(pkg) {
    const a = this.apps.find((x) => x.pkg === pkg);
    if (!this.online || !a) return false;
    this.key('wake');
    return this.write('am start -n ' + a.comp);
  }

  async refreshInfo() {
    if (!this.online) { this.info = { adb: false, app: '', label: '', awake: null }; return this.info; }
    const out = (await this.sh("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' ; dumpsys power | grep -m1 'mWakefulness='")) || '';
    const m = out.match(/\{[^}]*\s([\w.]+)\/[\w.$]+\}/);
    const pkg = m ? m[1] : '';
    const w = out.match(/mWakefulness=(\w+)/);
    this.info = { adb: true, app: pkg, label: pkg ? label(pkg) : '', awake: w ? w[1] === 'Awake' : null };
    return this.info;
  }

  // Captura de pantalla de cualquier app (Netflix/Disney+ salen en negro por DRM).
  async screenshot() {
    if (!this.online) return null;
    if (this.shotCache && Date.now() - this.shotAt < 1200) return this.shotCache;
    if (this.shotBusy) return this.shotBusy;
    this.shotBusy = (async () => {
      const png = await this.run(['-s', this.serial, 'exec-out', 'screencap', '-p'], { timeout: 10000, buffer: true });
      if (!png || png.length < 100) return null;
      let out = { type: 'image/png', data: png };
      if (sharp) {
        try { out = { type: 'image/jpeg', data: await sharp(png).resize({ width: 960 }).jpeg({ quality: 60 }).toBuffer() }; } catch {}
      }
      this.shotCache = out; this.shotAt = Date.now();
      return out;
    })().finally(() => { this.shotBusy = null; });
    return this.shotBusy;
  }

  start() {
    // Revisa cada 5 s si hay alguien usando el mando; si no, cada 30 s (no carga la TV).
    this.active = false;
    let last = 0;
    const tick = async () => {
      if (this.active || Date.now() - last > 30000) {
        last = Date.now();
        await this.ensure();
        if (this.online && this.active) await this.refreshInfo();
        this.emit('info', this.info);
      }
      setTimeout(tick, 5000);
    };
    tick();
  }
}

module.exports = new TvAdb();
