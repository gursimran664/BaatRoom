# BaatRoom

A little less scrolling. A little more talking.

A real Flask group chat with temporary guest nicknames, private messages and
browser audio calls. The interface and instructions are in English; messages
support English, Hindi, Punjabi and emoji. No visitor registration, phone number,
email, password or app installation is required. Change APP_NAME to rename it.
This ZIP is source code, not a publicly deployed website.

## Run locally on Windows in VS Code

Extract the ZIP. Open the **BaatRoom** folder in VS Code, then open Terminal.
Use Python 3.11 or later. Run each command separately:

```powershell
python --version
```

```powershell
python -m venv .venv
```

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

```powershell
.\.venv\Scripts\python.exe app.py
```

Open http://127.0.0.1:5000. After activating the environment, **python app.py**
is the normal startup command. Do not open chat.html directly.

macOS/Linux: run these separately:

```bash
python3 -m venv .venv
```

```bash
.venv/bin/python -m pip install -r requirements.txt
```

```bash
.venv/bin/python app.py
```

The moderation database is created automatically. No Node.js, React, Docker,
paid messaging API or external account service is required to run the chat.

## Features and use

- Choose a 2–24 character nickname. Optional gender: Male, Female, Other or
  Prefer not to say. The choice is visible, self-reported and changeable.
- Everyone is the public group. Open the online count and choose **Message**
  beside a guest to open a private conversation. Conversation buttons switch
  between Everyone and private chats; incoming messages show unread indicators.
- Messages have server IDs and timestamps, acknowledgements, retry handling,
  typing indicators, expiry and automatic reconnect/history restoration.
- The online number counts connected guest sessions, not verified people.
  Multiple tabs with the same session count once. Duplicate names have suffixes.
- **Guest settings** controls gender, private messages and audio calls.
- **Audio calls start OFF.** Both guests must enable Allow audio calls. In a
  private conversation, choose Audio call. The recipient accepts or declines.
  Mute/Unmute and End call are available. No phone number is used.
- A declined caller must wait two minutes before calling that guest again.
  One active call per guest is allowed, with a configurable one-hour maximum.
  Disconnecting, leaving, blocking or switching calls off ends the call.
- **Block guest** hides their messages for you and stops private messages/calls
  between your guest sessions. Blocks synchronize across your connected tabs.
  Unblock in the conversation or use Unblock all in the privacy dialog.
- **Report message** opens a reason form. Only after its report has been saved
  does the server remove the message from every recipient's chat. Public messages
  disappear from Everyone; private messages disappear from their two participants.
  A report copy remains for owner review for at most 24 hours.
- Invite Friends uses native sharing, clipboard copying or a manual-copy dialog.
- Four LED themes: Ember, Aurora, Ultraviolet and Arctic, plus a glow switch.

Desktop: Enter sends and Shift+Enter adds a line. Touch devices use Send.
Leave Chat ends that temporary guest session, including its other connected tabs.

## Message rules and moderation limits

The server checks public and private messages before accepting them. Messages
must contain 1–1,000 characters. Digits and other Unicode numeric characters,
recognizable links/domains/contact addresses, and known abusive words are refused.
The intentionally strict filter may reject harmless numbers or domain-like text.
It can miss disguised links, spelled-out contact details and contextual abuse;
it does not guarantee that every harmful message is detected. BLOCKED_WORDS can
add comma-separated words/phrases. No message is sent to an external AI service.

The same text, normalized for case, Unicode and repeated whitespace, can be
accepted at most **five times per hour per guest**, across public and private
chat together. A twenty-second gap also applies to repeats. Technical retries
reuse their identifier and do not create another copy or increment this count.
Additional limits: 8 accepted attempts/10 seconds and 45/minute, shared across
both kinds of chat; reports 5/minute; outgoing call attempts 3/minute and incoming
attempts 8/minute. Connection and typing limits are also enforced server-side.

A personal block does not expel a guest from the public room. Owner moderation
can mute or disconnect a guest. Reports remove messages immediately as requested;
a report is not proof of wrongdoing, and an attacker could misuse reporting.
Rate limits reduce misuse but cannot eliminate it. Starting a new browser session
can bypass guest restrictions; no permanent identity-based ban is promised.

## Privacy and deletion

Every message expires from its **original sending time**, at most one hour later.
The public room and each private conversation retain at most the latest 100
unexpired messages. Private history also has a global default cap of 1,000, so
older private messages can be removed sooner when that cap is reached. Both
server and connected browsers enforce expiry. A server restart clears ordinary
messages, guest identities, preferences, blocks, call state and restrictions.
Leaving explicitly deletes that guest's private history for both participants.

Private messages are routed only to their two guest sessions; other tabs sharing
those sessions can read them. They are **not end-to-end encrypted**: the server
processes them. Public participants and private recipients can copy/screenshot
messages. Deletion cannot erase screenshots or saved copies. Reports keep only
the reported message, reason, temporary guest reference and time in SQLite for
up to 24 hours. Reporting a private message shares its copy with the owner.

Audio uses WebRTC and is not recorded or saved by the application. Microphone
permission is requested only on Start/Accept, never on joining or receiving a
ring. Camera access is disabled. WebRTC can expose network addresses to the
other caller; configured relay operators can process connection/media traffic.

The server processes connection information and temporary keyed IP references
for abuse limits. Hosting providers may keep technical logs. No advertising
trackers, analytics, fingerprinting, external fonts, contacts or location access
are included. Theme choices use local storage; nickname and message hiding use
session storage. An HttpOnly SameSite session cookie holds the temporary identity.
Browsers can restore session cookies according to their own session settings.

## Audio calls: local testing and public networks

To test locally, open http://127.0.0.1:5000 in two independent browsers (or one
normal and one private window), join as two guests, and enable calls in both.
Choose a private chat and Audio call; allow each browser's microphone permission.
Use headphones to avoid feedback. Call acceptance, mute and hangup are real UI
controls; there is no simulated audio or fake connection success.

Microphone access requires HTTPS or localhost. Plain HTTP to a LAN address such
as a computer's private IP generally cannot use the microphone. Some Instagram
in-app browsers restrict media; use Open in browser / Chrome / Safari if needed.

**Empty ICE settings provide local/direct connectivity only. Reliable calls
between different internet networks usually require a TURN relay.** STUN alone
does not guarantee connectivity. This ZIP does not supply or provision a relay.
Until one is configured, public/private text chat works, but some audio calls
will time out and show an error instead of claiming to be connected.

For a coturn server you operate:

1. Configure its public DNS, TLS certificate, firewall/relay ports, realm and
   REST authentication (`use-auth-secret` with `static-auth-secret`). Follow the
   coturn documentation and protect the host; do not run an open relay.
2. Set STUN_URLS and TURN_URLS in the app's .env or hosting environment, using
   the addresses your relay actually serves. The example settings show the format.
3. Set TURN_SHARED_SECRET to that relay's static-auth-secret. Never put this
   master secret in public JavaScript, a link, page source or GitHub.
4. Restart the app. It issues short-lived per-guest relay credentials only to
   authenticated participants of an allowed call. Those expiring credentials
   must reach WebRTC in the browser; the master secret stays on the server.
5. Verify two real devices on different networks before sharing publicly.

No external ICE service is contacted by the default empty configuration. If you
configure a third-party STUN/TURN service, review its privacy terms and costs.

## Owner commands

Copy .env.example to .env. Generate two different random values, running this
command separately for SECRET_KEY and OWNER_SECRET:

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
```

Set both values and restart the app. Leave OWNER_SECRET blank to disable owner
access. Never upload .env. Commands below target the running local server; with
an activated environment run each separately. OWNER_API_URL can target your
public HTTPS origin.

```powershell
python app.py owner reports
```

```powershell
python app.py owner reports --offset 100
```

```powershell
python app.py owner remove MESSAGE_ID
```

```powershell
python app.py owner mute GUEST_REFERENCE --minutes 10
```

```powershell
python app.py owner disconnect GUEST_REFERENCE --minutes 10
```

Take MESSAGE_ID / GUEST_REFERENCE from reports. A report already removes the
ordinary message; its copy remains available for review. Owner access uses a
bearer header, with no visitor login page or URL secret.

## Public HTTPS deployment

A localhost link cannot be used by friends over the internet. GitHub stores the
files; GitHub Pages serves static content and cannot run this Flask/Socket.IO
server. Use a host supporting a long-running Python app and WebSockets.
The supplied Render Blueprint is an optional deployment starting point, not an
active deployment. Check the provider's current plan availability and limits.

Upload the extracted application's contents (not the ZIP) to your repository.
Connect a Python web service, install requirements.txt and run, from that folder:

```bash
gunicorn -c gunicorn.conf.py app:app
```

Required production environment values:

| Variable | Value |
| --- | --- |
| APP_ENV | production |
| APP_NAME | BaatRoom or your chosen name |
| SECRET_KEY | A random value with at least 32 characters |
| OWNER_SECRET | A different random value with at least 32 characters |
| PUBLIC_URL | Your exact HTTPS origin, without path/trailing slash |
| COOKIE_SECURE | true (also enforced in production) |
| TRUST_PROXY_COUNT | 1 only behind exactly one trusted reverse proxy |
| DATA_DIR | A writable directory; persistent disk for retained reports |
| GUNICORN_THREADS | 100 initially |

Set the optional ICE variables above for calls across public networks. PUBLIC_URL
controls invites and sharing metadata. Change it and redeploy when changing the
domain. ALLOWED_HOSTS defaults to the hostname from PUBLIC_URL. Do not use wildcard
CORS. A reverse proxy must forward WebSocket Upgrade and preserve host/protocol.

**Exactly one worker and one replica are required.** Memory state is protected
by a thread lock, and one process keeps all guests in the same room. Scaling to
multiple processes needs a different shared-state/message-queue architecture.
Gunicorn is for Linux/macOS; run python app.py on local Windows. Debug is off.
The configuration disables access logging and the unneeded Gunicorn control socket.

Visitors pay nothing. The owner may have hosting, domain or relay costs.
Ephemeral hosting can erase reports before 24 hours on sleep/restart/deployment.
A persistent disk preserves reports between restarts, with cleanup at startup,
every thirty seconds and owner review. If stopped, cleanup resumes at startup.

## Capacity and verification

Default bounds: 50 connected guest identities, 80 socket connections, four tabs
per guest, 1,000 retained guest records, 1,000 private messages globally, 100
messages per conversation, 1,000 unexpired reports, and 600 message retry/text
records per guest. Limits are configurable in .env.example; they are not load
or throughput guarantees. Calls use peer/relay bandwidth in addition to signaling.

The update passed 94 backend checks, covering independent sessions, privacy of
private history/events, forged sender rejection, retry idempotency, report access
and removal scope, filters, fifth/sixth-repeat behavior, calls off by default,
accept/decline/cooldown, call membership/tab binding, blocking, settings, owner
moderation, expiry and retention. Backend signaling tests do not establish real
microphone-to-speaker media delivery across internet networks.

Shared Chromium UI checks exercised joining, English controls, optional gender,
real presence, acknowledged multilingual private messages and replies, optional
call settings, incoming-call decline and report removal with an independent
Socket.IO test guest. A separate automated browser launch was blocked by the environment.
Real iPhone/Android keyboards, Instagram media permissions, public HTTPS hosting
and full two-device audio/relay behavior were not verified here. Test those on
your actual devices and configured public host. No public deployment is claimed.

## Files

app.py is the single backend. templates/chat.html, static/css/style.css,
static/js/chat.js and static/js/calls.js provide the UI and browser WebRTC audio.
static/vendor contains Socket.IO 4.8.4 and its MIT license. The other files are
the local icon/social image, pinned requirements, example environment, ignore
rules, setup instructions and one-worker production configuration. This archive
contains no real secrets, databases, fake guests, QA bridges, tests, virtual
environments, package.json, caches or Node dependencies.

## References

- https://flask-socketio.readthedocs.io/en/latest/deployment.html
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- https://webrtc.org/getting-started/turn-server
- https://github.com/coturn/coturn/wiki/turnserver
- https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- https://render.com/docs/deploy-flask
- https://render.com/docs/websocket
- https://render.com/docs/free
