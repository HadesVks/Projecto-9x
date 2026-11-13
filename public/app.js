const state = {
  presets: {},
  qualityProfiles: {},
  donationStyles: [],
  tiktokTopics: [],
  accounts: [],
  monitors: [],
  streams: new Map(),
  logsByStream: new Map(),
  openLogs: new Set(),
  openAccountEdits: new Set(),
  donationCapableStreams: new Set(),
  system: null,
  auth: {
    pinEnabled: false,
    authenticated: true,
    envLocked: false
  },
  bootstrapped: false,
  sse: null
};

const dom = {
  vaapiPill: document.getElementById('vaapiPill'),
  activeStreamsPill: document.getElementById('activeStreamsPill'),
  quotaPill: document.getElementById('quotaPill'),
  sysResourcesPill: document.getElementById('sysResourcesPill'),
  pinBtn: document.getElementById('pinBtn'),
  monitorsCount: document.getElementById('monitorsCount'),
  accountsCount: document.getElementById('accountsCount'),
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabPanels: document.querySelectorAll('.tab-panel'),

  // Stream Form
  streamForm: document.getElementById('streamForm'),
  accountSelect: document.getElementById('accountSelect'),
  sourceUrl: document.getElementById('sourceUrl'),
  tiktokTitleGroup: document.getElementById('tiktokTitleGroup'),
  tiktokTitle: document.getElementById('tiktokTitle'),
  tiktokTopic: document.getElementById('tiktokTopic'),
  modeSelect: document.getElementById('modeSelect'),
  qualitySelect: document.getElementById('qualitySelect'),
  donEnabled: document.getElementById('donEnabled'),
  donSettingsArea: document.getElementById('donSettingsArea'),
  donText: document.getElementById('donText'),
  donPosition: document.getElementById('donPosition'),
  donStyle: document.getElementById('donStyle'),
  donDisplayMode: document.getElementById('donDisplayMode'),
  donRotateSec: document.getElementById('donRotateSec'),
  donTimingRow: document.getElementById('donTimingRow'),
  donInterval: document.getElementById('donInterval'),
  donDuration: document.getElementById('donDuration'),
  autoReconnect: document.getElementById('autoReconnect'),
  reconnectDelay: document.getElementById('reconnectDelay'),
  launchStreamBtn: document.getElementById('launchStreamBtn'),
  streamsContainer: document.getElementById('streamsContainer'),

  // Monitor Form
  monitorForm: document.getElementById('monitorForm'),
  monName: document.getElementById('monName'),
  monChannelUrl: document.getElementById('monChannelUrl'),
  monAccountSelect: document.getElementById('monAccountSelect'),
  monTitle: document.getElementById('monTitle'),
  monTopic: document.getElementById('monTopic'),
  monMode: document.getElementById('monMode'),
  monQuality: document.getElementById('monQuality'),
  monIntervalSec: document.getElementById('monIntervalSec'),
  monDonEnabled: document.getElementById('monDonEnabled'),
  monDonText: document.getElementById('monDonText'),
  monDonPosition: document.getElementById('monDonPosition'),
  monDonStyle: document.getElementById('monDonStyle'),
  saveMonitorBtn: document.getElementById('saveMonitorBtn'),
  monitorsContainer: document.getElementById('monitorsContainer'),

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
  accountsContainer: document.getElementById('accountsContainer'),

  // PIN Modals
  pinLockModal: document.getElementById('pinLockModal'),
  pinUnlockInput: document.getElementById('pinUnlockInput'),
  pinUnlockError: document.getElementById('pinUnlockError'),
  pinUnlockBtn: document.getElementById('pinUnlockBtn'),
  pinConfigModal: document.getElementById('pinConfigModal'),
  pinConfigInput: document.getElementById('pinConfigInput'),
  pinSaveBtn: document.getElementById('pinSaveBtn'),
  pinDisableBtn: document.getElementById('pinDisableBtn'),
  pinLogoutBtn: document.getElementById('pinLogoutBtn'),
  pinCloseModalBtn: document.getElementById('pinCloseModalBtn')
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

function formatRelativeTime(iso) {
  if (iso === null || iso === undefined || iso === '') return 'Nunca';
  const num = Number(iso);
  const ts = Number.isFinite(num)
    ? (num < 1e12 ? num * 1000 : num)
    : new Date(iso).getTime();
  if (!Number.isFinite(ts)) return String(iso);
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `hace ${diffSec}s`;
  if (diffSec < 3600) return `hace ${Math.floor(diffSec / 60)}m`;
  return `hace ${Math.floor(diffSec / 3600)}h`;
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
      'max-width:440px',
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

async function apiJson(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (res.status === 401) {
    state.auth.pinEnabled = true;
    state.auth.authenticated = false;
    closeSSE();
    openPinLockModal('Sesión expirada o bloqueada. Ingresa tu PIN.');
    throw new Error(data.error || 'Autenticación requerida');
  }
  if (!res.ok || data.success === false) {
    throw new Error(data.error || `Error HTTP ${res.status}`);
  }
  return data;
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

// --- PIN / Auth Modals ---
function updatePinButtonUI() {
  if (!dom.pinBtn) return;
  const enabled = state.auth.pinEnabled;
  dom.pinBtn.textContent = enabled ? '🔒 PIN Activo' : '🔓 Seguridad PIN';
  dom.pinBtn.classList.toggle('pill-ok', enabled);
  dom.pinBtn.title = state.auth.envLocked
    ? 'PIN bloqueado por variable de entorno ADMIN_PIN'
    : 'Configurar o bloquear panel con PIN';
}

function openPinLockModal(msg = '') {
  if (!dom.pinLockModal) return;
  dom.pinLockModal.classList.add('open');
  if (dom.pinUnlockError) dom.pinUnlockError.textContent = msg;
  if (dom.pinUnlockInput) {
    dom.pinUnlockInput.value = '';
    setTimeout(() => dom.pinUnlockInput.focus(), 50);
  }
}

function closePinLockModal() {
  if (!dom.pinLockModal) return;
  dom.pinLockModal.classList.remove('open');
  if (dom.pinUnlockError) dom.pinUnlockError.textContent = '';
  if (dom.pinUnlockInput) dom.pinUnlockInput.value = '';
}

function openPinConfigModal() {
  if (!dom.pinConfigModal) return;
  dom.pinConfigInput.value = '';
  dom.pinConfigInput.disabled = state.auth.envLocked;
  dom.pinSaveBtn.disabled = state.auth.envLocked;
  dom.pinDisableBtn.disabled = state.auth.envLocked || !state.auth.pinEnabled;
  dom.pinDisableBtn.style.display = state.auth.pinEnabled ? 'inline-flex' : 'none';
  dom.pinLogoutBtn.style.display = state.auth.pinEnabled ? 'inline-flex' : 'none';
  if (state.auth.envLocked) {
    dom.pinConfigInput.placeholder = 'Gestionado por variable ADMIN_PIN';
  } else {
    dom.pinConfigInput.placeholder = 'Nuevo PIN (mínimo 4 caracteres)';
  }
  dom.pinConfigModal.classList.add('open');
  if (!state.auth.envLocked) {
    setTimeout(() => dom.pinConfigInput.focus(), 50);
  }
}

function closePinConfigModal() {
  if (!dom.pinConfigModal) return;
  dom.pinConfigModal.classList.remove('open');
  dom.pinConfigInput.value = '';
}

async function fetchAuthStatus() {
  const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
  const data = await res.json();
  state.auth = {
    pinEnabled: Boolean(data.pinEnabled),
    authenticated: Boolean(data.authenticated),
    envLocked: Boolean(data.envLocked)
  };
  updatePinButtonUI();
  return state.auth;
}

async function handlePinUnlock() {
  const pin = dom.pinUnlockInput.value.trim();
  if (!pin) {
    dom.pinUnlockError.textContent = 'Ingresa tu PIN.';
    return;
  }
  dom.pinUnlockBtn.disabled = true;
  dom.pinUnlockError.textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'PIN incorrecto');
    }
    closePinLockModal();
    await fetchAuthStatus();
    await loadBootstrap();
    connectSSE();
    notify('Panel desbloqueado.');
  } catch (err) {
    dom.pinUnlockError.textContent = err.message;
  } finally {
    dom.pinUnlockBtn.disabled = false;
  }
}

async function handlePinSave() {
  const pin = dom.pinConfigInput.value.trim();
  if (pin.length < 4) {
    notify('El PIN debe tener al menos 4 caracteres.', true);
    return;
  }
  dom.pinSaveBtn.disabled = true;
  try {
    await apiJson('/api/auth/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    await fetchAuthStatus();
    closePinConfigModal();
    notify('PIN de seguridad guardado y activado.');
  } catch (err) {
    notify(err.message, true);
  } finally {
    dom.pinSaveBtn.disabled = false;
  }
}

async function handlePinDisable() {
  if (!confirm('¿Desactivar la protección por PIN del panel?')) return;
  dom.pinDisableBtn.disabled = true;
  try {
    await apiJson('/api/auth/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '' })
    });
    await fetchAuthStatus();
    closePinConfigModal();
    notify('Protección PIN desactivada.');
  } catch (err) {
    notify(err.message, true);
  } finally {
    dom.pinDisableBtn.disabled = false;
  }
}

async function handlePinLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}
  closePinConfigModal();
  closeSSE();
  state.auth.authenticated = false;
  openPinLockModal('');
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
    : Array.from(state.streams.values()).filter((s) => ['running', 'starting', 'checking', 'reconnecting'].includes(s.status)).length;

  dom.activeStreamsPill.textContent = `📡 ${active} en vivo`;
  dom.activeStreamsPill.classList.toggle('pill-live', active > 0);

  if (dom.quotaPill) {
    const q = sys.rapidApiQuota;
    dom.quotaPill.classList.remove('pill-ok', 'pill-warn', 'pill-danger');
    if (q && Number.isFinite(Number(q.remaining)) && Number.isFinite(Number(q.limit))) {
      const rem = Number(q.remaining);
      const lim = Number(q.limit);
      dom.quotaPill.textContent = `API: ${rem}/${lim}`;
      if (rem < 500) dom.quotaPill.classList.add('pill-danger');
      else if (rem < 1500) dom.quotaPill.classList.add('pill-warn');
      else dom.quotaPill.classList.add('pill-ok');
      dom.quotaPill.title = q.updated
        ? `RapidAPI EulerStream • Usados: ${q.used ?? '--'} • Act: ${formatRelativeTime(q.updated)}`
        : 'Cuota RapidAPI';
    } else {
      dom.quotaPill.textContent = 'API: --/--';
      dom.quotaPill.title = 'Sin lecturas recientes de cuota RapidAPI (0 llamadas extra)';
    }
  }

  const tempStr = sys.tempC !== null && sys.tempC !== undefined ? ` • ${sys.tempC}°C` : '';
  dom.sysResourcesPill.textContent = `CPU ${sys.cpuApproxPct ?? '--'}% • RAM ${sys.ramUsedGb ?? '--'}/${sys.ramTotalGb ?? '--'} GB${tempStr}`;
}

// --- Dynamic Selects ---
function populateSelectOptions() {
  const topics = Array.isArray(state.tiktokTopics) ? state.tiktokTopics : [];
  for (const sel of [dom.tiktokTopic, dom.monTopic]) {
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = '';
    for (const t of topics) {
      const opt = document.createElement('option');
      opt.value = String(t.id ?? t.value ?? '');
      opt.textContent = t.name || t.label || t.title || String(t.id);
      sel.appendChild(opt);
    }
    if (prev && Array.from(sel.options).some((o) => o.value === prev)) {
      sel.value = prev;
    } else if (sel.options.length > 0 && !sel.value) {
      const hasGaming = Array.from(sel.options).some((o) => o.value === '5');
      if (hasGaming) sel.value = '5';
    }
  }

  const stylesRaw = state.donationStyles;
  const styleEntries = Array.isArray(stylesRaw)
    ? stylesRaw.map((s) => [s.id ?? s.value, s.label || s.name || s.id])
    : Object.entries(stylesRaw || {}).map(([k, v]) => [k, v?.label || v?.name || k]);

  if (styleEntries.length > 0) {
    for (const sel of [dom.donStyle, dom.monDonStyle]) {
      if (!sel) continue;
      const prev = sel.value;
      sel.innerHTML = '';
      for (const [id, label] of styleEntries) {
        const opt = document.createElement('option');
        opt.value = String(id);
        opt.textContent = String(label);
        sel.appendChild(opt);
      }
      if (prev && Array.from(sel.options).some((o) => o.value === prev)) {
        sel.value = prev;
      }
    }
  }

  const profiles = state.qualityProfiles || {};
  const profileEntries = Object.entries(profiles);
  if (profileEntries.length > 0) {
    for (const sel of [dom.qualitySelect, dom.monQuality]) {
      if (!sel) continue;
      const prev = sel.value;
      sel.innerHTML = '';
      for (const [id, p] of profileEntries) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = p?.label || `${id} (${p?.videoBitrate || ''})`;
        sel.appendChild(opt);
      }
      if (prev && Array.from(sel.options).some((o) => o.value === prev)) {
        sel.value = prev;
      }
    }
  }
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
    dom.accRtmpServer.value = state.presets[plat]?.rtmpServer || '';
  }
}

function renderAccountDropdown(sel, { disableBtn = null, syncUI = null } = {}) {
  if (!sel) return;
  const previousValue = sel.value;
  sel.innerHTML = '';

  if (state.accounts.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Sin cuentas configuradas (Agrega una en la pestaña Cuentas)';
    sel.appendChild(opt);
    if (disableBtn) disableBtn.disabled = true;
    if (syncUI) syncUI();
    return;
  }

  if (disableBtn) disableBtn.disabled = false;
  for (const acc of state.accounts) {
    const platName = state.presets[acc.platform]?.name || acc.platform;
    const handle = acc.username ? ` • @${acc.username}` : '';
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.textContent = `${acc.name} (${platName}${handle})`;
    sel.appendChild(opt);
  }

  if (previousValue && state.accounts.some((a) => a.id === previousValue)) {
    sel.value = previousValue;
  }
  if (syncUI) syncUI();
}

function renderAccountSelect() {
  renderAccountDropdown(dom.accountSelect, {
    disableBtn: dom.launchStreamBtn,
    syncUI: syncSelectedAccountUI
  });
  renderAccountDropdown(dom.monAccountSelect, {
    disableBtn: dom.saveMonitorBtn
  });
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
    const isEditOpen = state.openAccountEdits.has(acc.id);

    const editBody = acc.authType === 'cookies'
      ? `
        <div class="field">
          <label>Reemplazar Cookies JSON (opcional)</label>
          <textarea class="acc-edit-cookies" rows="3" placeholder="Pega nuevas cookies JSON solo si deseas reemplazar las actuales..."></textarea>
        </div>
      `
      : `
        <div class="field-row">
          <div class="field">
            <label>Servidor RTMP</label>
            <input type="text" class="acc-edit-rtmp" value="${esc(acc.rtmpServer || '')}" />
          </div>
          <div class="field">
            <label>Nueva Stream Key (opcional)</label>
            <input type="password" class="acc-edit-key" placeholder="Dejar vacío para conservar la actual" />
          </div>
        </div>
      `;

    return `
      <div class="account-card" data-acc-id="${esc(acc.id)}">
        <div class="acc-head-row" style="display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;flex-wrap:wrap;">
          <div class="acc-info">
            <h3>${esc(acc.name)}</h3>
            <div class="acc-sub">
              ${esc(platName)} • ${esc(methodLabel)}${acc.platform === 'tiktok' ? ` • ${esc(userLabel)}` : ''}
            </div>
          </div>
          <div class="acc-actions">
            <span class="badge ${badgeClass}"><span class="dot"></span>${esc(badgeText)}</span>
            ${canVerify ? `<button type="button" class="btn btn-sm btn-neutral-sm btn-verify-acc" data-id="${esc(acc.id)}">🔍 Verificar</button>` : ''}
            <button type="button" class="btn btn-sm btn-accent-sm btn-edit-acc" data-id="${esc(acc.id)}">${isEditOpen ? '✖ Cerrar' : '✏️ Editar'}</button>
            <button type="button" class="btn btn-sm btn-danger-sm btn-delete-acc" data-id="${esc(acc.id)}">🗑️ Eliminar</button>
          </div>
        </div>
        <div class="account-edit-drawer ${isEditOpen ? 'open' : ''}">
          <div class="field">
            <label>Nombre de la cuenta</label>
            <input type="text" class="acc-edit-name" value="${esc(acc.name)}" />
          </div>
          ${editBody}
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button type="button" class="btn btn-sm btn-neutral-sm btn-cancel-edit-acc" data-id="${esc(acc.id)}">Cancelar</button>
            <button type="button" class="btn btn-sm btn-accent-sm btn-save-edit-acc" data-id="${esc(acc.id)}">💾 Guardar Cambios</button>
          </div>
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
    const data = await apiJson('/api/accounts', {
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

async function handleSaveAccountEdit(id, btn) {
  const card = btn.closest('.account-card');
  if (!card) return;

  const name = card.querySelector('.acc-edit-name')?.value.trim() || '';
  if (!name) {
    notify('El nombre de cuenta no puede quedar vacío.', true);
    return;
  }

  const payload = { name };
  const cookiesInput = card.querySelector('.acc-edit-cookies');
  if (cookiesInput && cookiesInput.value.trim()) {
    payload.cookiesJson = cookiesInput.value.trim();
  }
  const rtmpInput = card.querySelector('.acc-edit-rtmp');
  if (rtmpInput) {
    payload.rtmpServer = rtmpInput.value.trim();
  }
  const keyInput = card.querySelector('.acc-edit-key');
  if (keyInput && keyInput.value.trim()) {
    payload.streamKey = keyInput.value.trim();
  }

  btn.disabled = true;
  btn.textContent = '⏳ Guardando...';
  try {
    const data = await apiJson(`/api/accounts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const idx = state.accounts.findIndex((a) => a.id === id);
    if (idx !== -1 && data.account) {
      state.accounts[idx] = data.account;
    }
    state.openAccountEdits.delete(id);
    renderAccounts();
    renderAccountSelect();
    notify(`Cuenta "${data.account?.name || name}" actualizada.`);
  } catch (err) {
    notify(err.message, true);
    btn.disabled = false;
    btn.textContent = '💾 Guardar Cambios';
  }
}

async function handleVerifyAccount(id, btn) {
  btn.disabled = true;
  btn.textContent = '⏳...';
  try {
    const data = await apiJson(`/api/accounts/${encodeURIComponent(id)}/verify`, { method: 'POST' });
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
    await apiJson(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.accounts = state.accounts.filter((a) => a.id !== id);
    state.openAccountEdits.delete(id);
    renderAccounts();
    renderAccountSelect();
    notify('Cuenta eliminada.');
  } catch (err) {
    notify(err.message, true);
  }
}

// --- Monitors UI (Auto-Restreamer 24/7) ---
function monitorBadgeInfo(m) {
  const rt = m.runtime || {};
  if (rt.activeStreamId) return { cls: 'badge-running', label: `En Vivo #${rt.activeStreamId}` };
  if (!m.enabled) return { cls: 'badge-idle', label: 'Pausado' };
  if (rt.state === 'checking') return { cls: 'badge-starting', label: 'Revisando...' };
  if (rt.state === 'error') return { cls: 'badge-error', label: 'Error al revisar' };
  if (rt.state === 'live') return { cls: 'badge-running', label: 'Canal En Vivo' };
  return { cls: 'badge-starting', label: 'Vigilando 24/7' };
}

function renderMonitors() {
  if (dom.monitorsCount) dom.monitorsCount.textContent = String(state.monitors.length);
  if (!dom.monitorsContainer) return;

  if (state.monitors.length === 0) {
    dom.monitorsContainer.innerHTML = '<div class="empty-state">No hay canales vigilados todavía. Configura uno a la izquierda para auto-retransmitir en cuanto empiece un directo.</div>';
    return;
  }

  dom.monitorsContainer.innerHTML = `<div class="monitors-list">${state.monitors.map((m) => {
    const acc = state.accounts.find((a) => a.id === m.accountId);
    const accLabel = acc ? acc.name : (m.accountId || 'Cuenta');
    const rt = m.runtime || {};
    const badge = monitorBadgeInfo(m);
    const checkStr = rt.lastCheckedAt ? formatRelativeTime(rt.lastCheckedAt) : 'Pendiente';
    const don = m.donation || {};
    const isErr = rt.state === 'error';

    return `
      <div class="monitor-card" data-monitor-id="${esc(m.id)}">
        <div class="stream-card-head">
          <div class="stream-title-group">
            <span class="slot-id">${m.enabled ? '🤖' : '⏸'}</span>
            <strong>${esc(m.name)}</strong>
            <span class="tag">${esc(accLabel)} • ${esc(m.quality || '720p30')} • c/${esc(m.checkIntervalSec || 45)}s</span>
          </div>
          <span class="badge ${badge.cls}"><span class="dot"></span>${esc(badge.label)}</span>
        </div>

        <div class="stream-meta">
          <span>Canal: <a href="${esc(m.channelUrl)}" target="_blank" rel="noopener">${esc(m.channelUrl)}</a></span>
          <span>Modo: <strong>${esc(m.mode || 'reencode')}</strong></span>
          <span>Última revisión: <strong>${esc(checkStr)}</strong></span>
          <span>Donaciones: <strong>${don.enabled ? `${esc(don.style || 'dark')}` : 'Desactivadas'}</strong></span>
          ${rt.lastMessage ? `<span${isErr ? ' style="color:var(--danger);"' : ''}>${isErr ? '⚠️ ' : '💬 '}${esc(rt.lastMessage)}</span>` : ''}
        </div>

        <div class="stream-actions">
          <button type="button" class="btn btn-sm btn-accent-sm btn-check-monitor" data-id="${esc(m.id)}">🔍 Revisar Ya</button>
          <button type="button" class="btn btn-sm btn-neutral-sm btn-toggle-monitor" data-id="${esc(m.id)}">
            ${m.enabled ? '⏸ Pausar' : '▶ Activar'}
          </button>
          <button type="button" class="btn btn-sm btn-danger-sm btn-delete-monitor" data-id="${esc(m.id)}">🗑️ Eliminar</button>
        </div>
      </div>
    `;
  }).join('')}</div>`;
}

async function handleSaveMonitor() {
  const name = dom.monName.value.trim();
  const channelUrl = dom.monChannelUrl.value.trim();
  const accountId = dom.monAccountSelect.value;

  if (!name || !channelUrl || !accountId) {
    notify('Completa nombre, URL del canal (/live) y cuenta destino.', true);
    return;
  }

  dom.saveMonitorBtn.disabled = true;
  dom.saveMonitorBtn.textContent = '⏳ Guardando vigilante...';

  try {
    const data = await apiJson('/api/monitors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        channelUrl,
        accountId,
        tiktokTitle: dom.monTitle.value.trim(),
        topicId: dom.monTopic?.value || '5',
        mode: dom.monMode.value,
        quality: dom.monQuality.value,
        checkIntervalSec: Number(dom.monIntervalSec.value) || 45,
        donation: {
          enabled: dom.monDonEnabled.checked,
          text: dom.monDonText.value.trim(),
          position: dom.monDonPosition.value,
          style: dom.monDonStyle?.value || 'dark'
        }
      })
    });

    if (data.monitor) {
      const idx = state.monitors.findIndex((m) => m.id === data.monitor.id);
      if (idx === -1) state.monitors.unshift(data.monitor);
      else state.monitors[idx] = data.monitor;
      renderMonitors();
    }

    dom.monName.value = '';
    dom.monChannelUrl.value = '';
    notify(`Auto-Restreamer "${data.monitor?.name || name}" activado.`);
  } catch (err) {
    notify(err.message, true);
  } finally {
    dom.saveMonitorBtn.disabled = false;
    dom.saveMonitorBtn.textContent = '🤖 Guardar y Activar Vigilante';
  }
}

async function handleToggleMonitor(id, btn) {
  btn.disabled = true;
  try {
    const data = await apiJson(`/api/monitors/${encodeURIComponent(id)}/toggle`, { method: 'PATCH' });
    if (data.monitor) {
      const idx = state.monitors.findIndex((m) => m.id === id);
      if (idx !== -1) state.monitors[idx] = data.monitor;
      renderMonitors();
      notify(`Vigilante ${data.monitor.enabled ? 'activado' : 'pausado'}.`);
    }
  } catch (err) {
    notify(err.message, true);
    btn.disabled = false;
  }
}

async function handleCheckMonitorNow(id, btn) {
  btn.disabled = true;
  btn.textContent = '⏳ Revisando...';
  try {
    const data = await apiJson(`/api/monitors/${encodeURIComponent(id)}/check`, { method: 'POST' });
    if (data.runtime) {
      const idx = state.monitors.findIndex((m) => m.id === id);
      if (idx !== -1) {
        state.monitors[idx] = { ...state.monitors[idx], runtime: data.runtime };
        renderMonitors();
      }
      const rt = data.runtime;
      notify(
        rt.activeStreamId
          ? `¡Canal en vivo! Stream #${rt.activeStreamId} activo.`
          : (rt.lastMessage || 'Revisión completada.')
      );
    } else {
      notify('Revisión completada.');
    }
  } catch (err) {
    notify(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Revisar Ya';
  }
}

async function handleDeleteMonitor(id) {
  const m = state.monitors.find((x) => x.id === id);
  if (!confirm(`¿Eliminar el vigilante "${m ? m.name : id}"?`)) return;
  try {
    await apiJson(`/api/monitors/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.monitors = state.monitors.filter((x) => x.id !== id);
    renderMonitors();
    notify('Vigilante eliminado.');
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
    case 'reconnecting': return { cls: 'badge-starting', label: 'Reconectando...' };
    case 'stopping': return { cls: 'badge-starting', label: 'Deteniendo...' };
    case 'finished': return { cls: 'badge-idle', label: 'Finalizado' };
    case 'error': return { cls: 'badge-error', label: 'Error' };
    default: return { cls: 'badge-idle', label: 'Detenido' };
  }
}

function trackDonationCapability(s) {
  if (s?.id && s?.config?.donation?.enabled) {
    state.donationCapableStreams.add(s.id);
  }
}

function buildStreamCardHtml(s) {
  const badge = statusBadgeInfo(s.status);
  const active = ['running', 'starting', 'checking', 'reconnecting', 'stopping'].includes(s.status);
  const canRelaunch = ['idle', 'finished', 'error'].includes(s.status);
  const cfg = s.config || {};
  const platName = state.presets[cfg.platform]?.name || cfg.platform || 'custom';
  const stats = s.stats || {};
  const isLogsOpen = state.openLogs.has(s.id);
  const don = cfg.donation || {};
  const canLiveDonation = Boolean(don.enabled || state.donationCapableStreams.has(s.id));

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
        <span>Proxy SEI: <code>:${esc(s.listenPort ?? '--')}</code></span>
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

      ${canLiveDonation ? `
        <div class="live-donation-bar">
          <input type="text" class="don-live-input" data-id="${esc(s.id)}" value="${esc(don.text || '')}" placeholder="Texto de donación (usa | para rotar mensajes)..." />
          <button type="button" class="btn btn-sm btn-accent-sm btn-save-don" data-id="${esc(s.id)}">💖 Actualizar</button>
          <button type="button" class="btn btn-sm btn-neutral-sm btn-toggle-don" data-id="${esc(s.id)}">
            ${don.enabled ? '⏸ Pausar Banner' : '▶ Reanudar Banner'}
          </button>
        </div>
      ` : ''}

      <div class="stream-actions">
        ${active
          ? `<button type="button" class="btn btn-sm btn-danger-sm btn-stop-stream" data-id="${esc(s.id)}">⏹ Detener</button>`
          : `
            ${canRelaunch && cfg.sourceUrl && cfg.accountId
              ? `<button type="button" class="btn btn-sm btn-accent-sm btn-relaunch-stream" data-id="${esc(s.id)}">🔁 Relanzar</button>`
              : ''}
            <button type="button" class="btn btn-sm btn-danger-sm btn-remove-stream" data-id="${esc(s.id)}">🗑️ Quitar</button>
          `
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
      topicId: dom.tiktokTopic?.value || '5',
      autoReconnect: dom.autoReconnect.checked,
      reconnectDelay: Number(dom.reconnectDelay.value) || 5,
      donation: {
        enabled: dom.donEnabled.checked,
        text: dom.donText.value.trim(),
        position: dom.donPosition.value,
        style: dom.donStyle?.value || 'dark',
        displayMode: dom.donDisplayMode.value,
        rotateSec: Number(dom.donRotateSec?.value) || 20,
        intervalSec: Number(dom.donInterval.value) || 180,
        durationSec: Number(dom.donDuration.value) || 25
      }
    };

    const data = await apiJson('/api/streams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (data.stream) {
      trackDonationCapability(data.stream);
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

async function handleRelaunchStream(id, btn) {
  const s = state.streams.get(id);
  const cfg = s?.config;
  if (!cfg || !cfg.accountId || !cfg.sourceUrl) {
    notify('No hay configuración suficiente para relanzar este slot.', true);
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Relanzando...';

  try {
    const payload = {
      accountId: cfg.accountId,
      sourceUrl: cfg.sourceUrl,
      mode: cfg.mode || 'reencode',
      quality: cfg.quality || '720p30',
      tiktokTitle: cfg.tiktokTitle || '',
      topicId: cfg.topicId || '5',
      autoReconnect: cfg.autoReconnect !== false,
      reconnectDelay: Number(cfg.reconnectDelay) || 5,
      donation: cfg.donation ? { ...cfg.donation } : { enabled: false }
    };

    const data = await apiJson('/api/streams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (data.stream) {
      trackDonationCapability(data.stream);
      state.streams.set(data.stream.id, data.stream);
      state.openLogs.add(data.stream.id);
      renderStreams();
    }
    notify(`Relanzado en nuevo slot #${data.stream?.id || ''}.`);
  } catch (err) {
    notify(err.message, true);
    btn.disabled = false;
    btn.textContent = '🔁 Relanzar';
  }
}

async function handleStopStream(id, btn) {
  btn.disabled = true;
  btn.textContent = '⏳ Deteniendo...';
  try {
    await apiJson(`/api/streams/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    notify(`Transmisión #${id} detenida.`);
  } catch (err) {
    notify(err.message, true);
    btn.disabled = false;
    btn.textContent = '⏹ Detener';
  }
}

async function handleRemoveStream(id) {
  try {
    await apiJson(`/api/streams/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.streams.delete(id);
    state.logsByStream.delete(id);
    state.openLogs.delete(id);
    state.donationCapableStreams.delete(id);
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
    const data = await apiJson(`/api/streams/${encodeURIComponent(id)}/donation`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const st = state.streams.get(id);
    if (st && st.config?.donation) {
      st.config.donation = { ...st.config.donation, ...data.donation };
    }
    renderStreams();
    notify('Texto de donación actualizado en vivo.');
  } catch (err) {
    notify(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function handleToggleDonationBanner(id, btn) {
  const st = state.streams.get(id);
  const currentEnabled = Boolean(st?.config?.donation?.enabled);
  const nextEnabled = !currentEnabled;

  btn.disabled = true;
  try {
    const data = await apiJson(`/api/streams/${encodeURIComponent(id)}/donation`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nextEnabled })
    });
    if (st) {
      st.config = st.config || {};
      st.config.donation = { ...(st.config.donation || {}), ...data.donation };
    }
    renderStreams();
    notify(nextEnabled ? 'Banner de donaciones reanudado en vivo.' : 'Banner de donaciones pausado en vivo.');
  } catch (err) {
    notify(err.message, true);
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
      const data = await apiJson(`/api/streams/${encodeURIComponent(id)}/logs`);
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

  if (dom.saveMonitorBtn) {
    dom.saveMonitorBtn.addEventListener('click', handleSaveMonitor);
  }

  dom.streamsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;

    if (btn.classList.contains('btn-stop-stream')) handleStopStream(id, btn);
    else if (btn.classList.contains('btn-relaunch-stream')) handleRelaunchStream(id, btn);
    else if (btn.classList.contains('btn-remove-stream')) handleRemoveStream(id);
    else if (btn.classList.contains('btn-save-don')) handleUpdateDonationText(id, btn);
    else if (btn.classList.contains('btn-toggle-don')) handleToggleDonationBanner(id, btn);
    else if (btn.classList.contains('btn-toggle-logs')) handleToggleLogs(id);
  });

  if (dom.monitorsContainer) {
    dom.monitorsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const id = btn.dataset.id;
      if (!id) return;

      if (btn.classList.contains('btn-check-monitor')) handleCheckMonitorNow(id, btn);
      else if (btn.classList.contains('btn-toggle-monitor')) handleToggleMonitor(id, btn);
      else if (btn.classList.contains('btn-delete-monitor')) handleDeleteMonitor(id);
    });
  }

  dom.accountsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;

    if (btn.classList.contains('btn-verify-acc')) handleVerifyAccount(id, btn);
    else if (btn.classList.contains('btn-edit-acc')) {
      if (state.openAccountEdits.has(id)) state.openAccountEdits.delete(id);
      else state.openAccountEdits.add(id);
      renderAccounts();
    } else if (btn.classList.contains('btn-cancel-edit-acc')) {
      state.openAccountEdits.delete(id);
      renderAccounts();
    } else if (btn.classList.contains('btn-save-edit-acc')) {
      handleSaveAccountEdit(id, btn);
    } else if (btn.classList.contains('btn-delete-acc')) {
      handleDeleteAccount(id);
    }
  });

  // PIN Modals
  if (dom.pinBtn) dom.pinBtn.addEventListener('click', openPinConfigModal);
  if (dom.pinUnlockBtn) dom.pinUnlockBtn.addEventListener('click', handlePinUnlock);
  if (dom.pinUnlockInput) {
    dom.pinUnlockInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handlePinUnlock();
    });
  }
  if (dom.pinSaveBtn) dom.pinSaveBtn.addEventListener('click', handlePinSave);
  if (dom.pinDisableBtn) dom.pinDisableBtn.addEventListener('click', handlePinDisable);
  if (dom.pinLogoutBtn) dom.pinLogoutBtn.addEventListener('click', handlePinLogout);
  if (dom.pinCloseModalBtn) dom.pinCloseModalBtn.addEventListener('click', closePinConfigModal);
  if (dom.pinConfigModal) {
    dom.pinConfigModal.addEventListener('click', (e) => {
      if (e.target === dom.pinConfigModal) closePinConfigModal();
    });
  }
}

// --- SSE Connection ---
function closeSSE() {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
}

function connectSSE() {
  closeSSE();
  const es = new EventSource('/api/stream/events');
  state.sse = es;

  es.addEventListener('init', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      const validIds = new Set((payload.streams || []).map((s) => s.id));
      state.streams.clear();
      for (const sid of Array.from(state.logsByStream.keys())) {
        if (!validIds.has(sid)) state.logsByStream.delete(sid);
      }
      for (const sid of Array.from(state.openLogs)) {
        if (!validIds.has(sid)) state.openLogs.delete(sid);
      }
      for (const sid of Array.from(state.donationCapableStreams)) {
        if (!validIds.has(sid)) state.donationCapableStreams.delete(sid);
      }
      for (const s of payload.streams || []) {
        trackDonationCapability(s);
        state.streams.set(s.id, s);
      }
      if (Array.isArray(payload.monitors)) {
        state.monitors = payload.monitors;
        renderMonitors();
      }
      renderStreams();
      if (payload.system) renderSystemMetrics(payload.system);
    } catch {}
  });

  es.addEventListener('stream_status', (ev) => {
    try {
      const s = JSON.parse(ev.data);
      trackDonationCapability(s);
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
      state.donationCapableStreams.delete(id);
      renderStreams();
    } catch {}
  });

  es.addEventListener('monitors', (ev) => {
    try {
      const monitors = JSON.parse(ev.data);
      if (Array.isArray(monitors)) {
        state.monitors = monitors;
        renderMonitors();
      }
    } catch {}
  });

  es.addEventListener('system', (ev) => {
    try {
      renderSystemMetrics(JSON.parse(ev.data));
    } catch {}
  });
}

// --- Bootstrap ---
async function loadBootstrap() {
  const data = await apiJson('/api/bootstrap');

  state.presets = data.presets || {};
  state.qualityProfiles = data.qualityProfiles || {};
  state.donationStyles = data.donationStyles || [];
  state.tiktokTopics = data.tiktokTopics || [];
  state.accounts = data.accounts || [];
  state.monitors = data.monitors || [];

  state.streams.clear();
  for (const s of data.streams || []) {
    trackDonationCapability(s);
    state.streams.set(s.id, s);
  }

  populateSelectOptions();

  const last = data.lastConfig || {};
  const don = data.donationDefaults || {};

  if (last.sourceUrl) dom.sourceUrl.value = last.sourceUrl;
  if (last.tiktokTitle) dom.tiktokTitle.value = last.tiktokTitle;
  if (last.topicId && dom.tiktokTopic) dom.tiktokTopic.value = String(last.topicId);
  if (last.mode) dom.modeSelect.value = last.mode;
  if (last.quality) dom.qualitySelect.value = last.quality;
  if (typeof last.autoReconnect === 'boolean') dom.autoReconnect.checked = last.autoReconnect;
  if (last.reconnectDelay) dom.reconnectDelay.value = last.reconnectDelay;

  if (typeof don.enabled === 'boolean') dom.donEnabled.checked = don.enabled;
  if (don.text !== undefined) dom.donText.value = don.text;
  if (don.position) dom.donPosition.value = don.position;
  if (don.style && dom.donStyle) dom.donStyle.value = don.style;
  if (don.displayMode) dom.donDisplayMode.value = don.displayMode;
  if (don.rotateSec && dom.donRotateSec) dom.donRotateSec.value = don.rotateSec;
  if (don.intervalSec) dom.donInterval.value = don.intervalSec;
  if (don.durationSec) dom.donDuration.value = don.durationSec;

  if (don.text !== undefined && dom.monDonText && !dom.monDonText.value) dom.monDonText.value = don.text;
  if (don.position && dom.monDonPosition) dom.monDonPosition.value = don.position;
  if (don.style && dom.monDonStyle) dom.monDonStyle.value = don.style;

  syncAccountFormFields();
  syncDonationFormFields();
  renderAccounts();
  renderAccountSelect();
  renderMonitors();

  if (last.accountId && state.accounts.some((a) => a.id === last.accountId)) {
    dom.accountSelect.value = last.accountId;
    syncSelectedAccountUI();
  }

  renderStreams();
  renderSystemMetrics(data.system);
  state.bootstrapped = true;
}

async function init() {
  initTabs();
  bindEvents();

  try {
    const auth = await fetchAuthStatus();
    if (auth.pinEnabled && !auth.authenticated) {
      openPinLockModal('');
      return;
    }
    await loadBootstrap();
    connectSSE();
  } catch (err) {
    notify('Error cargando configuración inicial del servidor.', true);
  }
}

init();
