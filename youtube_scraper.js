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
const SCRAPER_PY = path.join(__dirname, 'youtube_live_scraper.py');

const HANDLE_RE = /^[a-zA-Z0-9._-]{2,64}$/;
const UC_RE = /^UC[a-zA-Z0-9_-]{22}$/;
const VID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function extractYouTubeTarget(rawTarget) {
  if (!rawTarget || typeof rawTarget !== 'string') return '';
  const text = rawTarget.trim();
  if (!text) return '';

  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      const host = parsed.hostname.toLowerCase();
      if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
        return '';
      }
      if (host === 'youtu.be') {
        const vid = parsed.pathname.replace(/^\/+/, '').split('/')[0] || '';
        return VID_RE.test(vid) ? `https://www.youtube.com/watch?v=${vid}` : '';
      }
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (!parts.length) return '';
      if (parts[0] === 'watch') {
        const v = parsed.searchParams.get('v') || '';
        return VID_RE.test(v) ? `https://www.youtube.com/watch?v=${v}` : '';
      }
      if (parts[0] === 'live' && VID_RE.test(parts[1] || '')) {
        return `https://www.youtube.com/watch?v=${parts[1]}`;
      }
      if (parts[0].startsWith('@') && HANDLE_RE.test(parts[0].slice(1))) {
        return `https://www.youtube.com/${parts[0]}/live`;
      }
      if (parts[0] === 'channel' && UC_RE.test(parts[1] || '')) {
        return `https://www.youtube.com/channel/${parts[1]}/live`;
      }
      if ((parts[0] === 'c' || parts[0] === 'user') && HANDLE_RE.test(parts[1] || '')) {
        return `https://www.youtube.com/${parts[0]}/${parts[1]}/live`;
      }
      return '';
    } catch {
      return '';
    }
  }

  if (UC_RE.test(text)) return `https://www.youtube.com/channel/${text}/live`;
  const clean = text.startsWith('@') ? text.slice(1) : text;
  if (HANDLE_RE.test(clean)) return `https://www.youtube.com/@${clean}/live`;
  return '';
}

async function execScraper(args, timeoutMs = 22000) {
  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, [SCRAPER_PY, ...args], {
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
        // fall through
      }
    }
    return {
      success: false,
      blocked: false,
      items: [],
      error: err.killed ? 'Timeout consultando YouTube Live' : (err.message || 'Error ejecutando scraper YouTube')
    };
  }
}

export class YouTubeDiscoveryService {
  constructor(accountStore, { cacheTtlMs = 60000, radarTtlMs = 45000, maxCacheEntries = 50 } = {}) {
    this.accountStore = accountStore;
    this.cacheTtlMs = cacheTtlMs;
    this.radarTtlMs = radarTtlMs;
    this.maxCacheEntries = maxCacheEntries;
    this.cache = new Map();
    this.inFlight = new Map();
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

  async searchLives({ keyword, limit = 18, minViewers = 0, forceRefresh = false } = {}) {
    const kw = String(keyword || '').trim();
    if (!kw) {
      return { success: false, items: [], blocked: false, error: 'Escribe una palabra clave o selecciona una categoría' };
    }
    const cleanLimit = Math.max(1, Math.min(Number(limit) || 18, 40));
    const cleanMin = Math.max(0, Number(minViewers) || 0);
    const key = `search:${kw.toLowerCase()}:${cleanLimit}:${cleanMin}`;

    return this._cached(key, this.cacheTtlMs, forceRefresh, async () => {
      return execScraper([
        '--search', kw,
        '--limit', String(cleanLimit),
        '--min-viewers', String(cleanMin)
      ], 25000);
    });
  }

  async lookupChannel(target, { forceRefresh = false } = {}) {
    const normalized = extractYouTubeTarget(target);
    if (!normalized) {
      return {
        success: false,
        is_live: false,
        blocked: false,
        error: 'Canal o enlace de YouTube inválido (usa @canal o URL de youtube.com)'
      };
    }
    const key = `lookup:${normalized.toLowerCase()}`;
    return this._cached(key, 30000, forceRefresh, async () => {
      return execScraper(['--lookup', normalized], 18000);
    });
  }

  async checkRadar({ forceRefresh = false } = {}) {
    const saved = this.accountStore?.listRadar?.() || [];
    if (saved.length === 0) {
      return { success: true, items: [], blocked: false, cached: false, cacheAgeSec: 0 };
    }

    const metaMap = new Map();
    const validPairs = [];
    for (const entry of saved) {
      const targetUrl = entry.channelUrl || extractYouTubeTarget(entry.handle);
      if (!targetUrl) continue;
      validPairs.push({ entry, targetUrl });
      metaMap.set(String(entry.handle || '').toLowerCase(), entry);
      metaMap.set(targetUrl.toLowerCase(), entry);
    }
    const targets = validPairs.map((p) => p.targetUrl);
    if (targets.length === 0) {
      return { success: true, items: [], blocked: false, cached: false, cacheAgeSec: 0 };
    }

    const sortedKey = targets.map((t) => t.toLowerCase()).sort().join(',');
    const cacheKey = `radar:${sortedKey}`;

    return this._cached(cacheKey, this.radarTtlMs, forceRefresh, async () => {
      const res = await execScraper(['--check-batch', targets.join(',')], 35000);
      if (!res.success && (!res.items || res.items.length === 0)) {
        return {
          ...res,
          items: saved.map((entry) => ({
            handle: entry.handle,
            channel_name: entry.handle,
            is_live: false,
            viewers: 0,
            note: entry.note || '',
            addedAt: entry.addedAt || '',
            channel_live_url: entry.channelUrl || extractYouTubeTarget(entry.handle),
            live_url: entry.channelUrl || extractYouTubeTarget(entry.handle),
            error: res.error || ''
          }))
        };
      }

      const enriched = (res.items || []).map((item, idx) => {
        const stored = validPairs[idx]?.entry || {};
        const byHandle = metaMap.get(String(item.handle || '').toLowerCase())
          || metaMap.get(String(item.channel_live_url || '').toLowerCase());
        const meta = byHandle || stored || {};
        return {
          ...item,
          handle: meta.handle || item.handle,
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
