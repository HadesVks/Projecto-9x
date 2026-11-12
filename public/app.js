const state = {
  presets: {},
  qualityProfiles: {},
  accounts: [],
  streams: new Map(),
  logsByStream: new Map(),
  openLogs: new Set(),
  system: null
};

const dom = {
  vaapiPill: document.getElementById('vaapiPill'),
  activeStreamsPill: document.getElementById('activeStreamsPill'),
  sysResourcesPill: document.getElementById('sysResourcesPill'),
  accountsCount: document.getElementById('accountsCount'),
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabPanels: document.querySelectorAll('.tab-panel'),

  // Stream Form
  streamForm: document.getElementById('streamForm'),
  accountSelect: document.getElementById('accountSelect'),
  sourceUrl: document.getElementById('sourceUrl'),
  tiktokTitleGroup: document.getElementById('tiktokTitleGroup'),
  tiktokTitle: document.getElementById('tiktokTitle'),
  modeSelect: document.getElementById('modeSelect'),
  qualitySelect: document.getElementById('qualitySelect'),
  donEnabled: document.getElementById('donEnabled'),
  donSettingsArea: document.getElementById('donSettingsArea'),
  donText: document.getElementById('donText'),
  donPosition: document.getElementById('donPosition'),
  donDisplayMode: document.getElementById('donDisplayMode'),
  donTimingRow: document.getElementById('donTimingRow'),
  donInterval: document.getElementById('donInterval'),
  donDuration: document.getElementById('donDuration'),
  autoReconnect: document.getElementById('autoReconnect'),
  reconnectDelay: document.getElementById('reconnectDelay'),
  launchStreamBtn: document.getElementById('launchStreamBtn'),
  streamsContainer: document.getElementById('streamsContainer'),

  // Account Form
  accountForm: document.getElementById('accountForm'),
  accName: document.getElementById('accName'),
  accPlatform: document.getElementById('accPlatform'),
  accAuthTypeGroup: document.getElementById('accAuthTypeGroup'),
  accAuthType: document.getElementById('accAuthType'),
  accCookiesArea: document.getElementById('accCookiesArea'),
  accCookiesFile: document.getElementById('accCookiesFile'),
  accCookiesJson: document.getElementById('accCookiesJson'),
  accManualArea: document.getElementById('accManualArea'),
  accRtmpServer: document.getElementById('accRtmpServer'),
  accStreamKey: document.getElementById('accStreamKey'),
  saveAccountBtn: document.getElementById('saveAccountBtn'),
  accountsContainer: document.getElementById('accountsContainer')
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUptime(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function notify(message, isError = false) {
  let bar = document.getElementById('toastBanner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'toastBanner';
    bar.style.cssText = [
      'position:fixed',
      'bottom:20px',
      'right:20px',
      'z-index:9999',
      'max-width:420px',
      'padding:12px 16px',
      'border-radius:10px',
      'font-size:0.88rem',
      'font-weight:600',
      'box-shadow:0 8px 24px rgba(0,0,0,0.45)',
      'transition:opacity 0.25s ease'
    ].join(';');
    document.body.appendChild(bar);
  }
  bar.textContent = message;
  bar.style.background = isError ? 'rgba(255, 51, 102, 0.94)' : 'rgba(0, 210, 118, 0.94)';
  bar.style.color = isError ? '#ffffff' : '#061018';
  bar.style.opacity = '1';
  clearTimeout(bar._timer);
  bar._timer = setTimeout(() => {
    bar.style.opacity = '0';
  }, 4000);
}

// --- Tabs ---
function initTabs() {
  dom.tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      dom.tabBtns.forEach((b) => b.classList.toggle('active', b === btn));
      dom.tabPanels.forEach((p) => p.classList.toggle('active', p.id === `tab-${target}`));
    });
  });
}

// --- System Pills ---
function renderSystemMetrics(sys) {
  if (!sys) return;
  state.system = sys;

  if (sys.vaapiSupported) {
    dom.vaapiPill.textContent = '⚡ GPU: Intel VAAPI Activa';
    dom.vaapiPill.classList.add('pill-ok');
  } else {
    dom.vaapiPill.textContent = '⚙️ Encoder: CPU x264';
    dom.vaapiPill.classList.remove('pill-ok');
  }

  const active = Number.isFinite(sys.activeStreams)
    ? sys.activeStreams
    : Array.from(state.streams.values()).filter((s) => s.status === 'running' || s.status === 'starting').length;

  dom.activeStreamsPill.textContent = `📡 ${active} en vivo`;
  dom.activeStreamsPill.classList.toggle('pill-live', active > 0);

  const tempStr = sys.tempC !== null && sys.tempC !== undefined ? ` • ${sys.tempC}°C` : '';
  dom.sysResourcesPill.textContent = `CPU ${sys.cpuApproxPct ?? '--'}% • RAM ${sys.ramUsedGb ?? '--'}/${sys.ramTotalGb ?? '--'} GB${tempStr}`;
}

// --- Accounts UI ---
function syncAccountFormFields() {
  const plat = dom.accPlatform.value;
  const isTikTok = plat === 'tiktok';
  dom.accAuthTypeGroup.style.display = isTikTok ? 'block' : 'none';

  const useCookies = isTikTok && dom.accAuthType.value === 'cookies';
  dom.accCookiesArea.style.display = useCookies ? 'block' : 'none';
  dom.accManualArea.style.display = useCookies ? 'none' : 'block';

  if (!useCookies) {
    const presetUrl = state.presets[plat]?.rtmpServer || '';
    dom.accRtmpServer.value = presetUrl;
  }
}

function renderAccountSelect() {
  const previousValue = dom.accountSelect.value;
  dom.accountSelect.innerHTML = '';

  if (state.accounts.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Sin cuentas configuradas (Agrega una en la pestaña Cuentas)';
    dom.accountSelect.appendChild(opt);
    dom.launchStreamBtn.disabled = true;
    dom.tiktokTitleGroup.style.display = 'none';
    return;
  }

  dom.launchStreamBtn.disabled = false;
  for (const acc of state.accounts) {
    const platName = state.presets[acc.platform]?.name || acc.platform;
    const handle = acc.username ? ` • @${acc.username}` : '';
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.textContent = `${acc.name} (${platName}${handle})`;
    dom.accountSelect.appendChild(opt);
  }

  if (previousValue && state.accounts.some((a) => a.id === previousValue)) {
    dom.accountSelect.value = previousValue;
  }
  syncSelectedAccountUI();
}

function syncSelectedAccountUI() {
  const acc = state.accounts.find((a) => a.id === dom.accountSelect.value);
  dom.tiktokTitleGroup.style.display = acc && acc.platform === 'tiktok' ? 'block' : 'none';
}

function renderAccounts() {
  dom.accountsCount.textContent = String(state.accounts.length);
  if (state.accounts.length === 0) {
    dom.accountsContainer.innerHTML = '<div class="empty-state">No hay cuentas configuradas aún. Agrega tu primera cuenta en el formulario de la izquierda.</div>';
    return;
  }

  dom.accountsContainer.innerHTML = state.accounts.map((acc) => {
    const platName = state.presets[acc.platform]?.name || acc.platform;
    const methodLabel = acc.authType === 'cookies'
      ? 'Cookies JSON (Auto-Sala + SEI)'
      : `RTMP Manual (${acc.streamKeyMasked || '****'})`;
    const userLabel = acc.username ? `@${acc.username}` : 'Sin usuario verificado';
    const badgeClass = acc.verified ? 'badge-running' : 'badge-idle';
    const badgeText = acc.verified ? (acc.statusText || 'Lista') : (acc.statusText || 'Sin verificar');
    const canVerify = acc.platform === 'tiktok' && acc.authType === 'cookies';

    return `
      <div class="account-card" data-acc-id="${esc(acc.id)}">
        <div class="acc-info">
          <h3>${esc(acc.name)}</h3>
          <div class="acc-sub">
            ${esc(platName)} • ${esc(methodLabel)}${acc.platform === 'tiktok' ? ` • ${esc(userLabel)}` : ''}
          </div>
        </div>
        <div class="acc-actions">
          <span class="badge ${badgeClass}"><span class="dot"></span>${esc(badgeText)}</span>
          ${canVerify ? `<button type="button" class="btn btn-sm btn-neutral-sm btn-verify-acc" data-id="${esc(acc.id)}">🔍 Verificar</button>` : ''}
          <button type="button" class="btn btn-sm btn-danger-sm btn-delete-acc" data-id="${esc(acc.id)}">🗑️ Eliminar</button>
        </div>
      </div>
    `;
  }).join('');
}

async function handleSaveAccount() {
  const name = dom.accName.value.trim();
  const platform = dom.accPlatform.value;
  const authType = platform === 'tiktok' ? dom.accAuthType.value : 'manual';

  if (!name) {
    notify('Escribe un nombre identificador para la cuenta.', true);
    return;
  }

  dom.saveAccountBtn.disabled = true;
  dom.saveAccountBtn.textContent = '⏳ Guardando y verificando...';

  try {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        platform,
        authType,
        rtmpServer: dom.accRtmpServer.value.trim(),
        streamKey: dom.accStreamKey.value.trim(),
        cookiesJson: dom.accCookiesJson.value.trim()
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Error guardando la cuenta');
    }

    state.accounts.push(data.account);
    renderAccounts();
    renderAccountSelect();
    dom.accountSelect.value = data.account.id;
    syncSelectedAccountUI();

    dom.accName.value = '';
    dom.accCookiesFile.value = '';
    dom.accCookiesJson.value = '';
    dom.accStreamKey.value = '';

    notify(`Cuenta "${data.account.name}" agregada correctamente.`);
  } catch (err) {
    notify(err.message, true);
  } finally {
    dom.saveAccountBtn.disabled = false;
    dom.saveAccountBtn.textContent = '➕ Guardar Cuenta';
  }
}

async function handleVerifyAccount(id, btn) {
  btn.disabled = true;
  btn.textContent = '⏳...';
  try {
    const res = await fetch(`/api/accounts/${encodeURIComponent(id)}/verify`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'No se pudo verificar la cuenta');
    }

    const idx = state.accounts.findIndex((a) => a.id === id);
    if (idx !== -1 && data.account) {
      state.accounts[idx] = data.account;
    }
    renderAccounts();
    renderAccountSelect();

    const r = data.result || {};
    if (r.valid && r.can_stream) {
      notify(`Cuenta @${r.account || 'TikTok'} verificada: lista para emitir.`);
    } else {
      notify(r.error || `Estado: ${r.status_text || 'No apta para live'}`, true);
    }
  } catch (err) {
    notify(err.message, true);
    btn.disabled = false;
    btn.textContent = '🔍 Verificar';
  }
}

async function handleDeleteAccount(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!confirm(`¿Eliminar la cuenta "${acc ? acc.name : id}"?`)) return;

  try {
    const res = await fetch(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Error eliminando cuenta');
    }
    state.accounts = state.accounts.filter((a) => a.id !== id);
    renderAccounts();
    renderAccountSelect();
    notify('Cuenta eliminada.');
  } catch (err) {
    notify(err.message, true);
  }
}

// --- Streams UI ---
function syncDonationFormFields() {
  dom.donSettingsArea.style.display = dom.donEnabled.checked ? 'block' : 'none';
  dom.donTimingRow.style.display = dom.donDisplayMode.value === 'periodic' ? 'flex' : 'none';
}

function statusBadgeInfo(status) {
  switch (status) {
    case 'running': return { cls: 'badge-running', label: 'En Vivo' };
    case 'checking': return { cls: 'badge-starting', label: 'Verificando...' };
    case 'starting': return { cls: 'badge-starting', label: 'Iniciando...' };
    case 'stopping': return { cls: 'badge-starting', label: 'Deteniendo...' };
    case 'finished': return { cls: 'badge-idle', label: 'Finalizado' };
    case 'error': return { cls: 'badge-error', label: 'Error' };
    default: return { cls: 'badge-idle', label: 'Detenido' };
  }
}

function buildStreamCardHtml(s) {
  const badge = statusBadgeInfo(s.status);
  const active = ['running', 'starting', 'checking', 'stopping'].includes(s.status);
  const cfg = s.config || {};
  const platName = state.presets[cfg.platform]?.name || cfg.platform || 'custom';
  const stats = s.stats || {};
  const isLogsOpen = state.openLogs.has(s.id);
  const don = cfg.donation || {};

  const roomLink = s.tiktokSession?.shareUrl
    ? `<a href="${esc(s.tiktokSession.shareUrl)}" target="_blank" rel="noopener">🔗 Sala TikTok (${esc(s.tiktokSession.roomId || '')})</a>`
    : '';

  const logEntries = (state.logsByStream.get(s.id) || [])
    .map((l) => `<div class="log-entry log-${esc(l.type || 'info')}">[${esc(l.time)}] ${esc(l.message)}</div>`)
    .join('');

  return `
    <div class="stream-card ${active ? 'is-running' : ''}" data-stream-id="${esc(s.id)}">
      <div class="stream-card-head">
        <div class="stream-title-group">
          <span class="slot-id">#${esc(s.id)}</span>
          <strong>${esc(cfg.accountName || cfg.accountId || 'Stream')}</strong>
          <span class="tag">${esc(platName)} • ${esc(cfg.quality || '1080p30')}</span>
        </div>
        <span class="badge ${badge.cls}" data-role="badge"><span class="dot"></span>${esc(badge.label)}</span>
      </div>

      <div class="stream-meta">
        <span>Modo: <strong>${esc(cfg.mode || '-')}</strong> (${esc(stats.encoder || cfg.encoder || 'auto')})</span>
        <span>Proxy SEI: <code>:${esc(s.listenPort)}</code></span>
        ${cfg.sourceUrl ? `<span>Origen: <a href="${esc(cfg.sourceUrl)}" target="_blank" rel="noopener">${esc(cfg.sourceUrl)}</a></span>` : ''}
        ${roomLink}
      </div>

      <div class="mini-metrics">
        <div class="mini-metric">
          <span class="lbl">FPS</span>
          <span class="val" data-metric="fps">${esc(stats.fps ?? '0')}</span>
        </div>
        <div class="mini-metric">
          <span class="lbl">Bitrate</span>
          <span class="val" data-metric="bitrate">${esc(stats.bitrate ?? '0')} kbps</span>
        </div>
        <div class="mini-metric">
          <span class="lbl">Velocidad</span>
          <span class="val" data-metric="speed">${esc(stats.speed ?? '0x')}</span>
        </div>
        <div class="mini-metric">
          <span class="lbl">Duración</span>
          <span class="val" data-metric="uptime">${esc(formatUptime(stats.uptimeSeconds || 0))}</span>
        </div>
      </div>

      ${don.enabled ? `
        <div class="live-donation-bar">
          <input type="text" class="don-live-input" data-id="${esc(s.id)}" value="${esc(don.text || '')}" placeholder="Texto de donación en pantalla..." />
          <button type="button" class="btn btn-sm btn-accent-sm btn-save-don" data-id="${esc(s.id)}">💖 Actualizar Texto</button>
        </div>
      ` : ''}

      <div class="stream-actions">
        ${active
          ? `<button type="button" class="btn btn-sm btn-danger-sm btn-stop-stream" data-id="${esc(s.id)}">⏹ Detener</button>`
          : `<button type="button" class="btn btn-sm btn-danger-sm btn-remove-stream" data-id="${esc(s.id)}">🗑️ Quitar</button>`
        }
        <button type="button" class="btn btn-sm btn-neutral-sm btn-toggle-logs" data-id="${esc(s.id)}">
          ${isLogsOpen ? '🔽 Ocultar Logs' : '📜 Ver Logs'}
        </button>
      </div>

      <div class="logs-drawer ${isLogsOpen ? 'open' : ''}" id="logs-${esc(s.id)}">${logEntries}</div>
    </div>
  `;
}

function renderStreams() {
  const list = Array.from(state.streams.values());
  if (list.length === 0) {
    dom.streamsContainer.innerHTML = `
      <div class="empty-state">
        No hay transmisiones activas. Selecciona una cuenta y pega un enlace de YouTube para comenzar.
      </div>
    `;
    return;
  }

  dom.streamsContainer.innerHTML = list.map(buildStreamCardHtml).join('');
  for (const sid of state.openLogs) {
    const drawer = document.getElementById(`logs-${sid}`);
    if (drawer) drawer.scrollTop = drawer.scrollHeight;
  }
}

function updateStreamStatsInPlace(streamId, stats) {
  const existing = state.streams.get(streamId);
  if (existing) {
    existing.stats = { ...(existing.stats || {}), ...stats };
  }

  const card = dom.streamsContainer.querySelector(`.stream-card[data-stream-id="${CSS.escape(streamId)}"]`);
  if (!card) return;

  const setVal = (key, text) => {
    const el = card.querySelector(`[data-metric="${key}"]`);
    if (el) el.textContent = text;
  };
  setVal('fps', stats.fps ?? '0');
  setVal('bitrate', `${stats.bitrate ?? '0'} kbps`);
  setVal('speed', stats.speed ?? '0x');
  setVal('uptime', formatUptime(stats.uptimeSeconds || 0));
}

function appendStreamLog(entry) {
  const sid = entry.streamId;
  if (!sid) return;
  let arr = state.logsByStream.get(sid);
  if (!arr) {
    arr = [];
    state.logsByStream.set(sid, arr);
  }
  arr.push(entry);
  if (arr.length > 150) arr.shift();

  const drawer = document.getElementById(`logs-${sid}`);
  if (drawer) {
    const div = document.createElement('div');
    div.className = `log-entry log-${entry.type || 'info'}`;
    div.textContent = `[${entry.time}] ${entry.message}`;
    drawer.appendChild(div);
    while (drawer.children.length > 150) {
      drawer.removeChild(drawer.firstChild);
    }
    if (state.openLogs.has(sid)) {
      drawer.scrollTop = drawer.scrollHeight;
    }
  }
}

async function handleLaunchStream() {
  const accountId = dom.accountSelect.value;
  const sourceUrl = dom.sourceUrl.value.trim();

  if (!accountId) {
    notify('Primero configura o selecciona una cuenta destino.', true);
    return;
  }
  if (!sourceUrl) {
    notify('Pega la URL del directo de origen.', true);
    return;
  }

  dom.launchStreamBtn.disabled = true;
  dom.launchStreamBtn.textContent = '⏳ Iniciando transmisión...';

  try {
    const payload = {
      accountId,
      sourceUrl,
      mode: dom.modeSelect.value,
      quality: dom.qualitySelect.value,
      tiktokTitle: dom.tiktokTitle.value.trim(),
      autoReconnect: dom.autoReconnect.checked,
      reconnectDelay: Number(dom.reconnectDelay.value) || 5,
      donation: {
        enabled: dom.donEnabled.checked,
        text: dom.donText.value.trim(),
        position: dom.donPosition.value,
        displayMode: dom.donDisplayMode.value,
        intervalSec: Number(dom.donInterval.value) || 180,
        durationSec: Number(dom.donDuration.value) || 25
      }
    };

    const res = await fetch('/api/streams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'No se pudo iniciar la transmisión');
    }

    if (data.stream) {
      state.streams.set(data.stream.id, data.stream);
      state.openLogs.add(data.stream.id);
      renderStreams();
    }
    dom.sourceUrl.value = '';
    notify(`Slot #${data.stream.id} iniciado.`);
  } catch (err) {
    notify(err.message, true);
  } finally {
    dom.launchStreamBtn.disabled = false;
    dom.launchStreamBtn.textContent = '▶ Iniciar Transmisión';
  }
}

async function handleStopStream(id, btn) {
  btn.disabled = true;
  btn.textContent = '⏳ Deteniendo...';
  try {
    const res = await fetch(`/api/streams/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'No se pudo detener el stream');
    }
    notify(`Transmisión #${id} detenida.`);
  } catch (err) {
    notify(err.message, true);
    btn.disabled = false;
    btn.textContent = '⏹ Detener';
  }
}

async function handleRemoveStream(id) {
  try {
    const res = await fetch(`/api/streams/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'No se pudo quitar la tarjeta');
    }
    state.streams.delete(id);
    state.logsByStream.delete(id);
    state.openLogs.delete(id);
    renderStreams();
  } catch (err) {
    notify(err.message, true);
  }
}

async function handleUpdateDonationText(id, btn) {
  const card = btn.closest('.stream-card');
  const input = card?.querySelector('.don-live-input');
  const text = input ? input.value.trim() : '';
  if (!text) {
    notify('Escribe un texto de donación válido.', true);
    return;
  }

  btn.disabled = true;
  try {
    const res = await fetch(`/api/streams/${encodeURIComponent(id)}/donation`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Error actualizando el banner');
    }
    const st = state.streams.get(id);
    if (st && st.config?.donation) {
      st.config.donation.text = data.donation.text;
    }
    notify('Texto de donación actualizado en vivo.');
  } catch (err) {
    notify(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function handleToggleLogs(id) {
  if (state.openLogs.has(id)) {
    state.openLogs.delete(id);
    renderStreams();
    return;
  }

  state.openLogs.add(id);
  if (!state.logsByStream.has(id) || state.logsByStream.get(id).length === 0) {
    try {
      const res = await fetch(`/api/streams/${encodeURIComponent(id)}/logs`);
      const data = await res.json();
      if (Array.isArray(data.logs)) {
        state.logsByStream.set(id, data.logs);
      }
    } catch {}
  }
  renderStreams();
}

// --- Event Delegation ---
function bindEvents() {
  dom.accPlatform.addEventListener('change', syncAccountFormFields);
  dom.accAuthType.addEventListener('change', syncAccountFormFields);
  dom.accCookiesFile.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      dom.accCookiesJson.value = String(reader.result || '');
    };
    reader.readAsText(file);
  });
  dom.saveAccountBtn.addEventListener('click', handleSaveAccount);

  dom.accountSelect.addEventListener('change', syncSelectedAccountUI);
  dom.donEnabled.addEventListener('change', syncDonationFormFields);
  dom.donDisplayMode.addEventListener('change', syncDonationFormFields);
  dom.launchStreamBtn.addEventListener('click', handleLaunchStream);

  dom.streamsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;

    if (btn.classList.contains('btn-stop-stream')) handleStopStream(id, btn);
    else if (btn.classList.contains('btn-remove-stream')) handleRemoveStream(id);
    else if (btn.classList.contains('btn-save-don')) handleUpdateDonationText(id, btn);
    else if (btn.classList.contains('btn-toggle-logs')) handleToggleLogs(id);
  });

  dom.accountsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;

    if (btn.classList.contains('btn-verify-acc')) handleVerifyAccount(id, btn);
    else if (btn.classList.contains('btn-delete-acc')) handleDeleteAccount(id);
  });
}

// --- SSE Connection ---
function connectSSE() {
  const es = new EventSource('/api/stream/events');

  es.addEventListener('init', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      state.streams.clear();
      for (const s of payload.streams || []) {
        state.streams.set(s.id, s);
      }
      renderStreams();
      if (payload.system) renderSystemMetrics(payload.system);
    } catch {}
  });

  es.addEventListener('stream_status', (ev) => {
    try {
      const s = JSON.parse(ev.data);
      state.streams.set(s.id, s);
      renderStreams();
    } catch {}
  });

  es.addEventListener('stream_stats', (ev) => {
    try {
      const { id, stats } = JSON.parse(ev.data);
      updateStreamStatsInPlace(id, stats);
    } catch {}
  });

  es.addEventListener('stream_log', (ev) => {
    try {
      appendStreamLog(JSON.parse(ev.data));
    } catch {}
  });

  es.addEventListener('stream_removed', (ev) => {
    try {
      const { id } = JSON.parse(ev.data);
      state.streams.delete(id);
      state.logsByStream.delete(id);
      state.openLogs.delete(id);
      renderStreams();
    } catch {}
  });

  es.addEventListener('system', (ev) => {
    try {
      renderSystemMetrics(JSON.parse(ev.data));
    } catch {}
  });
}

// --- Bootstrap ---
async function init() {
  initTabs();
  bindEvents();

  try {
    const res = await fetch('/api/bootstrap');
    const data = await res.json();

    state.presets = data.presets || {};
    state.qualityProfiles = data.qualityProfiles || {};
    state.accounts = data.accounts || [];

    for (const s of data.streams || []) {
      state.streams.set(s.id, s);
    }

    const last = data.lastConfig || {};
    const don = data.donationDefaults || {};

    if (last.sourceUrl) dom.sourceUrl.value = last.sourceUrl;
    if (last.tiktokTitle) dom.tiktokTitle.value = last.tiktokTitle;
    if (last.mode) dom.modeSelect.value = last.mode;
    if (last.quality) dom.qualitySelect.value = last.quality;
    if (typeof last.autoReconnect === 'boolean') dom.autoReconnect.checked = last.autoReconnect;
    if (last.reconnectDelay) dom.reconnectDelay.value = last.reconnectDelay;

    if (typeof don.enabled === 'boolean') dom.donEnabled.checked = don.enabled;
    if (don.text !== undefined) dom.donText.value = don.text;
    if (don.position) dom.donPosition.value = don.position;
    if (don.displayMode) dom.donDisplayMode.value = don.displayMode;
    if (don.intervalSec) dom.donInterval.value = don.intervalSec;
    if (don.durationSec) dom.donDuration.value = don.durationSec;

    syncAccountFormFields();
    syncDonationFormFields();
    renderAccounts();
    renderAccountSelect();

    if (last.accountId && state.accounts.some((a) => a.id === last.accountId)) {
      dom.accountSelect.value = last.accountId;
      syncSelectedAccountUI();
    }

    renderStreams();
    renderSystemMetrics(data.system);
  } catch (err) {
    notify('Error cargando configuración inicial del servidor.', true);
  }

  connectSSE();
}

init();
