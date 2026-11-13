<div align="center">

# ⚡ Projecto 9x — Multi-Stream Live Restreamer & Auto-Restreamer 24/7
### Motor Inteligente de Retransmisión Simultánea Multi-Cuenta con GPU Intel VAAPI

[![Node.js](https://img.shields.io/badge/Node.js-v22-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.13-blue.svg)](https://www.python.org/)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-7.1%20VAAPI-orange.svg)](https://ffmpeg.org/)
[![AI-Powered](https://img.shields.io/badge/Developed%20with-Artificial%20Intelligence-purple.svg)](#-desarrollado-con-inteligencia-artificial)
[![License](https://img.shields.io/badge/License-MIT-brightgreen.svg)](LICENSE)

*Sistema autónomo multi-cuenta (v2.6) para descubrir y capturar múltiples directos simultáneamente (TikTok Live, YouTube Live, Twitch, Kick) —manualmente, desde el Explorador/Radar integrado o mediante vigilancia 24/7— y retransmitirlos con decodificación y codificación hardware Intel VAAPI, banners de donación con estilos y rotación en vivo, proxy SEI anti-baneo en TikTok, bloqueo opcional por PIN y auto-detección de fin de emisión.*

---

</div>

## 🤖 Desarrollado con Inteligencia Artificial

> **Nota de autoría**: Este proyecto ha sido **completamente diseñado, programado y optimizado por Inteligencia Artificial (Antigravity AI Agent)**. Desde el motor concurrente multi-slot (`StreamManager`), el vigilante automático 24/7 (`ChannelMonitor`) y el almacén aislado de cuentas (`AccountStore`), hasta el pipeline VAAPI completo, los overlays dinámicos con pausa en vivo y el proxy SEI firmado por sesión, toda la arquitectura fue construida mediante ingeniería de software asistida por IA.

---

## 🌟 Características Principales

- **🔎 Explorador de Lives & Radar de Creadores TikTok:** Pestaña integrada para descubrir transmisiones en vivo de TikTok por **palabra clave o categorías** (`Gaming`, `Free Fire`, `GTA V`, `Fortnite`, `Música`, etc.) y comprobar un **Radar/Watchlist de `@usuarios` favoritos** en lote. Todo mediante `curl_cffi` (`tiktok_live_scraper.py`) con caché TTL + deduplicación de peticiones, **sin consumir cuota de RapidAPI**, detección limpia de bloqueos/CAPTCHA y botones de un clic para **Retransmitir** o **Vigilar 24/7**.
- **👥 Gestión Multi-Cuenta Real (con Edición Inline):** Registra, edita y verifica múltiples cuentas destino (**TikTok Live** con Cookies JSON independientes o RTMP manual, **YouTube Live**, **Kick**, **Twitch**, **Facebook Live** o servidores **RTMP/RTMPS** personalizados) y selecciona la categoría/tema de sala TikTok (`topicId`).
- **🤖 Auto-Restreamer 24/7 (`ChannelMonitor`):** Vigila canales `/live` (incluyendo **TikTok Live**, YouTube, Twitch y Kick) en el intervalo configurado, detecta automáticamente cuando el creador entra en directo y lanza el slot con sustitución dinámica de `{title}` y limpieza automática al terminar.
- **📡 Multi-Stream Simultáneo Aislado + Ingesta Directa TikTok CDN:** Ejecuta múltiples transmisiones distintas al mismo tiempo (`#live-1`, `#live-2`, ...). Para URLs `https://www.tiktok.com/@usuario/live`, resuelve el flujo directo hacia FFmpeg sin pasar por `yt-dlp` y omite el doble `boxblur` cuando el origen ya es vertical (`9:16`). Cada directo opera en su propio puerto de Proxy SEI verificado por TCP (`19350–19449`), carpeta aislada de cola y botón de **Relanzar** sobre slots finalizados/detenidos.
- **⚡ Pipeline Intel VAAPI Completo (`-hwaccel vaapi` + Blur Rápido):** Decodifica y codifica H.264 directamente en la GPU Intel (`/dev/dri/renderD128`) con respaldo automático a `libx264` y límite inteligente de resolución (`yt-dlp` hasta `720p`/`1080p` evitando streams pesados 4K/AV1). El modo Vertical Blur procesa el desenfoque en lienzo reducido (`180x320`) antes de escalar a `720p30`, `1080p30` o `1080p60`.
- **💖 Sistema de Donaciones v2.5 en Vivo:** Overlay nativo mediante `drawtext` con 4 estilos visuales (**Oscuro**, **Neón TikTok**, **Dorado VIP**, **Alerta Roja**), rotación automática de múltiples mensajes separados por `|` (`rotateSec`), modo **Periódico** o **Fijo**, edición de texto instantánea y **Pausa/Reanudación en vivo** sin reiniciar FFmpeg.
- **🛡️ Evasión Anti-Bot, Watchdog y Proxy SEI Anti-Baneo:** Ingesta mediante `yt-dlp` calibrado (`player_client=ios,android,tv,mweb`), limpieza de paquetes SEI previos, firma **SEI NALU tipo 100** en `ffmpeg_sei_proxy.py`, heartbeat auto-terminable si cae el proxy o cierra la sala, y watchdog anti-congelamiento (45s).
- **🏁 Auto-Detección de Fin y Reconexión Inteligente:** Reconoce `#EXT-X-ENDLIST` al terminar el stream origen, o reconecta con backoff exponencial (máximo 5 intentos iniciales) verificando antes con `yt-dlp` si el directo sigue activo.
- **🖥️ Telemetría Real, Cuota API y Seguridad PIN:** Panel por SSE (`/api/stream/events`) con CPU % real (`/proc/stat`), RAM, temperatura, cuota RapidAPI de costo 0 (`rapidapi_quota.json`) y bloqueo opcional con **PIN** (`scrypt` + cookie firmada `HttpOnly`, o variable `ADMIN_PIN`).

---

## 🏗️ Arquitectura Técnica

```text
   [ Múltiples Orígenes: YouTube Live / Twitch / Kick ]
                          │
        ┌─────────────────┴─────────────────┐
        ▼ Slot 1                            ▼ Slot N
┌───────────────────┐               ┌───────────────────┐
│ yt-dlp + FFmpeg   │               │ yt-dlp + FFmpeg   │
│ - Blur Rápido     │               │ - Crop / VAAPI    │
│ - drawtext Donac. │               │ - drawtext Donac. │
│ - h264_vaapi GPU  │               │ - h264_vaapi GPU  │
└─────────┬─────────┘               └─────────┬─────────┘
          │ FLV -> RTMP :19350                │ FLV -> RTMP :19351 / Directo
          ▼                                   ▼
┌─────────────────────────┐         ┌─────────────────────────┐
│ ffmpeg_sei_proxy.py     │         │ Canal Destino Aislado   │
│ (queue/stream-1/ + SEI) │         │ (TikTok #2 / YouTube /  │
└─────────┬───────────────┘         │  Kick / Twitch)         │
          ▼                         └─────────────────────────┘
  [ TikTok Cuenta #1 ]
```

---

## 🚀 Instalación y Puesta en Marcha

### Prerrequisitos
- **Node.js** v20+ y **npm**
- **Python** 3.10+
- **FFmpeg** con soporte para `h264_vaapi` (opcional, recomendado en Linux Intel/AMD), `libx264`, `drawtext` (`libfreetype`) y `aac`
- **yt-dlp** actualizado
- En Linux con GPU Intel/AMD: incluir al usuario del servicio en el grupo `render` (`sudo usermod -aG render $USER`) para acceder a `/dev/dri/renderD128`.

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

## 👥 Multi-Cuenta y Modos de Emisión

Desde la pestaña **Cuentas de Emisión** del dashboard puedes registrar y verificar tantas cuentas como necesites:

### Opción 1: TikTok Auto-Sala + Proxy SEI (Recomendada)
Sube o pega el arreglo JSON de cookies de cada cuenta de TikTok directamente desde la interfaz web (se almacenan aisladas en `tiktok/accounts/<id>/cookies.json`). Cada cuenta se verifica con TikTok Live, crea su sala de forma autónoma y utiliza su propio puerto de Proxy SEI.

### Opción 2: RTMP Manual (+ Proxy SEI en TikTok)
Configura el servidor RTMP y la Stream Key de **YouTube Live**, **Kick**, **Twitch**, **Facebook Live** o **TikTok LIVE Studio**. En cuentas de TikTok manuales, el flujo continúa pasando por el Proxy SEI anti-detección.

---

## 📄 Licencia

Este proyecto está bajo la Licencia **MIT**. Desarrollado con ❤️ e Inteligencia Artificial para la comunidad de creadores y streamers.
