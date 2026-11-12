import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { AccountStore } from './account_store.js';
import { StreamManager, QUALITY_PROFILES } from './stream_engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const store = new AccountStore();
const manager = new StreamManager();

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

// Emitir métricas del sistema cada 4s mientras haya clientes conectados
setInterval(() => {
  if (sseClients.size > 0) {
    broadcast('system', manager.getSystemMetrics());
  }
}, 4000);

// SSE Stream
app.get('/api/stream/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  res.write(`event: init\ndata: ${JSON.stringify({
    streams: manager.listStreams(),
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
    accounts: store.listAccountsSafe(),
    streams: manager.listStreams(),
    donationDefaults: store.getDonationDefaults(),
    lastConfig: store.getLastConfig(),
    system: manager.getSystemMetrics()
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

const PORT = process.env.PORT || store.getPort() || 9090;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` Projecto 9x v2 — Multi-Stream & GPU VAAPI en :${PORT}`);
  console.log(` LAN:       http://10.0.0.3:${PORT}`);
  console.log(` Tailscale: http://100.109.45.25:${PORT}`);
  console.log(`====================================================`);
});

let shuttingDown = false;
async function gracefulShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] Señal ${sig} recibida; cerrando streams activos...`);
  try {
    await manager.stopAll();
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
