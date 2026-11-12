<div align="center">

# ⚡ Projecto 9x — Multi-Stream Live Restreamer & Donation Engine
### Motor Inteligente de Retransmisión Simultánea Multi-Cuenta con Aceleración GPU VAAPI

[![Node.js](https://img.shields.io/badge/Node.js-v22-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.13-blue.svg)](https://www.python.org/)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-7.1%20VAAPI-orange.svg)](https://ffmpeg.org/)
[![AI-Powered](https://img.shields.io/badge/Developed%20with-Artificial%20Intelligence-purple.svg)](#-desarrollado-con-inteligencia-artificial)
[![License](https://img.shields.io/badge/License-MIT-brightgreen.svg)](LICENSE)

*Sistema autónomo multi-cuenta para capturar múltiples directos simultáneamente (YouTube Live, Twitch, Kick) y retransmitirlos con codificación hardware Intel VAAPI, banners de donación editables en vivo, proxy SEI anti-baneo en TikTok y auto-detección de fin de emisión.*

---

</div>

## 🤖 Desarrollado con Inteligencia Artificial

> **Nota de autoría**: Este proyecto ha sido **completamente diseñado, programado y optimizado por Inteligencia Artificial (Antigravity AI Agent)**. Desde el motor concurrente multi-slot (`StreamManager`) y el almacén aislado de cuentas (`AccountStore`), hasta la codificación por hardware VAAPI con blur optimizado y el proxy SEI firmado por sesión, toda la arquitectura fue construida mediante ingeniería de software asistida por IA.

---

## 🌟 Características Principales

- **👥 Gestión Multi-Cuenta Real:** Registra y verifica múltiples cuentas destino (**TikTok Live** con Cookies JSON independientes o RTMP manual, **YouTube Live**, **Kick**, **Twitch**, **Facebook Live** o servidores **RTMP/RTMPS** personalizados).
- **📡 Multi-Stream Simultáneo Aislado:** Ejecuta múltiples transmisiones distintas al mismo tiempo (`Slot #stream-1`, `#stream-2`, ...). Cada directo opera en su propio puerto de Proxy SEI (`19350–19449`), carpeta aislada de sesión/cola y limpieza segura por árbol de procesos.
- **⚡ Aceleración Hardware Intel VAAPI + Blur Rápido:** Descarga la codificación H.264 al chip gráfico (`h264_vaapi` en `/dev/dri/renderD128`) con respaldo automático a `libx264`. El modo Vertical Blur procesa el desenfoque sobre un lienzo reducido (`180x320`, reduciendo drásticamente la carga de CPU) antes de reescalar a `720p30`, `1080p30` o `1080p60`.
- **💖 Sistema de Donaciones Visuales en Vivo:** Overlay nativo mediante `drawtext` con lectura dinámica (`textfile` + `reload=30`), ajuste automático de línea y modo **Periódico** (aparece cada *N* segundos durante *X* segundos) o **Fijo**, sin alterar el audio del directo. Permite actualizar el mensaje de donación desde el panel web sin reiniciar el stream.
- **🛡️ Evasión Anti-Bot y Proxy SEI Anti-Baneo:** Ingesta mediante `yt-dlp` calibrado (`player_client=ios,android,tv,mweb`), limpieza de paquetes SEI previos y firma de paquetes **SEI NALU tipo 100** mediante `ffmpeg_sei_proxy.py` por cada instancia de TikTok Live.
- **🏁 Auto-Detección de Fin y Reconexión Anti-Caídas:** Reconoce `#EXT-X-ENDLIST` al finalizar la transmisión origen para cerrar la sala limpiamente, o reconecta de forma controlada si se habilita.
- **🖥️ Panel Web Reactivo con Telemetría en Tiempo Real:** Monitor por SSE (`/api/stream/events`) con métricas por transmisión (FPS, Bitrate, Velocidad, Uptime, enlace a Sala TikTok, visor de logs individual) y telemetría del servidor (GPU VAAPI, CPU %, RAM y temperatura).

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
