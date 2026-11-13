#!/usr/bin/env python3
"""
Stateless YouTube Live Discovery & Channel Radar CLI for Projecto 9x.
Extracts active YouTube Live broadcasts directly via curl_cffi TLS impersonation
without RapidAPI quotas or external API keys.
"""

import argparse
import concurrent.futures
import json
import re
from urllib.parse import quote_plus, urlparse

from curl_cffi import requests as cffi_requests

YT_SEARCH_URL = 'https://www.youtube.com/results'
HANDLE_RE = re.compile(r'^[a-zA-Z0-9._-]{2,64}$')
UC_RE = re.compile(r'^UC[a-zA-Z0-9_-]{22}$')
VIDEO_ID_RE = re.compile(r'^[a-zA-Z0-9_-]{11}$')


def _create_session():
    session = cffi_requests.Session(impersonate='chrome')
    session.headers.update({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
    })
    # Pre-seed standard consent cookie so EU/regional nodes return full video data directly
    session.cookies.set('SOCS', 'CAI', domain='.youtube.com')
    return session


def detect_block(status_code, final_url, html):
    """Detects CAPTCHA / rate-limit blocks cleanly without bypassing them."""
    if status_code in (403, 429):
        return True, f'YouTube devolvió HTTP {status_code} (rate-limit temporal)'
    low_url = str(final_url or '').lower()
    if '/sorry/' in low_url or 'consent.google.com' in low_url:
        return True, 'YouTube/Google solicitó verificación temporal o CAPTCHA'
    head = (html or '')[:4000].lower()
    if 'g-recaptcha' in head or 'unusual traffic' in head or 'tráfico inusual' in head:
        return True, 'YouTube detectó tráfico automatizado y devolvió CAPTCHA temporal'
    return False, ''


def extract_json_var(html, marker):
    """Extracts an embedded JSON object from YouTube HTML using JSONDecoder.raw_decode."""
    if not html:
        return None
    pattern = rf'(?:var\s+|window\[[\'"]{re.escape(marker)}[\'"]\]\s*=\s*|{re.escape(marker)}\s*=\s*)\{{'
    m = re.search(pattern, html)
    if not m:
        return None
    brace_pos = m.end() - 1
    try:
        obj, _ = json.JSONDecoder().raw_decode(html, brace_pos)
        return obj
    except Exception:
        return None


def parse_viewer_count(raw_text):
    """Parses YouTube concurrent viewer strings across EN/ES locales into an int."""
    text = str(raw_text or '').strip().lower()
    if not text:
        return 0
    m = re.search(r'(\d+(?:[.,]\d+)*)\s*(mil|k|m)?', text)
    if not m:
        return 0
    num_str, suffix = m.group(1), m.group(2) or ''
    if suffix in ('k', 'mil', 'm'):
        clean = num_str.replace(',', '.')
        try:
            val = float(clean)
        except ValueError:
            return 0
        mult = 1_000_000 if suffix == 'm' else 1_000
        return int(val * mult)

    digits = re.sub(r'[.,]', '', num_str)
    try:
        return int(digits)
    except ValueError:
        return 0


def parse_target(raw_target):
    """
    Normalizes a YouTube handle, channel ID, or URL into:
    (key, display_handle, probe_url, channel_live_url, is_direct_video)
    Returns tuple of Nones if invalid or non-YouTube URL.
    """
    if not raw_target or not isinstance(raw_target, str):
        return None, None, None, None, False
    text = raw_target.strip()
    if not text:
        return None, None, None, None, False

    if re.match(r'^https?://', text, re.I):
        try:
            parsed = urlparse(text)
            host = (parsed.hostname or '').lower()
            if host not in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'):
                return None, None, None, None, False

            if host == 'youtu.be':
                vid = parsed.path.strip('/').split('/')[0]
                if VIDEO_ID_RE.match(vid):
                    u = f'https://www.youtube.com/watch?v={vid}'
                    return vid, vid, u, u, True
                return None, None, None, None, False

            parts = [p for p in parsed.path.split('/') if p]
            if not parts:
                return None, None, None, None, False

            if parts[0] == 'watch':
                qm = re.search(r'(?:^|&)v=([a-zA-Z0-9_-]{11})', parsed.query or '')
                if qm:
                    vid = qm.group(1)
                    u = f'https://www.youtube.com/watch?v={vid}'
                    return vid, vid, u, u, True
                return None, None, None, None, False

            if parts[0] == 'live' and len(parts) >= 2 and VIDEO_ID_RE.match(parts[1]):
                vid = parts[1]
                u = f'https://www.youtube.com/watch?v={vid}'
                return vid, vid, u, u, True

            if parts[0].startswith('@'):
                h = parts[0][1:]
                if not HANDLE_RE.match(h):
                    return None, None, None, None, False
                live_u = f'https://www.youtube.com/@{h}/live'
                return f'@{h.lower()}', f'@{h}', live_u, live_u, False

            if parts[0] == 'channel' and len(parts) >= 2 and UC_RE.match(parts[1]):
                cid = parts[1]
                live_u = f'https://www.youtube.com/channel/{cid}/live'
                return cid, cid, live_u, live_u, False

            if parts[0] in ('c', 'user') and len(parts) >= 2 and HANDLE_RE.match(parts[1]):
                name = parts[1]
                live_u = f'https://www.youtube.com/{parts[0]}/{name}/live'
                return f'{parts[0]}/{name.lower()}', name, live_u, live_u, False

            return None, None, None, None, False
        except Exception:
            return None, None, None, None, False

    # Bare input: UC... channel ID or @handle / handle
    if UC_RE.match(text):
        live_u = f'https://www.youtube.com/channel/{text}/live'
        return text, text, live_u, live_u, False

    if text.lower().startswith('channel/'):
        cid = text.split('/', 1)[1].strip()
        if UC_RE.match(cid):
            live_u = f'https://www.youtube.com/channel/{cid}/live'
            return cid, cid, live_u, live_u, False

    cand = text[1:] if text.startswith('@') else text
    cand = cand.strip()
    if HANDLE_RE.match(cand):
        live_u = f'https://www.youtube.com/@{cand}/live'
        return f'@{cand.lower()}', f'@{cand}', live_u, live_u, False

    return None, None, None, None, False


def _runs_text(node):
    if not isinstance(node, dict):
        return ''
    if isinstance(node.get('simpleText'), str):
        return node['simpleText']
    runs = node.get('runs')
    if isinstance(runs, list):
        return ''.join(str(r.get('text', '')) for r in runs if isinstance(r, dict))
    return ''


def _build_channel_live_url(chan_path, fallback_author=''):
    p = (chan_path or '').strip()
    if p.startswith('/@'):
        h = p.split('/', 2)[1]
        return f'https://www.youtube.com/{h}/live', h
    if p.startswith('/channel/'):
        parts = [x for x in p.split('/') if x]
        if len(parts) >= 2:
            cid = parts[1]
            return f'https://www.youtube.com/channel/{cid}/live', cid
    if p.startswith('/c/') or p.startswith('/user/'):
        parts = [x for x in p.split('/') if x]
        if len(parts) >= 2:
            return f'https://www.youtube.com/{parts[0]}/{parts[1]}/live', parts[1]
    clean_fallback = re.sub(r'[^a-zA-Z0-9._-]', '', fallback_author or '')
    return '', f'@{clean_fallback}' if clean_fallback else ''


def _parse_video_renderer(vr):
    vid = vr.get('videoId') or ''
    if not VIDEO_ID_RE.match(vid):
        return None
    if vr.get('upcomingEventData'):
        return None

    badges = [
        (b.get('metadataBadgeRenderer') or {}).get('style', '')
        for b in (vr.get('badges') or [])
    ]
    overlay_styles = [
        (ov.get('thumbnailOverlayTimeStatusRenderer') or {}).get('style', '')
        for ov in (vr.get('thumbnailOverlays') or [])
    ]
    is_live_badge = ('BADGE_STYLE_TYPE_LIVE_NOW' in badges) or ('LIVE' in overlay_styles)
    if not is_live_badge:
        return None

    title = _runs_text(vr.get('title')).strip()
    owner_node = vr.get('ownerText') or vr.get('longBylineText') or {}
    channel_name = _runs_text(owner_node).strip()
    owner_runs = owner_node.get('runs') or []
    chan_path = ''
    if owner_runs and isinstance(owner_runs[0], dict):
        chan_path = (
            owner_runs[0]
            .get('navigationEndpoint', {})
            .get('commandMetadata', {})
            .get('webCommandMetadata', {})
            .get('url', '')
        )
    channel_live_url, handle = _build_channel_live_url(chan_path, channel_name)

    vc_text = _runs_text(vr.get('viewCountText')) or _runs_text(vr.get('shortViewCountText'))
    viewers = parse_viewer_count(vc_text)

    thumbs = (vr.get('thumbnail') or {}).get('thumbnails') or []
    cover = thumbs[-1].get('url', '') if thumbs else f'https://i.ytimg.com/vi/{vid}/hqdefault.jpg'

    chan_thumbs = (
        (vr.get('channelThumbnailSupportedRenderers') or {})
        .get('channelThumbnailWithLinkRenderer', {})
        .get('thumbnail', {})
        .get('thumbnails', [])
    )
    avatar = chan_thumbs[-1].get('url', '') if chan_thumbs else ''

    return {
        'success': True,
        'platform': 'youtube',
        'video_id': vid,
        'handle': handle or vid,
        'channel_name': channel_name or handle,
        'avatar': avatar,
        'is_live': True,
        'title': title,
        'viewers': viewers,
        'cover': cover,
        'live_url': f'https://www.youtube.com/watch?v={vid}',
        'channel_live_url': channel_live_url or f'https://www.youtube.com/watch?v={vid}',
        'blocked': False,
    }


def search_lives(keyword, limit=18, min_viewers=0):
    """Searches active YouTube Live broadcasts using sp=EgJAAQ%3D%3D filter."""
    kw = (keyword or '').strip()
    if not kw:
        return {'success': False, 'items': [], 'blocked': False, 'error': 'Keyword vacía'}

    limit = max(1, min(int(limit or 18), 40))
    min_viewers = max(0, int(min_viewers or 0))
    session = _create_session()
    try:
        # sp=EgJAAQ%3D%3D instructs YouTube search to return Live videos
        url = f'{YT_SEARCH_URL}?search_query={quote_plus(kw)}&sp=EgJAAQ%253D%253D'
        resp = session.get(url, timeout=14)
        blocked, reason = detect_block(resp.status_code, resp.url, resp.text)
        if blocked:
            return {'success': False, 'items': [], 'blocked': True, 'error': reason}

        data = extract_json_var(resp.text, 'ytInitialData')
        if not data:
            return {
                'success': False,
                'items': [],
                'blocked': False,
                'error': 'No se pudo leer la lista de transmisiones de YouTube'
            }

        renderers = []

        def collect(node):
            if isinstance(node, dict):
                if 'videoRenderer' in node and isinstance(node['videoRenderer'], dict):
                    renderers.append(node['videoRenderer'])
                for v in node.values():
                    collect(v)
            elif isinstance(node, list):
                for x in node:
                    collect(x)

        collect(data)

        items = []
        seen_vids = set()
        for vr in renderers:
            parsed = _parse_video_renderer(vr)
            if not parsed:
                continue
            if parsed['viewers'] < min_viewers:
                continue
            vid = parsed['video_id']
            if vid in seen_vids:
                continue
            seen_vids.add(vid)
            items.append(parsed)

        items.sort(key=lambda x: x.get('viewers', 0), reverse=True)
        return {
            'success': True,
            'keyword': kw,
            'items': items[:limit],
            'blocked': False,
        }
    except Exception as exc:
        return {
            'success': False,
            'items': [],
            'blocked': False,
            'error': str(exc),
        }
    finally:
        try:
            session.close()
        except Exception:
            pass


def _find_view_count_text(yt_initial_data):
    found = ''

    def walk(node):
        nonlocal found
        if found:
            return
        if isinstance(node, dict):
            vcr = node.get('videoViewCountRenderer')
            if isinstance(vcr, dict):
                txt = _runs_text(vcr.get('viewCount'))
                if txt:
                    found = txt
                    return
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for x in node:
                walk(x)

    walk(yt_initial_data)
    return found


def lookup_target(raw_target):
    """Checks live status of a single YouTube channel (@handle/channel ID/URL) or video URL."""
    key, handle, probe_url, channel_live_url, is_direct_video = parse_target(raw_target)
    if not probe_url:
        return {
            'success': False,
            'handle': '',
            'is_live': False,
            'blocked': False,
            'error': 'Canal o URL de YouTube inválido (usa @canal o enlace youtube.com)',
        }

    session = _create_session()
    try:
        resp = session.get(probe_url, timeout=14, allow_redirects=True)
        blocked, reason = detect_block(resp.status_code, resp.url, resp.text)
        if blocked:
            return {
                'success': False,
                'handle': handle,
                'is_live': False,
                'blocked': True,
                'error': reason,
            }
        if resp.status_code == 404:
            return {
                'success': False,
                'handle': handle,
                'is_live': False,
                'blocked': False,
                'error': 'Canal o video de YouTube no encontrado (404)',
            }

        pr = extract_json_var(resp.text, 'ytInitialPlayerResponse') or {}
        id_data = extract_json_var(resp.text, 'ytInitialData') or {}

        vd = pr.get('videoDetails') or {}
        live_det = (
            (pr.get('microformat') or {})
            .get('playerMicroformatRenderer', {})
            .get('liveBroadcastDetails', {})
        )
        vid = vd.get('videoId') or ''
        is_live = bool(vid and (vd.get('isLive') is True or live_det.get('isLiveNow') is True))

        meta = ((id_data.get('metadata') or {}).get('channelMetadataRenderer') or {})
        channel_name = vd.get('author') or meta.get('title') or handle

        meta_thumbs = (meta.get('avatar') or {}).get('thumbnails') or []
        avatar = meta_thumbs[-1].get('url', '') if meta_thumbs else ''

        if is_live:
            vc_text = _find_view_count_text(id_data)
            viewers = parse_viewer_count(vc_text)
            vd_thumbs = (vd.get('thumbnail') or {}).get('thumbnails') or []
            cover = vd_thumbs[-1].get('url', '') if vd_thumbs else f'https://i.ytimg.com/vi/{vid}/hqdefault.jpg'

            # Derive canonical channel handle / live url if input was a direct video watch URL
            chan_id = vd.get('channelId') or ''
            if is_direct_video and chan_id:
                vanity = meta.get('vanityChannelUrl') or ''
                if '/@' in vanity:
                    h_part = '@' + vanity.split('/@', 1)[1].split('/')[0]
                    handle = h_part
                    channel_live_url = f'https://www.youtube.com/{h_part}/live'
                else:
                    handle = chan_id
                    channel_live_url = f'https://www.youtube.com/channel/{chan_id}/live'

            return {
                'success': True,
                'platform': 'youtube',
                'key': key,
                'video_id': vid,
                'handle': handle,
                'channel_name': channel_name,
                'avatar': avatar,
                'is_live': True,
                'title': (vd.get('title') or '').strip(),
                'viewers': viewers,
                'cover': cover,
                'live_url': f'https://www.youtube.com/watch?v={vid}',
                'channel_live_url': channel_live_url,
                'blocked': False,
            }

        return {
            'success': True,
            'platform': 'youtube',
            'key': key,
            'video_id': '',
            'handle': handle,
            'channel_name': channel_name,
            'avatar': avatar,
            'is_live': False,
            'title': '',
            'viewers': 0,
            'cover': '',
            'live_url': channel_live_url,
            'channel_live_url': channel_live_url,
            'blocked': False,
        }
    except Exception as exc:
        return {
            'success': False,
            'handle': handle,
            'is_live': False,
            'blocked': False,
            'error': str(exc),
        }
    finally:
        try:
            session.close()
        except Exception:
            pass


def check_batch(targets_csv):
    """Checks multiple YouTube channels concurrently using bounded workers."""
    raw_items = [x.strip() for x in (targets_csv or '').split(',') if x.strip()]
    targets = []
    seen = set()
    for item in raw_items:
        key, handle, probe_url, _chan_live, _is_vid = parse_target(item)
        if key and key.lower() not in seen:
            seen.add(key.lower())
            targets.append((item, handle))
        if len(targets) >= 60:
            break

    if not targets:
        return {'success': True, 'items': [], 'blocked': False}

    results_map = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        future_map = {
            executor.submit(lookup_target, raw): raw
            for raw, _ in targets
        }
        for future in concurrent.futures.as_completed(future_map):
            raw = future_map[future]
            try:
                results_map[raw] = future.result()
            except Exception as exc:
                results_map[raw] = {
                    'success': False,
                    'handle': raw,
                    'is_live': False,
                    'error': str(exc),
                }

    ordered = [results_map[raw] for raw, _ in targets]
    any_blocked = any(item.get('blocked') for item in ordered)
    return {
        'success': True,
        'items': ordered,
        'blocked': any_blocked,
    }


def main():
    parser = argparse.ArgumentParser(description='YouTube Live Discovery & Radar CLI')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--search', help='Search keyword for active YouTube Live broadcasts')
    group.add_argument('--lookup', help='Single YouTube @channel, channel ID, or URL')
    group.add_argument('--check-batch', help='Comma-separated list of YouTube channels')

    parser.add_argument('--limit', type=int, default=18, help='Max results for search')
    parser.add_argument('--min-viewers', type=int, default=0, help='Minimum viewers filter')

    args = parser.parse_args()
    if args.search:
        result = search_lives(args.search, limit=args.limit, min_viewers=args.min_viewers)
    elif args.lookup:
        result = lookup_target(args.lookup)
    else:
        result = check_batch(args.check_batch)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
