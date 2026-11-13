import crypto from 'crypto';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { AccountStore } from './account_store.js';
import { ChannelMonitor } from './channel_monitor.js';
import {
  StreamManager,
  QUALITY_PROFILES,
  DONATION_STYLES,
  TIKTOK_TOPICS
} from './stream_engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const store = new AccountStore();
const manager = new StreamManager();
const monitor = new ChannelMonitor(store, manager);

const sseClients = new Set();

function broadcast(eventName, payload) {
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

manager.on('stream_status', (s) => broadcast('stream_status', s));
manager.on('stream_stats', (p) => broadcast('stream_stats', p));
manager.on('stream_log', (l) => broadcast('stream_log', l));
manager.on('stream_removed', (r) => broadcast('stream_removed', r));
monitor.on('monitors_updated', (m) => broadcast('monitors', m));

setInterval(() => {
  if (sseClients.size > 0) {
    broadcast('system', manager.getSystemMetrics());
  }
}, 4000);

// --- Autenticación Opcional por PIN (Cookie HttpOnly firmada) ---
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function signAuthToken() {
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', store.getSessionSecret()).update(ts).digest('hex');
  return `${ts}.${sig}`;
}

function isTokenValid(token) {
  if (!token || !token.includes('.')) return false;
  const [ts, sig] = token.split('.', 2);
  if (!ts || !sig) return false;
  const expected = crypto.createHmac('sha256', store.getSessionSecret()).update(ts).digest('hex');
  const a = Buffer.from(sig, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const ageMs = Date.now() - Number(ts);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 7 * 24 * 3600 * 1000;
}

function isAuthenticated(req) {
  if (!store.hasAdminPin()) return true;
  const cookies = parseCookies(req);
  return isTokenValid(cookies.p9x_token);
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ success: false, authRequired: true, error: 'PIN requerido.' });
}

app.get('/api/auth/status', (req, res) => {
  res.json({
    pinEnabled: store.hasAdminPin(),
    authenticated: isAuthenticated(req),
    envLocked: Boolean(process.env.ADMIN_PIN && process.env.ADMIN_PIN.trim())
  });
});

app.post('/api/auth/login', (req, res) => {
  if (!store.hasAdminPin()) {
    return res.json({ success: true, authenticated: true });
  }
  if (!store.verifyAdminPin(req.body?.pin)) {
    return res.status(401).json({ success: false, error: 'PIN incorrecto.' });
  }
  const token = signAuthToken();
  res.setHeader('Set-Cookie', `p9x_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
  res.json({ success: true, authenticated: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'p9x_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ success: true });
});

app.post('/api/auth/pin', requireAuth, (req, res) => {
  try {
    const result = store.setAdminPin(req.body?.pin || '');
    if (result.enabled) {
      const token = signAuthToken();
      res.setHeader('Set-Cookie', `p9x_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
    } else {
      res.setHeader('Set-Cookie', 'p9x_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    }
    res.json({ success: true, pinEnabled: result.enabled });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Proteger todas las demás rutas /api/* cuando hay PIN activo
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  return requireAuth(req, res, next);
});

// SSE Stream
app.get('/api/stream/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  res.write(`event: init\ndata: ${JSON.stringify({
    streams: manager.listStreams(),
    monitors: monitor.listWithStatus(),
    system: manager.getSystemMetrics()
  })}\n\n`);

  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// Bootstrap inicial para el Dashboard
app.get('/api/bootstrap', (req, res) => {
  res.json({
    presets: store.getPresets(),
    qualityProfiles: QUALITY_PROFILES,
    donationStyles: DONATION_STYLES,
    tiktokTopics: TIKTOK_TOPICS,
    accounts: store.listAccountsSafe(),
    streams: manager.listStreams(),
    monitors: monitor.listWithStatus(),
    donationDefaults: store.getDonationDefaults(),
    lastConfig: store.getLastConfig(),
    system: manager.getSystemMetrics(),
    pinEnabled: store.hasAdminPin()
  });
});

// --- Cuentas (Multi-Cuenta) ---
app.get('/api/accounts', (req, res) => {
  res.json({ accounts: store.listAccountsSafe() });
});

app.post('/api/accounts', async (req, res) => {
  try {
    const acc = store.createAccount(req.body);
    if (acc.platform === 'tiktok' && acc.authType === 'cookies') {
      try {
        await store.verifyTikTokAccount(acc.id);
      } catch {}
    }
    res.json({ success: true, account: store.listAccountsSafe().find((a) => a.id === acc.id) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/accounts/:id', async (req, res) => {
  try {
    if (manager.isAccountInUse(req.params.id)) {
      return res.status(409).json({
        success: false,
        error: 'Detén el stream activo de esta cuenta antes de editarla.'
      });
    }
    const updated = store.updateAccount(req.params.id, req.body || {});
    if (updated.platform === 'tiktok' && updated.authType === 'cookies' && req.body?.cookiesJson) {
      try {
        await store.verifyTikTokAccount(updated.id);
      } catch {}
    }
    res.json({
      success: true,
      account: store.listAccountsSafe().find((a) => a.id === updated.id)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/:id/verify', async (req, res) => {
  try {
    const result = await store.verifyTikTokAccount(req.params.id);
    res.json({
      success: true,
      result,
      account: store.listAccountsSafe().find((a) => a.id === req.params.id)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/accounts/:id', (req, res) => {
  try {
    if (manager.isAccountInUse(req.params.id)) {
      return res.status(409).json({
        success: false,
        error: 'Esta cuenta está transmitiendo en vivo actualmente. Detén el stream primero.'
      });
    }
    const result = store.deleteAccount(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Donaciones ---
app.patch('/api/donations/defaults', (req, res) => {
  const updated = store.updateDonationDefaults(req.body || {});
  res.json({ success: true, donationDefaults: updated });
});

app.patch('/api/streams/:id/donation', (req, res) => {
  try {
    const updated = manager.updateDonation(req.params.id, req.body || {});
    res.json({ success: true, donation: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Transmisiones (Multi-Stream Simultáneo) ---
app.get('/api/streams', (req, res) => {
  res.json({ streams: manager.listStreams() });
});

app.get('/api/streams/:id/logs', (req, res) => {
  res.json({ logs: manager.getStreamLogs(req.params.id) });
});

app.post('/api/streams', async (req, res) => {
  try {
    const {
      sourceUrl,
      accountId,
      mode,
      quality,
      encoder,
      tiktokTitle,
      topicId,
      autoReconnect,
      reconnectDelay,
      donation
    } = req.body;

    const account = store.getAccountRaw(accountId);
    if (!account) {
      return res.status(400).json({ success: false, error: 'Cuenta destino inválida o no encontrada.' });
    }

    store.saveLastConfig({
      sourceUrl,
      accountId,
      mode,
      quality,
      encoder,
      tiktokTitle,
      topicId,
      autoReconnect,
      reconnectDelay
    });
    if (donation) {
      store.updateDonationDefaults(donation);
    }

    const summary = await manager.createAndStartStream({
      sourceUrl,
      mode,
      quality,
      encoder,
      tiktokTitle,
      topicId,
      autoReconnect,
      reconnectDelay,
      donation
    }, account);

    res.json({ success: true, stream: summary });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/streams/:id/stop', async (req, res) => {
  try {
    const result = await manager.stopStream(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

app.delete('/api/streams/:id', async (req, res) => {
  try {
    const result = await manager.removeStream(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

// --- Auto-Restreamer 24/7 (Monitores) ---
app.get('/api/monitors', (req, res) => {
  res.json({ monitors: monitor.listWithStatus() });
});

app.post('/api/monitors', (req, res) => {
  try {
    const mon = store.createMonitor(req.body || {});
    monitor.refreshMonitor(mon.id);
    res.json({
      success: true,
      monitor: monitor.listWithStatus().find((m) => m.id === mon.id)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.patch('/api/monitors/:id/toggle', (req, res) => {
  try {
    const cur = store.listMonitors().find((m) => m.id === req.params.id);
    if (!cur) return res.status(404).json({ success: false, error: 'Monitor no encontrado.' });
    const nextEnabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : !cur.enabled;
    store.updateMonitor(cur.id, { enabled: nextEnabled });
    monitor.refreshMonitor(cur.id);
    res.json({
      success: true,
      monitor: monitor.listWithStatus().find((m) => m.id === cur.id)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/monitors/:id/check', async (req, res) => {
  try {
    const rt = await monitor.checkNow(req.params.id, true);
    res.json({ success: true, runtime: rt });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/monitors/:id', (req, res) => {
  try {
    const resDel = store.deleteMonitor(req.params.id);
    monitor.refreshMonitor(req.params.id);
    res.json({ success: true, ...resDel });
  } catch (err) {
    res.status(404).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || store.getPort() || 9090;
let server;

async function startServer() {
  await manager.cleanupStaleSessions();
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(` Projecto 9x v2.5 — Multi-Stream & Auto-Restreamer :${PORT}`);
    console.log(` LAN:       http://10.0.0.3:${PORT}`);
    console.log(` Tailscale: http://100.109.45.25:${PORT}`);
    console.log(`====================================================`);
  });
  monitor.startAll();
}

let shuttingDown = false;
async function gracefulShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] Señal ${sig} recibida; cerrando monitores y streams activos...`);
  monitor.stop();
  try {
    await manager.stopAll();
  } catch {}
  if (server) {
    server.close(() => process.exit(0));
  }
  setTimeout(() => process.exit(0), 2500);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();
