import { spawn, execFile, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import util from 'util';

const execFileAsync = util.promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PYTHON_BIN = path.join(__dirname, 'venv', 'bin', 'python3');
const TIKTOK_MGR = path.join(__dirname, 'tiktok', 'tiktok_manager.py');
const QUOTA_FILE = path.join(__dirname, 'tiktok', 'logs', 'rapidapi_quota.json');
const DONATIONS_DIR = path.join(__dirname, 'donations');
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const VAAPI_DEVICE = '/dev/dri/renderD128';

fs.mkdirSync(DONATIONS_DIR, { recursive: true });

export const DONATION_STYLES = {
  dark: { label: 'Oscuro Clásico', fontcolor: 'white', boxcolor: 'black@0.76', borderw: 0, bordercolor: 'black@0' },
  tiktok: { label: 'Neón TikTok', fontcolor: '0x00f2fe', boxcolor: '0x0f172a@0.86', borderw: 2, bordercolor: '0xff0050@0.88' },
  gold: { label: 'Dorado VIP', fontcolor: '0xffd54f', boxcolor: '0x1e1400@0.86', borderw: 2, bordercolor: '0xd97706@0.88' },
  alert: { label: 'Alerta Roja', fontcolor: 'white', boxcolor: '0x7f1d1d@0.88', borderw: 2, bordercolor: '0xff3366@0.9' }
};

export const TIKTOK_TOPICS = [
  { id: '5', label: 'Gaming (5)' },
  { id: '42', label: 'Entretenimiento / Variedades (42)' },
  { id: '4', label: 'Música (4)' },
  { id: '3', label: 'Charla / IRL (3)' },
  { id: '14', label: 'Deportes (14)' }
];

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
  if (!clean) return '';
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
  return lines.join('\n');
}

function splitDonationMessages(rawText) {
  return String(rawText || '')
    .split('|')
    .map((m) => m.trim())
    .filter(Boolean);
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
    this.isDestroyed = false;
    this.ytdlpFinishedCleanly = false;
    this.forceSoftwareFallback = false;
    this.hasDrawtextFilter = false;
    this.ffmpegStderrBuffer = [];
    this.logs = [];
    this.maxLogs = 150;
    this.donationFilePath = path.join(DONATIONS_DIR, `${this.id}.txt`);
    this.donationIndex = 0;
    this.donationRotateTimer = null;
    this.watchdogTimer = null;
    this.stopForceTimer = null;
    this._stopPromise = null;
    this._exitNotifyResolvers = [];
    this.consecutiveEarlyFailures = 0;
    this.maxEarlyRetries = 5;
    this.lastProgressAt = 0;
    this.lastProgressFrames = 0;
    this.stats = {
      fps: 0,
      bitrate: '0kbits/s',
      speed: '0x',
      frames: 0,
      uptimeSeconds: 0,
      encoder: 'idle'
    };
  }

  _emitStatus() {
    if (!this.isDestroyed) {
      this.emit('status', this.getSummary());
    }
  }

  addLog(type, message) {
    if (this.isDestroyed) return;
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
        topicId: this.config.topicId,
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
    if (this.isDestroyed || !this.config?.donation) return;
    let content = '';
    if (this.config.donation.enabled) {
      const msgs = splitDonationMessages(this.config.donation.text);
      const currentMsg = msgs.length > 0 ? msgs[this.donationIndex % msgs.length] : '';
      const prof = QUALITY_PROFILES[this.config.quality] || QUALITY_PROFILES['1080p30'];
      const isHoriz = ['copy', 'horizontal'].includes(this.config.mode);
      const maxChars = isHoriz ? prof.wrapChars16 : prof.wrapChars;
      content = wrapText(currentMsg, maxChars);
    }
    const tmp = `${this.donationFilePath}.tmp`;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, this.donationFilePath);
  }

  _startDonationRotation() {
    this._stopDonationRotation();
    if (this.isDestroyed) return;
    const msgs = splitDonationMessages(this.config?.donation?.text);
    if (!this.config?.donation?.enabled || msgs.length <= 1) return;
    const sec = Math.max(12, Number(this.config.donation.rotateSec) || 25);
    this.donationRotateTimer = setInterval(() => {
      if (this.isDestroyed || !this.config?.donation?.enabled) return;
      this.donationIndex = (this.donationIndex + 1) % msgs.length;
      this._writeDonationFile();
    }, sec * 1000);
  }

  _stopDonationRotation() {
    if (this.donationRotateTimer) {
      clearInterval(this.donationRotateTimer);
      this.donationRotateTimer = null;
    }
  }

  updateDonationLive(donationUpdates) {
    if (!this.config || this.isDestroyed) throw new Error('Transmisión sin configuración activa.');
    const wantsEnabled = donationUpdates.enabled !== undefined
      ? Boolean(donationUpdates.enabled)
      : this.config.donation.enabled;

    if (wantsEnabled && !this.hasDrawtextFilter && ['running', 'starting'].includes(this.status)) {
      throw new Error('El modo Copia Directa se inició sin filtro de texto. Activa Donaciones al iniciar o usa otro formato.');
    }

    this.config.donation = { ...this.config.donation, ...donationUpdates };
    this.donationIndex = 0;
    this._writeDonationFile();
    this._startDonationRotation();

    if (donationUpdates.enabled === false) {
      this.addLog('info', '💖 Banner de donaciones pausado en vivo.');
    } else if (donationUpdates.enabled === true && donationUpdates.text === undefined) {
      this.addLog('info', '💖 Banner de donaciones activado en vivo.');
    } else {
      this.addLog('info', `💖 Texto de donación actualizado en vivo: "${this.config.donation.text}"`);
    }
    this._emitStatus();
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
    this.consecutiveEarlyFailures = 0;
    this.ffmpegStderrBuffer = [];

    const donationCfg = {
      enabled: Boolean(config.donation?.enabled),
      text: (config.donation?.text || '').trim() || 'Apoya el stream ★ Donaciones',
      position: config.donation?.position || 'bottom',
      displayMode: config.donation?.displayMode || 'periodic',
      style: DONATION_STYLES[config.donation?.style] ? config.donation.style : 'dark',
      intervalSec: Math.max(15, Number(config.donation?.intervalSec) || 180),
      durationSec: Math.max(5, Number(config.donation?.durationSec) || 25),
      rotateSec: Math.max(12, Number(config.donation?.rotateSec) || 25)
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
      topicId: String(config.topicId || '5').trim() || '5',
      donation: donationCfg
    };

    this.donationIndex = 0;
    this._writeDonationFile();

    this.status = 'checking';
    this._emitStatus();
    this.addLog('info', `[${this.id}] Verificando directo: ${this.config.sourceUrl}`);

    try {
      const liveStatus = await this._probeLiveStatus(this.config.sourceUrl);
      if (liveStatus) {
        this.addLog('info', `Estado del directo en origen: ${liveStatus}`);
        if (['not_live', 'was_live', 'is_upcoming', 'post_live'].includes(liveStatus)) {
          this.status = 'idle';
          throw new Error(`El enlace no está transmitiendo en vivo ahora (estado: ${liveStatus}).`);
        }
      }
    } catch (err) {
      if (err.message && err.message.includes('no está transmitiendo')) throw err;
      this.addLog('warn', `Aviso pre-flight: ${err.message}. Intentando ingesta...`);
    }

    if (this.isManualStop || this.isDestroyed) return;

    this.status = 'starting';
    this._emitStatus();
    await this._spawnPipeline();
  }

  async _probeLiveStatus(url) {
    const { stdout } = await execFileAsync('yt-dlp', [
      '--no-playlist',
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=ios,android,tv,mweb',
      '--print', 'live_status',
      url
    ], { timeout: 15000 });
    return stdout.trim();
  }

  _buildFfmpegArgs(finalRtmpDestination) {
    const prof = QUALITY_PROFILES[this.config.quality];
    const mode = this.config.mode;
    const donation = this.config.donation;
    const isPureCopy = mode === 'copy' && !donation.enabled;
    this.hasDrawtextFilter = !isPureCopy && fs.existsSync(FONT_PATH);

    const useVaapi =
      !isPureCopy &&
      !this.forceSoftwareFallback &&
      this.config.encoder !== 'x264' &&
      this.vaapiSupported;

    this.stats.encoder = isPureCopy ? 'copy' : (useVaapi ? 'h264_vaapi (GPU)' : 'libx264 (CPU)');

    const args = [];
    if (useVaapi) {
      args.push('-hwaccel', 'vaapi', '-hwaccel_device', VAAPI_DEVICE);
    }
    args.push('-fflags', '+genpts+discardcorrupt', '-re', '-i', 'pipe:0');

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

    if (this.hasDrawtextFilter) {
      const styleCfg = DONATION_STYLES[donation.style] || DONATION_STYLES.dark;
      let yExpr = effectiveMode === 'horizontal' ? 'h-text_h-50' : 'h-text_h-130';
      if (donation.position === 'top') yExpr = '90';
      if (donation.position === 'center_bottom') yExpr = 'h*0.72-text_h/2';

      let draw =
        `,drawtext=fontfile=${FONT_PATH}:textfile=${this.donationFilePath}:reload=15:` +
        `expansion=none:text_align=center:fontcolor=${styleCfg.fontcolor}:fontsize=${fontSize}:line_spacing=8:` +
        `box=1:boxcolor=${styleCfg.boxcolor}:boxborderw=${prof.boxPad}:x=(w-text_w)/2:y=${yExpr}`;

      if (styleCfg.borderw > 0) {
        draw += `:borderw=${styleCfg.borderw}:bordercolor=${styleCfg.bordercolor}`;
      }

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
    if (this.isManualStop || this.isDestroyed) return;

    this.ffmpegStderrBuffer = [];
    const acc = this.accountInfo;
    const prof = QUALITY_PROFILES[this.config.quality];
    const isHoriz = ['copy', 'horizontal'].includes(this.config.mode);
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
            '--topic', this.config.topicId || '5',
            '--cookies', acc.cookiesAbsPath,
            '--session-id', this.id,
            '--listen-port', String(this.listenPort),
            '--fps', String(prof.fps),
            '--resolution', resStr
          ], { timeout: 35000 });

          if (this.isManualStop || this.isDestroyed) {
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
          if (this.isManualStop || this.isDestroyed) return;
          this.status = 'error';
          this.addLog('error', `Error creando sala TikTok: ${err.message}`);
          this._emitStatus();
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

          if (this.isManualStop || this.isDestroyed) {
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

    if (this.isManualStop || this.isDestroyed) {
      await this._cleanupTikTokSession();
      return;
    }

    // 1. Spawn yt-dlp con tope de resolución (ahorra CPU decodificando 4K/AV1) en grupo aislado
    const maxH = prof.h16;
    const formatExpr = `best[height<=${maxH}][vcodec^=avc1]/bestvideo[height<=${maxH}][vcodec!*=av01]+bestaudio/best[height<=${maxH}]/best`;
    const ytdlpArgs = [
      '--no-playlist',
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=ios,android,tv,mweb',
      '--hls-use-mpegts',
      '--retries', '10',
      '--fragment-retries', '10',
      '--retry-sleep', '5',
      '-o', '-',
      '-f', formatExpr,
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
      this._emitStatus();
      return;
    }

    // 2. Construir y lanzar FFmpeg (stdout ignorado para evitar retener pipe innecesario)
    const ffmpegArgs = this._buildFfmpegArgs(finalRtmpDestination);
    this.addLog('info', `Codificador activo: ${this.stats.encoder} (${this.config.quality})`);

    try {
      this.ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'ignore', 'pipe']
      });
    } catch (err) {
      this.status = 'error';
      this.addLog('error', `Fallo ffmpeg: ${err.message}`);
      this._cleanupProcesses();
      this._emitStatus();
      return;
    }

    const ytdlpProcRef = this.ytdlpProc;
    const ffmpegProcRef = this.ffmpegProc;

    ytdlpProcRef.on('error', (err) => {
      if (!this.isManualStop && !this.isDestroyed) {
        this.addLog('error', `Error proceso yt-dlp: ${err.message}`);
      }
    });

    ffmpegProcRef.on('error', (err) => {
      if (!this.isManualStop && !this.isDestroyed) {
        this.addLog('error', `Error proceso ffmpeg: ${err.message}`);
      }
    });

    ytdlpProcRef.stdout.pipe(ffmpegProcRef.stdin);

    ytdlpProcRef.stdout.on('error', (err) => {
      if (!this.isManualStop && !this.isDestroyed && !this.ytdlpFinishedCleanly) {
        this.addLog('warn', `yt-dlp pipe: ${err.message}`);
      }
    });

    ffmpegProcRef.stdin.on('error', (err) => {
      if (!this.isManualStop && !this.isDestroyed && !this.ytdlpFinishedCleanly) {
        this.addLog('warn', `ffmpeg stdin: ${err.message}`);
      }
    });

    ytdlpProcRef.stderr.on('data', (chunk) => {
      if (this.isDestroyed) return;
      const msg = chunk.toString().trim();
      if (msg.includes('ERROR:')) this.addLog('error', `yt-dlp: ${msg}`);
      else if (msg.includes('WARNING:')) this.addLog('warn', `yt-dlp: ${msg}`);
    });

    ffmpegProcRef.stderr.on('data', (chunk) => {
      if (this.isDestroyed) return;
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
          this.lastProgressAt = Date.now();
          this.lastProgressFrames = 0;
          this._startDonationRotation();
          this._startWatchdog();
          this.addLog('info', `🟢 [${acc.name}] Emitiendo en vivo (${this.stats.encoder})`);
          this._emitStatus();
        }

        if (fpsMatch) this.stats.fps = parseFloat(fpsMatch[1]);
        if (bitrateMatch) this.stats.bitrate = bitrateMatch[1];
        if (speedMatch) this.stats.speed = speedMatch[1];
        if (frameMatch) {
          const curFrames = parseInt(frameMatch[1], 10);
          if (curFrames > this.lastProgressFrames) {
            this.lastProgressFrames = curFrames;
            this.lastProgressAt = Date.now();
          }
          this.stats.frames = curFrames;
        }

        if (!this.isDestroyed) {
          this.emit('stats', { id: this.id, stats: this.getSummary().stats });
        }
      } else {
        const clean = text.trim();
        if (clean.includes('Error') || clean.includes('failed') || clean.includes('refused')) {
          this.addLog('error', `ffmpeg: ${clean}`);
        }
      }
    });

    ytdlpProcRef.on('close', (code) => {
      this._destroyProcStreams(ytdlpProcRef);
      if (this.ytdlpProc === ytdlpProcRef) this.ytdlpProc = null;
      if (this.isDestroyed) return;
      if (code === 0) {
        this.ytdlpFinishedCleanly = true;
        this.addLog('info', '🏁 El directo de origen ha finalizado.');
      } else if (!this.isManualStop) {
        this.addLog('warn', `yt-dlp cerró con código ${code}`);
      }
    });

    ffmpegProcRef.on('close', (code) => {
      this._destroyProcStreams(ffmpegProcRef);
      if (this.ffmpegProc === ffmpegProcRef) this.ffmpegProc = null;
      this._handleProcessExit(code);
    });
  }

  _destroyProcStreams(proc) {
    if (!proc) return;
    try { proc.stdout?.unpipe?.(); } catch {}
    try { proc.stdin?.destroy?.(); } catch {}
    try { proc.stdout?.destroy?.(); } catch {}
    try { proc.stderr?.destroy?.(); } catch {}
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
    this._destroyProcStreams(this.ytdlpProc);
    this._killYtDlpTree('SIGKILL');
    this.ytdlpProc = null;
    if (this.ffmpegProc) {
      this._destroyProcStreams(this.ffmpegProc);
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

  _startWatchdog() {
    this._stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (this.status !== 'running' || this.isManualStop) return;
      if (this.lastProgressAt > 0 && Date.now() - this.lastProgressAt > 45000) {
        this.addLog('warn', '⚠️ Stream congelado (>45s sin nuevos frames); reiniciando pipeline...');
        if (this.ffmpegProc) {
          try { this.ffmpegProc.kill('SIGKILL'); } catch {}
        }
        this._killYtDlpTree('SIGKILL');
      }
    }, 15000);
  }

  _stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  _notifyExitWaiters() {
    if (this._exitNotifyResolvers.length > 0) {
      const list = this._exitNotifyResolvers.splice(0);
      for (const resolve of list) {
        try { resolve(); } catch {}
      }
    }
  }

  _waitForExit(timeoutMs = 1200) {
    if (!this.ffmpegProc) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve();
      };
      this._exitNotifyResolvers.push(done);
      timer = setTimeout(() => {
        const idx = this._exitNotifyResolvers.indexOf(done);
        if (idx !== -1) this._exitNotifyResolvers.splice(idx, 1);
        done();
      }, timeoutMs);
    });
  }

  async _handleProcessExit(code) {
    this._stopWatchdog();
    this._stopDonationRotation();
    if (this.stopForceTimer) {
      clearTimeout(this.stopForceTimer);
      this.stopForceTimer = null;
    }

    if (this.isDestroyed) {
      this._cleanupProcesses();
      await this._cleanupTikTokSession();
      this._notifyExitWaiters();
      return;
    }

    if (this.isManualStop) {
      this.status = 'idle';
      this.startedAt = null;
      this._resetStats();
      this._cleanupProcesses();
      await this._cleanupTikTokSession();
      this.addLog('info', 'Transmisión detenida manualmente.');
      this._emitStatus();
      this._notifyExitWaiters();
      return;
    }

    if (this.ytdlpFinishedCleanly && code === 0) {
      this.status = 'finished';
      this.startedAt = null;
      this._resetStats();
      this._cleanupProcesses();
      await this._cleanupTikTokSession();
      this.addLog('info', '✅ Directo terminado limpiamente por el creador.');
      this._emitStatus();
      this._notifyExitWaiters();
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
      this._notifyExitWaiters();
      return;
    }

    const ranStably = this.startedAt && Date.now() - this.startedAt >= 60000;
    if (ranStably) {
      this.consecutiveEarlyFailures = 0;
    } else {
      this.consecutiveEarlyFailures += 1;
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
    await this._cleanupTikTokSession();

    if (this.config && this.config.autoReconnect) {
      if (this.consecutiveEarlyFailures > this.maxEarlyRetries) {
        this.status = 'error';
        this.startedAt = null;
        this._resetStats();
        this.addLog('error', `Reconexión detenida tras ${this.maxEarlyRetries} fallos tempranos consecutivos (protege tu cuenta/cuota).`);
        this._emitStatus();
        this._notifyExitWaiters();
        return;
      }

      const backoffDelay = Math.min(
        60,
        this.config.reconnectDelay * Math.pow(2, Math.max(0, this.consecutiveEarlyFailures - 1))
      );

      this.status = 'starting';
      this.addLog('warn', `Reconexión automática en ${backoffDelay}s (intento ${this.consecutiveEarlyFailures}/${this.maxEarlyRetries})...`);
      this._emitStatus();

      this.reconnectTimeout = setTimeout(async () => {
        if (this.isManualStop || this.isDestroyed || !this.config) return;
        try {
          const liveStatus = await this._probeLiveStatus(this.config.sourceUrl);
          if (this.isManualStop || this.isDestroyed) return;
          if (['not_live', 'was_live', 'is_upcoming', 'post_live'].includes(liveStatus)) {
            this.status = 'finished';
            this.startedAt = null;
            this._resetStats();
            this.addLog('info', `✅ El directo origen ya no está en vivo (${liveStatus}). Emisión cerrada.`);
            this._emitStatus();
            return;
          }
        } catch {}

        if (!this.isManualStop && !this.isDestroyed && this.config) {
          this.addLog('info', 'Reconectando...');
          await this._spawnPipeline();
        }
      }, backoffDelay * 1000);
    } else {
      this.status = 'idle';
      this.startedAt = null;
      this._resetStats();
      this._emitStatus();
    }
    this._notifyExitWaiters();
  }

  async stop() {
    if (this._stopPromise) return this._stopPromise;

    this._stopPromise = (async () => {
      this.isManualStop = true;
      this._stopWatchdog();
      this._stopDonationRotation();
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      if (this.stopForceTimer) {
        clearTimeout(this.stopForceTimer);
        this.stopForceTimer = null;
      }

      if (['idle', 'finished', 'error'].includes(this.status) && !this.ffmpegProc && !this.ytdlpProc) {
        this._cleanupProcesses();
        await this._cleanupTikTokSession();
        return { message: 'Stream inactivo.' };
      }

      if (!this.isDestroyed) {
        this.status = 'stopping';
        this.addLog('info', 'Deteniendo transmisión...');
        this._emitStatus();
      }

      if (this.ffmpegProc) {
        try { this.ffmpegProc.kill('SIGTERM'); } catch {}
      }
      this._killYtDlpTree('SIGTERM');

      const waitExit = this._waitForExit(1200);
      await Promise.all([waitExit, this._cleanupTikTokSession()]);

      // Si aún sigue vivo tras 1.2s, forzar limpieza completa
      this._cleanupProcesses();
      if (!this.isDestroyed && this.status === 'stopping') {
        this.status = 'idle';
        this.startedAt = null;
        this._resetStats();
        this._emitStatus();
      }
      this._notifyExitWaiters();
      return { message: 'Transmisión detenida.' };
    })();

    try {
      return await this._stopPromise;
    } finally {
      this._stopPromise = null;
    }
  }

  async destroy() {
    this.isDestroyed = true;
    await this.stop();
    this._stopWatchdog();
    this._stopDonationRotation();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.stopForceTimer) {
      clearTimeout(this.stopForceTimer);
      this.stopForceTimer = null;
    }
    this._cleanupProcesses();
    try { fs.unlinkSync(this.donationFilePath); } catch {}
    try { fs.unlinkSync(`${this.donationFilePath}.tmp`); } catch {}
    this.removeAllListeners();
  }
}

export class StreamManager extends EventEmitter {
  constructor() {
    super();
    this.streams = new Map();
    this.nextIdNum = 1;
    this.vaapiSupported = checkVaapiAvailable();
    this.prevCpuSample = this._readProcStat();
    console.log(`[StreamManager] GPU Intel VAAPI disponible: ${this.vaapiSupported}`);
  }

  async cleanupStaleSessions() {
    try {
      const { stdout } = await execFileAsync(PYTHON_BIN, [TIKTOK_MGR, '--cleanup-stale'], { timeout: 15000 });
      const res = JSON.parse(stdout.trim() || '{}');
      if (Array.isArray(res.cleaned) && res.cleaned.length > 0) {
        console.log(`[StreamManager] Sesiones huérfanas limpiadas al arranque: ${res.cleaned.join(', ')}`);
      }
    } catch {}

    // Limpiar archivos residuales en donations/ que no correspondan a slots activos
    try {
      if (fs.existsSync(DONATIONS_DIR)) {
        const cleanedFiles = [];
        for (const entry of fs.readdirSync(DONATIONS_DIR)) {
          const id = entry.replace(/\.txt(\.tmp)?$/, '');
          if (!this.streams.has(id)) {
            try {
              fs.unlinkSync(path.join(DONATIONS_DIR, entry));
              cleanedFiles.push(entry);
            } catch {}
          }
        }
        if (cleanedFiles.length > 0) {
          console.log(`[StreamManager] Archivos residuales en donations/ eliminados: ${cleanedFiles.join(', ')}`);
        }
      }
    } catch {}
  }

  _isPortFree(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => {
        srv.close(() => resolve(true));
      });
      srv.listen(port, '127.0.0.1');
    });
  }

  async _allocatePort() {
    const usedPorts = new Set();
    for (const s of this.streams.values()) {
      if (['checking', 'starting', 'running', 'stopping'].includes(s.status)) {
        usedPorts.add(s.listenPort);
      }
    }
    for (let port = 19350; port < 19450; port++) {
      if (!usedPorts.has(port) && await this._isPortFree(port)) {
        return port;
      }
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
    const listenPort = await this._allocatePort();
    const instance = new StreamInstance({
      id,
      listenPort,
      vaapiSupported: this.vaapiSupported
    });
    instance.accountInfo = account;

    instance.on('status', (summary) => {
      if (!instance.isDestroyed && this.streams.has(id)) {
        this.emit('stream_status', summary);
      }
    });
    instance.on('stats', (payload) => {
      if (!instance.isDestroyed && this.streams.has(id)) {
        this.emit('stream_stats', payload);
      }
    });
    instance.on('log', (entry) => {
      if (!instance.isDestroyed && this.streams.has(id)) {
        this.emit('stream_log', entry);
      }
    });

    this.streams.set(id, instance);

    try {
      await instance.start(config, account);
    } catch (err) {
      this.streams.delete(id);
      this.emit('stream_removed', { id });
      await instance.destroy();
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
    // Bloquear de inmediato cualquier evento futuro (evita tarjetas fantasma en SSE)
    s.isDestroyed = true;
    this.streams.delete(id);
    this.emit('stream_removed', { id });
    await s.destroy();
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

  _readProcStat() {
    try {
      const line = fs.readFileSync('/proc/stat', 'utf-8').split('\n')[0] || '';
      const nums = line.trim().split(/\s+/).slice(1).map(Number);
      if (nums.length < 4 || nums.some(Number.isNaN)) return null;
      const idle = nums[3] + (nums[4] || 0);
      const total = nums.reduce((a, b) => a + b, 0);
      return { idle, total };
    } catch {
      return null;
    }
  }

  _sampleCpuPct() {
    const cur = this._readProcStat();
    if (!cur || !this.prevCpuSample) {
      this.prevCpuSample = cur;
      const load1 = os.loadavg()[0] || 0;
      const cpuCount = os.cpus().length || 8;
      return Math.min(100, Math.round((load1 / cpuCount) * 100));
    }
    const dTotal = cur.total - this.prevCpuSample.total;
    const dIdle = cur.idle - this.prevCpuSample.idle;
    this.prevCpuSample = cur;
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)));
  }

  _readRapidApiQuota() {
    try {
      if (!fs.existsSync(QUOTA_FILE)) return null;
      const raw = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf-8'));
      return {
        limit: raw.limit ? Number(raw.limit) : null,
        remaining: raw.remaining !== undefined ? Number(raw.remaining) : null,
        used: raw.used !== undefined ? Number(raw.used) : null,
        updated: raw.updated || null
      };
    } catch {
      return null;
    }
  }

  getSystemMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const load1 = os.loadavg()[0] || 0;
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
      cpuApproxPct: this._sampleCpuPct(),
      ramUsedGb: (usedMem / 1024 ** 3).toFixed(1),
      ramTotalGb: (totalMem / 1024 ** 3).toFixed(1),
      tempC,
      rapidApiQuota: this._readRapidApiQuota()
    };
  }
}
