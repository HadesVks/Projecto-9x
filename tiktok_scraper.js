import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import util from 'util';

const execFileAsync = util.promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VENV_PYTHON = path.join(__dirname, 'venv', 'bin', 'python3');
const PYTHON_BIN = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';
const SCRAPER_PY = path.join(__dirname, 'tiktok', 'tiktok_live_scraper.py');
const FALLBACK_COOKIE_PATH = path.join(__dirname, 'tiktok', 'cookies', 'tiktok_cookies.json');

const HANDLE_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export function extractTikTokHandle(rawTarget) {
  if (!rawTarget || typeof rawTarget !== 'string') return '';
  const text = rawTarget.trim();
  let candidate = '';
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (!parsed.hostname.toLowerCase().endsWith('tiktok.com')) return '';
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length > 0 && parts[0].startsWith('@')) {
        candidate = parts[0].slice(1);
      }
    } catch {
      return '';
    }
  } else {
    candidate = text.startsWith('@') ? text.slice(1) : text;
  }
  candidate = candidate.trim();
  return HANDLE_RE.test(candidate) ? candidate : '';
}

export function isTikTokLiveUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  if (!/^https?:\/\//i.test(rawUrl.trim())) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith('tiktok.com')) return false;
    const p = parsed.pathname.toLowerCase();
    if (p.includes('/video/')) return false;
    if (p.includes('/live') || p.includes('/share/live')) return true;
    return /^\/@[a-z0-9._-]+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function execScraper(args, { cookiePath = '', timeoutMs = 20000 } = {}) {
  const fullArgs = [SCRAPER_PY, ...args];
  if (cookiePath && fs.existsSync(cookiePath)) {
    fullArgs.push('--cookies', cookiePath);
  }
  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, fullArgs, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024
    });
    const lastLine = stdout.trim().split('\n').pop() || '{}';
    return JSON.parse(lastLine);
  } catch (err) {
    const out = (err.stdout || '').trim();
    if (out) {
      try {
        return JSON.parse(out.split('\n').pop());
      } catch {
        // fall through to structured error
      }
    }
    return {
      success: false,
      blocked: false,
      items: [],
      error: err.killed ? 'Timeout consultando TikTok Live' : (err.message || 'Error ejecutando scraper')
    };
  }
}

export async function lookupTikTokRoom(handleOrUrl, { cookiePath = '', timeoutMs = 16000 } = {}) {
  const resolvedCookie = cookiePath || (fs.existsSync(FALLBACK_COOKIE_PATH) ? FALLBACK_COOKIE_PATH : '');
  return execScraper(['--lookup', String(handleOrUrl || '').trim()], {
    cookiePath: resolvedCookie,
    timeoutMs
  });
}

export class TikTokDiscoveryService {
  constructor(accountStore, { cacheTtlMs = 60000, radarTtlMs = 45000, maxCacheEntries = 50 } = {}) {
    this.accountStore = accountStore;
    this.cacheTtlMs = cacheTtlMs;
    this.radarTtlMs = radarTtlMs;
    this.maxCacheEntries = maxCacheEntries;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  _resolveReadonlyCookiePath() {
    try {
      const accounts = this.accountStore?.listAccountsSafe?.() || [];
      const sorted = [...accounts].sort((a, b) => Number(Boolean(b.verified)) - Number(Boolean(a.verified)));
      for (const acc of sorted) {
        if (acc.platform !== 'tiktok' || acc.authType !== 'cookies') continue;
        const raw = this.accountStore.getAccountRaw?.(acc.id);
        const candidate = raw?.cookiesAbsPath
          || (acc.id ? path.join(__dirname, 'tiktok', 'accounts', acc.id, 'cookies.json') : '');
        if (candidate && fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {
      // ignore and fall back to shared read-only cookie file or anonymous mode
    }
    return fs.existsSync(FALLBACK_COOKIE_PATH) ? FALLBACK_COOKIE_PATH : '';
  }

  _pruneCache() {
    const now = Date.now();
    for (const [k, entry] of this.cache.entries()) {
      if (now - entry.ts >= entry.ttlMs) {
        this.cache.delete(k);
      }
    }
    while (this.cache.size >= this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }
  }

  async _cached(cacheKey, ttlMs, forceRefresh, fetcher) {
    const now = Date.now();
    if (!forceRefresh) {
      const hit = this.cache.get(cacheKey);
      if (hit && (now - hit.ts < ttlMs)) {
        return {
          ...hit.value,
          cached: true,
          cacheAgeSec: Math.max(0, Math.round((now - hit.ts) / 1000))
        };
      }
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey);
    }

    const task = (async () => {
      const result = await fetcher();
      if (result && result.success) {
        this._pruneCache();
        this.cache.set(cacheKey, {
          ts: Date.now(),
          ttlMs,
          value: result
        });
      }
      return { ...result, cached: false, cacheAgeSec: 0 };
    })();

    this.inFlight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  invalidateRadarCache() {
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith('radar:')) {
        this.cache.delete(key);
      }
    }
  }

  async searchLives({ keyword, limit = 18, offset = 0, minViewers = 0, forceRefresh = false } = {}) {
    const kw = String(keyword || '').trim();
    if (!kw) {
      return { success: false, items: [], blocked: false, error: 'Escribe una palabra clave o selecciona una categoría' };
    }
    const cleanLimit = Math.max(1, Math.min(Number(limit) || 18, 40));
    const cleanOffset = Math.max(0, Number(offset) || 0);
    const cleanMin = Math.max(0, Number(minViewers) || 0);
    const key = `search:${kw.toLowerCase()}:${cleanLimit}:${cleanOffset}:${cleanMin}`;

    return this._cached(key, this.cacheTtlMs, forceRefresh, async () => {
      const cookiePath = this._resolveReadonlyCookiePath();
      return execScraper([
        '--search', kw,
        '--limit', String(cleanLimit),
        '--offset', String(cleanOffset),
        '--min-viewers', String(cleanMin)
      ], { cookiePath, timeoutMs: 25000 });
    });
  }

  async lookupUser(target, { forceRefresh = false } = {}) {
    const handle = extractTikTokHandle(target);
    if (!handle) {
      return { success: false, is_live: false, error: 'Handle o URL de TikTok inválida' };
    }
    const key = `lookup:${handle.toLowerCase()}`;
    return this._cached(key, 30000, forceRefresh, async () => {
      const cookiePath = this._resolveReadonlyCookiePath();
      return lookupTikTokRoom(handle, { cookiePath, timeoutMs: 18000 });
    });
  }

  async checkRadar({ forceRefresh = false } = {}) {
    const saved = this.accountStore?.listRadar?.() || [];
    if (saved.length === 0) {
      return { success: true, items: [], blocked: false, cached: false, cacheAgeSec: 0 };
    }

    const noteMap = new Map();
    const handles = [];
    for (const entry of saved) {
      const h = extractTikTokHandle(entry.handle);
      if (!h) continue;
      handles.push(h);
      noteMap.set(h.toLowerCase(), entry);
    }
    if (handles.length === 0) {
      return { success: true, items: [], blocked: false, cached: false, cacheAgeSec: 0 };
    }

    const sortedKey = handles.map(h => h.toLowerCase()).sort().join(',');
    const cacheKey = `radar:${sortedKey}`;

    return this._cached(cacheKey, this.radarTtlMs, forceRefresh, async () => {
      const cookiePath = this._resolveReadonlyCookiePath();
      const res = await execScraper(['--check-batch', handles.join(',')], {
        cookiePath,
        timeoutMs: 35000
      });
      if (!res.success && (!res.items || res.items.length === 0)) {
        return {
          ...res,
          items: handles.map(h => {
            const meta = noteMap.get(h.toLowerCase()) || {};
            return {
              handle: h,
              nickname: h,
              is_live: false,
              viewers: 0,
              note: meta.note || '',
              addedAt: meta.addedAt || '',
              live_url: `https://www.tiktok.com/@${h}/live`,
              error: res.error || ''
            };
          })
        };
      }

      const enriched = (res.items || []).map(item => {
        const meta = noteMap.get(String(item.handle || '').toLowerCase()) || {};
        return {
          ...item,
          note: meta.note || '',
          addedAt: meta.addedAt || ''
        };
      });

      enriched.sort((a, b) => {
        if (Boolean(a.is_live) !== Boolean(b.is_live)) {
          return a.is_live ? -1 : 1;
        }
        return (b.viewers || 0) - (a.viewers || 0);
      });

      return {
        ...res,
        items: enriched
      };
    });
  }

  destroy() {
    this.cache.clear();
    this.inFlight.clear();
  }
}
