import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StreamEngine } from './stream_engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'config.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cargar configuración persistente
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Error leyendo config.json:', err.message);
  }
  return {
    port: 9090,
    lastConfig: {},
    savedPresets: {}
  };
}

function saveConfig(data) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error guardando config.json:', err.message);
  }
}

let appConfig = loadConfig();
const engine = new StreamEngine();

// SSE (Server-Sent Events) clients
const sseClients = new Set();

function broadcastEvent(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Suscribir eventos del motor a SSE
engine.on('status', (status) => broadcastEvent('status', status));
engine.on('log', (log) => broadcastEvent('log', log));
engine.on('stats', (stats) => broadcastEvent('stats', stats));

// SSE Endpoint
app.get('/api/stream/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Enviar estado inicial y logs
  res.write(`event: status\ndata: ${JSON.stringify(engine.getStatus())}\n\n`);
  res.write(`event: init_logs\ndata: ${JSON.stringify(engine.getLogs())}\n\n`);

  // Heartbeat cada 15 segundos
  const pingInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    sseClients.delete(res);
  });
});

// Obtener Configuración y Presets
app.get('/api/config', (req, res) => {
  res.json({
    presets: appConfig.savedPresets || {},
    lastConfig: appConfig.lastConfig || {}
  });
});

// Guardar Configuración / Presets
app.post('/api/config', (req, res) => {
  const { presets, lastConfig } = req.body;
  if (presets) appConfig.savedPresets = presets;
  if (lastConfig) appConfig.lastConfig = { ...appConfig.lastConfig, ...lastConfig };
  saveConfig(appConfig);
  res.json({ success: true, message: 'Configuración guardada.' });
});

// Verificar estado de sesión y cookies de TikTok
app.get('/api/tiktok/verify', async (req, res) => {
  try {
    const result = await engine.verifyTikTokSession();
    res.json(result);
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// Estado actual del motor
app.get('/api/status', (req, res) => {
  res.json({
    ...engine.getStatus(),
    logs: engine.getLogs().slice(-50)
  });
});

// Iniciar Transmisión
app.post('/api/stream/start', async (req, res) => {
  try {
    const { 
      sourceUrl, 
      platform, 
      rtmpServer, 
      streamKey, 
      mode, 
      autoReconnect, 
      reconnectDelay,
      tiktokAutoRoom,
      tiktokTitle 
    } = req.body;

    appConfig.lastConfig = {
      sourceUrl,
      platform,
      rtmpServer,
      streamKey,
      mode,
      autoReconnect,
      reconnectDelay,
      tiktokAutoRoom: !!tiktokAutoRoom,
      tiktokTitle: tiktokTitle || ''
    };
    saveConfig(appConfig);

    await engine.start({
      sourceUrl,
      platform,
      rtmpServer,
      streamKey,
      mode,
      autoReconnect,
      reconnectDelay,
      tiktokAutoRoom,
      tiktokTitle
    });

    res.json({ success: true, message: 'Transmisión iniciada con éxito.' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Detener Transmisión
app.post('/api/stream/stop', async (req, res) => {
  try {
    const result = await engine.stop();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || appConfig.port || 9090;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` Projecto 9x — Panel Web Activo en puerto ${PORT}`);
  console.log(` LAN:       http://10.0.0.3:${PORT}`);
  console.log(` Tailscale: http://100.109.45.25:${PORT}`);
  console.log(`====================================================`);
});
