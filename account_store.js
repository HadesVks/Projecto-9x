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
  text: 'Apoya el directo ★ Donaciones: paypal.me/tuusuario',
  position: 'bottom',       // 'bottom' | 'center_bottom' | 'top'
  displayMode: 'periodic',  // 'always' | 'periodic'
  intervalSec: 180,
  durationSec: 25
};

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
    if (this.data.accounts.length === 0 && fs.existsSync(LEGACY_COOKIES)) {
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

    const id = `acc-${plat}-${Date.now().toString(36)}`;
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
    this._save();
    return { deleted: true, id };
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
