try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass
import hashlib
import json
import os
import sys
import time
import webbrowser
import socket
import threading
import urllib.parse
import base64
import mimetypes
import secrets
import signal
import shutil
import subprocess
from urllib.parse import urlencode

import requests
try:
    from curl_cffi import requests as curl_requests
    from curl_cffi.requests import exceptions as curl_exceptions
except Exception:
    curl_requests = None
    curl_exceptions = None
from packaging import version

if sys.platform == "win32":
    import winreg

from Libs.domain_routing import (
    attach_webcast_ntp_t0,
    build_common_headers,
    build_endpoint,
    get_synced_unix_seconds,
    resolve_api_host_candidates,
    resolve_webcast_base_url,
    resolve_webcast_host_candidates,
    update_ntp_from_response,
)
from Libs.device_gen import (
    build_live_studio_browser_version,
    fetch_live_studio_latest_version,
    register_desktop_device_identifiers,
)
from Libs.signers import TikTokSigners
from Libs.rapidapi_quota import (
    quota_reset_at,
    quota_updated_at,
    read_quota,
)
try:
    from Updater import VersionChecker
except ImportError:
    VersionChecker = None


CURL_CFFI_IMPERSONATE = "chrome"


def _new_http_session():
    if curl_requests is not None:
        return curl_requests.Session(impersonate=CURL_CFFI_IMPERSONATE)
    return requests.Session()


def _http_get(url, **kwargs):
    if curl_requests is not None:
        return curl_requests.get(url, impersonate=CURL_CFFI_IMPERSONATE, **kwargs)
    return requests.get(url, **kwargs)


def _is_http_timeout(exc):
    timeout_types = [requests.Timeout]
    if curl_exceptions is not None:
        timeout_types.append(curl_exceptions.Timeout)
    return isinstance(exc, tuple(timeout_types))


def _is_http_connection_error(exc):
    connection_types = [requests.ConnectionError, requests.Timeout]
    if curl_exceptions is not None:
        connection_types.extend([curl_exceptions.ConnectionError, curl_exceptions.Timeout])
    return isinstance(exc, tuple(connection_types))


TOPICS = {
    "5": "Gaming",
    "6": "Music",
    "42": "Chat & Interview",
    "9": "Beauty & Fashion",
    "3": "Dance",
    "13": "Fitness & Sports",
    "4": "Food",
    "43": "News & Event",
    "45": "Education",
}

REGIONS = [""] + (
    "af ax al dz as ad ao ai aq ag ar am aw au at az bs bh bd bb by be bz bj bm bt bo bq "
    "ba bw bv br io bn bg bf bi cv kh cm ca ky cf td cl cn cx cc co km cg cd ck cr ci hr "
    "cu cw cy cz dk dj dm do ec eg sv et fk fo fj fi fr gf pf tf ga gm ge de "
    "gh gi gr gl gd gp gu gt gg gn gw gy ht hm va hn hk hu is in id ir iq ie im il it jm "
    "jp je jo kz ke ki kp kr kw kg la lv lb ls lr ly li lt lu mo mg mw my mv ml mt mh mq "
    "mr mu yt mx fm md mc mn me ms ma mz mm na nr np nl nc nz ni ne ng nu nf mk mp no om "
    "pk pw ps pa pg py pe ph pn pl pt pr qa re ro ru rw bl sh kn lc mf pm vc ws sm st sa "
    "sn rs sc sl sg sx sk si sb so za gs ss es lk sd sr sj se ch sy tw tj tz th tl tg tk "
    "to tt tn tr tm tc tv ug ua ae gb um us uy uz vu ve vn vg vi wf eh ye zm zw"
).split()

LIVE_STUDIO_CLIENT_ID = "abad793d-e940-42cb-bc89-e6939b1b3b4d"
LIVE_STUDIO_REDIRECT_URI = "live-studio-app://login/continue"
DEFAULT_OS_VERSION = "10.0.26200"
PASSPORT_WEB_SDK_VERSION = "2.1.9"
PASSPORT_APP_KEY = "884c28a44b61b78f9d837fc8b0967178"

TT_TICKET_GUARD_PUBLIC_KEY = (
    "BHTyDu4GfY+Se8QoOlL22ARkOv4aLE5LBCk8eSiJ6K5N5m8Wg3cPeVYWVYNDrJ3hs"
    "RmaVCgNl/AKbMW67VBievw="
)
TT_TICKET_GUARD_VERSION = "2"
TT_TICKET_GUARD_WEB_VERSION = "1"
TT_TICKET_GUARD_ITERATION_VERSION = "0"
LADON_LOCAL_ID = 1877999593

ANCHOR_STATUS_DEFAULT = 0
ANCHOR_STATUS_PREPARE = 1
ANCHOR_STATUS_LIVING = 2
ANCHOR_STATUS_PAUSE = 3
ANCHOR_STATUS_FINISH = 4
PING_ANCHOR_TIMEOUT_SECONDS = 2.5
ROOM_HAS_FINISHED_CODES = {"30003", "30003001"}
ROOM_IS_LIVING_CODE = "4003150"
PERCEPTION_VIOLATION_SCENES = (7, 10, 16)
LOCAL_PROXY_DEFAULT_PORT = 19350
LOCAL_PROXY_APP_NAME = "live"
LOCAL_PROXY_STREAM_KEY = "obs"
LOCAL_PROXY_LISTEN_TIMEOUT_SECONDS = 120
LOCAL_PROXY_LOG_NAME = "ffmpeg_proxy.log"
# Dual layout: second signed listener for the portrait (vertical) canvas.
LOCAL_PROXY_PORTRAIT_DEFAULT_PORT = 19351
LOCAL_PROXY_PORTRAIT_APP_NAME = "live"
LOCAL_PROXY_PORTRAIT_STREAM_KEY = "portrait"
LOCAL_PROXY_PORTRAIT_LOG_NAME = "ffmpeg_proxy_portrait.log"
ENABLE_STUDIO_STATS_POLLING = True
ENABLE_ONLINE_AUDIENCE_POLLING = True
ENABLE_SAFETY_DETAIL_POLLING = True
# Polling while unfocused: every webcast call costs one RapidAPI /signatures
# request (~2,660/hour focused while live, which trips the provider-side
# hourly rate limit and burns the daily quota). When the window is not the
# active one, display-only pollers stop; the violation monitor keeps
# running, slower. The anchor heartbeat always runs: pausing it mid-stream
# risks TikTok tearing the room down server-side.
UNFOCUSED_VIOLATION_POLL_SECONDS = 60


def _is_frozen_build():
    return bool(getattr(sys, "frozen", False) or globals().get("__compiled__"))


def _application_dir():
    if _is_frozen_build():
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _is_macos_app_bundle():
    # Nuitka --macos-create-app-bundle puts the executable inside
    # <App>.app/Contents/MacOS. That is not a place for user data: the
    # bundle is replaced on every app update and can be read-only (App
    # Translocation, /Applications installs owned by another admin).
    return sys.platform == "darwin" and _is_frozen_build()


def _user_data_dir():
    # Config, the default cookies file, and logs live next to the
    # executable on Windows/Linux (portable style). macOS .app bundles use
    # the standard per-user Application Support folder instead.
    if _is_macos_app_bundle():
        base = os.path.join(
            os.path.expanduser("~"),
            "Library",
            "Application Support",
            "TiktokStreamKeyGenerator",
        )
        try:
            os.makedirs(base, exist_ok=True)
            return base
        except OSError:
            pass
    return _application_dir()


DEFAULT_COOKIES_PATH = os.path.join(_user_data_dir(), "cookies.json")
CONFIG_PATH = os.path.join(_user_data_dir(), "config.json")
RAPIDAPI_SIGNER_DOCS_URL = "https://rapidapi.com/Loukious/api/tiktok-live-studio-api-signer1"


def _normalize_configured_path(path, default=DEFAULT_COOKIES_PATH):
    value = str(path or "").strip()
    if not value:
        value = default
    value = os.path.expanduser(value)
    if not os.path.isabs(value):
        # Resolve relative paths against the app's data directory, not the
        # process CWD — a Finder-launched macOS .app has CWD "/", where
        # neither reading nor writing makes sense.
        value = os.path.join(os.path.dirname(default), value)
    return os.path.abspath(value)


def _load_config_file():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as file:
            data = json.load(file)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        return {}


def _configured_cookies_path(default=DEFAULT_COOKIES_PATH):
    data = _load_config_file()
    return _normalize_configured_path(data.get("cookies_path", default), default=default)


def _configured_rapidapi_key():
    data = _load_config_file()
    return str(data.get("rapidapi_key", "") or "").strip()


class WebcastError(RuntimeError):
    def __init__(self, message, *, status_code=None, payload=None, action=""):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload
        self.action = action


def _audit_webcast_request(method, url, params, headers, status_code):
    try:
        split = urllib.parse.urlsplit(url)
        request_headers = headers or {}
        khronos = str(request_headers.get("x-khronos", "") or "")
        ladon = str(request_headers.get("x-ladon", "") or "")
        argus = str(request_headers.get("x-argus", "") or "")
        stub = str(request_headers.get("x-ss-stub", "") or "")
        device_id = _param_value(params, "device_id")
        line = (
            f"{time.strftime('%Y-%m-%dT%H:%M:%S')} "
            f"method={method} path={split.path} status={status_code} "
            f"khronos={khronos} ladon_len={len(ladon)} argus_len={len(argus)} "
            f"stub_len={len(stub)} device_id_set={bool(device_id)}\n"
        )
        path = os.path.join(_runtime_logs_dir(), "webcast_requests.log")
        with open(path, "a", encoding="utf-8", errors="replace") as file:
            file.write(line)
    except Exception:
        pass


def _audit_violation_list(violation_list_type, data, records, summaries):
    try:
        line = (
            f"{time.strftime('%Y-%m-%dT%H:%M:%S')} "
            f"type={violation_list_type} server_active={data.get('active_count')} "
            f"server_history={data.get('history_count')} records={len(records)} "
            f"summaries={json.dumps(summaries[:3], ensure_ascii=False)}\n"
        )
        path = os.path.join(_runtime_logs_dir(), "violation_list.log")
        with open(path, "a", encoding="utf-8", errors="replace") as file:
            file.write(line)
    except Exception:
        pass


def _is_already_ended_payload(payload):
    if not isinstance(payload, dict):
        return False

    status_code = payload.get("status_code")
    data = payload.get("data", {})
    if not isinstance(data, dict):
        data = {}

    text = " ".join(
        str(part or "")
        for part in (
            data.get("prompts"),
            data.get("message"),
            payload.get("prompts"),
            payload.get("message"),
        )
    ).lower()

    return str(status_code) in ROOM_HAS_FINISHED_CODES and (
        "ended" in text or "finished" in text or "end" in text
    )


def _is_already_ended_error(exc):
    if isinstance(exc, WebcastError):
        return _is_already_ended_payload(exc.payload)
    text = str(exc).lower()
    return "live has ended" in text or "room has finished" in text


def _param_value(params, name, default=None):
    if params is None:
        return default
    if isinstance(params, dict):
        return params.get(name, default)
    if isinstance(params, (list, tuple)):
        for key, value in params:
            if key == name:
                return value
        return default

    value = str(params)
    split = urllib.parse.urlsplit(value)
    query = split.query if split.query else value.lstrip("?")
    parsed = urllib.parse.parse_qs(query, keep_blank_values=True)
    values = parsed.get(name)
    return values[0] if values else default


def _build_signature_headers(timestamp, aid="8311", params=None, x_ss_stub=None):
    device_id = _param_value(params, "device_id")
    return TikTokSigners.signature_headers(
        timestamp,
        aid,
        params=params,
        x_ss_stub=x_ss_stub,
        device_id=device_id,
        local_id=LADON_LOCAL_ID,
    )


def _encode_form_body(data):
    if data is None:
        return b""
    if isinstance(data, bytes):
        return data
    if isinstance(data, bytearray):
        return bytes(data)
    if isinstance(data, str):
        return data.encode()
    return urllib.parse.urlencode(
        data,
        doseq=True,
        quote_via=urllib.parse.quote,
    ).encode()


def _make_x_ss_stub(data):
    body = _encode_form_body(data)
    return hashlib.md5(body).hexdigest() if body else None


def _payload_status_code(payload):
    if not isinstance(payload, dict):
        return None
    return payload.get("status_code")


def _is_room_is_living_payload(payload):
    return str(_payload_status_code(payload)) == ROOM_IS_LIVING_CODE


def _is_update_in_lock_payload(payload):
    if not isinstance(payload, dict):
        return False
    data = payload.get("data", {})
    if not isinstance(data, dict):
        data = {}
    message = str(data.get("message") or payload.get("message") or "")
    return "StatusMessage:update_in_lock" in message


def _webcast_error_message(payload, action):
    if not isinstance(payload, dict):
        return f"{action} failed: invalid response: {payload!r}"

    status_code = payload.get("status_code", 0)
    if status_code in (0, "0", None) or str(status_code) == ROOM_IS_LIVING_CODE:
        return ""

    data = payload.get("data", {})
    if not isinstance(data, dict):
        data = {}

    message = (
        data.get("prompts")
        or data.get("message")
        or payload.get("prompts")
        or payload.get("message")
    )
    if message:
        return f"{action} failed: {message} (status_code={status_code})"

    return f"{action} failed: TikTok returned status_code={status_code}. Response={json.dumps(payload, ensure_ascii=False)[:1000]}"


def _raise_for_webcast_error(payload, action):
    message = _webcast_error_message(payload, action)
    if message:
        status_code = payload.get("status_code") if isinstance(payload, dict) else None
        raise WebcastError(message, status_code=status_code, payload=payload, action=action)


def _encode_multipart_form_data(fields, files, boundary=None):
    boundary = boundary or f"----WebKitFormBoundary{secrets.token_urlsafe(12).replace('_', 'A').replace('-', 'B')[:16]}"
    chunks = []

    for name, value in fields:
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    for name, filename, content_type, content in files:
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            (
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode("utf-8")
        )
        chunks.append(content)
        chunks.append(b"\r\n")

    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return boundary, b"".join(chunks)


class Stream:
    def __init__(self, cookies_path=None):
        self.s = _new_http_session()
        self.s.headers.update(build_common_headers(self.s))
        self.roomId = ""
        self.streamId = ""
        self._cached_live_studio_version = None
        self.cookies_path = _normalize_configured_path(cookies_path or _configured_cookies_path())
        with open(self.cookies_path, "r", encoding="utf-8") as file:
            cookies_file = json.load(file)

        cookies = {}
        for cookie in cookies_file:
            cookies[cookie["name"]] = cookie["value"]
        self.s.cookies.update(cookies)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.s.close()

    def _apply_room_info(self, room, *, require_stream_url=True):
        living_room_attrs = room.get("living_room_attrs") or {}
        self.roomId = (
            living_room_attrs.get("room_id_str")
            or str(living_room_attrs.get("room_id", ""))
            or room.get("id_str")
            or str(room.get("id", ""))
        )
        self.streamId = room.get("stream_id_str") or str(room.get("stream_id", ""))
        self.streamUrl = (room.get("stream_url") or {}).get("rtmp_push_url", "")
        if self.streamUrl:
            split_index = self.streamUrl.rfind("/")
            self.baseStreamUrl = self.streamUrl[:split_index]
            self.streamKey = self.streamUrl[split_index + 1 :]
        else:
            self.baseStreamUrl = ""
            self.streamKey = ""

        multi_stream_url = room.get("multi_stream_url") or {}
        self.multiStreamUrl = multi_stream_url.get("rtmp_push_url", "")
        if self.multiStreamUrl:
            split_index = self.multiStreamUrl.rfind("/")
            self.multiBaseStreamUrl = self.multiStreamUrl[:split_index]
            self.multiStreamKey = self.multiStreamUrl[split_index + 1 :]
        else:
            self.multiBaseStreamUrl = ""
            self.multiStreamKey = ""

        self.multiStreamScene = room.get("multi_stream_scene")
        self.multiStreamId = (
            room.get("multi_stream_id_str")
            or str(room.get("multi_stream_id", ""))
            or multi_stream_url.get("id_str")
            or str(multi_stream_url.get("id", ""))
        )
        self.streamShareUrl = room.get("share_url", "")
        self.roomStatus = room.get("status")
        owner = room.get("owner") or {}
        self.ownerUserId = (
            room.get("owner_user_id_str")
            or str(room.get("owner_user_id") or "")
            or owner.get("id_str")
            or str(owner.get("id") or "")
        )
        has_ids = bool(self.roomId and self.streamId)
        has_push_url = bool(self.streamUrl)
        return has_ids and (has_push_url or not require_stream_url)

    def save_cookies(self, path=None):
        path = _normalize_configured_path(path or getattr(self, "cookies_path", "") or _configured_cookies_path())
        cookies = _export_cookie_jar(self.s.cookies)
        if cookies:
            with open(path, "w", encoding="utf-8") as file:
                json.dump(cookies, file, indent=2)
        return cookies

    def getLiveStudioLatestVersion(self):
        if not self._cached_live_studio_version:
            self._cached_live_studio_version = fetch_live_studio_latest_version(self.s)
        return self._cached_live_studio_version

    def _cookie_value(self, name, default=""):
        try:
            return self.s.cookies.get(name) or default
        except Exception:
            return default

    def _effective_priority_region(self, priority_region=""):
        region = str(priority_region or "").strip().lower()
        if region:
            return region

        cookie_region = str(self._cookie_value("store-country-code", "") or "").strip().lower()
        if len(cookie_region) == 2:
            return cookie_region

        return ""

    def _priority_region_candidates(self, priority_region=""):
        candidates = []
        for candidate in (
            priority_region,
            self._effective_priority_region(priority_region),
            self._cookie_value("store-country-code", ""),
            "",
        ):
            candidate = str(candidate or "").strip().lower()
            if candidate not in candidates:
                candidates.append(candidate)
        return candidates

    def _apply_live_studio_headers(self):
        version = self.getLiveStudioLatestVersion()
        browser_version = build_live_studio_browser_version(version)
        self.s.headers.update(
            {
                "user-agent": f"Mozilla/{browser_version}",
                "accept": "application/json, text/plain, */*",
                "accept-language": "en-US",
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "sec-fetch-storage-access": "active",
                "X-SS-DP": "",
                "sdk_aid": "8311",
                "sec-ch-ua": '"Not.A/Brand";v="99", "Chromium";v="136"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
            }
        )
        return version, browser_version

    def _studio_params(self, *, device_id="", install_id="", priority_region=""):
        version = self.getLiveStudioLatestVersion()
        browser_version = build_live_studio_browser_version(version)
        priority_region = self._effective_priority_region(priority_region)
        return {
            "aid": "8311",
            "app_name": "tiktok_live_studio",
            "device_id": str(device_id) if device_id else "0",
            "install_id": str(install_id) if install_id else "0",
            "channel": "studio",
            "version_code": version,
            "device_platform": "windows",
            "timezone_name": "Africa/Tunis",
            "screen_width": "1920",
            "screen_height": "1080",
            "browser_language": "en-US",
            "browser_platform": "Win32",
            "browser_name": "Mozilla",
            "browser_version": browser_version,
            "language": "en",
            "app_language": "en",
            "webcast_language": "en",
            "priority_region": priority_region,
            "webcast_sdk_version": version.replace(".", ""),
            "live_mode": "6",
        }

    def _webcast_candidate_urls(self, url, priority_region=""):
        split = urllib.parse.urlsplit(url)
        current_host = split.netloc
        if not current_host or "webcast" not in current_host:
            return [url]

        # Do not route Webcast by priority_region. Live Studio gets the real IDC
        # from TNC/domain dispatch and session cookies. For alisg accounts, forcing
        # priority_region=fr to no1a produces HTTP 403 on heartbeat/safety endpoints.
        hosts = []
        try:
            hosts.extend(resolve_webcast_host_candidates(self.s))
        except Exception:
            pass
        hosts.append(current_host)

        urls = []
        seen_hosts = set()
        for host in hosts:
            host = str(host or "").strip().lower()
            if not host or host in seen_hosts:
                continue
            seen_hosts.add(host)
            urls.append(
                urllib.parse.urlunsplit(
                    (
                        split.scheme or "https",
                        host,
                        split.path,
                        split.query,
                        split.fragment,
                    )
                )
            )
        return urls or [url]

    def _is_retryable_request_error(self, exc):
        if _is_http_connection_error(exc):
            return True
        if isinstance(exc, WebcastError):
            if exc.status_code in (403, 404, 421, 429, 500, 502, 503, 504):
                return True
            # Invalid/empty non-JSON responses usually come from the wrong IDC.
            return exc.status_code is None
        return False

    def _signed_get_json(self, url, *, params, priority_region=""):
        self._apply_live_studio_headers()
        timestamp = get_synced_unix_seconds()
        headers = {
            "pragma": "no-cache",
            "cache-control": "no-cache",
            **_build_signature_headers(
                timestamp,
                params.get("aid", "8311"),
                params=params,
                x_ss_stub=None,
            ),
        }
        region = params.get("priority_region") or self._effective_priority_region(priority_region)
        if region:
            headers["x-tt-store-region"] = region
        return self._request_json_with_webcast_fallback("GET", url, params=params, headers=headers)

    def _signed_post_json(self, url, *, params, payload, priority_region="", timeout=20):
        self._apply_live_studio_headers()
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        x_ss_stub = _make_x_ss_stub(body)
        timestamp = get_synced_unix_seconds()
        headers = {
            "content-type": "application/json",
            "pragma": "no-cache",
            "cache-control": "no-cache",
            "x-ss-stub": x_ss_stub,
            **_build_signature_headers(
                timestamp,
                params.get("aid", "8311"),
                params=params,
                x_ss_stub=x_ss_stub,
            ),
        }
        region = params.get("priority_region") or self._effective_priority_region(priority_region)
        if region:
            headers["x-tt-store-region"] = region
        return self._request_json_with_webcast_fallback(
            "POST",
            url,
            params=params,
            data=body,
            headers=headers,
            timeout=timeout,
        )

    def _signed_post_form(self, url, *, params, data, priority_region="", timeout=20):
        self._apply_live_studio_headers()
        body = _encode_form_body(data)
        x_ss_stub = _make_x_ss_stub(body)
        timestamp = get_synced_unix_seconds()
        headers = {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "pragma": "no-cache",
            "cache-control": "no-cache",
            "x-ss-stub": x_ss_stub,
            **_build_signature_headers(
                timestamp,
                params.get("aid", "8311"),
                params=params,
                x_ss_stub=x_ss_stub,
            ),
        }
        region = params.get("priority_region") or self._effective_priority_region(priority_region)
        if region:
            headers["x-tt-store-region"] = region
        return self._request_json_with_webcast_fallback(
            "POST",
            url,
            params=params,
            data=body,
            headers=headers,
            timeout=timeout,
        )

    def _request_json(
        self,
        method,
        url,
        *,
        params=None,
        data=None,
        files=None,
        verify=True,
        timeout=None,
        headers=None,
    ):
        request_headers = dict(headers or {})
        t0_ms = attach_webcast_ntp_t0(request_headers)

        response = self.s.request(
            method=method,
            url=url,
            params=params,
            data=data,
            files=files,
            headers=request_headers,
            verify=verify,
            timeout=timeout,
        )
        update_ntp_from_response(t0_ms, response)
        _audit_webcast_request(method, url, params, request_headers, response.status_code)
        try:
            self.save_cookies()
        except Exception:
            pass

        if not (200 <= response.status_code < 300):
            text = (response.text or "").strip()
            if len(text) > 500:
                text = text[:500] + "..."
            raise WebcastError(
                f"HTTP {response.status_code} from {urllib.parse.urlsplit(url).netloc}: {text or response.reason}",
                status_code=response.status_code,
                payload=None,
                action=f"{method} {url}",
            )

        try:
            return response.json()
        except ValueError as exc:
            text = (response.text or "").strip()
            if len(text) > 500:
                text = text[:500] + "..."
            raise WebcastError(
                f"Invalid JSON from {urllib.parse.urlsplit(url).netloc}: {text or exc}",
                status_code=response.status_code,
                payload=None,
                action=f"{method} {url}",
            ) from exc

    def _request_json_with_webcast_fallback(self, method, url, **kwargs):
        candidate_urls = self._webcast_candidate_urls(
            url,
            priority_region=(kwargs.get("params") or {}).get("priority_region", ""),
        )
        last_error = None

        for index, candidate_url in enumerate(candidate_urls):
            try:
                return self._request_json(method, candidate_url, **kwargs)
            except Exception as exc:
                last_error = exc
                if index >= len(candidate_urls) - 1 or not self._is_retryable_request_error(exc):
                    raise
                continue

        if last_error:
            raise last_error
        raise RuntimeError(f"No candidate URL was available for {url}")

    def createStream(
        self,
        title,
        hashtag_id,
        game_tag_id="0",
        gen_replay=True,
        close_room_when_close_stream=False,
        age_restricted=False,
        priority_region="",
        thumbnail_path="",
        device_id="",
        install_id="",
        multi_stream_scene=False,
        multi_stream_source=1,
    ):
        base_url = self.getServerUrl()
        self._apply_live_studio_headers()

        params = self._studio_params(
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
        )

        data = {
            "title": title,
            "live_studio": "1",
            "gen_replay": str(gen_replay).lower(),
            "chat_auth": "1",
            "age_restricted": "0",
            "cover_uri": "",
            "close_room_when_close_stream": str(close_room_when_close_stream).lower(),
            "hashtag_id": str(hashtag_id),
            "game_tag_id": str(game_tag_id),
            "game_bitrate_type": "high",
            "screenshot_cover_status": "1",
            "multi_stream_scene": "1" if multi_stream_scene else "0",
            "gift_auth": "1",
            "chat_l2": "1",
            "star_comment_switch": "true",
            "multi_stream_source": str(multi_stream_source),
            "is_group_live_session": "false",
            "open_commercial_content_toggle": "false",
            "commercial_content_promote_myself": "false",
            "commercial_content_promote_third_party": "false",
            "rtc_net_enabled": "false",
        }

        if age_restricted:
            data["age_restricted"] = "4"

        if thumbnail_path:
            uri = self.uploadThumbnail(thumbnail_path, base_url, params)
            data["cover_uri"] = uri

        timestamp = get_synced_unix_seconds()
        body_encoded = _encode_form_body(data)
        x_ss_stub = _make_x_ss_stub(body_encoded)

        request_headers = {
            "x-ss-stub": x_ss_stub,
            **_build_signature_headers(
                timestamp,
                params["aid"],
                params=params,
                x_ss_stub=x_ss_stub,
            ),
        }
        if params.get("priority_region"):
            request_headers["x-tt-store-region"] = params["priority_region"]

        streamInfo = self._request_json(
            "POST",
            base_url + "webcast/room/create/",
            params=params,
            data=body_encoded,
            headers=request_headers,
        )
        self.lastCreateStreamResponse = streamInfo

        try:
            if not self._apply_room_info(streamInfo["data"], require_stream_url=True):
                raise KeyError("stream_url")
            return True
        except KeyError as exc:
            prompt = streamInfo.get("data", {}).get("prompts") or streamInfo.get("prompts")
            if not prompt:
                prompt = "Failed to create stream: " + json.dumps(streamInfo, ensure_ascii=False)[:1000]
            raise RuntimeError(prompt) from exc

    def getCreateRoomInfo(self, device_id="", install_id="", priority_region="", last_time_hashtag_id="5"):
        base_url = self.getServerUrl()
        params = self._studio_params(
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
        )
        params.update(
            {
                "last_time_hashtag_id": str(last_time_hashtag_id or "5"),
                "live_studio": "1",
            }
        )
        return self._signed_get_json(
            base_url + "webcast/room/create_info/",
            params=params,
            priority_region=params.get("priority_region", ""),
        )

    def getContinuableStreamInfo(self, device_id="", install_id="", priority_region=""):
        base_url = self.getServerUrl()
        last_payload = None
        last_reason = "No continuable stream was returned."

        for candidate_region in self._priority_region_candidates(priority_region):
            params = self._studio_params(
                device_id=device_id,
                install_id=install_id,
                priority_region=candidate_region,
            )
            payload = self._signed_get_json(
                base_url + "webcast/room/continue/",
                params=params,
                priority_region=params.get("priority_region", ""),
            )
            last_payload = payload
            data = payload.get("data", {}) if isinstance(payload, dict) else {}
            room = data.get("room") if isinstance(data, dict) else None
            if not isinstance(room, dict) or not room:
                message = (
                    payload.get("message")
                    or data.get("message") if isinstance(data, dict) else None
                )
                last_reason = message or last_reason
                continue

            self._apply_room_info(room, require_stream_url=False)
            has_ids = bool(self.roomId and self.streamId)
            has_push_url = bool(self.streamUrl)
            reason = ""
            if not has_ids:
                reason = "The continuable room did not include room_id and stream_id."
            elif not has_push_url:
                reason = "The continuable room did not include an RTMP push URL."

            return {
                "payload": payload,
                "data": data,
                "room": room,
                "has_room": True,
                "can_resume": has_ids and has_push_url,
                "reason": reason,
                "room_id": self.roomId,
                "stream_id": self.streamId,
                "stream_url": self.streamUrl,
                "priority_region": params.get("priority_region", ""),
                "continue_scene": data.get("continue_scene"),
                "cross_device_continue_scene": data.get("cross_device_continue_scene"),
                "link_mic_user_num": data.get("link_mic_user_num"),
            }

        return {
            "payload": last_payload,
            "data": {},
            "room": None,
            "has_room": False,
            "can_resume": False,
            "reason": last_reason,
            "room_id": "",
            "stream_id": "",
            "stream_url": "",
            "priority_region": "",
            "continue_scene": None,
            "cross_device_continue_scene": None,
            "link_mic_user_num": None,
        }

    def getContinuableStream(self, device_id="", install_id="", priority_region="", require_stream_url=True):
        info = self.getContinuableStreamInfo(
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
        )
        if not info.get("has_room"):
            return None
        if require_stream_url and not info.get("can_resume"):
            return None
        return info.get("room")

    def _pingAnchorStatus(
        self,
        status,
        *,
        device_id="",
        install_id="",
        priority_region="",
        room_id="",
        stream_id="",
        repeat=1,
    ):
        self._apply_live_studio_headers()
        base_url = self.getServerUrl()
        room_id = str(room_id or self.roomId or "").strip()
        stream_id = str(stream_id or self.streamId or "").strip()
        if not room_id or not stream_id:
            raise RuntimeError("Missing room_id or stream_id.")

        params = self._studio_params(
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
        )
        data = {
            "status": str(status),
            "room_id": room_id,
            "stream_id": stream_id,
        }
        body_encoded = _encode_form_body(data)
        x_ss_stub = _make_x_ss_stub(body_encoded)
        streamInfo = None
        for _ in range(max(1, int(repeat))):
            request_headers = {
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "pragma": "no-cache",
                "cache-control": "no-cache",
                "x-ss-stub": x_ss_stub,
                **_build_signature_headers(
                    get_synced_unix_seconds(),
                    params["aid"],
                    params=params,
                    x_ss_stub=x_ss_stub,
                ),
            }
            region = params.get("priority_region")
            if region:
                request_headers["x-tt-store-region"] = region

            try:
                streamInfo = self._request_json_with_webcast_fallback(
                    "POST",
                    base_url + "webcast/room/ping/anchor/",
                    params=params,
                    data=body_encoded,
                    headers=request_headers,
                    timeout=PING_ANCHOR_TIMEOUT_SECONDS,
                )
            except Exception as exc:
                if not _is_http_timeout(exc):
                    raise
                streamInfo = self._request_json_with_webcast_fallback(
                    "POST",
                    base_url + "webcast/room/ping/anchor/",
                    params=params,
                    data=body_encoded,
                    headers=request_headers,
                    timeout=PING_ANCHOR_TIMEOUT_SECONDS,
                )

            if _is_update_in_lock_payload(streamInfo):
                streamInfo = self._request_json_with_webcast_fallback(
                    "POST",
                    base_url + "webcast/room/ping/anchor/",
                    params=params,
                    data=body_encoded,
                    headers=request_headers,
                    timeout=PING_ANCHOR_TIMEOUT_SECONDS,
                )

        return streamInfo

    def anchorHeartbeat(self, status, device_id="", install_id="", priority_region="", room_id="", stream_id="", action="Anchor heartbeat"):
        streamInfo = self._pingAnchorStatus(
            status,
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
            room_id=room_id,
            stream_id=stream_id,
        )
        _raise_for_webcast_error(streamInfo, action)
        return streamInfo

    def prepareStream(self, device_id="", install_id="", priority_region="", room_id="", stream_id=""):
        # Official Live Studio starts anchor pings in prepare state.
        # It only switches to living after the backend reports RoomIsLiving or after SDK connection.
        return self.anchorHeartbeat(
            ANCHOR_STATUS_PREPARE,
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
            room_id=room_id,
            stream_id=stream_id,
            action="Prepare stream",
        )

    def pauseStream(self, device_id="", install_id="", priority_region="", room_id="", stream_id=""):
        return self.anchorHeartbeat(
            ANCHOR_STATUS_PAUSE,
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
            room_id=room_id,
            stream_id=stream_id,
            action="Pause stream",
        )

    def pausedHeartbeat(self, device_id="", install_id="", priority_region="", room_id="", stream_id=""):
        return self.anchorHeartbeat(
            ANCHOR_STATUS_PAUSE,
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
            room_id=room_id,
            stream_id=stream_id,
            action="Paused heartbeat",
        )

    def resumeStream(self, device_id="", install_id="", priority_region="", room_id="", stream_id=""):
        # Resume-existing after /continue/ behaves like Live Studio startup: start from prepare.
        if not room_id or not stream_id:
            self.getContinuableStream(device_id=device_id, install_id=install_id, priority_region=priority_region)

        return self.prepareStream(
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
            room_id=room_id,
            stream_id=stream_id,
        )

    def resumePausedStream(self, device_id="", install_id="", priority_region="", room_id="", stream_id=""):
        return self.anchorHeartbeat(
            ANCHOR_STATUS_LIVING,
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
            room_id=room_id,
            stream_id=stream_id,
            action="Resume stream",
        )

    def liveHeartbeat(self, device_id="", install_id="", priority_region="", room_id="", stream_id=""):
        return self.anchorHeartbeat(
            ANCHOR_STATUS_LIVING,
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
            room_id=room_id,
            stream_id=stream_id,
            action="Live heartbeat",
        )

    def endStream(self, device_id="", install_id="", priority_region="", room_id="", stream_id=""):
        base_url = self.getServerUrl()
        room_id = str(room_id or self.roomId or "").strip()
        stream_id = str(stream_id or self.streamId or "").strip()
        if not room_id or not stream_id:
            raise RuntimeError("Missing room_id or stream_id. Create or resume a stream before ending it.")

        params = self._studio_params(
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
        )
        # This pre-finish endpoint is advisory. Some IDCs/accounts return a raw
        # 403 for it even when the finish ping works, so do not block End Live
        # on this call.
        try:
            self._signed_get_json(
                base_url + "webcast/room/anchor_pre_finish/",
                params={**params, "room_id": room_id},
                priority_region=priority_region,
            )
        except Exception:
            pass

        streamInfo = self._pingAnchorStatus(
            ANCHOR_STATUS_FINISH,
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
            room_id=room_id,
            stream_id=stream_id,
            repeat=2,
        )

        _raise_for_webcast_error(streamInfo, "End stream")

        return True

    def getRealtimeStats(self, device_id="", install_id="", priority_region="", room_id=""):
        base_url = self.getServerUrl()
        room_id = str(room_id or self.roomId or "").strip()
        if not room_id:
            raise RuntimeError("Missing room_id. Create or resume a stream before loading realtime stats.")

        params = self._studio_params(
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
        )
        params["room_id"] = room_id

        payload = self._signed_get_json(
            base_url + "webcast/game/studio/realtime_stats/",
            params=params,
            priority_region=params.get("priority_region", ""),
        )
        _raise_for_webcast_error(payload, "Realtime stats")

        data = payload.get("data", {}) if isinstance(payload, dict) else {}
        room_stats = data.get("room_stats") or {}

        return {
            "is_live": data.get("is_live"),
            "room_id": room_stats.get("room_id") or room_id,
            "watch_count": room_stats.get("live_watch_cnt"),
            "comment_count": room_stats.get("live_comment_cnt"),
            "like_count": room_stats.get("live_like_cnt"),
            "share_count": room_stats.get("room_share_cnt"),
            "total_coin": room_stats.get("total_score"),
            "consume_user_count": room_stats.get("live_consume_ucnt"),
            "new_fans_count": room_stats.get("live_new_fans_ucnt"),
            "new_subscribers_count": room_stats.get("new_subscribers_cnt"),
            "fans_club_count": room_stats.get("fans_club_ucnt"),
            "new_fans_club_count": room_stats.get("live_new_fans_club_ucnt"),
            "raw": payload,
        }

    def getTrendsStats(self, device_id="", install_id="", priority_region="", room_id=""):
        base_url = self.getServerUrl()
        room_id = str(room_id or self.roomId or "").strip()
        if not room_id:
            raise RuntimeError("Missing room_id. Create or resume a stream before loading trends stats.")

        params = self._studio_params(
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
        )
        params["room_id"] = room_id

        payload = self._signed_get_json(
            base_url + "webcast/game/studio/trends_stats/",
            params=params,
            priority_region=params.get("priority_region", ""),
        )
        _raise_for_webcast_error(payload, "Trends stats")

        data = payload.get("data", {}) if isinstance(payload, dict) else {}
        trends = data.get("room_trends_stats") or {}

        return {
            "room_id": room_id,
            "current_viewers": trends.get("room_user_count"),
            "current_viewers_followed": trends.get("room_user_followed_count"),
            "current_viewers_trends": trends.get("current_viewers_trends"),
            "total_viewers_trends": trends.get("total_viewers_trends"),
            "raw": payload,
        }

    def _payload_data(self, payload):
        if not isinstance(payload, dict):
            return {}
        data = payload.get("data", {})
        return data if isinstance(data, dict) else {}

    def _summarize_payload(self, payload):
        if not isinstance(payload, dict):
            return "No response"

        data = payload.get("data")
        candidates = []
        if isinstance(data, dict):
            candidates.append(data)
            for key in ("record", "latest_record", "ban_record", "violation", "perception_info", "count_down", "countdown"):
                value = data.get(key)
                if isinstance(value, dict):
                    candidates.append(value)
                elif isinstance(value, list) and value:
                    candidates.append(value[0])
            for key in ("records", "record_list", "violations", "ban_records", "list"):
                value = data.get(key)
                if isinstance(value, list) and value:
                    candidates.append(value[0])
        elif isinstance(data, list) and data:
            candidates.append(data[0])

        message_keys = (
            "prompts",
            "message",
            "msg",
            "title",
            "reason",
            "violation_reason",
            "ban_reason",
            "punish_reason",
            "content",
            "text",
            "description",
            "toast",
        )
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            for key in message_keys:
                value = candidate.get(key)
                if value not in (None, "", []):
                    return str(value)[:220]

        status_code = payload.get("status_code")
        if status_code in (0, "0", None):
            return "None"
        return f"status_code={status_code}"

    def _safe_signed_get(self, endpoint, *, params, priority_region="", action="Request"):
        try:
            payload = self._signed_get_json(
                self.getServerUrl() + endpoint,
                params=params,
                priority_region=priority_region,
            )
            _raise_for_webcast_error(payload, action)
            return {"ok": True, "payload": payload, "summary": self._summarize_payload(payload), "error": ""}
        except Exception as exc:
            return {"ok": False, "payload": None, "summary": "Unavailable", "error": str(exc)}

    def getRoomInfo(self, device_id="", install_id="", priority_region="", room_id=""):
        base_url = self.getServerUrl()
        room_id = str(room_id or self.roomId or "").strip()
        if not room_id:
            raise RuntimeError("Missing room_id. Create or resume a stream before loading room info.")

        params = self._studio_params(
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
        )
        params["room_id"] = room_id

        payload = self._signed_get_json(
            base_url + "webcast/room/info/",
            params=params,
            priority_region=params.get("priority_region", ""),
        )
        _raise_for_webcast_error(payload, "Room info")

        data = payload.get("data", {}) if isinstance(payload, dict) else {}
        room = data.get("room") if isinstance(data, dict) else None
        if not isinstance(room, dict):
            room = data if isinstance(data, dict) else {}

        return {
            "room_id": room_id,
            "room": room,
            "perception_info": room.get("perception_info") or {},
            "room_auth": room.get("room_auth") or {},
            "raw": payload,
        }

    def getOnlineAudience(self, device_id="", install_id="", priority_region="", room_id="", anchor_id=""):
        base_url = self.getServerUrl()
        room_id = str(room_id or self.roomId or "").strip()
        anchor_id = str(anchor_id or getattr(self, "ownerUserId", "") or "").strip()
        if not room_id:
            raise RuntimeError("Missing room_id. Create or resume a stream before loading online audience.")

        params = self._studio_params(
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
        )
        params.update(
            {
                "room_id": room_id,
                "source": "0",
            }
        )
        if anchor_id:
            params["anchor_id"] = anchor_id

        payload = self._signed_get_json(
            base_url + "webcast/ranklist/online_audience/",
            params=params,
            priority_region=params.get("priority_region", ""),
        )
        _raise_for_webcast_error(payload, "Online audience")

        data = payload.get("data", {}) if isinstance(payload, dict) else {}
        if not isinstance(data, dict):
            data = {}

        return {
            "total": data.get("total"),
            "preview_count": data.get("preview_count"),
            "bottom_notice": data.get("bottom_notice", ""),
            "currency": data.get("currency", ""),
            "ranks": data.get("ranks") or [],
            "display_config": data.get("display_config") or {},
            "raw": payload,
        }

    def _active_eco_violation_records(self, payload):
        data = payload.get("data", {}) if isinstance(payload, dict) else {}
        if not isinstance(data, dict):
            data = {}
        records = data.get("records") or []
        now_ms = (payload.get("extra") or {}).get("now") if isinstance(payload, dict) else None
        try:
            now_seconds = int(now_ms) / 1000 if now_ms else time.time()
        except (TypeError, ValueError):
            now_seconds = time.time()

        active_records = []
        for record in records:
            if not isinstance(record, dict):
                continue
            punish = record.get("punish_info") or {}
            if not isinstance(punish, dict):
                punish = {}

            if punish.get("is_permanent_punish"):
                active_records.append(record)
                continue

            start_time = punish.get("punish_start_time") or 0
            try:
                start_time = int(start_time or 0)
            except (TypeError, ValueError):
                start_time = 0

            end_candidates = [
                punish.get("punish_end_time"),
                punish.get("punish_expected_end_time"),
                punish.get("punish_real_end_time"),
            ]
            end_times = []
            for end_time in end_candidates:
                try:
                    end_time = int(end_time or 0)
                except (TypeError, ValueError):
                    end_time = 0
                if end_time > 0:
                    end_times.append(end_time)

            # The endpoint returns history records too. Only keep punishments that are active now.
            if not end_times:
                if start_time and start_time <= now_seconds:
                    active_records.append(record)
                continue

            latest_end = max(end_times)
            if (not start_time or start_time <= now_seconds) and latest_end > now_seconds:
                active_records.append(record)

        return active_records

    def _eco_violation_id(self, record):
        punish = record.get("punish_info") or {}
        return str(
            record.get("violation_id_str")
            or record.get("violation_id")
            or punish.get("punish_record_id_str")
            or punish.get("punish_record_id")
            or punish.get("punish_id")
            or ""
        )

    def _format_epoch_seconds(self, value):
        try:
            value = int(value or 0)
        except (TypeError, ValueError):
            value = 0
        if not value:
            return ""
        try:
            return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(value))
        except Exception:
            return str(value)

    def _format_eco_violation_record(self, record):
        punish = record.get("punish_info") or {}
        live_info = record.get("live_info") or {}
        title = punish.get("punish_title") or "Violation"
        reason = punish.get("punish_reason") or punish.get("perception_code") or "Unknown reason"
        room_title = live_info.get("title") or ""
        end_time = self._format_epoch_seconds(
            punish.get("punish_end_time")
            or punish.get("punish_expected_end_time")
            or punish.get("punish_real_end_time")
        )
        parts = [str(title), str(reason)]
        if room_title:
            parts.append(f"Room: {room_title}")
        if end_time:
            parts.append(f"Until: {end_time}")
        return " | ".join(parts)

    def getEcoViolationList(self, device_id="", install_id="", priority_region="", violation_list_type=1):
        # Captured Live Studio-compatible request uses aid=8311 for this endpoint.
        # violation_list_type=0 returns active violations; type=1 returns history.
        # The response may return records even when counters are 0, so keep both
        # server counters and actual record counts for display.
        violation_list_type = int(violation_list_type)
        params = {
            "aid": "8311",
            "violation_list_type": str(violation_list_type),
        }
        if device_id:
            params["device_id"] = str(device_id)
        if install_id:
            params["iid"] = str(install_id)
        url = self.getServerUrl() + "webcast/eco/violation_list/"
        payload = self._signed_get_json(
            url,
            params=params,
            priority_region=self._effective_priority_region(priority_region),
        )
        _raise_for_webcast_error(payload, "Eco violation list")

        data = payload.get("data", {}) if isinstance(payload, dict) else {}
        if not isinstance(data, dict):
            data = {}

        records = data.get("records") or []
        if not isinstance(records, list):
            records = []

        active_records = records if violation_list_type == 0 else []
        active_ids = [
            self._eco_violation_id(record)
            for record in active_records
            if self._eco_violation_id(record)
        ]
        recent_ids = [
            self._eco_violation_id(record)
            for record in records
            if isinstance(record, dict) and self._eco_violation_id(record)
        ]
        active_summaries = [self._format_eco_violation_record(record) for record in active_records]
        recent_summaries = [self._format_eco_violation_record(record) for record in records if isinstance(record, dict)]
        _audit_violation_list(violation_list_type, data, records, active_summaries if violation_list_type == 0 else recent_summaries)

        return {
            "violation_list_type": violation_list_type,
            "server_active_count": data.get("active_count"),
            "active_count": len(active_records),
            "server_history_count": data.get("history_count"),
            "history_count": data.get("history_count"),
            "record_count": len(records),
            "recent_count": len(records),
            "is_eea": data.get("is_eea"),
            "has_more": data.get("has_more"),
            "records": records,
            "recent_records": records,
            "active_records": active_records,
            "active_ids": active_ids,
            "recent_ids": recent_ids,
            "active_summaries": active_summaries,
            "recent_summaries": recent_summaries,
            "raw": payload,
        }

    def getViolationStatus(
        self,
        device_id="",
        install_id="",
        priority_region="",
        room_id="",
        last_time_hashtag_id="5",
        include_details=True,
    ):
        room_id = str(room_id or self.roomId or "").strip()
        errors = []
        create_data = {}
        # include_details=False (app unfocused) skips create_info/room_info;
        # the violation lists below are what the safety feature needs.
        if ENABLE_SAFETY_DETAIL_POLLING and include_details:
            try:
                create_info = self.getCreateRoomInfo(
                    device_id=device_id,
                    install_id=install_id,
                    priority_region=priority_region,
                    last_time_hashtag_id=last_time_hashtag_id,
                )
                create_data = self._payload_data(create_info)
            except Exception as exc:
                errors.append(f"create_info: {exc}")

        room_info = {"room": {}, "perception_info": {}, "room_auth": {}}
        if ENABLE_SAFETY_DETAIL_POLLING and include_details and room_id:
            try:
                room_info = self.getRoomInfo(
                    device_id=device_id,
                    install_id=install_id,
                    priority_region=priority_region,
                    room_id=room_id,
                )
            except Exception as exc:
                errors.append(f"room_info: {exc}")

        active_eco_violation_list = {
            "active_records": [],
            "active_ids": [],
            "active_summaries": [],
            "active_count": 0,
            "server_active_count": None,
            "server_history_count": None,
            "history_count": None,
            "record_count": 0,
            "recent_count": 0,
            "recent_records": [],
            "recent_summaries": [],
        }
        history_eco_violation_list = {
            "active_records": [],
            "active_ids": [],
            "active_summaries": [],
            "active_count": 0,
            "server_active_count": None,
            "server_history_count": None,
            "history_count": None,
            "record_count": 0,
            "recent_count": 0,
            "recent_records": [],
            "recent_summaries": [],
        }
        try:
            active_eco_violation_list = self.getEcoViolationList(
                device_id=device_id,
                install_id=install_id,
                priority_region=priority_region,
                violation_list_type=0,
            )
        except Exception as exc:
            errors.append(f"active_eco_violation_list: {exc}")
        try:
            history_eco_violation_list = self.getEcoViolationList(
                device_id=device_id,
                install_id=install_id,
                priority_region=priority_region,
                violation_list_type=1,
            )
        except Exception as exc:
            errors.append(f"history_eco_violation_list: {exc}")

        ban_status = create_data.get("ban_status") or {}
        advanced_ban_status = create_data.get("advanced_live_ban_status") or {}
        block_status = create_data.get("block_status", 0)
        locale_restricted = bool(create_data.get("golive_locale_restricted", False))
        ban_active = bool(ban_status.get("is_ban") or advanced_ban_status.get("is_ban"))
        blocked = block_status not in (0, "0", None, "")

        room_auth = room_info.get("room_auth") or {}
        perception_info = room_info.get("perception_info") or {}
        community_flagged = bool(room_auth.get("CommunityFlagged"))
        community_review = bool(room_auth.get("CommunityFlaggedReview"))
        violations_entrance = bool(perception_info.get("show_violations_entrance"))
        violations_entrance_end_time = perception_info.get("violations_entrance_end_time")

        active_eco_records = active_eco_violation_list.get("active_records") or []
        active_eco_summaries = active_eco_violation_list.get("active_summaries") or []
        history_eco_records = history_eco_violation_list.get("recent_records") or history_eco_violation_list.get("records") or []
        active_violation_ids = set(active_eco_violation_list.get("active_ids") or [])

        if active_eco_records:
            status = "Active violation"
        elif ban_active or blocked or locale_restricted:
            status = "Restricted"
        elif community_flagged or community_review or violations_entrance:
            status = "Warning"
        else:
            status = "OK"

        return {
            "status": status,
            "ban_active": ban_active,
            "ban_summary": self._summarize_payload({"data": ban_status}) if ban_status else "None",
            "advanced_ban_active": bool(advanced_ban_status.get("is_ban")),
            "advanced_ban_summary": self._summarize_payload({"data": advanced_ban_status}) if advanced_ban_status else "None",
            "block_status": block_status,
            "locale_restricted": locale_restricted,
            "community_flagged": community_flagged,
            "community_review": community_review,
            "violations_entrance": violations_entrance,
            "violations_entrance_end_time": violations_entrance_end_time,
            "eco_violation_list": history_eco_violation_list,
            "active_eco_violation_list": active_eco_violation_list,
            "history_eco_violation_list": history_eco_violation_list,
            "active_violation_records": active_eco_records,
            "history_violation_records": history_eco_records,
            "active_violation_count": len(active_eco_records),
            "active_violation_ids": sorted(active_violation_ids),
            "active_violation_summaries": active_eco_summaries,
            "history_violation_count": (
                history_eco_violation_list.get("history_count")
                if history_eco_violation_list.get("history_count") not in (None, "")
                else active_eco_violation_list.get("history_count")
            ),
            "recent_violation_count": history_eco_violation_list.get("record_count", 0),
            "recent_violation_summaries": history_eco_violation_list.get("recent_summaries", []),
            "errors": errors,
            "raw": {
                "create_info": create_data,
                "room_info": room_info,
                "active_eco_violation_list": active_eco_violation_list,
                "history_eco_violation_list": history_eco_violation_list,
            },
        }

    def getServerUrl(self):
        return resolve_webcast_base_url(self.s)

    def getAccountInfo(self, device_id="", install_id="", priority_region="", last_time_hashtag_id="5"):
        base_url = self.getServerUrl()
        version = self.getLiveStudioLatestVersion()
        browser_version = build_live_studio_browser_version(version)
        self.s.headers.update(
            {
                "user-agent": f"Mozilla/{browser_version}",
                "accept": "application/json, text/plain, */*",
                "accept-language": "en-US",
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "sec-fetch-storage-access": "active",
                "X-SS-DP": "",
                "sdk_aid": "8311",
                "sec-ch-ua": '"Not.A/Brand";v="99", "Chromium";v="136"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
            }
        )

        verify_fp = f"verify_{device_id}" if device_id else "verify_0"
        account_params = _apply_passport_sdk_signature(
            {
                "device_id": str(device_id) if device_id else "0",
                "aid": "8311",
                "account_sdk_source": "web",
                "sdk_version": PASSPORT_WEB_SDK_VERSION,
                "verifyFp": verify_fp,
            }
        )
        account_payload = self._signed_get_json(
            build_endpoint("api.tiktokv.com", "passport/account/info/v2/", self.s),
            params=account_params,
            priority_region=priority_region,
        )
        account_data = account_payload.get("data", {}) if isinstance(account_payload, dict) else {}
        common_params = self._studio_params(
            device_id=device_id,
            install_id=install_id,
            priority_region=priority_region,
        )

        create_params = dict(common_params)
        create_params.update(
            {
                "last_time_hashtag_id": str(last_time_hashtag_id or "5"),
                "live_studio": "1",
            }
        )
        create_info = self._signed_get_json(
            base_url + "webcast/room/create_info/",
            params=create_params,
            priority_region=priority_region,
        )

        game_params = dict(common_params)
        game_params["scene"] = "2"
        game_create_info = self._signed_get_json(
            base_url + "webcast/game/basic/create_info/",
            params=game_params,
            priority_region=priority_region,
        )

        # Scene=1 is what TikTok LIVE Studio queries to decide whether the
        # dual layout button is shown at all; verified against Charles
        # captures: accounts with dual access return allow_multi_stream=true
        # here, accounts without return false.
        dual_params = dict(common_params)
        dual_params["scene"] = "1"
        dual_create_info = self._signed_get_json(
            base_url + "webcast/game/basic/create_info/",
            params=dual_params,
            priority_region=priority_region,
        )

        create_data = create_info.get("data", {}) if isinstance(create_info, dict) else {}
        game_data = game_create_info.get("data", {}) if isinstance(game_create_info, dict) else {}
        dual_data = dual_create_info.get("data", {}) if isinstance(dual_create_info, dict) else {}

        # New-user sensitive-feature restriction: dual layout stays locked
        # until the account has gone LIVE enough 25-minute sessions.
        # /webcast/anchor_tool/threshold/check/ -> {allowed, dual_canvas_used,
        # days_to_reach}. Trailing slash avoids a 301 redirect.
        threshold = {}
        try:
            threshold_payload = self._signed_get_json(
                base_url + "webcast/anchor_tool/threshold/check/",
                params=dict(common_params),
                priority_region=priority_region,
            )
            if isinstance(threshold_payload, dict):
                threshold = threshold_payload.get("data") or {}
        except Exception:
            threshold = {}

        ban_status = create_data.get("ban_status") or {}
        advanced_ban_status = create_data.get("advanced_live_ban_status") or {}
        block_status = create_data.get("block_status", 0)
        can_go_live = all(
            [
                not create_data.get("golive_locale_restricted", False),
                not ban_status.get("is_ban", False),
                not advanced_ban_status.get("is_ban", False),
                block_status in (0, "0", None),
                game_data.get("has_live_studio_login", False),
            ]
        )

        status_parts = []
        if can_go_live:
            status_parts.append("Ready")
        else:
            status_parts.append("Restricted")
        if ban_status.get("is_ban") or advanced_ban_status.get("is_ban"):
            status_parts.append("Banned")
        if block_status not in (0, "0", None):
            status_parts.append(f"Blocked {block_status}")
        if create_data.get("golive_locale_restricted"):
            status_parts.append("Locale restricted")

        return {
            "account": account_data,
            "create_info": create_data,
            "game_create_info": game_data,
            "can_go_live": can_go_live,
            "status": " / ".join(status_parts),
            "allow_multi_stream": game_data.get("allow_multi_stream", False),
            # Dual layout account-level gate (scene=1), the same signal
            # LIVE Studio uses to show/hide the dual layout button.
            "allow_multi_stream_scene1": dual_data.get("allow_multi_stream"),
            # Sensitive-feature restriction state, mirroring LIVE Studio's
            # logic: the restriction applies only when
            #   dualEnable = !allowed && !dual_canvas_used
            # so an account is unlocked when allowed OR dual_canvas_used
            # (verified live: a never-used dual-layout account returns
            # allowed=true, days_to_reach=0, dual_canvas_used=false and the
            # button is fully enabled in LIVE Studio).
            "dual_threshold": threshold,
            "dual_layout_unlocked": bool(
                dual_data.get("allow_multi_stream")
                and (threshold.get("allowed") or threshold.get("dual_canvas_used"))
            ),
            "dual_days_to_reach": threshold.get("days_to_reach"),
        }

    def uploadThumbnail(self, file_path, base_url, params):
        filename = os.path.basename(file_path)
        content_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        with open(file_path, "rb") as file_obj:
            boundary, multipart_body = _encode_multipart_form_data(
                [],
                [("image", filename, content_type, file_obj.read())],
            )

        timestamp = get_synced_unix_seconds()
        x_ss_stub = hashlib.md5(multipart_body).hexdigest()
        request_headers = {
            "content-type": f"multipart/form-data; boundary={boundary}",
            "x-ss-stub": x_ss_stub,
            **_build_signature_headers(
                timestamp,
                params.get("aid", "8311"),
                params=params,
                x_ss_stub=x_ss_stub,
            ),
            "pragma": "no-cache",
            "cache-control": "no-cache",
        }
        priority_region = params.get("priority_region")
        if params.get("priority_region"):
            request_headers["x-tt-store-region"] = params["priority_region"]

        thumbnailInfo = self._request_json(
            "POST",
            base_url + "webcast/room/upload/image/",
            params=params,
            data=multipart_body,
            headers=request_headers,
        )

        return thumbnailInfo.get("data", {}).get("uri", "")


def _build_ticket_guard_headers():
    return {
        "tt-ticket-guard-public-key": TT_TICKET_GUARD_PUBLIC_KEY,
        "tt-ticket-guard-version": TT_TICKET_GUARD_VERSION,
        "tt-ticket-guard-web-version": TT_TICKET_GUARD_WEB_VERSION,
        "tt-ticket-guard-iteration-version": TT_TICKET_GUARD_ITERATION_VERSION,
    }


def _passport_xor5_qs(keys):
    raw = ",".join(keys).encode("utf-8")
    return "".join(f"{byte ^ 5:02x}" for byte in raw)


def _passport_stringify_value(value):
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return str(value)


def _passport_sorted_string(values, limit=-1):
    """
    Python port of the Account SDK signing helper from the bundled JS.

    The SDK sorts request keys, keeps the first 10 param keys, builds
    key=value pairs without URL encoding, then signs:

        param_string + "&" + body_string + "&app_key=" + appKey

    In Live Studio's wrappers, navigation-only fields such as next/baseURL
    are passed to SDK methods but are not part of the signed Passport params.
    """
    if not isinstance(values, dict):
        return "", []

    ignored = {"sign", "qs", "isResend", "next", "baseURL", "extra_params"}
    keys = sorted(
        str(key)
        for key, value in values.items()
        if value is not None and str(key) not in ignored
    )
    if limit >= 0:
        keys = keys[:limit]

    parts = []
    for key in keys:
        parts.append(f"{key}={_passport_stringify_value(values.get(key))}")
    return "&".join(parts), keys


def _passport_sdk_signature(params, data=None, app_key=PASSPORT_APP_KEY):
    if not app_key:
        return {}

    param_string, signed_keys = _passport_sorted_string(params or {}, limit=10)
    body_string, _ = _passport_sorted_string(data or {}, limit=-1)
    base = f"{param_string}&{body_string}&app_key={app_key}"
    return {
        "sign": hashlib.md5(base.encode("utf-8")).hexdigest(),
        "qs": _passport_xor5_qs(signed_keys),
    }


def _apply_passport_sdk_signature(params, data=None):
    signed = dict(params or {})
    signed.pop("sign", None)
    signed.pop("qs", None)
    signed.update(_passport_sdk_signature(signed, data=data))
    return signed


def _random_qr_client_secret(length=8):
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _inject_qr_client_secret(qrcode_index_url, client_secret):
    if not qrcode_index_url or not client_secret:
        return qrcode_index_url

    decoded = urllib.parse.unquote(str(qrcode_index_url))
    base, separator, query = decoded.partition("?")
    if not separator:
        return qrcode_index_url

    values = urllib.parse.parse_qs(query, keep_blank_values=True)
    next_url = (values.get("next_url") or [""])[0]
    if not next_url:
        return qrcode_index_url

    joiner = "&" if "?" in next_url else "?"
    values["next_url"] = [f"{next_url}{joiner}client_secret={urllib.parse.quote(client_secret)}"]
    return base + "?" + urllib.parse.urlencode(values, doseq=True)


def _qrcode_png_base64(value):
    if not value:
        return ""
    try:
        import io
        import qrcode

        image = qrcode.make(value)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return base64.b64encode(buffer.getvalue()).decode("ascii")
    except Exception:
        return ""


def _dedupe_hosts(hosts):
    seen = set()
    out = []
    for host in hosts:
        host = str(host or "").strip()
        if host and host not in seen:
            seen.add(host)
            out.append(host)
    return out


def _build_onetap_auth_url(state, nonce, ticket):
    params = {
        "state": state,
        "nonce": nonce,
        "ticket": ticket,
        "client_id": LIVE_STUDIO_CLIENT_ID,
        "redirect_uri": LIVE_STUDIO_REDIRECT_URI,
    }
    return "https://www.tiktok.com/ucenter_web/onetap_auth?" + urlencode(params)


def _export_cookie_jar(cookie_jar):
    cookies = []
    iterable = getattr(cookie_jar, "jar", cookie_jar)

    for cookie in iterable:
        if isinstance(cookie, str):
            value = cookie_jar.get(cookie) if hasattr(cookie_jar, "get") else ""
            if value is None:
                continue
            cookies.append(
                {
                    "name": cookie,
                    "value": value,
                    "domain": "",
                    "path": "/",
                    "expires": -1,
                    "httpOnly": False,
                    "secure": False,
                }
            )
            continue

        rest = getattr(cookie, "_rest", None) or {}
        http_only = bool(rest.get("HttpOnly") or rest.get("httponly"))
        entry = {
            "name": getattr(cookie, "name", ""),
            "value": getattr(cookie, "value", ""),
            "domain": getattr(cookie, "domain", "") or "",
            "path": getattr(cookie, "path", "") or "/",
            "expires": getattr(cookie, "expires", None) if getattr(cookie, "expires", None) is not None else -1,
            "httpOnly": http_only,
            "secure": bool(getattr(cookie, "secure", False)),
        }
        same_site = rest.get("SameSite") or rest.get("samesite")
        if same_site:
            entry["sameSite"] = same_site
        if entry["name"]:
            cookies.append(entry)
    return cookies


