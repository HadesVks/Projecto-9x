#!/usr/bin/env python3
"""
tiktok_manager.py — Gestor Headless de Salas y Proxy RTMP SEI de TikTok Live
Ecosistema: Projecto 9x (/home/hades/Proyectos/Projecto-9x)
"""
import os
import sys
import json
import time
import argparse
import subprocess
import signal
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
LIB_DIR = BASE_DIR
LIBS_SUBDIR = BASE_DIR / "Libs"

if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))
if str(LIBS_SUBDIR) not in sys.path:
    sys.path.insert(0, str(LIBS_SUBDIR))

ENV_FILE = BASE_DIR / ".env"
if ENV_FILE.exists():
    with open(ENV_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip()

COOKIES_PATH = BASE_DIR / "cookies" / "tiktok_cookies.json"
QUEUE_DIR = BASE_DIR / "queue"
LOGS_DIR = BASE_DIR / "logs"

QUEUE_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)

PROXY_LOG = LOGS_DIR / "tiktok_proxy.log"
HEARTBEAT_LOG = LOGS_DIR / "tiktok_heartbeat.log"
SESSION_STATE_FILE = QUEUE_DIR / "tiktok_live_session.json"
PROXY_PID_FILE = QUEUE_DIR / "tiktok_proxy.pid"
HEARTBEAT_PID_FILE = QUEUE_DIR / "tiktok_heartbeat.pid"

PYTHON_BIN = PROJECT_ROOT / "venv" / "bin" / "python3"
if not PYTHON_BIN.exists():
    PYTHON_BIN = Path(sys.executable)

def get_stream_client():
    from tiktok_headless import Stream
    if not COOKIES_PATH.exists():
        raise FileNotFoundError(f"No se encontró el archivo de cookies en: {COOKIES_PATH}")
    return Stream(cookies_path=str(COOKIES_PATH))

def verify_session():
    """Verifica si las cookies y la sesión de TikTok están activas."""
    try:
        stream = get_stream_client()
        info = stream.getAccountInfo()
        return {
            "valid": True,
            "can_stream": getattr(stream, "canStream", True),
            "account": getattr(stream, "accountName", ""),
            "owner_user_id": getattr(stream, "ownerUserId", "")
        }
    except Exception as e:
        return {"valid": False, "error": str(e)}

def start_sei_proxy(stream_url, room_id="0", uid=""):
    """
    Inicia el proxy SEI de TikTok en segundo plano escuchando en rtmp://127.0.0.1:19350/live/obs
    Inyecta metadatos SEI de TikTok LIVE Studio para evitar shadowban o bloqueos.
    """
    proxy_script = LIBS_SUBDIR / "ffmpeg_sei_proxy.py"
    cmd = [
        str(PYTHON_BIN),
        str(proxy_script),
        "--ffmpeg", "/usr/bin/ffmpeg",
        "--input-flv", "listen",
        "--listen-url", "rtmp://127.0.0.1:19350/live/obs",
        "--output-url", stream_url,
        "--room-id", str(room_id),
        "--uid", str(uid),
        "--fps", "30",
        "--resolution", "1080x1920",
        "--timeout", "300",
        "--log", str(PROXY_LOG)
    ]

    env = os.environ.copy()
    proc = subprocess.Popen(
        cmd,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        preexec_fn=os.setsid
    )

    with open(PROXY_PID_FILE, "w", encoding="utf-8") as f:
        f.write(str(proc.pid))

    return proc.pid

def start_heartbeat_daemon(room_id, stream_id):
    """Inicia el demonio de latidos periódicos para TikTok."""
    cmd = [
        str(PYTHON_BIN),
        str(Path(__file__).resolve()),
        "--daemon-heartbeat",
        "--room-id", str(room_id),
        "--stream-id", str(stream_id)
    ]
    with open(HEARTBEAT_LOG, "a", encoding="utf-8") as log_file:
        proc = subprocess.Popen(
            cmd,
            stdout=log_file,
            stderr=log_file,
            preexec_fn=os.setsid
        )
    with open(HEARTBEAT_PID_FILE, "w", encoding="utf-8") as f:
        f.write(str(proc.pid))
    return proc.pid

def create_live_room(title=None, topic_id="42"):
    """Crea una sala LIVE oficial en TikTok, levanta el proxy SEI y arranca el heartbeat."""
    if not title:
        title = "⚡ Transmisión en Vivo 24/7 | Projecto 9x"

    end_live_room()

    stream = get_stream_client()
    stream.createStream(
        title=title,
        hashtag_id=str(topic_id),
        game_tag_id="0",
        gen_replay=False,
        age_restricted=False,
        multi_stream_scene=False
    )

    session_data = {
        "room_id": stream.roomId,
        "stream_id": stream.streamId,
        "stream_url": stream.streamUrl,
        "base_stream_url": stream.baseStreamUrl,
        "stream_key": stream.streamKey,
        "share_url": stream.streamShareUrl,
        "owner_user_id": stream.ownerUserId,
        "local_proxy_url": "rtmp://127.0.0.1:19350/live/obs",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": "active"
    }

    with open(SESSION_STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(session_data, f, indent=2)

    proxy_pid = start_sei_proxy(stream.streamUrl, stream.roomId, stream.ownerUserId)
    session_data["proxy_pid"] = proxy_pid

    hb_pid = start_heartbeat_daemon(stream.roomId, stream.streamId)
    session_data["heartbeat_pid"] = hb_pid

    time.sleep(1.5)
    return session_data

def run_heartbeat_loop(room_id, stream_id):
    """Ciclo infinito de latidos para mantener viva la sala."""
    stream = get_stream_client()
    while True:
        try:
            stream.liveHeartbeat(room_id=str(room_id), stream_id=str(stream_id))
        except Exception:
            pass
        time.sleep(20)

def end_live_room():
    """Detiene el proxy SEI, los heartbeats y cierra la sala en TikTok."""
    if PROXY_PID_FILE.exists():
        try:
            pid = int(PROXY_PID_FILE.read_text().strip())
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except Exception:
            pass
        PROXY_PID_FILE.unlink(missing_ok=True)

    if HEARTBEAT_PID_FILE.exists():
        try:
            pid = int(HEARTBEAT_PID_FILE.read_text().strip())
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except Exception:
            pass
        HEARTBEAT_PID_FILE.unlink(missing_ok=True)

    if SESSION_STATE_FILE.exists():
        try:
            with open(SESSION_STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            room_id = data.get("room_id")
            stream_id = data.get("stream_id")
            if room_id and stream_id:
                try:
                    stream = get_stream_client()
                    stream.endStream(room_id=str(room_id), stream_id=str(stream_id))
                except Exception:
                    pass
        except Exception:
            pass
        SESSION_STATE_FILE.unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser(description="TikTok Live Manager - Projecto 9x")
    parser.add_argument("--create", action="store_true", help="Crear sala TikTok Live con proxy SEI")
    parser.add_argument("--title", default="", help="Título de la transmisión")
    parser.add_argument("--topic", default="42", help="ID del tema")
    parser.add_argument("--end", action="store_true", help="Cerrar sala y detener proxy")
    parser.add_argument("--status", action="store_true", help="Consultar estado activo")
    parser.add_argument("--verify", action="store_true", help="Verificar cookies y sesión")
    parser.add_argument("--proxy-only", help="Iniciar proxy SEI apuntando a URL RTMP destino")
    parser.add_argument("--daemon-heartbeat", action="store_true", help="Uso interno: demonio heartbeat")
    parser.add_argument("--room-id", default="", help="Room ID")
    parser.add_argument("--stream-id", default="", help="Stream ID")
    args = parser.parse_args()

    if args.daemon_heartbeat:
        if args.room_id and args.stream_id:
            run_heartbeat_loop(args.room_id, args.stream_id)
        return

    if args.verify:
        print(json.dumps(verify_session(), ensure_ascii=False))
        return

    if args.create:
        res = create_live_room(title=args.title or None, topic_id=args.topic)
        print(json.dumps(res, ensure_ascii=False))
        return

    if args.proxy_only:
        end_live_room()
        pid = start_sei_proxy(args.proxy_only)
        time.sleep(1.5)
        print(json.dumps({
            "status": "proxy_ready",
            "proxy_url": "rtmp://127.0.0.1:19350/live/obs",
            "proxy_pid": pid
        }))
        return

    if args.end:
        end_live_room()
        print(json.dumps({"status": "ended"}))
        return

    if args.status:
        if SESSION_STATE_FILE.exists():
            with open(SESSION_STATE_FILE, "r", encoding="utf-8") as f:
                print(f.read())
        else:
            print(json.dumps({"status": "no_active_session"}))
        return

if __name__ == "__main__":
    main()
