# Projecto 9x — Retransmisor Inteligente de Streams en Vivo

Motor autónomo de captura y retransmisión de flujos en directo (YouTube Live, Twitch, Kick, etc.) hacia plataformas destino como **TikTok Live**, Kick, Twitch, YouTube o cualquier servidor RTMP/RTMPS personalizado.

---

## 🚀 Acceso al Panel Web Dashboard

El panel de control interactivo está activo y accesible desde cualquier navegador en tu red local o mediante Tailscale:

- **Red Local (LAN):** [http://10.0.0.3:9090](http://10.0.0.3:9090)
- **Tailscale (VPN Segura):** [http://100.109.45.25:9090](http://100.109.45.25:9090)
- **Localhost:** [http://127.0.0.1:9090](http://127.0.0.1:9090)

---

## 🎯 Modos de Transmisión

1. **📱 Vertical 9:16 (Fondo Desenfocado / Blur):**
   - Transforma automáticamente el video panorámico 16:9 en 9:16 (1080x1920) vertical nativo para TikTok.
   - El video central permanece nítido mientras que el fondo superior e inferior se rellenan con un desenfoque ambiental dinámico.
2. **📱 Vertical 9:16 (Recorte Centrado / Crop):**
   - Recorta el tercio central de la transmisión 16:9 y lo ajusta a 9:16 vertical. Ideal para podcasts, conferencias o enfoque de una sola persona.
3. **🖥️ Copia Directa 16:9 (Passthrough):**
   - Emite el stream sin recodificar (`-c copy`). Cero uso de CPU/GPU. Ideal para plataformas horizontales (Kick, YouTube, Twitch) o TikTok en modo horizontal.

---

## 🛠️ Comandos de Gestión con PM2

Ejecutar siempre bajo el usuario `hades`:

```bash
# Ver estado en tiempo real
su - hades -c "pm2 status projecto-9x"

# Ver logs de emisión en directo
su - hades -c "pm2 logs projecto-9x"

# Reiniciar servicio
su - hades -c "pm2 restart projecto-9x"

# Detener servicio
su - hades -c "pm2 stop projecto-9x"
```

---

## 📋 Arquitectura del Proyecto

- `server.js`: Servidor Express + API REST + Server-Sent Events (SSE) para telemetría y logs en tiempo real.
- `stream_engine.js`: Gestor del pipeline `yt-dlp` + `ffmpeg`, buffers de sincronización y reconexión automática anti-caídas.
- `config.json`: Almacén persistente de presets RTMP y última configuración usada.
- `public/`: Panel Web SPA responsivo (HTML5 / CSS / Vanilla JS) con tema oscuro, monitores de telemetría y visualizador de logs.
