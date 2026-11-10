"""BaatRoom: one public room, temporary guests, one process.

Local: python app.py. Production: gunicorn -c gunicorn.conf.py app:app.
Owner commands: python app.py owner --help. No visitor accounts.
"""

import argparse
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import unicodedata
from collections import OrderedDict, deque
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, session
from flask_socketio import SocketIO, join_room
from werkzeug.middleware.proxy_fix import ProxyFix


# Configuration ---------------------------------------------------------------
BASE = Path(__file__).resolve().parent
load_dotenv(BASE / ".env")


def setting(name, default, minimum, maximum):
    value = int(os.getenv(name, str(default)))
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}.")
    return value


PRODUCTION = os.getenv("APP_ENV", "development").lower() == "production"
APP_NAME = os.getenv("APP_NAME", "BaatRoom").strip()[:40] or "BaatRoom"
PUBLIC_URL = os.getenv("PUBLIC_URL", "").strip().rstrip("/")
SECRET_KEY = os.getenv("SECRET_KEY", "").strip()
OWNER_SECRET = os.getenv("OWNER_SECRET", "").strip()
if PUBLIC_URL:
    parsed_url = urlsplit(PUBLIC_URL)
    if (parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc
            or parsed_url.path or parsed_url.query or parsed_url.fragment
            or parsed_url.username or parsed_url.password):
        raise RuntimeError("PUBLIC_URL must be an origin, e.g. https://chat.example.com")
if PRODUCTION and (len(SECRET_KEY) < 32 or len(OWNER_SECRET) < 32
                   or not PUBLIC_URL.startswith("https://")):
    raise RuntimeError("Production needs distinct 32+ character SECRET_KEY and OWNER_SECRET, and an HTTPS PUBLIC_URL.")
if SECRET_KEY and SECRET_KEY == OWNER_SECRET:
    raise RuntimeError("SECRET_KEY and OWNER_SECRET must be different.")

HISTORY_LIMIT = setting("HISTORY_LIMIT", 100, 1, 100)
MESSAGE_TTL = setting("MESSAGE_TTL_SECONDS", 3600, 5, 3600)
MAX_GUESTS = setting("MAX_GUESTS", 50, 2, 200)
MAX_CONNECTIONS = setting("MAX_CONNECTIONS", 80, 2, 400)
PER_GUEST_CONNECTIONS = setting("MAX_CONNECTIONS_PER_GUEST", 4, 1, 8)
MAX_GUEST_RECORDS = setting("MAX_GUEST_RECORDS", 1000, MAX_GUESTS, 5000)
MAX_REPORTS = setting("MAX_REPORTS", 1000, 10, 10000)
REPORT_TTL = 24 * 60 * 60
GUEST_TTL = 3600
DEDUP_LIMIT = 600
ROOM = "everyone"
SERVER_INSTANCE = secrets.token_hex(12)
REASONS = {"spam", "harassment", "inappropriate", "personal_information", "other"}
INSTANCE = Path(os.getenv("DATA_DIR", str(BASE / "instance"))).resolve()
INSTANCE.mkdir(parents=True, exist_ok=True)
REPORT_DB = INSTANCE / "reports.sqlite3"

app = Flask(__name__)
app.wsgi_app= ProxyFix(app.wsgi_app,x_host=1)
app.config.update(
    SECRET_KEY=SECRET_KEY or secrets.token_hex(32),
    DEBUG=False,
    TESTING=False,
    SESSION_COOKIE_NAME="baatroom_guest",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=PRODUCTION or os.getenv("COOKIE_SECURE", "false").lower() == "true",
    MAX_CONTENT_LENGTH=8192,
    MAX_FORM_MEMORY_SIZE=8192,
)
allowed_hosts = os.getenv("ALLOWED_HOSTS", "").strip()
app.config["TRUSTED_HOSTS"] = ([s.strip() for s in allowed_hosts.split(",") if s.strip()]
                               if allowed_hosts else
                               [urlsplit(PUBLIC_URL).hostname] if PUBLIC_URL else
                               ["localhost", "127.0.0.1", "[::1]"])

# Engine.IO also validates Origin. Socket connect additionally requires CSRF.
socketio = SocketIO(
    app, async_mode="threading", async_handlers=False,
    cors_allowed_origins=[PUBLIC_URL] if PUBLIC_URL else None,
    max_http_buffer_size=16384, ping_interval=20, ping_timeout=25,
    logger=False, engineio_logger=False, cookie=None,
)
proxy_count = setting("TRUST_PROXY_COUNT", 0, 0, 2)
if proxy_count:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=proxy_count, x_proto=proxy_count,
                          x_host=proxy_count, x_port=proxy_count)

# Keep request URLs, chat bodies, auth headers and cookie values out of app logs.
logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
logging.getLogger("werkzeug").disabled = True
logging.getLogger("engineio").setLevel(logging.CRITICAL)
logging.getLogger("socketio").setLevel(logging.CRITICAL)


# All shared state and Socket.IO emits are serialized with this lock. Never add
# a second process/replica without replacing this in-memory design.
lock = threading.RLock()
guests = {}
connections = {}                         # socket id -> guest id
history = OrderedDict()                  # server id -> unexpired message
limits = OrderedDict()                   # bounded, short-lived rate windows
report_receipts = OrderedDict()          # (reporting guest, message) -> time
revision = 0
presence_revision = 0
limiter_salt = secrets.token_bytes(32)     # discarded on restart; no IP database
janitor_started = False


def now():
    return time.time()


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def failure(code, message):
    return {"ok": False, "code": code, "error": message}


def ip_reference():
    return hmac.new(limiter_salt, (request.remote_addr or "unknown").encode(), hashlib.sha256).hexdigest()[:24]


def allow(key, count, seconds):
    """Call under lock. Refuse new buckets at capacity instead of evicting limits."""
    t = now()
    entry = limits.get(key)
    if entry is None:
        if len(limits) >= 4000:
            return False
        entry = {"times": deque(), "last": t, "window": seconds}
        limits[key] = entry
    times = entry["times"]
    while times and times[0] <= t - seconds:
        times.popleft()
    entry["last"] = t
    if len(times) >= count:
        return False
    times.append(t)
    return True


def valid_origin(required=True):
    origin = request.headers.get("Origin")
    expected = PUBLIC_URL or request.host_url.rstrip("/")
    return (origin == expected) if origin else not required


def csrf_valid():
    token = request.headers.get("X-CSRF-Token", "")
    expected = session.get("csrf", "")
    return bool(expected and isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", token)
                and hmac.compare_digest(token, expected) and valid_origin())


def payload(keys):
    value = request.get_json(silent=True)
    return value if isinstance(value, dict) and set(value).issubset(keys) else None


def clean_text(value, minimum, maximum, nickname=False):
    if not isinstance(value, str) or len(value) > maximum * 3:
        return None
    value = unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n")).strip()
    if not minimum <= len(value) <= maximum:
        return None
    for char in value:
        category = unicodedata.category(char)
        if category.startswith("C") and char not in {"\n", "\t", "\u200c", "\u200d"}:
            return None
    if nickname:
        if any(c in value for c in "\n\t<>"):
            return None
        value = " ".join(value.split())
        if len(value) < minimum:
            return None
    return value


def public_guest(guest):
    return {"id": guest["id"], "nickname": guest["nickname"], "suffix": guest["suffix"],
            "display_name": f'{guest["nickname"]} #{guest["suffix"]}'}


def cookie_guest():
    guest = guests.get(session.get("guest_id"))
    if guest and (guest["connections"] or guest["last_seen"] > now() - GUEST_TTL
                  or guest["restricted_until"] > now()):
        return guest
    return None


def socket_guest():
    guest = guests.get(connections.get(request.sid))
    if not guest or session.get("guest_id") != guest["id"] or request.sid not in guest["connections"]:
        return None
    if guest["restricted_until"] > now():
        return None
    if not allow(("events", guest["id"]), 100, 10):
        return None
    guest["last_seen"] = now()
    return guest


def presence():
    people = sorted((public_guest(g) for g in guests.values() if g["connections"]),
                    key=lambda g: (g["nickname"].casefold(), g["suffix"]))
    return {"count": len(people), "participants": people, "revision": presence_revision}


def broadcast_presence():
    global presence_revision
    presence_revision += 1
    socketio.emit("presence", presence(), to=ROOM)


def notice(guest, action):
    # A refresh should not fill the room with system notices.
    t = now()
    if action == "joined" and t - guest["last_notice"] < 10:
        return
    if action == "joined":
        guest["last_notice"] = t
    socketio.emit("notice", {"id": secrets.token_hex(8), "guest": public_guest(guest),
                             "action": action, "timestamp": iso(t), "expires_at": t + 60}, to=ROOM)


def remove_messages(ids, reason):
    global revision
    removed = [message_id for message_id in ids if history.pop(message_id, None) is not None]
    if removed:
        revision += 1
        socketio.emit("messages_removed", {"ids": removed, "reason": reason, "revision": revision}, to=ROOM)
    return removed


def prune_history():
    remove_messages([key for key, msg in history.items() if msg["expires_at"] <= now()], "expired")


def typing_state():
    return [{**public_guest(g), "expires_at": g["typing_until"]} for g in guests.values()
            if g["connections"] and g["typing_until"] > now()]


def broadcast_typing():
    socketio.emit("typing", {"guests": typing_state()}, to=ROOM)


def snapshot(guest):
    prune_history()
    return {"ok": True, "self": public_guest(guest), "messages": list(history.values()),
            "revision": revision, "presence": presence(), "typing": typing_state(),
            "server_time": now(), "server_instance": SERVER_INSTANCE,
            "muted_until": guest["muted_until"], "message_ttl": MESSAGE_TTL}


# Only reports are persistent. secure_delete also overwrites deleted SQLite cells.
@contextmanager
def database():
    db = sqlite3.connect(REPORT_DB, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA secure_delete=ON")
    try:
        with db:
            yield db
    finally:
        db.close()


with database() as db:
    db.execute("""CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, guest_ref TEXT NOT NULL,
        message TEXT NOT NULL, reason TEXT NOT NULL, created_at REAL NOT NULL)""")
    db.execute("CREATE INDEX IF NOT EXISTS reports_expiry ON reports(created_at)")
    db.execute("DELETE FROM reports WHERE created_at <= ?", (now() - REPORT_TTL,))


def cleanup_loop():
    last_db_cleanup = 0
    while True:
        socketio.sleep(1)
        try:
            with lock:
                t = now()
                prune_history()
                changed = False
                for guest in list(guests.values()):
                    if guest["typing_until"] and guest["typing_until"] <= t:
                        guest["typing_until"] = 0
                        changed = True
                    for key in list(guest["receipts"]):
                        if guest["receipts"][key]["expires_at"] <= t:
                            del guest["receipts"][key]
                    if (not guest["connections"] and guest["last_seen"] < t - GUEST_TTL
                            and guest["restricted_until"] <= t and guest["muted_until"] <= t):
                        guests.pop(guest["id"], None)
                if changed:
                    broadcast_typing()
                for key in list(limits):
                    if limits[key]["last"] < t - max(60, limits[key]["window"]):
                        del limits[key]
                for key in list(report_receipts):
                    if report_receipts[key] < t - 3600:
                        del report_receipts[key]
                if t - last_db_cleanup >= 30:
                    with database() as db:
                        db.execute("DELETE FROM reports WHERE created_at <= ?", (t - REPORT_TTL,))
                    last_db_cleanup = t
        except Exception:
            # A fixed message deliberately excludes exception text and payloads.
            app.logger.error("Temporary-state cleanup failed; will retry.")


def ensure_janitor():
    global janitor_started
    with lock:
        if not janitor_started:
            janitor_started = True
            socketio.start_background_task(cleanup_loop)


# HTTP: the chat opens directly; no visitor login or registration routes. --------
@app.before_request
def prepare_request():
    ensure_janitor()
    if request.path.startswith("/api/") and request.content_length and request.content_length > 8192:
        return jsonify(failure("too_large", "This request is too large.")), 413


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; "
        "form-action 'self'; frame-ancestors 'none'")
    if PRODUCTION:
        response.headers["Strict-Transport-Security"] = "max-age=31536000"
    if request.path == "/" or request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def chat():
    share_url = PUBLIC_URL + "/" if PUBLIC_URL else request.url_root
    return render_template("chat.html", app_name=APP_NAME, share_url=share_url)


@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.get("/api/bootstrap")
def bootstrap():
    with lock:
        session.setdefault("csrf", secrets.token_urlsafe(32))
        session.setdefault("browser_ref", secrets.token_hex(16))
        guest = cookie_guest()
        restricted = guest and guest["restricted_until"] > now()
        return {"ok": True, "csrf": session["csrf"],
                "guest": public_guest(guest) if guest and not restricted else None,
                "restriction_until": guest["restricted_until"] if restricted else 0,
                "share_url": PUBLIC_URL + "/" if PUBLIC_URL else request.url_root,
                "message_ttl": MESSAGE_TTL, "history_limit": HISTORY_LIMIT}


@app.post("/api/join")
def join():
    if not csrf_valid():
        return jsonify(failure("csrf", "Refresh this page and try again.")), 403
    data = payload({"nickname"})
    nickname = clean_text(data.get("nickname") if data else None, 2, 24, nickname=True)
    if nickname is None:
        return jsonify(failure("nickname", "Choose a nickname with 2–24 characters and no control characters.")), 400
    with lock:
        if not allow(("join", session.get("browser_ref")), 5, 60) or not allow(("join_ip", ip_reference()), 30, 60):
            return jsonify(failure("rate_limit", "Too many join attempts. Please wait a minute.")), 429
        guest = cookie_guest()
        if guest and guest["restricted_until"] > now():
            return jsonify(failure("restricted", "This guest session is temporarily disconnected by the room owner.")), 403
        if guest is None:
            if len(guests) >= MAX_GUEST_RECORDS or presence()["count"] >= MAX_GUESTS:
                return jsonify(failure("capacity", "The room is full right now. Please try again shortly.")), 503
            used = {g["suffix"] for g in guests.values()}
            gid = secrets.token_hex(16)
            while gid[:4] in used:
                gid = secrets.token_hex(16)
            guest = {"id": gid, "nickname": nickname, "suffix": gid[:4], "connections": set(),
                     "last_seen": now(), "last_notice": 0, "typing_until": 0,
                     "muted_until": 0, "restricted_until": 0,
                     "receipts": OrderedDict(), "recent_texts": deque(maxlen=8)}
            guests[gid] = guest
            session["guest_id"] = gid
        return {"ok": True, "guest": public_guest(guest)}


def end_guest(guest, reason, restriction=0):
    guest["restricted_until"] = max(guest["restricted_until"], now() + restriction if restriction else 0)
    guest["typing_until"] = 0
    for sid in list(guest["connections"]):
        socketio.emit("session_ended", {"reason": reason, "until": guest["restricted_until"]}, to=sid)
        socketio.server.disconnect(sid, namespace="/")


@app.post("/api/leave")
def leave():
    if not csrf_valid():
        return jsonify(failure("csrf", "Refresh this page and try again.")), 403
    with lock:
        guest = cookie_guest()
        if guest:
            end_guest(guest, "You left the room.")
            # Keep a restriction if a delayed Leave request follows a moderation action.
            if guest["restricted_until"] <= now():
                guests.pop(guest["id"], None)
                session.pop("guest_id", None)
        return {"ok": True}


# Socket events: cookie identity + CSRF, never a client-supplied sender. -----------
@socketio.on("connect")
def connect(auth):
    ensure_janitor()
    with lock:
        # Same-origin polling GETs may omit Origin. The unguessable CSRF token
        # is still required, and Engine.IO rejects any mismatched Origin.
        if not isinstance(auth, dict) or set(auth) != {"csrf"} or not valid_origin(required=False):
            return False
        token = auth.get("csrf")
        if (not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token)
                or not session.get("csrf") or not hmac.compare_digest(token, session["csrf"])):
            return False
        guest = cookie_guest()
        if guest is None or guest["restricted_until"] > now():
            return False
        if not allow(("connect", guest["id"]), 20, 60) or not allow(("connect_ip", ip_reference()), 120, 60):
            return False
        if (len(connections) >= MAX_CONNECTIONS or len(guest["connections"]) >= PER_GUEST_CONNECTIONS
                or (not guest["connections"] and presence()["count"] >= MAX_GUESTS)):
            return False
        first = not guest["connections"]
        guest["connections"].add(request.sid)
        guest["last_seen"] = now()
        connections[request.sid] = guest["id"]
        join_room(ROOM)
        broadcast_presence()
        socketio.emit("snapshot", snapshot(guest), to=request.sid)
        if first:
            notice(guest, "joined")


@socketio.on("disconnect")
def disconnect(reason=None):
    with lock:
        guest = guests.get(connections.pop(request.sid, None))
        if guest:
            guest["connections"].discard(request.sid)
            guest["last_seen"] = now()
            if not guest["connections"]:
                guest["typing_until"] = 0
                notice(guest, "left")
                broadcast_typing()
            broadcast_presence()


@socketio.on("sync")
def sync(data=None):
    with lock:
        guest = socket_guest()
        if guest is None:
            return failure("session", "Join the room again.")
        if data not in (None, {}) or not allow(("sync", guest["id"]), 12, 60):
            return failure("rate_limit", "Please wait before refreshing the room again.")
        return snapshot(guest)


@socketio.on("send_message")
def send_message(data):
    global revision
    with lock:
        guest = socket_guest()
        if guest is None:
            return failure("session", "Join the room again.")
        if not isinstance(data, dict) or set(data) != {"text", "client_id"}:
            return failure("invalid", "Invalid message request.")
        text = clean_text(data["text"], 1, 1000)
        cid = data["client_id"]
        if text is None or not isinstance(cid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,64}", cid):
            return failure("invalid", "Messages must contain 1–1,000 characters and no unsafe control characters.")
        prune_history()
        fingerprint = hashlib.sha256(text.encode()).hexdigest()
        previous = guest["receipts"].get(cid)
        if previous and previous["expires_at"] > now():
            if fingerprint != previous["hash"]:
                return failure("conflict", "This retry identifier belongs to a different message.")
            return {"ok": True, "duplicate": True, "id": previous["id"], "message": history.get(previous["id"])}
        if guest["muted_until"] > now():
            return {**failure("muted", "The room owner has temporarily muted this guest session."),
                    "muted_until": guest["muted_until"]}
        if len(guest["receipts"]) >= DEDUP_LIMIT:
            return failure("quota", "This guest session has reached its hourly message limit.")
        if not allow(("messages_fast", guest["id"]), 8, 10) or not allow(("messages_minute", guest["id"]), 45, 60):
            return failure("rate_limit", "A little too fast. Wait a few seconds and try again.")
        if any(hash_value == fingerprint and timestamp > now() - 20 for hash_value, timestamp in guest["recent_texts"]):
            return failure("duplicate_text", "You just sent that message. Give the room a moment.")
        t = now()
        message = {"id": secrets.token_hex(16), "client_id": cid, "guest_id": guest["id"],
                   "nickname": guest["nickname"], "suffix": guest["suffix"], "text": text,
                   "timestamp": iso(t), "created_at": t, "expires_at": t + MESSAGE_TTL}
        history[message["id"]] = message
        guest["receipts"][cid] = {"id": message["id"], "hash": fingerprint, "expires_at": message["expires_at"]}
        guest["recent_texts"].append((fingerprint, t))
        guest["typing_until"] = 0
        # Evict before broadcast; everyone receives the same bounded timeline.
        if len(history) > HISTORY_LIMIT:
            remove_messages(list(history)[:len(history) - HISTORY_LIMIT], "capacity")
        revision += 1
        socketio.emit("message", {"message": message, "revision": revision}, to=ROOM)
        broadcast_typing()
        return {"ok": True, "id": message["id"], "message": message}


@socketio.on("typing")
def typing(data):
    with lock:
        guest = socket_guest()
        if guest is None:
            return failure("session", "Join the room again.")
        if not isinstance(data, dict) or set(data) != {"active"} or type(data["active"]) is not bool:
            return failure("invalid", "Invalid typing event.")
        if not allow(("typing", guest["id"]), 4, 5):
            return failure("rate_limit", "Typing updates paused briefly.")
        guest["typing_until"] = now() + 5 if data["active"] and guest["muted_until"] <= now() else 0
        broadcast_typing()
        return {"ok": True}


@socketio.on("report_message")
def report_message(data):
    with lock:
        guest = socket_guest()
        if guest is None:
            return failure("session", "Join the room again.")
        if (not isinstance(data, dict) or set(data) != {"message_id", "reason"}
                or not isinstance(data["message_id"], str) or len(data["message_id"]) != 32
                or not isinstance(data["reason"], str) or data["reason"] not in REASONS):
            return failure("invalid", "Choose one of the report reasons.")
        key = (guest["id"], data["message_id"])
        if key in report_receipts:
            return {"ok": True, "received": True, "already_reported": True}
        if not allow(("reports", guest["id"]), 5, 60) or len(report_receipts) >= 2000:
            return failure("rate_limit", "Please wait before sending another report.")
        prune_history()
        message = history.get(data["message_id"])
        if message is None:
            return failure("expired", "This message is no longer available to report.")
        try:
            with database() as db:
                db.execute("DELETE FROM reports WHERE created_at <= ?", (now() - REPORT_TTL,))
                if db.execute("SELECT COUNT(*) FROM reports").fetchone()[0] >= MAX_REPORTS:
                    return failure("capacity", "The report inbox is full. Try again later.")
                db.execute("INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?)",
                           (secrets.token_hex(12), message["id"], message["guest_id"],
                            json.dumps(message, ensure_ascii=False), data["reason"], now()))
        except sqlite3.Error:
            return failure("storage", "The report was not saved. Please try again.")
        report_receipts[key] = now()
        return {"ok": True, "received": True}


@socketio.on_error_default
def socket_error(error):
    app.logger.error("A socket event could not be processed.")
    return failure("server", "The request could not be confirmed. Please try again.")


# Owner-only HTTP API. Bearer authentication, never a URL token or public UI. ----
@app.before_request
def protect_owner():
    if not request.path.startswith("/api/owner/"):
        return None
    with lock:
        if not allow(("owner", ip_reference()), 60, 60):
            return jsonify(failure("rate_limit", "Too many owner requests.")), 429
        supplied = request.headers.get("Authorization", "")
        if (not OWNER_SECRET or len(supplied) > 512
                or not hmac.compare_digest(supplied.encode("utf-8", "surrogatepass"), ("Bearer " + OWNER_SECRET).encode("utf-8"))
                or not valid_origin(required=False)):
            return jsonify(failure("unauthorized", "Owner authorization required.")), 401


@app.get("/api/owner/reports")
def owner_reports():
    try:
        offset = int(request.args.get("offset", "0"))
    except ValueError:
        return jsonify(failure("invalid", "offset must be a nonnegative integer.")), 400
    if not 0 <= offset <= MAX_REPORTS:
        return jsonify(failure("invalid", "offset is outside the report inbox.")), 400
    with lock, database() as db:
        db.execute("DELETE FROM reports WHERE created_at <= ?", (now() - REPORT_TTL,))
        total = db.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
        rows = db.execute("SELECT * FROM reports ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET ?", (offset,)).fetchall()
        return {"ok": True, "total": total, "next_offset": offset + 100 if offset + 100 < total else None,
                "reports": [dict(r) | {"message": json.loads(r["message"])} for r in rows]}


@app.post("/api/owner/remove")
def owner_remove():
    data = payload({"message_id"})
    mid = data.get("message_id") if data else None
    if not isinstance(mid, str) or not re.fullmatch(r"[0-9a-f]{32}", mid):
        return jsonify(failure("invalid", "A valid message_id is required.")), 400
    with lock:
        removed = remove_messages([mid], "moderation")
        return {"ok": True, "removed": bool(removed)}


@app.post("/api/owner/restrict")
def owner_restrict():
    data = payload({"guest_ref", "action", "minutes"})
    if (not data or not isinstance(data.get("guest_ref"), str)
            or not isinstance(data.get("action"), str) or data["action"] not in {"mute", "disconnect"}
            or type(data.get("minutes")) is not int or not 1 <= data["minutes"] <= 60):
        return jsonify(failure("invalid", "Use a guest_ref, mute/disconnect, and minutes (1–60).")), 400
    with lock:
        guest = guests.get(data["guest_ref"])
        if guest is None:
            return jsonify(failure("missing", "That temporary guest is no longer known to this server.")), 404
        if data["action"] == "mute":
            guest["muted_until"] = now() + data["minutes"] * 60
            guest["typing_until"] = 0
            for sid in guest["connections"]:
                socketio.emit("muted", {"until": guest["muted_until"]}, to=sid)
            broadcast_typing()
        else:
            end_guest(guest, "The room owner temporarily disconnected this guest session.", data["minutes"] * 60)
        return {"ok": True, "action": data["action"], "minutes": data["minutes"]}


@app.errorhandler(413)
def too_large(error):
    return jsonify(failure("too_large", "This request is too large.")), 413


def owner_cli():
    """Talk to the RUNNING server, so moderation changes its live memory."""
    parser = argparse.ArgumentParser(description="Owner commands. Reads OWNER_SECRET from your .env; never paste it into a link.")
    parser.add_argument("command", choices=["reports", "remove", "mute", "disconnect"])
    parser.add_argument("reference", nargs="?", help="Message id for remove; guest_ref from reports for mute/disconnect")
    parser.add_argument("--minutes", type=int, default=10)
    parser.add_argument("--offset", type=int, default=0, help="Reports: page offset (0, 100, 200, ...)")
    parser.add_argument("--url", default=os.getenv("OWNER_API_URL") or PUBLIC_URL or "http://127.0.0.1:5000")
    args = parser.parse_args(sys.argv[2:])
    parsed = urlsplit(args.url)
    if (parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path not in {"", "/"}
            or parsed.query or parsed.fragment or parsed.username or parsed.password
            or (parsed.scheme != "https" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"})):
        parser.error("Use an HTTPS origin, or localhost HTTP.")
    if not OWNER_SECRET:
        parser.error("Set OWNER_SECRET in .env first, and restart the server.")
    headers = {"Authorization": "Bearer " + OWNER_SECRET, "Content-Type": "application/json"}
    body = None
    if args.command == "reports":
        if not 0 <= args.offset <= MAX_REPORTS:
            parser.error("--offset is outside the report inbox.")
        path = "/api/owner/reports?offset=" + str(args.offset)
    else:
        if not args.reference:
            parser.error("This command requires a reference from the report inbox.")
        path = "/api/owner/remove" if args.command == "remove" else "/api/owner/restrict"
        body = ({"message_id": args.reference} if args.command == "remove" else
                {"guest_ref": args.reference, "action": args.command, "minutes": args.minutes})
    req = Request(args.url.rstrip("/") + path, headers=headers,
                  data=json.dumps(body).encode() if body is not None else None)
    try:
        # Disable redirects: a bearer secret must never follow a changed host.
        import urllib.request
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
            result = json.load(response)
        # Escape terminal control sequences from user text with ensure_ascii.
        print(json.dumps(result, ensure_ascii=True, indent=2))
    except HTTPError as error:
        print(f"Owner request rejected (HTTP {error.code}). Check the URL, secret and reference.", file=sys.stderr)
        sys.exit(1)
    except (URLError, TimeoutError):
        print("Could not reach the running server. Start it first and check --url.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "owner":
        owner_cli()
    elif PRODUCTION:
        sys.exit("Use the production command: gunicorn -c gunicorn.conf.py app:app")
    else:
        print(f"{APP_NAME} is running locally at http://127.0.0.1:{os.getenv('PORT', '5000')}")
        socketio.run(app, host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "5000")),
                     debug=False, use_reloader=False, allow_unsafe_werkzeug=True, log_output=False)
