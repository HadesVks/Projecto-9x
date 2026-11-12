import { spawn, execFile, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import util from 'util';

const execFileAsync = util.promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PYTHON_BIN = path.join(__dirname, 'venv', 'bin', 'python3');
const TIKTOK_MGR = path.join(__dirname, 'tiktok', 'tiktok_manager.py');
const DONATIONS_DIR = path.join(__dirname, 'donations');
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const VAAPI_DEVICE = '/dev/dri/renderD128';

fs.mkdirSync(DONATIONS_DIR, { recursive: true });

export const QUALITY_PROFILES = {
  '720p30': {
    label: '720p 30fps (Ideal Multi-Stream)',
    width: 720,
    height: 1280,
    w16: 1280,
    h16: 720,
    fps: 30,
    gop: 60,
    bitrate: '2800k',
    bufsize: '5600k',
    fontSize: 24,
    fontSize16: 22,
    boxPad: 14,
    wrapChars: 34,
    wrapChars16: 62
  },
  '1080p30': {
    label: '1080p 30fps (Alta Calidad)',
    width: 1080,
    height: 1920,
    w16: 1920,
    h16: 1080,
    fps: 30,
    gop: 60,
    bitrate: '4500k',
    bufsize: '9000k',
    fontSize: 32,
    fontSize16: 30,
    boxPad: 18,
    wrapChars: 36,
    wrapChars16: 68
  },
  '1080p60': {
    label: '1080p 60fps (Fluidez Máxima)',
    width: 1080,
    height: 1920,
    w16: 1920,
    h16: 1080,
    fps: 60,
    gop: 120,
    bitrate: '6000k',
    bufsize: '12000k',
    fontSize: 32,
    fontSize16: 30,
    boxPad: 18,
    wrapChars: 36,
    wrapChars16: 68
  }
};

function wrapText(rawText, maxChars = 36) {
  const clean = (rawText || '').trim();
  if (!clean) return ' ';
  const paragraphs = clean.split(/\r?\n/);
  const lines = [];
  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/);
    let current = '';
    for (const w of words) {
      if (!current) {
        current = w;
      } else if (current.length + 1 + w.length <= maxChars) {
        current += ` ${w}`;
      } else {
        lines.push(current);
        current = w;
      }
    }
    if (current) lines.push(current);
  }
  return lines.join('\n') || ' ';
}

function checkVaapiAvailable() {
  try {
    fs.accessSync(VAAPI_DEVICE, fs.constants.R_OK | fs.constants.W_OK);
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'nullsrc=s=128x128:d=0.1',
      '-vaapi_device', VAAPI_DEVICE,
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi', '-f', 'null', '-'
    ], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export class StreamInstance extends EventEmitter {
  constructor({ id, listenPort, vaapiSupported }) {
    super();
    this.id = id;
    this.listenPort = listenPort;
    this.vaapiSupported = vaapiSupported;

    this.status = 'idle'; // 'idle' | 'checking' | 'starting' | 'running' | 'stopping' | 'finished' | 'error'
    this.config = null;
    this.accountInfo = null;
    this.ytdlpProc = null;
    this.ffmpegProc = null;
    this.tiktokSession = null;
    this.startedAt = null;
    this.reconnectTimeout = null;
    this.isManualStop = false;
    this.ytdlpFinishedCleanly = false;
    this.forceSoftwareFallback = false;
    this.ffmpegStderrBuffer = [];
    this.logs = [];
    this.maxLogs = 150;
    this.donationFilePath = path.join(DONATIONS_DIR, `${this.id}.txt`);
    this.stats = {
      fps: 0,
      bitrate: '0kbits/s',
      speed: '0x',
      frames: 0,
      uptimeSeconds: 0,
      encoder: 'idle'
    };
  }

  addLog(type, message) {
    const entry = {
      streamId: this.id,
      time: new Date().toLocaleTimeString('es-DO', { hour12: false }),
      type,
      message: message.trim()
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.emit('log', entry);
  }

  getSummary() {
    return {
      id: this.id,
      status: this.status,
      startedAt: this.startedAt,
      listenPort: this.listenPort,
      stats: {
        ...this.stats,
        uptimeSeconds: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0
      },
      tiktokSession: this.tiktokSession ? {
        roomId: this.tiktokSession.room_id,
        shareUrl: this.tiktokSession.share_url
      } : null,
      config: this.config ? {
        sourceUrl: this.config.sourceUrl,
        accountId: this.config.accountId,
        accountName: this.accountInfo?.name || 'Manual',
        platform: this.accountInfo?.platform || 'custom',
        mode: this.config.mode,
        quality: this.config.quality,
        encoder: this.config.encoder,
        tiktokTitle: this.config.tiktokTitle,
        autoReconnect: this.config.autoReconnect,
        reconnectDelay: this.config.reconnectDelay,
        donation: this.config.donation
      } : null
    };
  }

  getLogs() {
    return this.logs;
  }

  _writeDonationFile() {
    if (!this.config?.donation) return;
    const prof = QUALITY_PROFILES[this.config.quality] || QUALITY_PROFILES['1080p30'];
    const isHoriz = this.config.mode === 'copy';
    const maxChars = isHoriz ? prof.wrapChars16 : prof.wrapChars;
    const wrapped = wrapText(this.config.donation.text, maxChars);
    const tmp = `${this.donationFilePath}.tmp`;
    fs.writeFileSync(tmp, wrapped, 'utf-8');
    fs.renameSync(tmp, this.donationFilePath);
  }

  updateDonationLive(donationUpdates) {
    if (!this.config) throw new Error('Transmisión sin configuración activa.');
    this.config.donation = { ...this.config.donation, ...donationUpdates };
    this._writeDonationFile();
    this.addLog('info', `💖 Texto de donación actualizado en vivo: "${this.config.donation.text}"`);
    this.emit('status', this.getSummary());
    return this.config.donation;
  }

  _buildTargetUrl(server, key) {
    const cleanServer = (server || '').trim();
    const cleanKey = (key || '').trim();
    if (!cleanKey) return cleanServer;
    return cleanServer.endsWith('/') ? `${cleanServer}${cleanKey}` : `${cleanServer}/${cleanKey}`;
  }

  async start(config, account) {
    if (['running', 'starting', 'checking'].includes(this.status)) {
      throw new Error(`El slot ${this.id} ya está activo.`);
    }

    if (!config.sourceUrl || !config.sourceUrl.trim()) {
      throw new Error('Debes indicar la URL del en vivo de origen.');
    }
    if (!account) {
      throw new Error('Debes seleccionar una cuenta de destino válida.');
    }

    this.accountInfo = account;
    this.isManualStop = false;
    this.ytdlpFinishedCleanly = false;
    this.forceSoftwareFallback = false;
    this.ffmpegStderrBuffer = [];

    const donationCfg = {
      enabled: Boolean(config.donation?.enabled),
      text: (config.donation?.text || '').trim() || 'Apoya el stream ★ Donaciones',
      position: config.donation?.position || 'bottom',
      displayMode: config.donation?.displayMode || 'periodic',
      intervalSec: Math.max(15, Number(config.donation?.intervalSec) || 180),
      durationSec: Math.max(5, Number(config.donation?.durationSec) || 25)
    };

    this.config = {
      sourceUrl: config.sourceUrl.trim(),
      accountId: account.id,
      mode: config.mode || 'vertical_blur',
      quality: QUALITY_PROFILES[config.quality] ? config.quality : '1080p30',
      encoder: config.encoder || 'auto',
      autoReconnect: config.autoReconnect !== false,
      reconnectDelay: Math.max(2, Number(config.reconnectDelay) || 5),
      tiktokTitle: (config.tiktokTitle || '').trim() || '⚡ Transmisión en Vivo | Projecto 9x',
      donation: donationCfg
    };

    this._writeDonationFile();

    this.status = 'checking';
    this.emit('status', this.getSummary());
    this.addLog('info', `[${this.id}] Verificando directo: ${this.config.sourceUrl}`);

    try {
      const { stdout } = await execFileAsync('yt-dlp', [
        '--js-runtimes', 'node',
        '--extractor-args', 'youtube:player_client=ios,android,tv,mweb',
        '--print', 'live_status',
        this.config.sourceUrl
      ], { timeout: 15000 });

      const liveStatus = stdout.trim();
      this.addLog('info', `Estado del directo en origen: ${liveStatus}`);
      if (['not_live', 'was_live', 'is_upcoming', 'post_live'].includes(liveStatus)) {
        this.status = 'idle';
        throw new Error(`El enlace no está transmitiendo en vivo ahora (estado: ${liveStatus}).`);
      }
    } catch (err) {
      if (err.message && err.message.includes('no está transmitiendo')) throw err;
      this.addLog('warn', `Aviso pre-flight: ${err.message}. Intentando ingesta...`);
    }

    if (this.isManualStop) return;

    this.status = 'starting';
    this.emit('status', this.getSummary());
    await this._spawnPipeline();
  }

  _buildFfmpegArgs(finalRtmpDestination) {
    const prof = QUALITY_PROFILES[this.config.quality];
    const mode = this.config.mode;
    const donation = this.config.donation;
    const isPureCopy = mode === 'copy' && !donation.enabled;

    const useVaapi =
      !isPureCopy &&
      !this.forceSoftwareFallback &&
      this.config.encoder !== 'x264' &&
      this.vaapiSupported;

    this.stats.encoder = isPureCopy ? 'copy' : (useVaapi ? 'h264_vaapi (GPU)' : 'libx264 (CPU)');

    const args = ['-fflags', '+genpts+discardcorrupt', '-re'];
    if (useVaapi) {
      args.push('-vaapi_device', VAAPI_DEVICE);
    }
    args.push('-i', 'pipe:0');

    if (isPureCopy) {
      args.push(
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-max_muxing_queue_size', '1024',
        '-f', 'flv',
        finalRtmpDestination
      );
      return args;
    }

    // Si eligió "copy" pero activó el banner de donaciones, transcodificamos en 16:9 por GPU
    const effectiveMode = mode === 'copy' ? 'horizontal' : mode;
    const targetW = effectiveMode === 'horizontal' ? prof.w16 : prof.width;
    const targetH = effectiveMode === 'horizontal' ? prof.h16 : prof.height;
    const fontSize = effectiveMode === 'horizontal' ? prof.fontSize16 : prof.fontSize;

    let filterGraph = '';
    if (effectiveMode === 'vertical_blur') {
      filterGraph =
        `[0:v]split=2[bg_src][fg_src];` +
        `[bg_src]scale=180:320:force_original_aspect_ratio=increase:flags=fast_bilinear,` +
        `crop=180:320:(in_w-180)/2:(in_h-320)/2,boxblur=6:2,` +
        `scale=${targetW}:${targetH}:flags=fast_bilinear[bg];` +
        `[fg_src]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=bilinear[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2`;
    } else if (effectiveMode === 'vertical_crop') {
      filterGraph =
        `[0:v]crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)',scale=${targetW}:${targetH}:flags=bilinear`;
    } else {
      filterGraph =
        `[0:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=bilinear,` +
        `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2`;
    }

    if (donation.enabled && fs.existsSync(FONT_PATH)) {
      let yExpr = effectiveMode === 'horizontal' ? 'h-text_h-50' : 'h-text_h-130';
      if (donation.position === 'top') yExpr = '90';
      if (donation.position === 'center_bottom') yExpr = 'h*0.72-text_h/2';

      let draw =
        `,drawtext=fontfile=${FONT_PATH}:textfile=${this.donationFilePath}:reload=30:` +
        `expansion=none:text_align=center:fontcolor=white:fontsize=${fontSize}:line_spacing=8:` +
        `box=1:boxcolor=black@0.76:boxborderw=${prof.boxPad}:x=(w-text_w)/2:y=${yExpr}`;

      if (donation.displayMode === 'periodic') {
        const totalPeriod = donation.intervalSec + donation.durationSec;
        draw += `:enable='lt(mod(t,${totalPeriod}),${donation.durationSec})'`;
      }
      filterGraph += draw;
    }

    if (useVaapi) {
      filterGraph += ',setsar=1,format=nv12,hwupload[v_out]';
    } else {
      filterGraph += ',setsar=1[v_out]';
    }

    args.push('-filter_complex', filterGraph, '-map', '[v_out]', '-map', '0:a?');

    if (useVaapi) {
      args.push(
        '-c:v', 'h264_vaapi',
        '-rc_mode', 'CBR',
        '-profile:v', 'high',
        '-b:v', prof.bitrate,
        '-maxrate', prof.bitrate,
        '-bufsize', prof.bufsize,
        '-r', String(prof.fps),
        '-g', String(prof.gop)
      );
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'superfast',
        '-tune', 'zerolatency',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-b:v', prof.bitrate,
        '-minrate', prof.bitrate,
        '-maxrate', prof.bitrate,
        '-bufsize', prof.bufsize,
        '-r', String(prof.fps),
        '-g', String(prof.gop),
        '-keyint_min', String(prof.gop),
        '-sc_threshold', '0'
      );
    }

    args.push(
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      '-max_muxing_queue_size', '1024',
      '-f', 'flv',
      finalRtmpDestination
    );
    return args;
  }

  async _spawnPipeline() {
    if (this.isManualStop) return;

    this.ffmpegStderrBuffer = [];
    const acc = this.accountInfo;
    const prof = QUALITY_PROFILES[this.config.quality];
    const isHoriz = this.config.mode === 'copy';
    const resStr = isHoriz ? `${prof.w16}x${prof.h16}` : `${prof.width}x${prof.height}`;
    let finalRtmpDestination = '';

    if (acc.platform === 'tiktok') {
      if (acc.authType === 'cookies' && acc.cookiesAbsPath) {
        this.addLog('info', `Creando sala en TikTok (${acc.name}) y Proxy SEI en puerto ${this.listenPort}...`);
        try {
          const { stdout } = await execFileAsync(PYTHON_BIN, [
            TIKTOK_MGR,
            '--create',
            '--title', this.config.tiktokTitle,
            '--cookies', acc.cookiesAbsPath,
            '--session-id', this.id,
            '--listen-port', String(this.listenPort),
            '--fps', String(prof.fps),
            '--resolution', resStr
          ], { timeout: 35000 });

          if (this.isManualStop) {
            await this._cleanupTikTokSession();
            return;
          }

          this.tiktokSession = JSON.parse(stdout.trim());
          finalRtmpDestination = this.tiktokSession.local_proxy_url || `rtmp://127.0.0.1:${this.listenPort}/live/obs`;
          this.addLog('info', `Sala TikTok creada: ID ${this.tiktokSession.room_id}`);
          if (this.tiktokSession.share_url) {
            this.addLog('info', `Enlace sala: ${this.tiktokSession.share_url}`);
          }
        } catch (err) {
          if (this.isManualStop) return;
          this.status = 'error';
          this.addLog('error', `Error creando sala TikTok: ${err.message}`);
          this.emit('status', this.getSummary());
          return;
        }
      } else {
        const rawTarget = this._buildTargetUrl(acc.rtmpServer, acc.streamKey);
        this.addLog('info', `Activando Proxy SEI en puerto ${this.listenPort} para ${acc.name}...`);
        try {
          const { stdout } = await execFileAsync(PYTHON_BIN, [
            TIKTOK_MGR,
            '--proxy-only', rawTarget,
            '--session-id', this.id,
            '--listen-port', String(this.listenPort),
            '--fps', String(prof.fps),
            '--resolution', resStr
          ], { timeout: 15000 });

          if (this.isManualStop) {
            await this._cleanupTikTokSession();
            return;
          }

          const proxyRes = JSON.parse(stdout.trim());
          finalRtmpDestination = proxyRes.proxy_url || `rtmp://127.0.0.1:${this.listenPort}/live/obs`;
        } catch (err) {
          this.addLog('warn', `Proxy SEI no disponible (${err.message}). Push directo...`);
          finalRtmpDestination = rawTarget;
        }
      }
    } else {
      finalRtmpDestination = this._buildTargetUrl(acc.rtmpServer, acc.streamKey);
    }

    if (this.isManualStop) {
      await this._cleanupTikTokSession();
      return;
    }

    // 1. Spawn yt-dlp en grupo de procesos aislado (detached: true) para matar sus hijos ffmpeg sin huérfanos
    const ytdlpArgs = [
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=ios,android,tv,mweb',
      '--hls-use-mpegts',
      '--retries', '10',
      '--fragment-retries', '10',
      '--retry-sleep', '5',
      '-o', '-',
      '-f', 'bestvideo+bestaudio/best',
      '--no-part',
      '--buffer-size', '16k',
      this.config.sourceUrl
    ];

    try {
      this.ytdlpProc = spawn('yt-dlp', ytdlpArgs, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      this.status = 'error';
      this.addLog('error', `Fallo yt-dlp: ${err.message}`);
      this.emit('status', this.getSummary());
      return;
    }

    // 2. Construir y lanzar FFmpeg
    const ffmpegArgs = this._buildFfmpegArgs(finalRtmpDestination);
    this.addLog('info', `Codificador activo: ${this.stats.encoder} (${this.config.quality})`);

    try {
      this.ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      this.status = 'error';
      this.addLog('error', `Fallo ffmpeg: ${err.message}`);
      this._killYtDlpTree('SIGKILL');
      this.emit('status', this.getSummary());
      return;
    }

    this.ytdlpProc.stdout.pipe(this.ffmpegProc.stdin);

    this.ytdlpProc.stdout.on('error', (err) => {
      if (!this.isManualStop && !this.ytdlpFinishedCleanly) {
        this.addLog('warn', `yt-dlp pipe: ${err.message}`);
      }
    });

    this.ffmpegProc.stdin.on('error', (err) => {
      if (!this.isManualStop && !this.ytdlpFinishedCleanly) {
        this.addLog('warn', `ffmpeg stdin: ${err.message}`);
      }
    });

    this.ytdlpProc.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg.includes('ERROR:')) this.addLog('error', `yt-dlp: ${msg}`);
      else if (msg.includes('WARNING:')) this.addLog('warn', `yt-dlp: ${msg}`);
    });

    this.ffmpegProc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        this.ffmpegStderrBuffer.push(line);
        if (this.ffmpegStderrBuffer.length > 25) this.ffmpegStderrBuffer.shift();
      }

      const frameMatch = text.match(/frame=\s*(\d+)/);
      const fpsMatch = text.match(/fps=\s*([\d\.]+)/);
      const bitrateMatch = text.match(/bitrate=\s*([\d\.]+\w+\/s)/);
      const speedMatch = text.match(/speed=\s*([\d\.]+x)/);

      if (frameMatch || fpsMatch || bitrateMatch) {
        if (this.status !== 'running') {
          this.status = 'running';
          this.startedAt = Date.now();
          this.addLog('info', `🟢 [${acc.name}] Emitiendo en vivo (${this.stats.encoder})`);
          this.emit('status', this.getSummary());
        }

        if (fpsMatch) this.stats.fps = parseFloat(fpsMatch[1]);
        if (bitrateMatch) this.stats.bitrate = bitrateMatch[1];
        if (speedMatch) this.stats.speed = speedMatch[1];
        if (frameMatch) this.stats.frames = parseInt(frameMatch[1], 10);

        this.emit('stats', { id: this.id, stats: this.getSummary().stats });
      } else {
        const clean = text.trim();
        if (clean.includes('Error') || clean.includes('failed') || clean.includes('refused')) {
          this.addLog('error', `ffmpeg: ${clean}`);
        }
      }
    });

    this.ytdlpProc.on('close', (code) => {
      if (code === 0) {
        this.ytdlpFinishedCleanly = true;
        this.addLog('info', '🏁 El directo de origen ha finalizado.');
      } else if (!this.isManualStop) {
        this.addLog('warn', `yt-dlp cerró con código ${code}`);
      }
    });

    this.ffmpegProc.on('close', (code) => {
      this._handleProcessExit(code);
    });
  }

  _killYtDlpTree(sig = 'SIGTERM') {
    if (!this.ytdlpProc || !this.ytdlpProc.pid) return;
    try {
      // Negar el PID mata todo el grupo de procesos (yt-dlp + su ffmpeg hijo HLS)
      process.kill(-this.ytdlpProc.pid, sig);
    } catch {
      try {
        this.ytdlpProc.kill(sig);
      } catch {}
    }
  }

  _cleanupProcesses() {
    this._killYtDlpTree('SIGKILL');
    this.ytdlpProc = null;
    if (this.ffmpegProc) {
      try { this.ffmpegProc.kill('SIGKILL'); } catch {}
      this.ffmpegProc = null;
    }
  }

  async _cleanupTikTokSession() {
    if (!this.accountInfo || this.accountInfo.platform !== 'tiktok') return;
    if (this._cleaningUpSession) return this._cleaningUpSession;

    this._cleaningUpSession = (async () => {
      try {
        const args = [TIKTOK_MGR, '--end', '--session-id', this.id];
        if (this.accountInfo.cookiesAbsPath) {
          args.push('--cookies', this.accountInfo.cookiesAbsPath);
        }
        await execFileAsync(PYTHON_BIN, args, { timeout: 10000 });
        this.tiktokSession = null;
      } catch {} finally {
        this._cleaningUpSession = null;
      }
    })();

    return this._cleaningUpSession;
  }

  _resetStats() {
    this.stats = {
      fps: 0,
      bitrate: '0kbits/s',
      speed: '0x',
      frames: 0,
      uptimeSeconds: 0,
      encoder: 'idle'
    };
  }

  async _handleProcessExit(code) {
    if (this.isManualStop) {
      this.status = 'idle';
      this.startedAt = null;
      this._resetStats();
      this._cleanupProcesses();
      await this._cleanupTikTokSession();
      this.addLog('info', 'Transmisión detenida manualmente.');
      this.emit('status', this.getSummary());
      return;
    }

    if (this.ytdlpFinishedCleanly && code === 0) {
      this.status = 'finished';
      this.startedAt = null;
      this._resetStats();
      this._cleanupProcesses();
      await this._cleanupTikTokSession();
      this.addLog('info', '✅ Directo terminado limpiamente por el creador.');
      this.emit('status', this.getSummary());
      return;
    }

    // Fallback automático a CPU si VAAPI falló antes de empezar a emitir
    const failedEarlyWithVaapi =
      code !== 0 &&
      this.stats.frames === 0 &&
      this.stats.encoder.includes('vaapi') &&
      !this.forceSoftwareFallback;

    if (failedEarlyWithVaapi) {
      this.forceSoftwareFallback = true;
      this.addLog('warn', 'VAAPI falló al inicializar para este stream; cambiando automáticamente a libx264 (CPU)...');
      this._cleanupProcesses();
      await this._spawnPipeline();
      return;
    }

    if (code !== 0 && this.ffmpegStderrBuffer.length > 0) {
      const errLines = this.ffmpegStderrBuffer.filter((l) =>
        l.includes('Error') || l.includes('Invalid') || l.includes('failed') || l.includes('not found')
      );
      if (errLines.length > 0) {
        this.addLog('error', `FFmpeg: ${errLines.slice(-2).join(' | ')}`);
      }
    }

    this.addLog('warn', `Pipeline terminado (código: ${code}).`);
    this._cleanupProcesses();

    if (this.config && this.config.autoReconnect) {
      this.status = 'starting';
      this.addLog('warn', `Reconexión automática en ${this.config.reconnectDelay}s...`);
      this.emit('status', this.getSummary());

      this.reconnectTimeout = setTimeout(async () => {
        if (!this.isManualStop && this.config) {
          this.addLog('info', 'Reconectando...');
          await this._spawnPipeline();
        }
      }, this.config.reconnectDelay * 1000);
    } else {
      this.status = 'idle';
      this.startedAt = null;
      this._resetStats();
      await this._cleanupTikTokSession();
      this.emit('status', this.getSummary());
    }
  }

  async stop() {
    this.isManualStop = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (['idle', 'finished'].includes(this.status)) {
      this._cleanupProcesses();
      await this._cleanupTikTokSession();
      return { message: 'Stream inactivo.' };
    }

    this.status = 'stopping';
    this.addLog('info', 'Deteniendo transmisión...');
    this.emit('status', this.getSummary());

    if (this.ffmpegProc) {
      try { this.ffmpegProc.kill('SIGTERM'); } catch {}
    }
    this._killYtDlpTree('SIGTERM');

    await this._cleanupTikTokSession();

    setTimeout(() => {
      this._cleanupProcesses();
      if (this.status === 'stopping') {
        this.status = 'idle';
        this.startedAt = null;
        this._resetStats();
        this.emit('status', this.getSummary());
      }
    }, 1200);

    return { message: 'Transmisión detenida.' };
  }
}

export class StreamManager extends EventEmitter {
  constructor() {
    super();
    this.streams = new Map();
    this.nextIdNum = 1;
    this.vaapiSupported = checkVaapiAvailable();
    console.log(`[StreamManager] GPU Intel VAAPI disponible: ${this.vaapiSupported}`);
  }

  _allocatePort() {
    const usedPorts = new Set();
    for (const s of this.streams.values()) {
      usedPorts.add(s.listenPort);
    }
    for (let port = 19350; port < 19450; port++) {
      if (!usedPorts.has(port)) return port;
    }
    throw new Error('No hay puertos RTMP locales disponibles.');
  }

  async createAndStartStream(config, account) {
    // Evitar duplicar exactamente la misma cuenta en 2 streams activos simultáneamente
    for (const s of this.streams.values()) {
      if (
        (s.config?.accountId === account.id || s.accountInfo?.id === account.id) &&
        ['checking', 'starting', 'running', 'stopping'].includes(s.status)
      ) {
        throw new Error(`La cuenta "${account.name}" ya está transmitiendo en el slot ${s.id}.`);
      }
    }

    const id = `live-${this.nextIdNum++}`;
    const listenPort = this._allocatePort();
    const instance = new StreamInstance({
      id,
      listenPort,
      vaapiSupported: this.vaapiSupported
    });
    instance.accountInfo = account;

    instance.on('status', (summary) => this.emit('stream_status', summary));
    instance.on('stats', (payload) => this.emit('stream_stats', payload));
    instance.on('log', (entry) => this.emit('stream_log', entry));

    this.streams.set(id, instance);

    try {
      await instance.start(config, account);
    } catch (err) {
      try { fs.unlinkSync(instance.donationFilePath); } catch {}
      this.streams.delete(id);
      this.emit('stream_removed', { id });
      throw err;
    }
    return instance.getSummary();
  }

  async stopAll() {
    await Promise.allSettled(
      Array.from(this.streams.values()).map((s) => s.stop())
    );
  }

  async stopStream(id) {
    const s = this.streams.get(id);
    if (!s) throw new Error('Transmisión no encontrada.');
    return await s.stop();
  }

  async removeStream(id) {
    const s = this.streams.get(id);
    if (!s) throw new Error('Transmisión no encontrada.');
    if (['checking', 'starting', 'running', 'stopping'].includes(s.status)) {
      await s.stop();
    }
    try { fs.unlinkSync(s.donationFilePath); } catch {}
    this.streams.delete(id);
    this.emit('stream_removed', { id });
    return { removed: true, id };
  }

  updateDonation(id, updates) {
    const s = this.streams.get(id);
    if (!s) throw new Error('Transmisión no encontrada.');
    return s.updateDonationLive(updates);
  }

  isAccountInUse(accountId) {
    for (const s of this.streams.values()) {
      if (
        (s.config?.accountId === accountId || s.accountInfo?.id === accountId) &&
        ['checking', 'starting', 'running', 'stopping'].includes(s.status)
      ) {
        return true;
      }
    }
    return false;
  }

  listStreams() {
    return Array.from(this.streams.values()).map((s) => s.getSummary());
  }

  getStreamLogs(id) {
    const s = this.streams.get(id);
    return s ? s.getLogs() : [];
  }

  getSystemMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const load1 = os.loadavg()[0] || 0;
    const cpuCount = os.cpus().length || 8;
    const activeCount = Array.from(this.streams.values()).filter((s) =>
      ['running', 'starting', 'checking'].includes(s.status)
    ).length;

    let tempC = null;
    try {
      const files = fs.readdirSync('/sys/class/thermal').filter((f) => f.startsWith('thermal_zone'));
      let maxT = 0;
      for (const f of files) {
        const val = parseInt(fs.readFileSync(`/sys/class/thermal/${f}/temp`, 'utf-8').trim(), 10);
        if (!Number.isNaN(val) && val > maxT && val < 120000) maxT = val;
      }
      if (maxT > 0) tempC = Math.round(maxT / 1000);
    } catch {}

    return {
      vaapiSupported: this.vaapiSupported,
      activeStreams: activeCount,
      totalStreams: this.streams.size,
      load1: Number(load1.toFixed(2)),
      cpuApproxPct: Math.min(100, Math.round((load1 / cpuCount) * 100)),
      ramUsedGb: (usedMem / 1024 ** 3).toFixed(1),
      ramTotalGb: (totalMem / 1024 ** 3).toFixed(1),
      tempC
    };
  }
}
