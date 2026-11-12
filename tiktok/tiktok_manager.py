#!/usr/bin/env python3
"""
tiktok_manager.py — Gestor Headless Multi-Cuenta y Multi-Puerto de TikTok Live (Proxy SEI)
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

DEFAULT_COOKIES_PATH = BASE_DIR / "cookies" / "tiktok_cookies.json"
QUEUE_ROOT = BASE_DIR / "queue"
LOGS_ROOT = BASE_DIR / "logs"

QUEUE_ROOT.mkdir(parents=True, exist_ok=True)
LOGS_ROOT.mkdir(parents=True, exist_ok=True)

PYTHON_BIN = PROJECT_ROOT / "venv" / "bin" / "python3"
if not PYTHON_BIN.exists():
    PYTHON_BIN = Path(sys.executable)


def _safe_id(session_id: str) -> str:
    cleaned = "".join(c for c in (session_id or "default") if c.isalnum() or c in ("-", "_"))
    return cleaned or "default"


def _paths_for(session_id: str):
    sid = _safe_id(session_id)
    sdir = QUEUE_ROOT / sid
    sdir.mkdir(parents=True, exist_ok=True)
    return {
        "session_file": sdir / "tiktok_live_session.json",
        "proxy_pid": sdir / "tiktok_proxy.pid",
        "heartbeat_pid": sdir / "tiktok_heartbeat.pid",
        "proxy_log": LOGS_ROOT / f"{sid}_proxy.log",
        "heartbeat_log": LOGS_ROOT / f"{sid}_heartbeat.log",
    }


def get_stream_client(cookies_path=None):
    from tiktok_headless import Stream
    cpath = Path(cookies_path) if cookies_path else DEFAULT_COOKIES_PATH
    if not cpath.exists():
        raise FileNotFoundError(f"No se encontró el archivo de cookies en: {cpath}")
    return Stream(cookies_path=str(cpath))


def verify_session(cookies_path=None):
    """Verifica con precisión las cookies y permisos LIVE Studio de una cuenta de TikTok."""
    try:
        stream = get_stream_client(cookies_path)
        info = stream.getAccountInfo() or {}
        acct = info.get("account") or {}
        username = acct.get("username") or acct.get("screen_name") or acct.get("email") or ""
        uid = str(acct.get("user_id_str") or acct.get("user_id") or "")
        return {
            "valid": True,
            "can_stream": bool(info.get("can_go_live", False)),
            "status_text": info.get("status", ""),
            "account": username,
            "owner_user_id": uid,
        }
    except Exception as e:
        return {"valid": False, "can_stream": False, "error": str(e)}


def start_sei_proxy(
    stream_url,
    session_id="default",
    listen_port=19350,
    room_id="0",
    uid="",
    fps=30,
    resolution="1080x1920",
):
    """
    Inicia el proxy SEI de TikTok en un puerto local dedicado escuchando en:
    rtmp://127.0.0.1:<listen_port>/live/obs
    """
    paths = _paths_for(session_id)
    proxy_script = LIBS_SUBDIR / "ffmpeg_sei_proxy.py"
    listen_url = f"rtmp://127.0.0.1:{int(listen_port)}/live/obs"
    cmd = [
        str(PYTHON_BIN),
        str(proxy_script),
        "--ffmpeg", "/usr/bin/ffmpeg",
        "--input-flv", "listen",
        "--listen-url", listen_url,
        "--output-url", stream_url,
        "--room-id", str(room_id),
        "--uid", str(uid),
        "--fps", str(int(fps)),
        "--resolution", str(resolution),
        "--timeout", "300",
        "--log", str(paths["proxy_log"]),
    ]

    proc = subprocess.Popen(
        cmd,
        env=os.environ.copy(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        preexec_fn=os.setsid,
    )

    paths["proxy_pid"].write_text(str(proc.pid), encoding="utf-8")
    return proc.pid, listen_url


def start_heartbeat_daemon(room_id, stream_id, session_id="default", cookies_path=None):
    """Inicia el demonio de latidos periódicos aislado para una sala/cuenta."""
    paths = _paths_for(session_id)
    cmd = [
        str(PYTHON_BIN),
        str(Path(__file__).resolve()),
        "--daemon-heartbeat",
        "--room-id", str(room_id),
        "--stream-id", str(stream_id),
        "--session-id", _safe_id(session_id),
    ]
    if cookies_path:
        cmd.extend(["--cookies", str(cookies_path)])

    with open(paths["heartbeat_log"], "a", encoding="utf-8") as log_file:
        proc = subprocess.Popen(
            cmd,
            stdout=log_file,
            stderr=log_file,
            preexec_fn=os.setsid,
        )
    paths["heartbeat_pid"].write_text(str(proc.pid), encoding="utf-8")
    return proc.pid


def create_live_room(
    title=None,
    topic_id="42",
    cookies_path=None,
    session_id="default",
    listen_port=19350,
    fps=30,
    resolution="1080x1920",
):
    """Crea una sala LIVE oficial en TikTok para la cuenta indicada, levanta proxy SEI y heartbeat."""
    if not title:
        title = "⚡ Transmisión en Vivo 24/7 | Projecto 9x"

    end_live_room(session_id=session_id, cookies_path=cookies_path)

    paths = _paths_for(session_id)
    stream = get_stream_client(cookies_path)
    stream.createStream(
        title=title,
        hashtag_id=str(topic_id),
        game_tag_id="0",
        gen_replay=False,
        age_restricted=False,
        multi_stream_scene=False,
    )

    listen_url = f"rtmp://127.0.0.1:{int(listen_port)}/live/obs"
    session_data = {
        "session_id": _safe_id(session_id),
        "cookies_path": str(cookies_path or DEFAULT_COOKIES_PATH),
        "room_id": stream.roomId,
        "stream_id": stream.streamId,
        "stream_url": stream.streamUrl,
        "base_stream_url": stream.baseStreamUrl,
        "stream_key": stream.streamKey,
        "share_url": stream.streamShareUrl,
        "owner_user_id": stream.ownerUserId,
        "local_proxy_url": listen_url,
        "listen_port": int(listen_port),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": "active",
    }

    with open(paths["session_file"], "w", encoding="utf-8") as f:
        json.dump(session_data, f, indent=2)

    proxy_pid, _ = start_sei_proxy(
        stream.streamUrl,
        session_id=session_id,
        listen_port=listen_port,
        room_id=stream.roomId,
        uid=stream.ownerUserId,
        fps=fps,
        resolution=resolution,
    )
    session_data["proxy_pid"] = proxy_pid

    hb_pid = start_heartbeat_daemon(
        stream.roomId,
        stream.streamId,
        session_id=session_id,
        cookies_path=cookies_path,
    )
    session_data["heartbeat_pid"] = hb_pid

    time.sleep(1.5)
    return session_data


def run_heartbeat_loop(room_id, stream_id, cookies_path=None):
    """Ciclo continuo de latidos cada 20s."""
    stream = get_stream_client(cookies_path)
    while True:
        try:
            stream.liveHeartbeat(room_id=str(room_id), stream_id=str(stream_id))
        except Exception:
            pass
        time.sleep(20)


def _kill_pid_group(pid_file: Path):
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            pgid = os.getpgid(pid)
            os.killpg(pgid, signal.SIGTERM)
            deadline = time.time() + 0.8
            while time.time() < deadline:
                try:
                    os.killpg(pgid, 0)
                    time.sleep(0.1)
                except ProcessLookupError:
                    pgid = None
                    break
            if pgid is not None:
                os.killpg(pgid, signal.SIGKILL)
        except Exception:
            pass
        pid_file.unlink(missing_ok=True)


def end_live_room(session_id="default", cookies_path=None):
    """Detiene el proxy SEI, el heartbeat y cierra la sala de esta sesión."""
    paths = _paths_for(session_id)
    _kill_pid_group(paths["proxy_pid"])
    _kill_pid_group(paths["heartbeat_pid"])

    if paths["session_file"].exists():
        try:
            with open(paths["session_file"], "r", encoding="utf-8") as f:
                data = json.load(f)
            room_id = data.get("room_id")
            stream_id = data.get("stream_id")
            cpath = cookies_path or data.get("cookies_path")
            if room_id and stream_id:
                try:
                    stream = get_stream_client(cpath)
                    stream.endStream(room_id=str(room_id), stream_id=str(stream_id))
                except Exception:
                    pass
        except Exception:
            pass
        paths["session_file"].unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="TikTok Live Multi-Account Manager - Projecto 9x")
    parser.add_argument("--create", action="store_true", help="Crear sala TikTok Live con proxy SEI")
    parser.add_argument("--title", default="", help="Título de la transmisión")
    parser.add_argument("--topic", default="42", help="ID del tema")
    parser.add_argument("--cookies", default="", help="Ruta al archivo cookies.json de la cuenta")
    parser.add_argument("--session-id", default="default", help="ID único de sesión/slot")
    parser.add_argument("--listen-port", type=int, default=19350, help="Puerto RTMP local del proxy SEI")
    parser.add_argument("--fps", type=int, default=30, help="FPS del flujo")
    parser.add_argument("--resolution", default="1080x1920", help="Resolución WxH")
    parser.add_argument("--end", action="store_true", help="Cerrar sala y detener proxy")
    parser.add_argument("--status", action="store_true", help="Consultar estado activo")
    parser.add_argument("--verify", action="store_true", help="Verificar cookies y sesión")
    parser.add_argument("--proxy-only", help="Iniciar proxy SEI apuntando a URL RTMP destino")
    parser.add_argument("--daemon-heartbeat", action="store_true", help="Uso interno: demonio heartbeat")
    parser.add_argument("--room-id", default="", help="Room ID")
    parser.add_argument("--stream-id", default="", help="Stream ID")
    args = parser.parse_args()

    cpath = args.cookies.strip() or None

    if args.daemon_heartbeat:
        if args.room_id and args.stream_id:
            run_heartbeat_loop(args.room_id, args.stream_id, cookies_path=cpath)
        return

    if args.verify:
        print(json.dumps(verify_session(cookies_path=cpath), ensure_ascii=False))
        return

    if args.create:
        res = create_live_room(
            title=args.title or None,
            topic_id=args.topic,
            cookies_path=cpath,
            session_id=args.session_id,
            listen_port=args.listen_port,
            fps=args.fps,
            resolution=args.resolution,
        )
        print(json.dumps(res, ensure_ascii=False))
        return

    if args.proxy_only:
        end_live_room(session_id=args.session_id, cookies_path=cpath)
        pid, listen_url = start_sei_proxy(
            args.proxy_only,
            session_id=args.session_id,
            listen_port=args.listen_port,
            fps=args.fps,
            resolution=args.resolution,
        )
        time.sleep(1.5)
        print(json.dumps({
            "status": "proxy_ready",
            "proxy_url": listen_url,
            "listen_port": args.listen_port,
            "proxy_pid": pid,
        }))
        return

    if args.end:
        end_live_room(session_id=args.session_id, cookies_path=cpath)
        print(json.dumps({"status": "ended", "session_id": _safe_id(args.session_id)}))
        return

    if args.status:
        paths = _paths_for(args.session_id)
        if paths["session_file"].exists():
            print(paths["session_file"].read_text(encoding="utf-8"))
        else:
            print(json.dumps({"status": "no_active_session"}))
        return


if __name__ == "__main__":
    main()
