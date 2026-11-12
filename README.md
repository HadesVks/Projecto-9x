<div align="center">

# ⚡ Projecto 9x — Autonomous Live Restreamer
### Motor Inteligente de Retransmisión en Vivo Multi-Plataforma (YouTube &rarr; TikTok / Multi-RTMP)

[![Node.js](https://img.shields.io/badge/Node.js-v22-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.13-blue.svg)](https://www.python.org/)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-7.1-orange.svg)](https://ffmpeg.org/)
[![AI-Powered](https://img.shields.io/badge/Developed%20with-Artificial%20Intelligence-purple.svg)](#-desarrollado-con-inteligencia-artificial)
[![License](https://img.shields.io/badge/License-MIT-brightgreen.svg)](LICENSE)

*Sistema autónomo de captura y retransmisión de directos en alta calidad hacia TikTok Live, Kick, YouTube, Twitch y Facebook con bypass anti-bot, inyección de metadatos SEI y auto-detección de fin de emisión.*

---

</div>

## 🤖 Desarrollado con Inteligencia Artificial

> **Nota de autoría**: Este proyecto ha sido **completamente diseñado, programado y optimizado por Inteligencia Artificial (Antigravity AI Agent)**. Desde la arquitectura de multiplexado en memoria hasta el proxy SEI firmado y el panel web reactivo, cada componente fue concebido mediante ingeniería de software guiada por agentes autónomos de última generación.

---

## 🌟 Características Principales

- **🎯 Retransmisión Multi-Destino:** Captura streams en directo desde **YouTube Live**, Twitch, Kick y más de 1,800 plataformas y los retransmite en tiempo real hacia **TikTok Live**, Kick, YouTube Live, Twitch o servidores RTMP/RTMPS personalizados.
- **🛡️ Evasión Anti-Bot en YouTube:** Ingesta mediante `yt-dlp` calibrado tácticamente (`player_client=ios,android,tv,mweb`) evitando desafíos BotGuard, errores HTTP 403 y estrangulamiento de velocidad de descarga (*n-challenge throttling*).
- **🔒 Proxy SEI Anti-Baneo para TikTok Live:** Integración de un proxy RTMP local (`rtmp://127.0.0.1:19350/live/obs`) que analiza el flujo H.264 e inyecta paquetes **SEI NAL tipo 100** firmados en tiempo real. Esto emula fielmente a **TikTok LIVE Studio**, impidiendo suspensiones, *shadowbans* o caídas por algoritmos de detección de streamers automatizados.
- **🏁 Detección Automática de Finalización del Directo:** Detecta cuando el emisor original termina la transmisión (`#EXT-X-ENDLIST`), cerrando limpiamente el pipeline de FFmpeg, notificando al usuario y liberando los recursos de la sala sin bucles infinitos ni procesos zombis.
- **📐 Formatos de Video Adaptativos:**
  1. **📱 Vertical 9:16 (Fondo Blur Profesional):** Canvas vertical 1080x1920 con el video 16:9 centrado en nitidez máxima y un fondo dinámico ampliado con desenfoque Gaussiano.
  2. **📱 Vertical 9:16 (Recorte Centrado):** Crop inteligente del centro de la acción para pantallas verticales completas.
  3. **🖥️ Copia Directa 16:9 (Passthrough):** Muxing directo `-c copy` con **0% de consumo de CPU/GPU**.
- **📊 Calidad Estricta de Emisión (CBR & GOP = 2s):** Codificación conforme a las especificaciones exactas de TikTok y YouTube (CBR a 4500 kbps, GOP exacto de 2.0 segundos con `-sc_threshold 0`, audio AAC-LC estéreo a 44.1 kHz).
- **🖥️ Dashboard Web Reactivo:** Interfaz gráfica moderna en tema oscuro (*Dark Mode*) con telemetría en tiempo real (FPS, Bitrate, Velocidad, Frames, Uptime) transmitida mediante **Server-Sent Events (SSE)**.

---

## 🏗️ Arquitectura Técnica

```text
       [ En Vivo de YouTube / Twitch / Kick ]
                         │
                         ▼ (HLS / MPEG-TS Stream)
         ┌───────────────────────────────┐
         │     yt-dlp Anti-Bot Ingest    │  ◄── (Evasión InnerTube & BotGuard)
         └───────────────┬───────────────┘
                         │
                         ▼ (Binary Pipe stdin)
         ┌───────────────────────────────┐
         │          FFmpeg Core          │
         │  - Vertical 9:16 Blur Canvas  │
         │  - Strict CBR 4500k & GOP 2s  │
         │  - AAC 128k / 44.1 kHz Audio  │
         └───────────────┬───────────────┘
                         │ (FLV Stream)
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
[ Plataformas RTMP ]           [ TikTok LIVE Ingest ]
 (YouTube, Kick, Twitch)                  │
 (Push Directo)                           ▼
                         ┌─────────────────────────────────┐
                         │      ffmpeg_sei_proxy.py        │
                         │   (Inyección SEI NALU Tipo 100) │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                                [ Servidores TikTok ]
```

---

## 🚀 Instalación y Puesta en Marcha

### Prerrequisitos
- **Node.js** v18+ y **npm**
- **Python** 3.10+
- **FFmpeg** con soporte para `libx264` y `aac`
- **yt-dlp** actualizado

### 1. Clonar el Repositorio
```bash
git clone https://github.com/HadesVks/Projecto-9x.git
cd Projecto-9x
```

### 2. Instalar Dependencias de Node.js
```bash
npm install
```

### 3. Configurar Entorno Virtual de Python
```bash
python3 -m venv venv
./venv/bin/pip install -r tiktok/requirements.txt
```

### 4. Iniciar el Servidor de Desarrollo
```bash
node server.js
```

El panel estará disponible en:
- Local: `http://localhost:9090`
- Red Local (LAN): `http://TU_IP_LOCAL:9090`

---

## 🛡️ Despliegue en Producción con PM2

Para mantener el servicio ejecutándose de manera continua 24/7 en servidores Linux:

```bash
# Iniciar servicio con PM2
pm2 start ecosystem.config.cjs

# Guardar lista de procesos para auto-arranque en reinicios
pm2 save

# Ver logs en vivo
pm2 logs projecto-9x

# Monitorear estado y recursos
pm2 monit
```

---

## 📱 Modos de Emisión en TikTok

### Opción 1: Creación Automática de Sala (Recomendada)
Coloca tu archivo `tiktok_cookies.json` en `tiktok/cookies/` y configura tu clave de RapidAPI en `tiktok/.env`. El sistema creará la sala automáticamente, conectará el proxy SEI y emitirá con un solo clic sin necesidad de ingresar claves manualmente.

### Opción 2: Stream Key Manual con Proxy SEI
Pega tu servidor RTMP y clave de transmisión generada por **TikTok LIVE Studio**. El sistema enrutará automáticamente el flujo por el proxy SEI para garantizar la integridad y evitar bloqueos.

---

## 📄 Licencia

Este proyecto está bajo la Licencia **MIT**. Desarrollado con ❤️ e Inteligencia Artificial para la comunidad de creadores y streamers.
