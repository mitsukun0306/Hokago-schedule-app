#!/usr/bin/env python3
"""Afterclass — 放課後予定共有アプリのバックエンド。

Python 標準ライブラリだけで動くサーバーです（pip install 不要）。

- REST API (JSON)
- Server-Sent Events によるリアルタイム配信（チャット・予定・通話状態）
- WebRTC 通話のシグナリング中継
- フロントエンドの静的ファイル配信

起動:  python3 server.py        → http://localhost:8000
環境変数:
  PORT / HOST             待ち受けポート・アドレス（既定 8000 / 0.0.0.0）
  AFTERCLASS_DATA         データ保存先 JSON（既定 ./data.json）
  SSL_CERT / SSL_KEY      指定すると HTTPS で起動（別端末から通話する場合に必要）
  ICE_SERVERS             WebRTC の ICE サーバー設定（JSON 配列。TURN を使う場合など）
"""

import datetime
import json
import mimetypes
import os
import queue
import re
import secrets
import select
import socket
import ssl
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.environ.get('AFTERCLASS_DATA', os.path.join(ROOT, 'data.json'))
HOST = os.environ.get('HOST', '0.0.0.0')
PORT = int(os.environ.get('PORT', '8000'))
STATIC_EXTENSIONS = {'.html', '.css', '.js', '.svg', '.png', '.ico', '.webmanifest', '.json'}
STATIC_BLOCKLIST = {os.path.realpath(DATA_FILE)}
DEFAULT_ICE_SERVERS = [{'urls': ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']}]

USER_COLORS = ['#81b9a4', '#ed806d', '#e2b33c', '#6fa8c0', '#a58bc7', '#d58aa6', '#7d9c6b', '#c98c5a']
GROUP_COLORS = ['#ed806d', '#6fa8c0', '#81b9a4', '#e2b33c', '#a58bc7', '#d58aa6']
CATEGORIES = {'study', 'play', 'club', 'food', 'other'}
RSVP_STATUSES = {'yes', 'maybe', 'no'}
REPEATS = {'none', 'daily', 'weekly', 'monthly'}
REMINDERS = {0, 5, 10, 30, 60, 1440}
MAX_MESSAGES_PER_GROUP = 500
BOOTSTRAP_MESSAGES = 200
CALL_GRACE_SECONDS = 6

DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
TIME_RE = re.compile(r'^([01]\d|2[0-3]):[0-5]\d$')


def now_ms():
    return int(time.time() * 1000)


def new_id(prefix):
    return f'{prefix}_{secrets.token_hex(6)}'


def new_invite_code():
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(8))


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# 入力チェック
# ---------------------------------------------------------------------------

def clean_text(value, field, max_len, required=False):
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise ApiError(400, f'{field}が不正です')
    value = value.strip()
    if required and not value:
        raise ApiError(400, f'{field}を入力してください')
    if len(value) > max_len:
        raise ApiError(400, f'{field}は{max_len}文字以内で入力してください')
    return value


def clean_date(value, field, required=True):
    if not value and not required:
        return ''
    if not isinstance(value, str) or not DATE_RE.match(value):
        raise ApiError(400, f'{field}の形式が不正です')
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        raise ApiError(400, f'{field}が存在しない日付です')
    return value


def clean_time(value, field):
    if not value:
        return ''
    if not isinstance(value, str) or not TIME_RE.match(value):
        raise ApiError(400, f'{field}の形式が不正です')
    return value


# ---------------------------------------------------------------------------
# データストア（JSON ファイルに永続化）
# ---------------------------------------------------------------------------

class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.data = {'users': {}, 'groups': {}, 'events': {}, 'messages': {}}
        if os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                loaded = json.load(f)
            for key in self.data:
                self.data[key] = loaded.get(key, {})

    def save(self):
        with self.lock:
            tmp = f'{self.path}.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.data, f, ensure_ascii=False)
            os.replace(tmp, self.path)

    @property
    def users(self):
        return self.data['users']

    @property
    def groups(self):
        return self.data['groups']

    @property
    def events(self):
        return self.data['events']

    @property
    def messages(self):
        return self.data['messages']

    def user_by_token(self, token):
        if not token:
            return None
        for user in self.users.values():
            if secrets.compare_digest(user['token'], token):
                return user
        return None

    def groups_of(self, uid):
        return [g for g in self.groups.values() if uid in g['members']]

    def co_member_ids(self, uid):
        ids = {uid}
        for group in self.groups_of(uid):
            ids.update(group['members'])
        return ids

    def can_see_event(self, uid, event):
        if event.get('groupId'):
            group = self.groups.get(event['groupId'])
            return bool(group and uid in group['members'])
        return event['ownerId'] == uid

    def event_audience(self, event):
        if event.get('groupId'):
            group = self.groups.get(event['groupId'])
            return set(group['members']) if group else set()
        return {event['ownerId']}


store = Store(DATA_FILE)


def public_user(user):
    return {'id': user['id'], 'name': user['name'], 'color': user['color']}


def public_group(group):
    return {key: group[key] for key in ('id', 'name', 'color', 'ownerId', 'members', 'inviteCode', 'createdAt')}


# ---------------------------------------------------------------------------
# リアルタイム配信ハブ（SSE 接続ごとにキューを持つ）
# ---------------------------------------------------------------------------

class Hub:
    def __init__(self):
        self.lock = threading.Lock()
        self.clients = {}  # clientId -> {'uid': str, 'q': Queue}

    def add(self, client_id, uid):
        q = queue.Queue()
        with self.lock:
            self.clients[client_id] = {'uid': uid, 'q': q}
        return q

    def remove(self, client_id, q):
        with self.lock:
            entry = self.clients.get(client_id)
            if entry and entry['q'] is q:
                del self.clients[client_id]
                return True
        return False

    def owner_of(self, client_id):
        with self.lock:
            entry = self.clients.get(client_id)
            return entry['uid'] if entry else None

    def to_users(self, uids, kind, payload):
        uids = set(uids)
        with self.lock:
            targets = [c['q'] for c in self.clients.values() if c['uid'] in uids]
        for q in targets:
            q.put({'type': kind, 'payload': payload})

    def to_client(self, client_id, kind, payload):
        with self.lock:
            entry = self.clients.get(client_id)
        if entry:
            entry['q'].put({'type': kind, 'payload': payload})


hub = Hub()


# ---------------------------------------------------------------------------
# 通話ルーム（メモリ上で管理）
# ---------------------------------------------------------------------------

calls_lock = threading.RLock()
calls = {}  # groupId -> {'startedAt': ms, 'participants': {clientId: {...}}}


def call_state(group_id):
    with calls_lock:
        room = calls.get(group_id)
        if not room:
            return {'groupId': group_id, 'participants': [], 'startedAt': None}
        return {
            'groupId': group_id,
            'startedAt': room['startedAt'],
            'participants': list(room['participants'].values()),
        }


def broadcast_call_state(group_id):
    group = store.groups.get(group_id)
    if group:
        hub.to_users(group['members'], 'call.state', call_state(group_id))


def leave_call(group_id, client_id):
    ended = None
    with calls_lock:
        room = calls.get(group_id)
        if not room or client_id not in room['participants']:
            return
        del room['participants'][client_id]
        if not room['participants']:
            ended = now_ms() - room['startedAt']
            del calls[group_id]
    broadcast_call_state(group_id)
    if ended is not None and group_id in store.groups:
        minutes = max(1, round(ended / 60000))
        add_message(group_id, None, f'通話が終了しました（{minutes}分）', kind='system')


def leave_all_calls(client_id):
    with calls_lock:
        group_ids = [gid for gid, room in calls.items() if client_id in room['participants']]
    for gid in group_ids:
        leave_call(gid, client_id)


# ---------------------------------------------------------------------------
# 共通処理
# ---------------------------------------------------------------------------

def add_message(group_id, uid, text, kind='text', event_id=None):
    message = {
        'id': new_id('m'),
        'groupId': group_id,
        'userId': uid,
        'kind': kind,
        'text': text,
        'eventId': event_id,
        'createdAt': now_ms(),
    }
    with store.lock:
        bucket = store.messages.setdefault(group_id, [])
        bucket.append(message)
        del bucket[:-MAX_MESSAGES_PER_GROUP]
        store.save()
        members = store.groups[group_id]['members']
    hub.to_users(members, 'message.new', {'message': message})
    return message


def broadcast_group(group):
    users = [public_user(store.users[m]) for m in group['members'] if m in store.users]
    hub.to_users(group['members'], 'group.update', {'group': public_group(group), 'users': users})


def require_member(uid, group_id):
    group = store.groups.get(group_id)
    if not group or uid not in group['members']:
        raise ApiError(404, 'グループが見つかりません')
    return group


def parse_event(body, uid):
    title = clean_text(body.get('title'), 'タイトル', 60, required=True)
    date = clean_date(body.get('date'), '日付')
    all_day = bool(body.get('allDay'))
    start = '' if all_day else clean_time(body.get('start'), '開始時刻')
    end = '' if all_day else clean_time(body.get('end'), '終了時刻')
    if not all_day and not start:
        raise ApiError(400, '開始時刻を入力するか「終日」を選んでください')
    if start and end and end <= start:
        raise ApiError(400, '終了時刻は開始時刻より後にしてください')
    category = body.get('category') if body.get('category') in CATEGORIES else 'other'
    group_id = body.get('groupId') or None
    if group_id:
        require_member(uid, group_id)
    repeat = body.get('repeat') if body.get('repeat') in REPEATS else 'none'
    repeat_until = clean_date(body.get('repeatUntil'), '繰り返しの終了日', required=False) if repeat != 'none' else ''
    if repeat_until and repeat_until < date:
        raise ApiError(400, '繰り返しの終了日は開始日より後にしてください')
    try:
        reminder = int(body.get('reminder') or 0)
    except (TypeError, ValueError):
        reminder = 0
    return {
        'title': title,
        'date': date,
        'allDay': all_day,
        'start': start,
        'end': end,
        'category': category,
        'location': clean_text(body.get('location'), '場所', 80),
        'memo': clean_text(body.get('memo'), 'メモ', 500),
        'groupId': group_id,
        'repeat': repeat,
        'repeatUntil': repeat_until,
        'reminder': reminder if reminder in REMINDERS else 0,
    }


# ---------------------------------------------------------------------------
# ルーティング
# ---------------------------------------------------------------------------

ROUTES = []


def route(method, pattern, auth=True):
    def decorator(fn):
        ROUTES.append((method, re.compile(pattern), fn, auth))
        return fn
    return decorator


@route('GET', r'/api/config', auth=False)
def get_config(h, user):
    ice = DEFAULT_ICE_SERVERS
    if os.environ.get('ICE_SERVERS'):
        try:
            ice = json.loads(os.environ['ICE_SERVERS'])
        except json.JSONDecodeError:
            pass
    return {'iceServers': ice}


@route('POST', r'/api/login', auth=False)
def login(h, user):
    body = h.read_json()
    code = body.get('code')
    if code:
        found = store.user_by_token(str(code).strip())
        if not found:
            raise ApiError(401, 'ログインコードが正しくありません')
        return {'token': found['token'], 'user': public_user(found)}
    name = clean_text(body.get('name'), 'ニックネーム', 20, required=True)
    with store.lock:
        new_user = {
            'id': new_id('u'),
            'name': name,
            'color': USER_COLORS[len(store.users) % len(USER_COLORS)],
            'token': secrets.token_urlsafe(24),
            'createdAt': now_ms(),
        }
        store.users[new_user['id']] = new_user
        store.save()
    return {'token': new_user['token'], 'user': public_user(new_user)}


@route('GET', r'/api/bootstrap')
def bootstrap(h, user):
    uid = user['id']
    with store.lock:
        groups = store.groups_of(uid)
        user_ids = store.co_member_ids(uid)
        return {
            'me': public_user(user),
            'users': [public_user(store.users[i]) for i in user_ids if i in store.users],
            'groups': [public_group(g) for g in groups],
            'events': [e for e in store.events.values() if store.can_see_event(uid, e)],
            'messages': {g['id']: store.messages.get(g['id'], [])[-BOOTSTRAP_MESSAGES:] for g in groups},
            'calls': [call_state(g['id']) for g in groups],
        }


@route('PATCH', r'/api/me')
def update_me(h, user):
    body = h.read_json()
    with store.lock:
        user['name'] = clean_text(body.get('name'), 'ニックネーム', 20, required=True)
        store.save()
        audience = store.co_member_ids(user['id'])
    hub.to_users(audience, 'user.update', {'user': public_user(user)})
    return {'user': public_user(user)}


# --- グループ -----------------------------------------------------------------

@route('POST', r'/api/groups')
def create_group(h, user):
    body = h.read_json()
    name = clean_text(body.get('name'), 'グループ名', 30, required=True)
    with store.lock:
        group = {
            'id': new_id('g'),
            'name': name,
            'color': GROUP_COLORS[len(store.groups) % len(GROUP_COLORS)],
            'ownerId': user['id'],
            'members': [user['id']],
            'inviteCode': new_invite_code(),
            'createdAt': now_ms(),
        }
        store.groups[group['id']] = group
        store.messages[group['id']] = []
        store.save()
    broadcast_group(group)
    add_message(group['id'], None, f'{user["name"]}さんがグループ「{name}」を作成しました', kind='system')
    return {'group': public_group(group)}


def group_by_code(code):
    code = (code or '').strip().upper()
    return next((g for g in store.groups.values() if g['inviteCode'] == code), None)


@route('GET', r'/api/invites/([A-Za-z0-9]{4,16})', auth=False)
def invite_preview(h, user, code):
    group = group_by_code(code)
    if not group:
        raise ApiError(404, '招待コードが見つかりません。期限切れの可能性があります')
    return {'group': {'id': group['id'], 'name': group['name'], 'color': group['color'],
                      'memberCount': len(group['members'])}}


@route('POST', r'/api/invites/([A-Za-z0-9]{4,16})/join')
def join_group(h, user, code):
    with store.lock:
        group = group_by_code(code)
        if not group:
            raise ApiError(404, '招待コードが見つかりません。期限切れの可能性があります')
        joined = user['id'] not in group['members']
        if joined:
            group['members'].append(user['id'])
            store.save()
    if joined:
        broadcast_group(group)
        add_message(group['id'], None, f'{user["name"]}さんが参加しました', kind='system')
    return {'group': public_group(group), 'joined': joined}


@route('PATCH', r'/api/groups/([\w-]+)')
def update_group(h, user, group_id):
    body = h.read_json()
    with store.lock:
        group = require_member(user['id'], group_id)
        group['name'] = clean_text(body.get('name'), 'グループ名', 30, required=True)
        store.save()
    broadcast_group(group)
    return {'group': public_group(group)}


@route('POST', r'/api/groups/([\w-]+)/invite')
def regenerate_invite(h, user, group_id):
    with store.lock:
        group = require_member(user['id'], group_id)
        group['inviteCode'] = new_invite_code()
        store.save()
    broadcast_group(group)
    return {'group': public_group(group)}


@route('POST', r'/api/groups/([\w-]+)/leave')
def leave_group(h, user, group_id):
    uid = user['id']
    with store.lock:
        group = require_member(uid, group_id)
        group['members'].remove(uid)
        removed_event_ids = []
        if not group['members']:
            del store.groups[group_id]
            store.messages.pop(group_id, None)
            removed_event_ids = [eid for eid, e in store.events.items() if e.get('groupId') == group_id]
            for eid in removed_event_ids:
                del store.events[eid]
        elif group['ownerId'] == uid:
            group['ownerId'] = group['members'][0]
        store.save()
    with calls_lock:
        room = calls.get(group_id, {'participants': {}})
        mine = [cid for cid, p in room['participants'].items() if p['userId'] == uid]
    for cid in mine:
        leave_call(group_id, cid)
    hub.to_users([uid], 'group.remove', {'groupId': group_id})
    if group_id in store.groups:
        broadcast_group(group)
        add_message(group_id, None, f'{user["name"]}さんが退出しました', kind='system')
    return {'ok': True}


def event_busy_view(event, visible):
    view = {key: event[key] for key in ('date', 'start', 'end', 'allDay', 'repeat', 'repeatUntil')}
    if visible:
        view.update({'id': event['id'], 'title': event['title']})
    return view


@route('GET', r'/api/groups/([\w-]+)/busy')
def group_busy(h, user, group_id):
    """メンバーの予定が入っている時間帯（タイトルは見られる予定だけ）"""
    with store.lock:
        group = require_member(user['id'], group_id)
        result = []
        for member_id in group['members']:
            busy = []
            for event in store.events.values():
                if event.get('groupId'):
                    other = store.groups.get(event['groupId'])
                    involved = bool(other and member_id in other['members'] and (
                        event['ownerId'] == member_id or event.get('rsvp', {}).get(member_id) == 'yes'))
                else:
                    involved = event['ownerId'] == member_id
                if involved:
                    busy.append(event_busy_view(event, store.can_see_event(user['id'], event)))
            result.append({'userId': member_id, 'busy': busy})
    return {'members': result}


# --- 予定 ---------------------------------------------------------------------

@route('POST', r'/api/events')
def create_event(h, user):
    fields = parse_event(h.read_json(), user['id'])
    with store.lock:
        event = {'id': new_id('e'), 'ownerId': user['id'], 'rsvp': {user['id']: 'yes'},
                 'createdAt': now_ms(), 'updatedAt': now_ms(), **fields}
        store.events[event['id']] = event
        store.save()
    hub.to_users(store.event_audience(event), 'event.upsert', {'event': event})
    if event['groupId']:
        add_message(event['groupId'], user['id'], f'予定「{event["title"]}」を追加しました',
                    kind='event', event_id=event['id'])
    return {'event': event}


def visible_event(uid, event_id):
    event = store.events.get(event_id)
    if not event or not store.can_see_event(uid, event):
        raise ApiError(404, '予定が見つかりません')
    return event


@route('GET', r'/api/events/([\w-]+)')
def get_event(h, user, event_id):
    return {'event': visible_event(user['id'], event_id)}


@route('PUT', r'/api/events/([\w-]+)')
def update_event(h, user, event_id):
    body = h.read_json()
    with store.lock:
        event = visible_event(user['id'], event_id)
        fields = parse_event(body, user['id'])
        if fields['groupId'] != event.get('groupId') and event['ownerId'] != user['id']:
            raise ApiError(403, '共有先を変更できるのは作成した人だけです')
        before = store.event_audience(event)
        event.update(fields)
        event['updatedAt'] = now_ms()
        store.save()
        after = store.event_audience(event)
    hub.to_users(after, 'event.upsert', {'event': event})
    hub.to_users(before - after, 'event.delete', {'id': event_id})
    return {'event': event}


@route('DELETE', r'/api/events/([\w-]+)')
def delete_event(h, user, event_id):
    with store.lock:
        event = visible_event(user['id'], event_id)
        group = store.groups.get(event.get('groupId') or '')
        if event['ownerId'] != user['id'] and not (group and group['ownerId'] == user['id']):
            raise ApiError(403, '予定を削除できるのは作成した人（またはグループ管理者）だけです')
        audience = store.event_audience(event)
        del store.events[event_id]
        store.save()
    hub.to_users(audience, 'event.delete', {'id': event_id})
    if group:
        add_message(group['id'], None, f'{user["name"]}さんが予定「{event["title"]}」を削除しました', kind='system')
    return {'ok': True}


@route('POST', r'/api/events/([\w-]+)/rsvp')
def rsvp_event(h, user, event_id):
    status = h.read_json().get('status')
    with store.lock:
        event = visible_event(user['id'], event_id)
        rsvp = event.setdefault('rsvp', {})
        if status in RSVP_STATUSES:
            rsvp[user['id']] = status
        else:
            rsvp.pop(user['id'], None)
        store.save()
    hub.to_users(store.event_audience(event), 'event.upsert', {'event': event})
    return {'event': event}


# --- チャット -------------------------------------------------------------------

@route('POST', r'/api/groups/([\w-]+)/messages')
def post_message(h, user, group_id):
    body = h.read_json()
    require_member(user['id'], group_id)
    text = clean_text(body.get('text'), 'メッセージ', 1000)
    event_id = body.get('eventId') or None
    if event_id:
        event = visible_event(user['id'], event_id)
        if event.get('groupId') != group_id:
            raise ApiError(400, 'このグループの予定だけ共有できます')
    if not text and not event_id:
        raise ApiError(400, 'メッセージを入力してください')
    return {'message': add_message(group_id, user['id'], text, kind='event' if event_id else 'text',
                                   event_id=event_id)}


@route('DELETE', r'/api/messages/([\w-]+)')
def delete_message(h, user, message_id):
    with store.lock:
        for group_id, bucket in store.messages.items():
            for message in bucket:
                if message['id'] == message_id:
                    if message['userId'] != user['id']:
                        raise ApiError(403, '自分のメッセージだけ削除できます')
                    message.update({'text': '', 'eventId': None, 'deleted': True})
                    store.save()
                    hub.to_users(store.groups[group_id]['members'], 'message.update', {'message': message})
                    return {'message': message}
    raise ApiError(404, 'メッセージが見つかりません')


# --- 通話 -----------------------------------------------------------------------

def require_own_client(user, client_id):
    if not client_id or hub.owner_of(client_id) != user['id']:
        raise ApiError(409, 'リアルタイム接続が切れています。ページを再読み込みしてください')


@route('POST', r'/api/groups/([\w-]+)/call/join')
def call_join(h, user, group_id):
    body = h.read_json()
    require_member(user['id'], group_id)
    client_id = body.get('clientId')
    require_own_client(user, client_id)
    kind = 'video' if body.get('kind') == 'video' else 'audio'
    started = False
    with calls_lock:
        room = calls.get(group_id)
        if not room:
            room = calls[group_id] = {'startedAt': now_ms(), 'participants': {}}
            started = True
        others = list(room['participants'].values())
        room['participants'][client_id] = {'clientId': client_id, 'userId': user['id'], 'kind': kind,
                                           'joinedAt': now_ms()}
        started_at = room['startedAt']
    broadcast_call_state(group_id)
    if started:
        label = 'ビデオ通話' if kind == 'video' else '音声通話'
        add_message(group_id, user['id'], f'{label}を開始しました', kind='call')
    return {'participants': others, 'startedAt': started_at}


@route('POST', r'/api/groups/([\w-]+)/call/leave')
def call_leave(h, user, group_id):
    client_id = h.read_json().get('clientId')
    with calls_lock:
        room = calls.get(group_id)
        participant = room and room['participants'].get(client_id)
        if not participant or participant['userId'] != user['id']:
            return {'ok': True}
    leave_call(group_id, client_id)
    return {'ok': True}


@route('POST', r'/api/signal')
def signal(h, user):
    body = h.read_json()
    group_id, client_id, target = body.get('groupId'), body.get('clientId'), body.get('to')
    with calls_lock:
        room = calls.get(group_id)
        me = room and room['participants'].get(client_id)
        if not me or me['userId'] != user['id'] or target not in room['participants']:
            raise ApiError(409, '通話に参加していません')
    hub.to_client(target, 'signal', {'from': client_id, 'fromUser': user['id'], 'groupId': group_id,
                                     'data': body.get('data')})
    return {'ok': True}


# --- リアルタイム配信 -----------------------------------------------------------

def client_closed(sock):
    """SSE の接続がブラウザ側から閉じられたか（ブラウザはこの接続に何も送ってこない）"""
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        if not readable:
            return False
        return sock.recv(1) == b''
    except ssl.SSLWantReadError:
        return False
    except (OSError, ValueError):
        return True


@route('GET', r'/api/stream')
def stream(h, user):
    client_id = (h.query().get('clientId') or [''])[0]
    if not re.fullmatch(r'[\w-]{8,64}', client_id):
        raise ApiError(400, 'clientId が不正です')
    h.send_response(200)
    h.send_header('Content-Type', 'text/event-stream; charset=utf-8')
    h.send_header('Cache-Control', 'no-cache, no-store')
    h.send_header('X-Accel-Buffering', 'no')
    h.end_headers()
    q = hub.add(client_id, user['id'])

    def write(payload):
        h.wfile.write(f'data: {json.dumps(payload, ensure_ascii=False)}\n\n'.encode('utf-8'))
        h.wfile.flush()

    try:
        h.wfile.write(b'retry: 2000\n\n')
        write({'type': 'hello', 'payload': {'clientId': client_id}})
        last_ping = time.time()
        while not client_closed(h.connection):
            try:
                write(q.get(timeout=1))
            except queue.Empty:
                if time.time() - last_ping > 15:
                    h.wfile.write(b': ping\n\n')
                    h.wfile.flush()
                    last_ping = time.time()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        if hub.remove(client_id, q):
            # 一瞬の切断で通話から外れないよう、少し待ってから退出させる
            def drop():
                if hub.owner_of(client_id) is None:
                    leave_all_calls(client_id)
            threading.Timer(CALL_GRACE_SECONDS, drop).start()
    return None


# ---------------------------------------------------------------------------
# HTTP ハンドラ
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = 'Afterclass/1.0'

    def log_message(self, fmt, *args):
        if '/api/stream' not in self.path:
            super().log_message(fmt, *args)

    def query(self):
        return parse_qs(urlparse(self.path).query)

    def read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > 1_000_000:
            raise ApiError(413, 'リクエストが大きすぎます')
        if not length:
            return {}
        try:
            body = json.loads(self.rfile.read(length).decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, 'JSON の形式が不正です')
        if not isinstance(body, dict):
            raise ApiError(400, 'JSON の形式が不正です')
        return body

    def send_json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def current_user(self):
        header = self.headers.get('Authorization', '')
        token = header[7:] if header.startswith('Bearer ') else ''
        return store.user_by_token(token)

    def dispatch(self, method):
        path = urlparse(self.path).path
        if not path.startswith('/api/'):
            if method in ('GET', 'HEAD'):
                return self.serve_static(path)
            return self.send_json({'error': 'Method not allowed'}, 405)
        try:
            for route_method, pattern, fn, auth in ROUTES:
                match = pattern.fullmatch(path)
                if route_method == method and match:
                    user = self.current_user()
                    if auth and not user:
                        raise ApiError(401, 'ログインしてください')
                    result = fn(self, user, *match.groups())
                    if result is not None:
                        self.send_json(result)
                    return
            raise ApiError(404, 'API が見つかりません')
        except ApiError as error:
            self.send_json({'error': error.message}, error.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self.send_json({'error': 'サーバーでエラーが発生しました'}, 500)

    def serve_static(self, path):
        relative = 'index.html' if path in ('', '/') else path.lstrip('/')
        full = os.path.realpath(os.path.join(ROOT, relative))
        ext = os.path.splitext(full)[1].lower()
        if (not full.startswith(ROOT + os.sep) or full in STATIC_BLOCKLIST or ext not in STATIC_EXTENSIONS
                or not os.path.isfile(full)):
            return self.send_json({'error': 'Not found'}, 404)
        with open(full, 'rb') as f:
            data = f.read()
        content_type = mimetypes.guess_type(full)[0] or 'application/octet-stream'
        if content_type.startswith('text/') or ext == '.js':
            content_type += '; charset=utf-8'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def do_GET(self):
        self.dispatch('GET')

    def do_HEAD(self):
        self.dispatch('HEAD')

    def do_POST(self):
        self.dispatch('POST')

    def do_PUT(self):
        self.dispatch('PUT')

    def do_PATCH(self):
        self.dispatch('PATCH')

    def do_DELETE(self):
        self.dispatch('DELETE')


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    mimetypes.add_type('text/javascript', '.js')
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    scheme = 'http'
    if os.environ.get('SSL_CERT') and os.environ.get('SSL_KEY'):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(os.environ['SSL_CERT'], os.environ['SSL_KEY'])
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = 'https'
    print(f'Afterclass を起動しました → {scheme}://localhost:{PORT}')
    lan = lan_address()
    if lan and HOST == '0.0.0.0':
        print(f'  同じネットワークの端末から → {scheme}://{lan}:{PORT}')
        if scheme == 'http':
            print('  ※ 別端末で通話（マイク・カメラ）を使うには HTTPS が必要です。README を参照してください。')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n停止しました')


if __name__ == '__main__':
    main()
