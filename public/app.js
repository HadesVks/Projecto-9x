// Projecto 9x Client Application

let presets = {};
let currentStatus = 'idle';
let uptimeTimer = null;
let streamStartedTime = null;

// DOM Elements
const sourceUrlInput = document.getElementById('sourceUrl');
const platformSelect = document.getElementById('platformSelect');
const rtmpServerGroup = document.getElementById('rtmpServerGroup');
const rtmpServerInput = document.getElementById('rtmpServer');
const streamKeyGroup = document.getElementById('streamKeyGroup');
const streamKeyInput = document.getElementById('streamKey');
const toggleKeyBtn = document.getElementById('toggleKeyBtn');
const tiktokSpecialBox = document.getElementById('tiktokSpecialBox');
const tiktokShield = document.getElementById('tiktokShield');
const checkTikTokBtn = document.getElementById('checkTikTokBtn');
const tiktokAutoRoom = document.getElementById('tiktokAutoRoom');
const tiktokTitleGroup = document.getElementById('tiktokTitleGroup');
const tiktokTitle = document.getElementById('tiktokTitle');
const autoReconnectInput = document.getElementById('autoReconnect');
const reconnectDelayInput = document.getElementById('reconnectDelay');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const liveBadge = document.getElementById('liveBadge');
const liveStatusText = document.getElementById('liveStatusText');
const uptimeDisplay = document.getElementById('uptimeDisplay');
const metricFps = document.getElementById('metricFps');
const metricBitrate = document.getElementById('metricBitrate');
const metricSpeed = document.getElementById('metricSpeed');
const metricFrames = document.getElementById('metricFrames');
const infoPlatform = document.getElementById('infoPlatform');
const infoMode = document.getElementById('infoMode');
const shareUrlRow = document.getElementById('shareUrlRow');
const infoShareLink = document.getElementById('infoShareLink');
const logsTerminal = document.getElementById('logsTerminal');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const modeCards = document.querySelectorAll('.mode-card');

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function updateUptime() {
  if (streamStartedTime && currentStatus === 'running') {
    const elapsed = Math.floor((Date.now() - streamStartedTime) / 1000);
    uptimeDisplay.textContent = formatUptime(elapsed);
  } else {
    uptimeDisplay.textContent = '00:00:00';
  }
}

// Mode Selection Handler
modeCards.forEach((card) => {
  card.addEventListener('click', () => {
    modeCards.forEach((c) => c.classList.remove('active'));
    card.classList.add('active');
    const radio = card.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;
  });
});

function getSelectedMode() {
  const checked = document.querySelector('input[name="videoMode"]:checked');
  return checked ? checked.value : 'vertical_blur';
}

function setSelectedMode(mode) {
  modeCards.forEach((card) => {
    const radio = card.querySelector('input[type="radio"]');
    if (radio && radio.value === mode) {
      card.classList.add('active');
      radio.checked = true;
    } else {
      card.classList.remove('active');
    }
  });
}

// Stream Key Toggle
toggleKeyBtn.addEventListener('click', () => {
  if (streamKeyInput.type === 'password') {
    streamKeyInput.type = 'text';
    toggleKeyBtn.textContent = '🔒';
  } else {
    streamKeyInput.type = 'password';
    toggleKeyBtn.textContent = '👁️';
  }
});

// UI visibility for TikTok vs other platforms
function updatePlatformUI() {
  const isTikTok = platformSelect.value === 'tiktok';
  if (isTikTok) {
    tiktokSpecialBox.style.display = 'flex';
    if (tiktokAutoRoom.checked) {
      rtmpServerGroup.style.display = 'none';
      streamKeyGroup.style.display = 'none';
      tiktokTitleGroup.style.display = 'flex';
    } else {
      rtmpServerGroup.style.display = 'flex';
      streamKeyGroup.style.display = 'flex';
      tiktokTitleGroup.style.display = 'none';
    }
  } else {
    tiktokSpecialBox.style.display = 'none';
    rtmpServerGroup.style.display = 'flex';
    streamKeyGroup.style.display = 'flex';
  }

  // Auto-fill RTMP server if available
  const key = platformSelect.value;
  if (presets[key] && presets[key].rtmpServer && !isTikTok) {
    rtmpServerInput.value = presets[key].rtmpServer;
  }
}

platformSelect.addEventListener('change', updatePlatformUI);
tiktokAutoRoom.addEventListener('change', updatePlatformUI);

// Verify TikTok Session
async function checkTikTokSession() {
  tiktokShield.textContent = '🛡️ Verificando sesión...';
  tiktokShield.className = 'shield-badge';
  try {
    const res = await fetch('/api/tiktok/verify');
    const data = await res.json();
    if (data.valid && data.can_stream) {
      tiktokShield.textContent = '🛡️ Sesión TikTok: Verificada y Activa (Anti-Baneo OK)';
      tiktokShield.className = 'shield-badge shield-ok';
    } else {
      tiktokShield.textContent = '⚠️ TikTok: ' + (data.error || 'Sesión no disponible');
      tiktokShield.className = 'shield-badge';
    }
  } catch (err) {
    tiktokShield.textContent = '⚠️ Error conectando al verificador';
  }
}

checkTikTokBtn.addEventListener('click', checkTikTokSession);

// Log Entry
function appendLog(entry) {
  const div = document.createElement('div');
  div.className = `log-entry log-${entry.type || 'info'}`;
  div.textContent = `[${entry.time}] ${entry.message}`;
  logsTerminal.appendChild(div);
  logsTerminal.scrollTop = logsTerminal.scrollHeight;
}

clearLogsBtn.addEventListener('click', () => {
  logsTerminal.innerHTML = '';
});

// Handle Engine Status Updates
function handleStatusUpdate(data) {
  currentStatus = data.status;
  liveBadge.className = 'badge';

  if (currentStatus === 'running') {
    liveBadge.classList.add('badge-running');
    liveStatusText.textContent = 'EN VIVO';
    startBtn.disabled = true;
    stopBtn.disabled = false;
    if (data.startedAt) streamStartedTime = data.startedAt;
  } else if (currentStatus === 'checking') {
    liveBadge.classList.add('badge-starting');
    liveStatusText.textContent = 'VERIFICANDO...';
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else if (currentStatus === 'starting') {
    liveBadge.classList.add('badge-starting');
    liveStatusText.textContent = 'CONECTANDO...';
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else if (currentStatus === 'stopping') {
    liveBadge.classList.add('badge-starting');
    liveStatusText.textContent = 'DETENIENDO...';
    startBtn.disabled = true;
    stopBtn.disabled = true;
  } else if (currentStatus === 'finished') {
    liveBadge.classList.add('badge-idle');
    liveStatusText.textContent = 'FINALIZADO';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    streamStartedTime = null;
    updateUptime();
  } else {
    // idle / error
    liveBadge.classList.add('badge-idle');
    liveStatusText.textContent = 'INACTIVO';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    streamStartedTime = null;
    updateUptime();
  }

  // Active Stream info box
  if (data.config) {
    infoPlatform.textContent = (data.config.platform || 'Custom').toUpperCase();
    let modeText = 'Vertical 9:16 (Blur)';
    if (data.config.mode === 'copy') modeText = 'Copia Directa 16:9';
    if (data.config.mode === 'vertical_crop') modeText = 'Vertical 9:16 (Crop)';
    infoMode.textContent = modeText;
  } else {
    infoPlatform.textContent = 'Ninguno';
    infoMode.textContent = 'Sin transmisión activa';
  }

  // Share URL if present
  if (data.tiktokSession && data.tiktokSession.shareUrl) {
    shareUrlRow.style.display = 'flex';
    infoShareLink.href = data.tiktokSession.shareUrl;
    infoShareLink.textContent = `Sala ${data.tiktokSession.roomId} ↗`;
  } else {
    shareUrlRow.style.display = 'none';
  }

  // Stats
  if (data.stats) {
    metricFps.textContent = (data.stats.fps || 0).toFixed(1);
    metricBitrate.textContent = data.stats.bitrate || '0k';
    metricSpeed.textContent = data.stats.speed || '0.0x';
    metricFrames.textContent = data.stats.frames || '0';
  }
}

// Load Initial Config
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    presets = data.presets || {};

    const last = data.lastConfig || {};
    if (last.sourceUrl) sourceUrlInput.value = last.sourceUrl;
    if (last.platform) platformSelect.value = last.platform;
    if (last.rtmpServer) rtmpServerInput.value = last.rtmpServer;
    if (last.streamKey) streamKeyInput.value = last.streamKey;
    if (last.mode) setSelectedMode(last.mode);
    if (last.autoReconnect !== undefined) autoReconnectInput.checked = last.autoReconnect;
    if (last.reconnectDelay) reconnectDelayInput.value = last.reconnectDelay;
    if (last.tiktokAutoRoom !== undefined) tiktokAutoRoom.checked = last.tiktokAutoRoom;
    if (last.tiktokTitle) tiktokTitle.value = last.tiktokTitle;

    updatePlatformUI();
    checkTikTokSession();
  } catch (err) {
    appendLog({ time: new Date().toLocaleTimeString(), type: 'error', message: 'Error cargando configuración: ' + err.message });
  }
}

// SSE Connection
function connectSSE() {
  const evtSource = new EventSource('/api/stream/events');

  evtSource.addEventListener('status', (e) => {
    try {
      const data = JSON.parse(e.data);
      handleStatusUpdate(data);
    } catch (err) {}
  });

  evtSource.addEventListener('stats', (e) => {
    try {
      const stats = JSON.parse(e.data);
      metricFps.textContent = (stats.fps || 0).toFixed(1);
      metricBitrate.textContent = stats.bitrate || '0k';
      metricSpeed.textContent = stats.speed || '0.0x';
      metricFrames.textContent = stats.frames || '0';
    } catch (err) {}
  });

  evtSource.addEventListener('log', (e) => {
    try {
      const log = JSON.parse(e.data);
      appendLog(log);
    } catch (err) {}
  });

  evtSource.addEventListener('init_logs', (e) => {
    try {
      const logs = JSON.parse(e.data);
      logsTerminal.innerHTML = '';
      logs.forEach((log) => appendLog(log));
    } catch (err) {}
  });

  evtSource.onerror = () => {
    // SSE auto-reconnects natively
  };
}

// Start Button Handler
startBtn.addEventListener('click', async () => {
  const sourceUrl = sourceUrlInput.value.trim();
  const platform = platformSelect.value;
  const isTikTokAuto = (platform === 'tiktok' && tiktokAutoRoom.checked);
  const rtmpServer = rtmpServerInput.value.trim();
  const streamKey = streamKeyInput.value.trim();
  const mode = getSelectedMode();
  const autoReconnect = autoReconnectInput.checked;
  const reconnectDelay = parseInt(reconnectDelayInput.value, 10) || 5;
  const tTitle = tiktokTitle.value.trim();

  if (!sourceUrl) {
    alert('Ingresa la URL del en vivo de origen (ej: YouTube)');
    sourceUrlInput.focus();
    return;
  }

  if (!isTikTokAuto) {
    if (!rtmpServer) {
      alert('Ingresa el servidor RTMP de destino.');
      rtmpServerInput.focus();
      return;
    }
    if (!streamKey) {
      alert('Ingresa la clave de transmisión (Stream Key).');
      streamKeyInput.focus();
      return;
    }
  }

  startBtn.disabled = true;
  appendLog({ time: new Date().toLocaleTimeString(), type: 'info', message: 'Iniciando proceso de verificación y transmisión...' });

  try {
    const res = await fetch('/api/stream/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceUrl,
        platform,
        rtmpServer,
        streamKey,
        mode,
        autoReconnect,
        reconnectDelay,
        tiktokAutoRoom: isTikTokAuto,
        tiktokTitle: tTitle
      })
    });
    const result = await res.json();
    if (!result.success) {
      alert('Error al iniciar: ' + (result.error || 'Desconocido'));
      startBtn.disabled = false;
    }
  } catch (err) {
    alert('Error al conectar con el servidor: ' + err.message);
    startBtn.disabled = false;
  }
});

// Stop Button Handler
stopBtn.addEventListener('click', async () => {
  if (!confirm('¿Seguro que deseas detener la transmisión en vivo?')) {
    return;
  }

  stopBtn.disabled = true;
  appendLog({ time: new Date().toLocaleTimeString(), type: 'info', message: 'Enviando orden de detención...' });

  try {
    const res = await fetch('/api/stream/stop', { method: 'POST' });
    const result = await res.json();
    if (!result.success) {
      alert('Error al detener: ' + (result.error || 'Desconocido'));
      stopBtn.disabled = false;
    }
  } catch (err) {
    alert('Error al conectar con el servidor: ' + err.message);
    stopBtn.disabled = false;
  }
});

window.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  connectSSE();
  uptimeTimer = setInterval(updateUptime, 1000);
});
