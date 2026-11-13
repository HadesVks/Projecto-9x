import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import util from 'util';

const execFileAsync = util.promisify(execFile);

export class ChannelMonitor extends EventEmitter {
  constructor(store, manager) {
    super();
    this.store = store;
    this.manager = manager;
    this.runtime = new Map(); // monitorId -> { state, lastCheckedAt, lastMessage, activeStreamId, lastTitle }
    this.timers = new Map();
    this.inFlight = new Set();
    this.stopped = false;

    this.manager.on('stream_status', (summary) => this._onStreamStatus(summary));
    this.manager.on('stream_removed', ({ id }) => this._onStreamRemoved(id));
  }

  _getRt(id) {
    if (!this.runtime.has(id)) {
      this.runtime.set(id, {
        state: 'idle',
        lastCheckedAt: null,
        lastMessage: 'En espera de comprobación',
        activeStreamId: null,
        lastTitle: ''
      });
    }
    return this.runtime.get(id);
  }

  _onStreamStatus(summary) {
    let changed = false;
    for (const [monId, rt] of this.runtime.entries()) {
      if (rt.activeStreamId === summary.id) {
        if (['idle', 'finished', 'error'].includes(summary.status)) {
          rt.activeStreamId = null;
          rt.state = 'idle';
          rt.lastMessage = summary.status === 'finished'
            ? 'Directo finalizado; esperando próximo en vivo'
            : `Transmisión cerrada (${summary.status})`;
          changed = true;
        }
      }
    }
    if (changed) this.emitUpdate();
  }

  _onStreamRemoved(streamId) {
    let changed = false;
    for (const rt of this.runtime.values()) {
      if (rt.activeStreamId === streamId) {
        rt.activeStreamId = null;
        rt.state = 'idle';
        rt.lastMessage = 'En espera';
        changed = true;
      }
    }
    if (changed) this.emitUpdate();
  }

  listWithStatus() {
    return this.store.listMonitors().map((m) => {
      const rt = this._getRt(m.id);
      return {
        ...m,
        runtime: {
          ...rt,
          state: m.enabled ? rt.state : 'paused'
        }
      };
    });
  }

  emitUpdate() {
    this.emit('monitors_updated', this.listWithStatus());
  }

  startAll() {
    this.stopped = false;
    for (const mon of this.store.listMonitors()) {
      this._scheduleMonitor(mon);
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
  }

  refreshMonitor(id) {
    if (this.timers.has(id)) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
    }
    const mon = this.store.listMonitors().find((m) => m.id === id);
    if (!mon) {
      this.runtime.delete(id);
      this.emitUpdate();
      return;
    }
    if (!mon.enabled) {
      const rt = this._getRt(id);
      rt.state = 'paused';
      rt.lastMessage = 'Monitor pausado';
      this.emitUpdate();
      return;
    }
    this._scheduleMonitor(mon, 2000);
    this.emitUpdate();
  }

  _scheduleMonitor(mon, delayMs) {
    if (this.stopped || !mon.enabled) return;
    if (this.timers.has(mon.id)) {
      clearTimeout(this.timers.get(mon.id));
    }
    const waitMs = typeof delayMs === 'number'
      ? delayMs
      : Math.max(30, Number(mon.checkIntervalSec) || 60) * 1000;

    const timer = setTimeout(async () => {
      if (this.stopped) return;
      const latest = this.store.listMonitors().find((m) => m.id === mon.id);
      if (!latest || !latest.enabled) return;
      await this.checkNow(mon.id, false);
      this._scheduleMonitor(latest);
    }, waitMs);

    this.timers.set(mon.id, timer);
  }

  async checkNow(id, forceResetTriggered = false) {
    const mon = this.store.listMonitors().find((m) => m.id === id);
    if (!mon) throw new Error('Monitor no encontrado.');
    if (this.inFlight.has(id)) return this._getRt(id);

    const rt = this._getRt(id);
    if (rt.activeStreamId) {
      rt.state = 'live';
      rt.lastMessage = `Emitiendo en slot #${rt.activeStreamId}`;
      this.emitUpdate();
      return rt;
    }

    if (forceResetTriggered) {
      this.store.updateMonitor(id, { lastTriggeredVideoId: '' });
    }

    const account = this.store.getAccountRaw(mon.accountId);
    if (!account) {
      rt.state = 'error';
      rt.lastCheckedAt = new Date().toISOString();
      rt.lastMessage = 'Cuenta destino no existe';
      this.emitUpdate();
      return rt;
    }

    if (this.manager.isAccountInUse(mon.accountId)) {
      rt.state = 'busy';
      rt.lastCheckedAt = new Date().toISOString();
      rt.lastMessage = `Cuenta "${account.name}" ocupada en otra transmisión`;
      this.emitUpdate();
      return rt;
    }

    this.inFlight.add(id);
    rt.state = 'checking';
    rt.lastMessage = 'Consultando estado del canal...';
    this.emitUpdate();

    try {
      const { stdout } = await execFileAsync('yt-dlp', [
        '--no-playlist',
        '--js-runtimes', 'node',
        '--extractor-args', 'youtube:player_client=ios,android,tv,mweb',
        '--print', 'live_status',
        '--print', 'id',
        '--print', 'title',
        '--print', 'webpage_url',
        mon.channelUrl
      ], { timeout: 20000 });

      const lines = stdout.trim().split('\n').map((l) => l.trim());
      const liveStatus = lines[0] || '';
      const videoId = lines[1] || '';
      const title = lines[2] || mon.name;
      const resolvedUrl = lines[3] || mon.channelUrl;

      rt.lastCheckedAt = new Date().toISOString();
      rt.lastTitle = title;

      if (liveStatus !== 'is_live') {
        rt.state = 'offline';
        rt.lastMessage = `Offline (${liveStatus || 'sin directo'})`;
        if (mon.lastTriggeredVideoId && (!videoId || videoId !== mon.lastTriggeredVideoId)) {
          this.store.updateMonitor(id, { lastTriggeredVideoId: '' });
        }
        this.emitUpdate();
        return rt;
      }

      if (videoId && mon.lastTriggeredVideoId === videoId) {
        rt.state = 'offline';
        rt.lastMessage = 'Ya fue emitido manualmente o detenido en esta sesión';
        this.emitUpdate();
        return rt;
      }

      const cleanTitle = (mon.tiktokTitle || '{title}')
        .replace(/\{title\}/g, title)
        .slice(0, 80);

      rt.state = 'live';
      rt.lastMessage = `En vivo detectado: "${title.slice(0, 40)}" — iniciando...`;
      this.emitUpdate();

      const summary = await this.manager.createAndStartStream({
        sourceUrl: resolvedUrl,
        mode: mon.mode,
        quality: mon.quality,
        topicId: mon.topicId || '5',
        tiktokTitle: cleanTitle,
        autoReconnect: true,
        reconnectDelay: 5,
        donation: mon.donation
      }, account);

      rt.activeStreamId = summary.id;
      rt.lastMessage = `Transmitiendo en slot #${summary.id}`;
      this.store.updateMonitor(id, { lastTriggeredVideoId: videoId || resolvedUrl });
      this.emitUpdate();
      return rt;
    } catch (err) {
      rt.lastCheckedAt = new Date().toISOString();
      const msg = (err.stderr || err.message || '').toLowerCase();
      if (msg.includes('not currently live') || msg.includes('offline') || msg.includes('not_live') || msg.includes('no live')) {
        rt.state = 'offline';
        rt.lastMessage = 'Canal sin directo activo';
        if (mon.lastTriggeredVideoId) {
          this.store.updateMonitor(id, { lastTriggeredVideoId: '' });
        }
      } else {
        rt.state = 'error';
        rt.lastMessage = `Aviso: ${(err.message || 'error').slice(0, 100)}`;
      }
      this.emitUpdate();
      return rt;
    } finally {
      this.inFlight.delete(id);
    }
  }
}
