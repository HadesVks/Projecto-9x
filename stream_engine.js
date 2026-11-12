import { spawn, execFile } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { fileURLToPath } from 'url';
import util from 'util';

const execFileAsync = util.promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PYTHON_BIN = path.join(__dirname, 'venv', 'bin', 'python3');
const TIKTOK_MGR = path.join(__dirname, 'tiktok', 'tiktok_manager.py');

export class StreamEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle'; // 'idle' | 'checking' | 'starting' | 'running' | 'stopping' | 'finished' | 'error'
    this.config = null;
    this.ytdlpProc = null;
    this.ffmpegProc = null;
    this.tiktokSession = null;
    this.startedAt = null;
    this.reconnectTimeout = null;
    this.isManualStop = false;
    this.ytdlpFinishedCleanly = false;
    this.logs = [];
    this.maxLogs = 250;
    this.stats = {
      fps: 0,
      bitrate: '0kbits/s',
      speed: '0x',
      frames: 0,
      uptimeSeconds: 0
    };
  }

  addLog(type, message) {
    const entry = {
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

  getStatus() {
    return {
      status: this.status,
      startedAt: this.startedAt,
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
        platform: this.config.platform,
        rtmpServer: this.config.rtmpServer,
        mode: this.config.mode,
        autoReconnect: this.config.autoReconnect,
        streamKeyMasked: this.config.streamKey ? (this.config.streamKey.substring(0, 4) + '****' + this.config.streamKey.slice(-4)) : ''
      } : null
    };
  }

  getLogs() {
    return this.logs;
  }

  buildTargetUrl(server, key) {
    const cleanServer = (server || '').trim();
    const cleanKey = (key || '').trim();
    if (!cleanKey) return cleanServer;
    return cleanServer.endsWith('/') ? `${cleanServer}${cleanKey}` : `${cleanServer}/${cleanKey}`;
  }

  async verifyTikTokSession() {
    try {
      const { stdout } = await execFileAsync(PYTHON_BIN, [TIKTOK_MGR, '--verify']);
      return JSON.parse(stdout.trim());
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  async start(config) {
    if (this.status === 'running' || this.status === 'starting' || this.status === 'checking') {
      throw new Error('Ya hay una transmisión en curso o en proceso de inicio.');
    }

    if (!config.sourceUrl || !config.sourceUrl.trim()) {
      throw new Error('Debes indicar la URL del en vivo de origen (YouTube, etc.).');
    }

    const platform = config.platform || 'custom';
    const isAutoTikTok = (platform === 'tiktok' && config.tiktokAutoRoom);

    if (!isAutoTikTok) {
      if (!config.rtmpServer || !config.rtmpServer.trim()) {
        throw new Error('Debes indicar el Servidor RTMP destino.');
      }
      if (!config.streamKey || !config.streamKey.trim()) {
        throw new Error('Debes indicar la Clave de Transmisión (Stream Key).');
      }
    }

    this.isManualStop = false;
    this.ytdlpFinishedCleanly = false;
    this.config = {
      sourceUrl: config.sourceUrl.trim(),
      platform,
      rtmpServer: (config.rtmpServer || '').trim(),
      streamKey: (config.streamKey || '').trim(),
      mode: config.mode || 'vertical_blur',
      autoReconnect: config.autoReconnect !== false,
      reconnectDelay: Number(config.reconnectDelay) || 5,
      tiktokAutoRoom: isAutoTikTok,
      tiktokTitle: (config.tiktokTitle || '').trim() || '⚡ Transmisión en Vivo | Projecto 9x'
    };

    this.status = 'checking';
    this.emit('status', this.getStatus());
    this.addLog('info', `[Projecto 9x] Verificando en vivo de origen: ${this.config.sourceUrl}`);

    // Pre-flight check: Verificar si el stream está en directo
    try {
      const { stdout } = await execFileAsync('yt-dlp', [
        '--js-runtimes', 'node',
        '--extractor-args', 'youtube:player_client=ios,android,tv,mweb',
        '--print', 'live_status',
        this.config.sourceUrl
      ], { timeout: 15000 });

      const liveStatus = stdout.trim();
      this.addLog('info', `Estado de live detectado: ${liveStatus}`);
      if (liveStatus === 'not_live' || liveStatus === 'was_live') {
        this.status = 'idle';
        this.emit('status', this.getStatus());
        throw new Error(`El canal o video no está en directo actualmente (Estado: ${liveStatus}).`);
      }
    } catch (err) {
      if (err.message && err.message.includes('no está en directo')) {
        throw err;
      }
      this.addLog('warn', `Aviso pre-flight: ${err.message}. Intentando iniciar de todas formas...`);
    }

    this.status = 'starting';
    this.emit('status', this.getStatus());
    await this._spawnPipeline();
  }

  async _spawnPipeline() {
    let finalRtmpDestination = '';

    // Manejo de TikTok con Proxy SEI Anti-Baneo
    if (this.config.platform === 'tiktok') {
      if (this.config.tiktokAutoRoom) {
        this.addLog('info', 'Creando sala oficial en TikTok LIVE y levantando Proxy SEI...');
        try {
          const { stdout } = await execFileAsync(PYTHON_BIN, [
            TIKTOK_MGR,
            '--create',
            '--title', this.config.tiktokTitle
          ], { timeout: 30000 });

          this.tiktokSession = JSON.parse(stdout.trim());
          finalRtmpDestination = this.tiktokSession.local_proxy_url || 'rtmp://127.0.0.1:19350/live/obs';
          this.addLog('info', `Sala TikTok creada: ID ${this.tiktokSession.room_id}`);
          if (this.tiktokSession.share_url) {
            this.addLog('info', `Enlace para compartir: ${this.tiktokSession.share_url}`);
          }
        } catch (err) {
          this.status = 'error';
          this.addLog('error', `Error creando sala en TikTok: ${err.message}`);
          this.emit('status', this.getStatus());
          return;
        }
      } else {
        // Stream Key manual pero protegiendo con SEI Proxy
        const rawTarget = this.buildTargetUrl(this.config.rtmpServer, this.config.streamKey);
        this.addLog('info', 'Activando Proxy SEI anti-baneo para tu Stream Key de TikTok...');
        try {
          const { stdout } = await execFileAsync(PYTHON_BIN, [
            TIKTOK_MGR,
            '--proxy-only', rawTarget
          ], { timeout: 15000 });

          const proxyRes = JSON.parse(stdout.trim());
          finalRtmpDestination = proxyRes.proxy_url || 'rtmp://127.0.0.1:19350/live/obs';
          this.addLog('info', `Proxy SEI activo en ${finalRtmpDestination} -> TikTok`);
        } catch (err) {
          this.addLog('warn', `Fallo al iniciar proxy SEI: ${err.message}. Emitiendo directo...`);
          finalRtmpDestination = rawTarget;
        }
      }
    } else {
      // Destino estándar directo (YouTube, Kick, Twitch, etc.)
      finalRtmpDestination = this.buildTargetUrl(this.config.rtmpServer, this.config.streamKey);
    }

    this.addLog('info', 'Iniciando ingestor yt-dlp con evasión anti-bloqueo...');

    // 1. Iniciar yt-dlp con argumentos anti-bot validados
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
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      this.status = 'error';
      this.addLog('error', `Fallo al arrancar yt-dlp: ${err.message}`);
      this.emit('status', this.getStatus());
      return;
    }

    // 2. Construir argumentos FFmpeg con calidad estricta CBR y keyframe de 2s
    let ffmpegArgs = [
      '-fflags', '+genpts+discardcorrupt',
      '-reconnect', '1',
      '-reconnect_at_eof', '0',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-re',
      '-i', 'pipe:0'
    ];

    if (this.config.mode === 'copy') {
      // Copia directa passthrough sin recodificar (cero uso de CPU)
      ffmpegArgs.push(
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-f', 'flv',
        finalRtmpDestination
      );
    } else if (this.config.mode === 'vertical_crop') {
      // Recorte centrado a vertical 9:16 (1080x1920)
      ffmpegArgs.push(
        '-filter_complex', '[0:v]crop=ih*(9/16):ih,scale=1080:1920,setsar=1[v]',
        '-map', '[v]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-b:v', '4500k',
        '-minrate', '4500k',
        '-maxrate', '4500k',
        '-bufsize', '9000k',
        '-r', '30',
        '-g', '60',
        '-keyint_min', '60',
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        '-f', 'flv',
        finalRtmpDestination
      );
    } else {
      // Formato Vertical 9:16 Profesional con Fondo Blur Dinámico
      ffmpegArgs.push(
        '-filter_complex', '[0:v]split=2[bg_src][fg_src];[bg_src]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5[bg];[fg_src]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v_out]',
        '-map', '[v_out]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-b:v', '4500k',
        '-minrate', '4500k',
        '-maxrate', '4500k',
        '-bufsize', '9000k',
        '-r', '30',
        '-g', '60',
        '-keyint_min', '60',
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        '-f', 'flv',
        finalRtmpDestination
      );
    }

    this.addLog('info', `Iniciando codificador FFmpeg hacia: ${this.config.platform.toUpperCase()}`);

    try {
      this.ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      this.status = 'error';
      this.addLog('error', `Fallo al iniciar ffmpeg: ${err.message}`);
      if (this.ytdlpProc) this.ytdlpProc.kill('SIGTERM');
      this.emit('status', this.getStatus());
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
      if (msg) {
        if (msg.includes('ERROR:')) {
          this.addLog('error', `yt-dlp: ${msg}`);
        } else if (msg.includes('WARNING:')) {
          this.addLog('warn', `yt-dlp: ${msg}`);
        }
      }
    });

    this.ffmpegProc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      const frameMatch = text.match(/frame=\s*(\d+)/);
      const fpsMatch = text.match(/fps=\s*([\d\.]+)/);
      const bitrateMatch = text.match(/bitrate=\s*([\d\.]+\w+\/s)/);
      const speedMatch = text.match(/speed=\s*([\d\.]+x)/);

      if (frameMatch || fpsMatch || bitrateMatch) {
        if (this.status !== 'running') {
          this.status = 'running';
          this.startedAt = Date.now();
          this.addLog('info', '🟢 ¡Transmisión en vivo activa y emitiendo exitosamente!');
          this.emit('status', this.getStatus());
        }

        if (fpsMatch) this.stats.fps = parseFloat(fpsMatch[1]);
        if (bitrateMatch) this.stats.bitrate = bitrateMatch[1];
        if (speedMatch) this.stats.speed = speedMatch[1];
        if (frameMatch) this.stats.frames = parseInt(frameMatch[1], 10);

        this.emit('stats', this.getStatus().stats);
      } else {
        const clean = text.trim();
        if (clean.includes('Connection refused') || clean.includes('Input/output error') || clean.includes('Server returned')) {
          this.addLog('error', `ffmpeg: ${clean}`);
        }
      }
    });

    // Monitoreo de yt-dlp: detección de fin del directo
    this.ytdlpProc.on('close', (code) => {
      if (code === 0) {
        this.ytdlpFinishedCleanly = true;
        this.addLog('info', '🏁 El en vivo de YouTube ha finalizado por completo.');
      } else if (!this.isManualStop) {
        this.addLog('warn', `yt-dlp finalizó con código ${code}`);
      }
    });

    // Monitoreo de FFmpeg
    this.ffmpegProc.on('close', (code) => {
      this._handleProcessExit(code);
    });
  }

  async _handleProcessExit(code) {
    if (this.isManualStop) {
      this.status = 'idle';
      this.startedAt = null;
      this._resetStats();
      await this._cleanupTikTokSession();
      this.addLog('info', 'Transmisión detenida por el usuario.');
      this.emit('status', this.getStatus());
      return;
    }

    // Si yt-dlp finalizó limpiamente (código 0), significa que el creador cerró el en vivo
    if (this.ytdlpFinishedCleanly && code === 0) {
      this.status = 'finished';
      this.startedAt = null;
      this._resetStats();
      this.addLog('info', '✅ La transmisión finalizó naturalmente. Sala cerrada con éxito.');
      this._cleanupProcesses();
      await this._cleanupTikTokSession();
      this.emit('status', this.getStatus());
      return;
    }

    this.addLog('warn', `El pipeline finalizó (código: ${code}).`);
    this._cleanupProcesses();

    // Auto-reconexión si no fue cierre limpio ni manual
    if (this.config && this.config.autoReconnect) {
      this.status = 'starting';
      this.addLog('warn', `Reconexión automática en ${this.config.reconnectDelay}s...`);
      this.emit('status', this.getStatus());

      this.reconnectTimeout = setTimeout(async () => {
        if (!this.isManualStop && this.config) {
          this.addLog('info', 'Intentando reconectar transmisión...');
          await this._spawnPipeline();
        }
      }, this.config.reconnectDelay * 1000);
    } else {
      this.status = 'idle';
      this.startedAt = null;
      this._resetStats();
      await this._cleanupTikTokSession();
      this.emit('status', this.getStatus());
    }
  }

  async _cleanupTikTokSession() {
    try {
      await execFileAsync(PYTHON_BIN, [TIKTOK_MGR, '--end']);
      this.tiktokSession = null;
    } catch (e) {}
  }

  _resetStats() {
    this.stats = {
      fps: 0,
      bitrate: '0kbits/s',
      speed: '0x',
      frames: 0,
      uptimeSeconds: 0
    };
  }

  _cleanupProcesses() {
    if (this.ytdlpProc) {
      try { this.ytdlpProc.kill('SIGKILL'); } catch (e) {}
      this.ytdlpProc = null;
    }
    if (this.ffmpegProc) {
      try { this.ffmpegProc.kill('SIGKILL'); } catch (e) {}
      this.ffmpegProc = null;
    }
  }

  async stop() {
    this.isManualStop = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.status === 'idle') {
      return { message: 'El motor ya está inactivo.' };
    }

    this.status = 'stopping';
    this.addLog('info', 'Deteniendo transmisión...');
    this.emit('status', this.getStatus());

    if (this.ffmpegProc) {
      try { this.ffmpegProc.kill('SIGTERM'); } catch (e) {}
    }
    if (this.ytdlpProc) {
      try { this.ytdlpProc.kill('SIGTERM'); } catch (e) {}
    }

    await this._cleanupTikTokSession();

    setTimeout(() => {
      this._cleanupProcesses();
      this.status = 'idle';
      this.startedAt = null;
      this._resetStats();
      this.emit('status', this.getStatus());
    }, 1200);

    return { message: 'Transmisión y proxy detenidos correctamente.' };
  }
}
