import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import util from 'util';

const execFileAsync = util.promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, 'config.json');
const ACCOUNTS_DIR = path.join(__dirname, 'tiktok', 'accounts');
const LEGACY_COOKIES = path.join(__dirname, 'tiktok', 'cookies', 'tiktok_cookies.json');
const PYTHON_BIN = path.join(__dirname, 'venv', 'bin', 'python3');
const TIKTOK_MGR = path.join(__dirname, 'tiktok', 'tiktok_manager.py');

const DEFAULT_PRESETS = {
  tiktok: { name: 'TikTok Live', rtmpServer: 'rtmp://push-rtmp-l9.tiktokcdn.com/stage/' },
  kick: { name: 'Kick', rtmpServer: 'rtmps://fa723794b6f2.global-contribute.live-video.net:443/app/' },
  youtube: { name: 'YouTube Live', rtmpServer: 'rtmp://a.rtmp.youtube.com/live2/' },
  twitch: { name: 'Twitch', rtmpServer: 'rtmp://live.twitch.tv/app/' },
  facebook: { name: 'Facebook Live', rtmpServer: 'rtmps://live-api-s.facebook.com:443/rtmp/' },
  custom: { name: 'Personalizado (RTMP/RTMPS)', rtmpServer: '' }
};

const DEFAULT_DONATION = {
  enabled: true,
  text: 'Apoya el directo ★ Donaciones: paypal.me/tuusuario | ¡Dale Tap Tap y Síguenos!',
  position: 'bottom',       // 'bottom' | 'center_bottom' | 'top'
  displayMode: 'periodic',  // 'always' | 'periodic'
  style: 'dark',            // 'dark' | 'tiktok' | 'gold' | 'alert'
  intervalSec: 180,
  durationSec: 25,
  rotateSec: 25
};

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export class AccountStore {
  constructor() {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    this.data = this._load();
    this._migrateLegacyTikTok();
  }

  _load() {
    let parsed = {};
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      }
    } catch (err) {
      console.error('Error leyendo config.json:', err.message);
    }

    return {
      port: parsed.port || 9090,
      savedPresets: parsed.savedPresets || DEFAULT_PRESETS,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      autoMonitors: Array.isArray(parsed.autoMonitors) ? parsed.autoMonitors : [],
      radarCreators: Array.isArray(parsed.radarCreators) ? parsed.radarCreators : [],
      legacyMigrated: Boolean(parsed.legacyMigrated),
      security: {
        pinSalt: parsed.security?.pinSalt || '',
        pinHash: parsed.security?.pinHash || '',
        sessionSecret: parsed.security?.sessionSecret || crypto.randomBytes(32).toString('hex')
      },
      donationDefaults: { ...DEFAULT_DONATION, ...(parsed.donationDefaults || {}) },
      lastConfig: parsed.lastConfig || {}
    };
  }

  _save() {
    const tmp = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, CONFIG_PATH);
  }

  _migrateLegacyTikTok() {
    if (!this.data.legacyMigrated && this.data.accounts.length === 0 && fs.existsSync(LEGACY_COOKIES)) {
      const id = 'acc-tiktok-principal';
      const accDir = path.join(ACCOUNTS_DIR, id);
      fs.mkdirSync(accDir, { recursive: true });
      const destCookies = path.join(accDir, 'cookies.json');
      fs.copyFileSync(LEGACY_COOKIES, destCookies);

      this.data.accounts.push({
        id,
        name: 'TikTok Principal',
        platform: 'tiktok',
        authType: 'cookies',
        cookiesFile: path.relative(__dirname, destCookies),
        rtmpServer: DEFAULT_PRESETS.tiktok.rtmpServer,
        streamKey: '',
        verified: true,
        username: 'hadess888',
        statusText: 'Ready',
        createdAt: new Date().toISOString()
      });
      this.data.legacyMigrated = true;
      this._save();
    }
  }

  getPresets() {
    return this.data.savedPresets;
  }

  getPort() {
    return this.data.port;
  }

  getDonationDefaults() {
    return this.data.donationDefaults;
  }

  updateDonationDefaults(updates) {
    this.data.donationDefaults = { ...this.data.donationDefaults, ...updates };
    this._save();
    return this.data.donationDefaults;
  }

  getLastConfig() {
    return this.data.lastConfig;
  }

  saveLastConfig(updates) {
    this.data.lastConfig = { ...this.data.lastConfig, ...updates };
    this._save();
  }

  listAccountsSafe() {
    return this.data.accounts.map((acc) => ({
      id: acc.id,
      name: acc.name,
      platform: acc.platform,
      authType: acc.authType,
      rtmpServer: acc.rtmpServer,
      streamKeyMasked: maskKey(acc.streamKey),
      hasCookies: Boolean(acc.cookiesFile && fs.existsSync(path.resolve(__dirname, acc.cookiesFile))),
      verified: Boolean(acc.verified),
      username: acc.username || '',
      statusText: acc.statusText || '',
      createdAt: acc.createdAt
    }));
  }

  getAccountRaw(id) {
    const acc = this.data.accounts.find((a) => a.id === id);
    if (!acc) return null;
    return {
      ...acc,
      cookiesAbsPath: acc.cookiesFile ? path.resolve(__dirname, acc.cookiesFile) : null
    };
  }

  createAccount({ name, platform, authType, rtmpServer, streamKey, cookiesJson }) {
    const cleanName = (name || '').trim();
    if (!cleanName) throw new Error('El nombre de la cuenta es obligatorio.');
    const plat = (platform || 'custom').trim();
    const mode = plat === 'tiktok' ? (authType || 'cookies') : 'manual';

    const id = `acc-${plat}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    let cookiesRel = '';

    if (plat === 'tiktok' && mode === 'cookies') {
      if (!cookiesJson || !cookiesJson.trim()) {
        throw new Error('Debes pegar o subir el JSON de cookies de TikTok.');
      }
      let parsedCookies;
      try {
        parsedCookies = JSON.parse(cookiesJson);
      } catch {
        throw new Error('El archivo/texto de cookies no es un JSON válido.');
      }
      if (!Array.isArray(parsedCookies) && typeof parsedCookies !== 'object') {
        throw new Error('Formato de cookies TikTok inválido.');
      }

      const accDir = path.join(ACCOUNTS_DIR, id);
      fs.mkdirSync(accDir, { recursive: true });
      const cookiesAbs = path.join(accDir, 'cookies.json');
      fs.writeFileSync(cookiesAbs, JSON.stringify(parsedCookies, null, 2), 'utf-8');
      cookiesRel = path.relative(__dirname, cookiesAbs);
    } else {
      const srv = (rtmpServer || this.data.savedPresets[plat]?.rtmpServer || '').trim();
      if (!srv) throw new Error('Debes especificar el servidor RTMP destino.');
      if (!streamKey || !streamKey.trim()) throw new Error('Debes especificar la Stream Key.');
    }

    const account = {
      id,
      name: cleanName,
      platform: plat,
      authType: mode,
      cookiesFile: cookiesRel,
      rtmpServer: (rtmpServer || this.data.savedPresets[plat]?.rtmpServer || '').trim(),
      streamKey: (streamKey || '').trim(),
      verified: mode === 'manual',
      username: '',
      statusText: mode === 'manual' ? 'Manual RTMP' : 'Sin verificar',
      createdAt: new Date().toISOString()
    };

    this.data.accounts.push(account);
    this._save();
    return this.listAccountsSafe().find((a) => a.id === id);
  }

  updateAccount(id, { name, rtmpServer, streamKey, cookiesJson }) {
    const acc = this.data.accounts.find((a) => a.id === id);
    if (!acc) throw new Error('Cuenta no encontrada.');

    if (name && name.trim()) {
      acc.name = name.trim();
    }

    if (acc.platform === 'tiktok' && acc.authType === 'cookies') {
      if (cookiesJson && cookiesJson.trim()) {
        let parsedCookies;
        try {
          parsedCookies = JSON.parse(cookiesJson);
        } catch {
          throw new Error('El texto de cookies no es un JSON válido.');
        }
        if (!Array.isArray(parsedCookies) && typeof parsedCookies !== 'object') {
          throw new Error('Formato de cookies TikTok inválido.');
        }
        const accDir = path.join(ACCOUNTS_DIR, acc.id);
        fs.mkdirSync(accDir, { recursive: true });
        const cookiesAbs = path.join(accDir, 'cookies.json');
        fs.writeFileSync(cookiesAbs, JSON.stringify(parsedCookies, null, 2), 'utf-8');
        acc.cookiesFile = path.relative(__dirname, cookiesAbs);
        acc.verified = false;
        acc.statusText = 'Sin verificar';
      }
    } else {
      if (rtmpServer !== undefined && rtmpServer.trim()) {
        acc.rtmpServer = rtmpServer.trim();
      }
      if (streamKey && streamKey.trim()) {
        acc.streamKey = streamKey.trim();
      }
    }

    this._save();
    return this.listAccountsSafe().find((a) => a.id === id);
  }

  deleteAccount(id) {
    const idx = this.data.accounts.findIndex((a) => a.id === id);
    if (idx === -1) throw new Error('Cuenta no encontrada.');
    const [removed] = this.data.accounts.splice(idx, 1);
    if (removed.cookiesFile) {
      const accDir = path.dirname(path.resolve(__dirname, removed.cookiesFile));
      if (accDir.startsWith(ACCOUNTS_DIR)) {
        fs.rmSync(accDir, { recursive: true, force: true });
      }
    }
    this.data.legacyMigrated = true;
    this._save();
    return { deleted: true, id };
  }

  // --- Seguridad PIN Opcional ---
  getSessionSecret() {
    if (!this.data.security?.sessionSecret) {
      this.data.security = {
        ...(this.data.security || {}),
        sessionSecret: crypto.randomBytes(32).toString('hex')
      };
      this._save();
    }
    return this.data.security.sessionSecret;
  }

  hasAdminPin() {
    if (process.env.ADMIN_PIN && process.env.ADMIN_PIN.trim()) return true;
    return Boolean(this.data.security?.pinHash);
  }

  verifyAdminPin(pin) {
    const candidate = String(pin ?? '').trim();
    if (!candidate) return false;
    const envPin = (process.env.ADMIN_PIN || '').trim();
    if (envPin) {
      const a = Buffer.from(candidate, 'utf-8');
      const b = Buffer.from(envPin, 'utf-8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    const { pinSalt, pinHash } = this.data.security || {};
    if (!pinSalt || !pinHash) return true;
    const a = Buffer.from(hashPin(candidate, pinSalt), 'hex');
    const b = Buffer.from(pinHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  setAdminPin(newPin) {
    if (process.env.ADMIN_PIN && process.env.ADMIN_PIN.trim()) {
      throw new Error('El PIN está bloqueado por variable de entorno ADMIN_PIN.');
    }
    const clean = String(newPin ?? '').trim();
    if (!clean) {
      this.data.security.pinSalt = '';
      this.data.security.pinHash = '';
      this._save();
      return { enabled: false };
    }
    if (clean.length < 4) {
      throw new Error('El PIN debe tener al menos 4 caracteres.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    this.data.security.pinSalt = salt;
    this.data.security.pinHash = hashPin(clean, salt);
    this._save();
    return { enabled: true };
  }

  // --- Auto-Monitores 24/7 ---
  listMonitors() {
    return this.data.autoMonitors;
  }

  createMonitor(payload) {
    const name = (payload.name || '').trim();
    const channelUrl = (payload.channelUrl || '').trim();
    const accountId = (payload.accountId || '').trim();
    if (!name) throw new Error('Nombre del monitor obligatorio.');
    if (!channelUrl) throw new Error('URL del canal o /live obligatoria.');
    if (!accountId || !this.getAccountRaw(accountId)) {
      throw new Error('Cuenta destino no válida.');
    }

    const mon = {
      id: `mon-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
      name,
      channelUrl,
      accountId,
      mode: payload.mode || 'vertical_blur',
      quality: payload.quality || '720p30',
      topicId: String(payload.topicId || '5').trim() || '5',
      tiktokTitle: (payload.tiktokTitle || '{title}').trim(),
      checkIntervalSec: Math.max(30, Math.min(600, Number(payload.checkIntervalSec) || 60)),
      donation: { ...DEFAULT_DONATION, ...(payload.donation || {}) },
      enabled: payload.enabled !== false,
      lastTriggeredVideoId: '',
      createdAt: new Date().toISOString()
    };
    this.data.autoMonitors.push(mon);
    this._save();
    return mon;
  }

  updateMonitor(id, updates) {
    const mon = this.data.autoMonitors.find((m) => m.id === id);
    if (!mon) throw new Error('Monitor no encontrado.');
    Object.assign(mon, updates);
    this._save();
    return mon;
  }

  deleteMonitor(id) {
    const idx = this.data.autoMonitors.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error('Monitor no encontrado.');
    this.data.autoMonitors.splice(idx, 1);
    this._save();
    return { deleted: true, id };
  }

  _normalizeRadarHandle(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    let candidate = text;
    if (/^https?:\/\//i.test(text)) {
      try {
        const parsed = new URL(text);
        if (!parsed.hostname.toLowerCase().endsWith('tiktok.com')) return '';
        const first = parsed.pathname.split('/').filter(Boolean)[0] || '';
        if (!first.startsWith('@')) return '';
        candidate = first.slice(1);
      } catch {
        return '';
      }
    } else if (text.startsWith('@')) {
      candidate = text.slice(1);
    }
    candidate = candidate.trim().toLowerCase();
    return /^[a-z0-9._-]{1,64}$/.test(candidate) ? candidate : '';
  }

  listRadar() {
    return (this.data.radarCreators || []).map((r) => ({ ...r }));
  }

  addRadarCreator({ handle, note = '' }) {
    const clean = this._normalizeRadarHandle(handle);
    if (!clean) throw new Error('Handle de TikTok inválido (usa @usuario o URL de TikTok).');
    if (!Array.isArray(this.data.radarCreators)) this.data.radarCreators = [];
    const existing = this.data.radarCreators.find((r) => r.handle.toLowerCase() === clean);
    if (existing) {
      if (note && note.trim()) {
        existing.note = note.trim().slice(0, 80);
        this._save();
      }
      return { ...existing };
    }
    if (this.data.radarCreators.length >= 60) {
      throw new Error('Límite de 60 creadores en Radar alcanzado.');
    }
    const entry = {
      handle: clean,
      note: String(note || '').trim().slice(0, 80),
      addedAt: new Date().toISOString()
    };
    this.data.radarCreators.push(entry);
    this._save();
    return { ...entry };
  }

  removeRadarCreator(handle) {
    const clean = this._normalizeRadarHandle(handle);
    if (!clean) throw new Error('Handle inválido.');
    if (!Array.isArray(this.data.radarCreators)) this.data.radarCreators = [];
    const idx = this.data.radarCreators.findIndex((r) => r.handle.toLowerCase() === clean);
    if (idx === -1) throw new Error('Creador no encontrado en el Radar.');
    this.data.radarCreators.splice(idx, 1);
    this._save();
    return { deleted: true, handle: clean };
  }

  async verifyTikTokAccount(id) {
    const acc = this.getAccountRaw(id);
    if (!acc) throw new Error('Cuenta no encontrada.');
    if (acc.platform !== 'tiktok' || acc.authType !== 'cookies' || !acc.cookiesAbsPath) {
      return { valid: true, can_stream: true, status_text: 'Manual RTMP', account: acc.name };
    }

    const { stdout } = await execFileAsync(PYTHON_BIN, [
      TIKTOK_MGR,
      '--verify',
      '--cookies', acc.cookiesAbsPath
    ], { timeout: 25000 });

    const res = JSON.parse(stdout.trim());
    const stored = this.data.accounts.find((a) => a.id === id);
    if (stored) {
      stored.verified = Boolean(res.valid && res.can_stream);
      stored.username = res.account || stored.username;
      stored.statusText = res.status_text || (stored.verified ? 'Ready' : res.error || 'Error');
      this._save();
    }
    return res;
  }
}
