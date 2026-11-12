import { spawn } from 'child_process';
import { EventEmitter } from 'events';

export class StreamEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle'; // 'idle' | 'starting' | 'running' | 'stopping' | 'error'
    this.config = null;
    this.ytdlpProc = null;
    this.ffmpegProc = null;
    this.startedAt = null;
    this.reconnectTimeout = null;
    this.isManualStop = false;
    this.logs = [];
    this.maxLogs = 200;
    this.stats = {
      fps: 0,
      bitrate: '0kbits/s',
      speed: '0x',
      frames: 0,
      uptimeSeconds: 0
    };
    this.uptimeInterval = null;
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
      config: this.config ? {
        sourceUrl: this.config.sourceUrl,
        platform: this.config.platform,
        rtmpServer: this.config.rtmpServer,
        mode: this.config.mode,
        autoReconnect: this.config.autoReconnect,
        // Mask stream key for security in status responses
        streamKeyMasked: this.config.streamKey ? (this.config.streamKey.substring(0, 4) + '****' + this.config.streamKey.slice(-4)) : ''
      } : null
    };
  }

  getLogs() {
    return this.logs;
  }

  buildTargetUrl(server, key) {
    const cleanServer = server.trim();
    const cleanKey = key.trim();
    if (!cleanKey) return cleanServer;
    return cleanServer.endsWith('/') ? `${cleanServer}${cleanKey}` : `${cleanServer}/${cleanKey}`;
  }

  async start(config) {
    if (this.status === 'running' || this.status === 'starting') {
      throw new Error('Ya hay una transmisión en curso. Deténla primero.');
    }

    if (!config.sourceUrl || !config.sourceUrl.trim()) {
      throw new Error('Debes indicar la URL del en vivo de origen.');
    }
    if (!config.rtmpServer || !config.rtmpServer.trim()) {
      throw new Error('Debes indicar la URL del servidor RTMP destino.');
    }
    if (!config.streamKey || !config.streamKey.trim()) {
      throw new Error('Debes ingresar la Clave de Transmisión (Stream Key).');
    }

    this.isManualStop = false;
    this.config = {
      sourceUrl: config.sourceUrl.trim(),
      platform: config.platform || 'custom',
      rtmpServer: config.rtmpServer.trim(),
      streamKey: config.streamKey.trim(),
      mode: config.mode || 'vertical_blur',
      autoReconnect: config.autoReconnect !== false,
      reconnectDelay: Number(config.reconnectDelay) || 5
    };

    this.status = 'starting';
    this.emit('status', this.getStatus());
    this.addLog('info', `Iniciando Projecto 9x... Modo: ${this.config.mode}`);
    this.addLog('info', `Origen: ${this.config.sourceUrl}`);
    this.addLog('info', `Servidor Destino: ${this.config.rtmpServer}`);

    this._spawnPipeline();
  }

  _spawnPipeline() {
    const fullTargetUrl = this.buildTargetUrl(this.config.rtmpServer, this.config.streamKey);

    this.addLog('info', 'Ejecutando extractor yt-dlp...');

    // 1. Iniciar yt-dlp
    const ytdlpArgs = [
      '--js-runtimes', 'node',
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
      this.addLog('error', `Fallo al iniciar yt-dlp: ${err.message}`);
      this.emit('status', this.getStatus());
      return;
    }

    // 2. Construir argumentos FFmpeg según el modo
    let ffmpegArgs = ['-re', '-i', 'pipe:0'];

    if (this.config.mode === 'copy') {
      // Modo directo: 16:9 sin tocar video
      ffmpegArgs.push(
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-f', 'flv',
        fullTargetUrl
      );
    } else if (this.config.mode === 'vertical_crop') {
      // Recorte centrado a 9:16
      ffmpegArgs.push(
        '-filter_complex', '[0:v]crop=ih*(9/16):ih,scale=1080:1920[v]',
        '-map', '[v]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-b:v', '2500k',
        '-maxrate', '3000k',
        '-bufsize', '6000k',
        '-pix_fmt', 'yuv420p',
        '-g', '60',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-f', 'flv',
        fullTargetUrl
      );
    } else {
      // Modo por defecto: vertical 9:16 inteligente con fondo desenfocado
      ffmpegArgs.push(
        '-filter_complex', '[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[bgblur];[fg]scale=1080:-2[fgscaled];[bgblur][fgscaled]overlay=(W-w)/2:(H-h)/2[v]',
        '-map', '[v]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-b:v', '2500k',
        '-maxrate', '3000k',
        '-bufsize', '6000k',
        '-pix_fmt', 'yuv420p',
        '-g', '60',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-f', 'flv',
        fullTargetUrl
      );
    }

    this.addLog('info', 'Iniciando encoder FFmpeg hacia RTMP...');

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

    // Pipe ytdlp output into ffmpeg input
    this.ytdlpProc.stdout.pipe(this.ffmpegProc.stdin);

    // Manejar errores de pipes para evitar unhandled exceptions
    this.ytdlpProc.stdout.on('error', (err) => {
      // Ignorar si fue cierre intencional
      if (!this.isManualStop) {
        this.addLog('warn', `yt-dlp pipe error: ${err.message}`);
      }
    });

    this.ffmpegProc.stdin.on('error', (err) => {
      if (!this.isManualStop) {
        this.addLog('warn', `ffmpeg stdin error: ${err.message}`);
      }
    });

    // Monitorear logs de yt-dlp stderr
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

    // Monitorear logs y telemetría de ffmpeg stderr
    this.ffmpegProc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      
      // Parsear métricas en tiempo real de FFmpeg
      // frame= 120 fps= 30 q=28.0 size= 1024kB time=00:00:04.00 bitrate=2097.2kbits/s speed=1.0x
      const frameMatch = text.match(/frame=\s*(\d+)/);
      const fpsMatch = text.match(/fps=\s*([\d\.]+)/);
      const bitrateMatch = text.match(/bitrate=\s*([\d\.]+\w+\/s)/);
      const speedMatch = text.match(/speed=\s*([\d\.]+x)/);

      if (frameMatch || fpsMatch || bitrateMatch) {
        if (this.status !== 'running') {
          this.status = 'running';
          this.startedAt = Date.now();
          this.addLog('info', 'Transmisión RTMP activa y transmitiendo en vivo.');
          this.emit('status', this.getStatus());
        }

        if (fpsMatch) this.stats.fps = parseFloat(fpsMatch[1]);
        if (bitrateMatch) this.stats.bitrate = bitrateMatch[1];
        if (speedMatch) this.stats.speed = speedMatch[1];
        if (frameMatch) this.stats.frames = parseInt(frameMatch[1], 10);

        this.emit('stats', this.getStatus().stats);
      } else {
        // Log de salida informativa o de error
        const cleanText = text.trim();
        if (cleanText.includes('Connection refused') || cleanText.includes('Input/output error') || cleanText.includes('Server returned')) {
          this.addLog('error', `ffmpeg: ${cleanText}`);
        }
      }
    });

    // Monitorear cierre de yt-dlp
    this.ytdlpProc.on('close', (code) => {
      if (!this.isManualStop) {
        this.addLog('warn', `yt-dlp finalizó con código ${code}`);
      }
    });

    // Monitorear cierre de FFmpeg
    this.ffmpegProc.on('close', (code) => {
      this._handleProcessExit(code);
    });
  }

  _handleProcessExit(code) {
    if (this.isManualStop) {
      this.status = 'idle';
      this.startedAt = null;
      this._resetStats();
      this.addLog('info', 'Transmisión detenida por el usuario.');
      this.emit('status', this.getStatus());
      return;
    }

    this.addLog('warn', `Proceso FFmpeg terminó (código: ${code}).`);

    // Limpiar instancias
    this._cleanupProcesses();

    if (this.config && this.config.autoReconnect) {
      this.status = 'starting';
      this.addLog('warn', `Reconexión automática programada en ${this.config.reconnectDelay}s...`);
      this.emit('status', this.getStatus());

      this.reconnectTimeout = setTimeout(() => {
        if (!this.isManualStop && this.config) {
          this.addLog('info', 'Intentando reconectar transmisión...');
          this._spawnPipeline();
        }
      }, this.config.reconnectDelay * 1000);
    } else {
      this.status = 'idle';
      this.startedAt = null;
      this._resetStats();
      this.emit('status', this.getStatus());
    }
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
      try {
        this.ytdlpProc.kill('SIGKILL');
      } catch (e) {}
      this.ytdlpProc = null;
    }
    if (this.ffmpegProc) {
      try {
        this.ffmpegProc.kill('SIGKILL');
      } catch (e) {}
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

    // Cierre suave de procesos
    if (this.ffmpegProc) {
      try {
        this.ffmpegProc.kill('SIGTERM');
      } catch (e) {}
    }
    if (this.ytdlpProc) {
      try {
        this.ytdlpProc.kill('SIGTERM');
      } catch (e) {}
    }

    // Timeout de seguridad para forzar cierre con SIGKILL si se cuelga
    setTimeout(() => {
      this._cleanupProcesses();
      this.status = 'idle';
      this.startedAt = null;
      this._resetStats();
      this.emit('status', this.getStatus());
    }, 1500);

    return { message: 'Transmisión detenida correctamente.' };
  }
}
