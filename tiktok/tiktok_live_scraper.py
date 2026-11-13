#!/usr/bin/env python3
"""
Stateless TikTok Live scraper/discovery CLI for Projecto 9x.
Uses curl_cffi TLS fingerprint impersonation without burning RapidAPI quota.
Never writes or modifies cookie files; strictly read-only.
"""

import argparse
import concurrent.futures
import json
import os
import re
import sys
from urllib.parse import quote, urlparse

from curl_cffi import requests as cffi_requests

TIKTOK_LIVE_URL = 'https://www.tiktok.com/live'
ROOM_API_URL = 'https://www.tiktok.com/api-live/user/room/'
SEARCH_API_URL = 'https://www.tiktok.com/api/search/live/full/'
QUALITY_ORDER = ('origin', 'uhd', 'hd', 'sd1', 'sd2')
FLV_QUALITY_ORDER = ('FULL_HD1', 'ORIGION', 'ORIGIN', 'HD1', 'SD1', 'SD2')
HANDLE_RE = re.compile(r'^[a-zA-Z0-9._-]{1,64}$')


def extract_handle(raw_target):
    """Extracts a normalized TikTok @handle from a handle or live URL."""
    if not raw_target or not isinstance(raw_target, str):
        return None
    text = raw_target.strip()
    if text.startswith('http://') or text.startswith('https://'):
        try:
            parsed = urlparse(text)
            host = (parsed.hostname or '').lower()
            if 'tiktok.com' not in host:
                return None
            parts = [p for p in parsed.path.split('/') if p]
            if not parts:
                return None
            if parts[0].startswith('@'):
                candidate = parts[0][1:]
            else:
                return None
        except Exception:
            return None
    else:
        candidate = text[1:] if text.startswith('@') else text

    candidate = candidate.strip()
    if not HANDLE_RE.match(candidate):
        return None
    return candidate


def load_cookies_readonly(cookie_path):
    """Loads Playwright/EditThisCookie JSON or name->value dict without mutating disk."""
    if not cookie_path or not os.path.isfile(cookie_path):
        return {}
    try:
        with open(cookie_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        return {}

    cookies = {}
    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            domain = str(item.get('domain') or '')
            if domain and 'tiktok.com' not in domain:
                continue
            name = item.get('name')
            value = item.get('value')
            if name and value is not None:
                cookies[str(name)] = str(value)
    elif isinstance(data, dict):
        for k, v in data.items():
            if k and v is not None:
                cookies[str(k)] = str(v)
    return cookies


def detect_block(status_code, text):
    """Detects CAPTCHA/verification blocks cleanly without bypassing them."""
    if status_code in (403, 429):
        return True, f'HTTP {status_code} de TikTok (rate-limit o bloqueo temporal)'
    sample = (text or '')[:1200].lower()
    if not sample:
        return False, ''
    if not sample.lstrip().startswith('{'):
        if any(tok in sample for tok in ('captcha', 'verify', 'waf', 'security check', 'slide')):
            return True, 'TikTok devolvió verificación CAPTCHA/WAF temporal'
    return False, ''


def warm_session(cookies_dict=None, timeout=10):
    """Creates a curl_cffi session warmed on /live to acquire ttwid/csrf cookies."""
    session = cffi_requests.Session(impersonate='chrome')
    session.headers.update({
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Referer': TIKTOK_LIVE_URL,
    })
    if cookies_dict:
        session.cookies.update(cookies_dict)

    try:
        resp = session.get(TIKTOK_LIVE_URL, timeout=timeout)
        blocked, reason = detect_block(resp.status_code, '')
        if blocked:
            return session, {}, reason
    except Exception:
        pass

    try:
        jar = dict(session.cookies.items())
    except Exception:
        jar = dict(cookies_dict or {})
    return session, jar, ''


def _parse_stream_data(live_room):
    """Extracts highest quality HLS/FLV pull URLs and resolution from liveRoom."""
    pull_hls = ''
    pull_flv = ''
    width = 0
    height = 0

    stream_data_obj = live_room.get('streamData') or {}
    raw_stream = (stream_data_obj.get('pull_data') or {}).get('stream_data')
    if isinstance(raw_stream, str) and raw_stream.strip():
        try:
            parsed = json.loads(raw_stream)
            qmap = parsed.get('data') or {}
            for q in QUALITY_ORDER:
                entry = (qmap.get(q) or {}).get('main') or {}
                if not entry:
                    continue
                if not pull_hls and entry.get('hls'):
                    pull_hls = entry['hls']
                if not pull_flv and entry.get('flv'):
                    pull_flv = entry['flv']
                if not width and entry.get('sdk_params'):
                    try:
                        sdk = json.loads(entry['sdk_params'])
                        res = str(sdk.get('resolution') or '')
                        if 'x' in res:
                            parts = res.lower().split('x', 1)
                            width = int(parts[0])
                            height = int(parts[1])
                    except Exception:
                        pass
                if pull_hls and pull_flv and width:
                    break
        except Exception:
            pass

    return pull_hls, pull_flv, width, height


def lookup_handle(handle_or_url, cookies_dict=None, warm_cookies=None):
    """Looks up a single TikTok user's live room status and pull URLs."""
    handle = extract_handle(handle_or_url)
    if not handle:
        return {
            'success': False,
            'handle': '',
            'is_live': False,
            'error': 'Handle o URL de TikTok inválida',
        }

    session = None
    try:
        if warm_cookies is not None:
            session = cffi_requests.Session(impersonate='chrome')
            session.headers.update({
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
                'Referer': f'https://www.tiktok.com/@{handle}/live',
            })
            merged = dict(cookies_dict or {})
            merged.update(warm_cookies)
            session.cookies.update(merged)
        else:
            session, _, warn = warm_session(cookies_dict)
            if warn:
                return {
                    'success': False,
                    'handle': handle,
                    'is_live': False,
                    'blocked': True,
                    'error': warn,
                }
            session.headers['Referer'] = f'https://www.tiktok.com/@{handle}/live'

        url = f'{ROOM_API_URL}?aid=1988&uniqueId={quote(handle)}&sourceType=54'
        resp = session.get(url, timeout=12)
        blocked, reason = detect_block(resp.status_code, resp.text)
        if blocked:
            return {
                'success': False,
                'handle': handle,
                'is_live': False,
                'blocked': True,
                'error': reason,
            }

        try:
            payload = resp.json()
        except Exception:
            return {
                'success': False,
                'handle': handle,
                'is_live': False,
                'error': f'Respuesta no JSON de TikTok (HTTP {resp.status_code})',
            }

        status_code = payload.get('statusCode')
        if status_code not in (None, 0):
            msg = payload.get('message') or f'statusCode={status_code}'
            if 'verify' in str(msg).lower() or 'captcha' in str(msg).lower():
                return {
                    'success': False,
                    'handle': handle,
                    'is_live': False,
                    'blocked': True,
                    'error': f'TikTok solicitó verificación: {msg}',
                }
            return {
                'success': False,
                'handle': handle,
                'is_live': False,
                'error': msg,
            }

        data = payload.get('data') or {}
        user = data.get('user') or {}
        live_room = data.get('liveRoom') or {}
        room_status = live_room.get('status')
        room_id = str(user.get('roomId') or live_room.get('roomId') or '')
        is_live = (room_status == 2 and bool(room_id))

        pull_hls, pull_flv, width, height = ('', '', 0, 0)
        if is_live:
            pull_hls, pull_flv, width, height = _parse_stream_data(live_room)

        stats = live_room.get('liveRoomStats') or {}
        resolved_handle = user.get('uniqueId') or handle
        return {
            'success': True,
            'handle': resolved_handle,
            'nickname': user.get('nickname') or resolved_handle,
            'avatar': user.get('avatarMedium') or user.get('avatarThumb') or '',
            'verified': bool(user.get('verified')),
            'is_live': bool(is_live),
            'status': room_status,
            'room_id': room_id,
            'title': live_room.get('title') or '',
            'viewers': int(stats.get('userCount') or 0) if is_live else 0,
            'cover': live_room.get('coverUrl') or '',
            'category': '',
            'sub_only': bool(live_room.get('liveSubOnly')),
            'width': width,
            'height': height,
            'live_url': f'https://www.tiktok.com/@{resolved_handle}/live',
            'pull_hls_url': pull_hls,
            'pull_flv_url': pull_flv,
            'blocked': False,
        }
    except Exception as exc:
        return {
            'success': False,
            'handle': handle,
            'is_live': False,
            'error': str(exc),
        }
    finally:
        if session is not None:
            try:
                session.close()
            except Exception:
                pass


def check_batch(handles_csv, cookies_dict=None):
    """Checks live status for a list of @handles using bounded concurrency."""
    raw_items = [x.strip() for x in (handles_csv or '').split(',') if x.strip()]
    seen = set()
    handles = []
    for item in raw_items:
        h = extract_handle(item)
        if h and h.lower() not in seen:
            seen.add(h.lower())
            handles.append(h)
        if len(handles) >= 60:
            break

    if not handles:
        return {'success': True, 'items': [], 'blocked': False}

    session, warm_cookies, warn = warm_session(cookies_dict)
    try:
        if warn:
            return {'success': False, 'items': [], 'blocked': True, 'error': warn}
    finally:
        try:
            session.close()
        except Exception:
            pass

    results_map = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        future_map = {
            executor.submit(lookup_handle, h, cookies_dict, warm_cookies): h
            for h in handles
        }
        for future in concurrent.futures.as_completed(future_map):
            h = future_map[future]
            try:
                results_map[h] = future.result()
            except Exception as exc:
                results_map[h] = {
                    'success': False,
                    'handle': h,
                    'is_live': False,
                    'error': str(exc),
                }

    ordered = [results_map[h] for h in handles]
    any_blocked = any(item.get('blocked') for item in ordered)
    return {
        'success': True,
        'items': ordered,
        'blocked': any_blocked,
    }


def _parse_search_item(entry):
    """Normalizes one item from /api/search/live/full/ into unified live card schema."""
    live_info = entry.get('live_info') or {}
    raw_str = live_info.get('raw_data')
    if not raw_str or not isinstance(raw_str, str):
        return None
    try:
        raw = json.loads(raw_str)
    except Exception:
        return None

    status = raw.get('status')
    if status is not None and status != 2:
        return None

    owner = raw.get('owner') or {}
    handle = (owner.get('display_id') or '').strip()
    if not handle or not HANDLE_RE.match(handle):
        return None

    avatar_urls = (owner.get('avatar_thumb') or {}).get('url_list') or []
    cover_urls = (raw.get('cover') or {}).get('url_list') or []
    hashtag = raw.get('hashtag') or {}
    stream_url = raw.get('stream_url') or {}
    flv_map = stream_url.get('flv_pull_url') or {}

    pull_flv = ''
    for q in FLV_QUALITY_ORDER:
        if flv_map.get(q):
            pull_flv = flv_map[q]
            break
    if not pull_flv and flv_map:
        for v in flv_map.values():
            if isinstance(v, str) and v:
                pull_flv = v
                break

    pull_hls = stream_url.get('hls_pull_url') or ''
    width = int(stream_url.get('stream_size_width') or 0)
    height = int(stream_url.get('stream_size_height') or 0)
    viewers = int(raw.get('user_count') or 0)

    return {
        'success': True,
        'handle': handle,
        'nickname': owner.get('nickname') or handle,
        'avatar': avatar_urls[0] if avatar_urls else '',
        'verified': False,
        'is_live': True,
        'status': 2,
        'room_id': str(raw.get('id_str') or raw.get('id') or ''),
        'title': (raw.get('title') or '').strip(),
        'viewers': viewers,
        'cover': cover_urls[0] if cover_urls else '',
        'category': (hashtag.get('title') or '').strip(),
        'sub_only': False,
        'width': width,
        'height': height,
        'live_url': f'https://www.tiktok.com/@{handle}/live',
        'pull_hls_url': pull_hls,
        'pull_flv_url': pull_flv,
        'blocked': False,
    }


def search_lives(keyword, limit=18, offset=0, min_viewers=0, cookies_dict=None):
    """Searches active TikTok Live broadcasts by keyword."""
    kw = (keyword or '').strip()
    if not kw:
        return {'success': False, 'items': [], 'blocked': False, 'error': 'Keyword vacía'}

    limit = max(1, min(int(limit or 18), 40))
    offset = max(0, int(offset or 0))
    min_viewers = max(0, int(min_viewers or 0))

    session, _, warn = warm_session(cookies_dict)
    if warn:
        try:
            session.close()
        except Exception:
            pass
        return {'success': False, 'items': [], 'blocked': True, 'error': warn}

    collected = []
    seen_handles = set()
    cur_offset = offset
    has_more = False

    try:
        for _page in range(2):
            count = min(20, max(15, limit))
            url = (
                f'{SEARCH_API_URL}?aid=1988'
                f'&keyword={quote(kw)}'
                f'&offset={cur_offset}'
                f'&count={count}'
            )
            resp = session.get(url, timeout=14)
            blocked, reason = detect_block(resp.status_code, resp.text)
            if blocked:
                return {
                    'success': False,
                    'items': collected,
                    'blocked': True,
                    'error': reason,
                }

            try:
                payload = resp.json()
            except Exception:
                return {
                    'success': False,
                    'items': collected,
                    'blocked': False,
                    'error': f'Respuesta no JSON en búsqueda (HTTP {resp.status_code})',
                }

            sc = payload.get('status_code')
            if sc not in (None, 0):
                msg = payload.get('status_msg') or f'status_code={sc}'
                is_block = sc in (2483, 10000, 10001) or any(
                    tok in str(msg).lower() for tok in ('captcha', 'verify', 'risk', 'login')
                )
                return {
                    'success': False,
                    'items': collected,
                    'blocked': is_block,
                    'error': msg,
                }

            rows = payload.get('data') or []
            for entry in rows:
                item = _parse_search_item(entry)
                if not item:
                    continue
                if item['viewers'] < min_viewers:
                    continue
                key = item['handle'].lower()
                if key in seen_handles:
                    continue
                seen_handles.add(key)
                collected.append(item)

            has_more = bool(payload.get('has_more'))
            next_cursor = int(payload.get('cursor') or 0)
            if not has_more or next_cursor <= cur_offset or len(collected) >= limit:
                break
            cur_offset = next_cursor

        collected.sort(key=lambda x: x.get('viewers', 0), reverse=True)
        return {
            'success': True,
            'keyword': kw,
            'items': collected[:limit],
            'has_more': has_more,
            'blocked': False,
        }
    except Exception as exc:
        return {
            'success': False,
            'items': collected,
            'blocked': False,
            'error': str(exc),
        }
    finally:
        try:
            session.close()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description='TikTok Live Discovery & Lookup CLI')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--lookup', help='Single @handle or TikTok live URL')
    group.add_argument('--check-batch', help='Comma-separated @handles')
    group.add_argument('--search', help='Search keyword for live broadcasts')

    parser.add_argument('--limit', type=int, default=18, help='Max results for search')
    parser.add_argument('--offset', type=int, default=0, help='Search pagination offset')
    parser.add_argument('--min-viewers', type=int, default=0, help='Minimum viewers filter')
    parser.add_argument('--cookies', default='', help='Optional read-only JSON cookie path')

    args = parser.parse_args()
    cookies = load_cookies_readonly(args.cookies)

    if args.lookup:
        result = lookup_handle(args.lookup, cookies_dict=cookies)
    elif args.check_batch:
        result = check_batch(args.check_batch, cookies_dict=cookies)
    else:
        result = search_lives(
            args.search,
            limit=args.limit,
            offset=args.offset,
            min_viewers=args.min_viewers,
            cookies_dict=cookies,
        )

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
