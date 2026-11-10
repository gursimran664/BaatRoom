# BaatRoom

**A little less scrolling. A little more talking.**

One public group called **Everyone**. Open the chat, choose a nickname, and talk
live with other visitors. No visitor accounts, registration, email or app install.
This download contains the real Flask application; it has not been publicly deployed.

## What works

- Live Socket.IO chat, server acknowledgements, retry protection and reconnects.
- English, Hindi, Punjabi and emoji; server timestamps; distinct own-message bubbles.
- Real connected-guest count, expandable participants, typing and join/leave notices.
- Native sharing where supported, clipboard copying, and a selectable-link fallback.
- Four LED themes: **Ember, Aurora, Ultraviolet and Arctic**, plus a glow switch.
- Local blocking, saved message reports, and secret-protected owner commands.
- In-memory ordinary history: latest 100 messages, each at most one hour old.

Only actual visitors create activity. No seeded users, generated chats or popularity numbers.

## Run on Windows in VS Code

Extract the ZIP and open the **BaatRoom** folder in VS Code. Open its terminal.
Python 3.11+ is required; this delivery was exercised with Python 3.12.14.
Run each command separately:

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

Open **http://127.0.0.1:5000**. With the virtual environment already activated,
the normal start command is **`python app.py`**. Using the explicit interpreter
above also works when PowerShell does not permit activation scripts.

On macOS/Linux, use these separate commands instead:

```bash
python3 -m venv .venv
```

```bash
.venv/bin/python -m pip install -r requirements.txt
```

```bash
.venv/bin/python app.py
```

The database and its folder are created automatically. No prebuilt database,
Node.js, Docker, API subscription or external identity service is needed.

## Using the room

Enter a made-up nickname with 2–24 Unicode characters. A short `#abcd` suffix
distinguishes guests, including duplicate nicknames. The browser session cookie
keeps the temporary identity; session storage remembers the nickname in this tab.
Extra tabs using that cookie count as one guest. A different browser/private
session gets another identity. Leave Chat ends that guest's connected tabs.

Desktop: Enter sends; Shift+Enter adds a line. On touch devices, use the send
button. Messages allow 1–1,000 Unicode code points after trimming/normalization.
“Sent” confirms server acceptance, not that another participant has read it.
An unconfirmed send offers Retry with the **same** identifier. Drafts and pending
sends are not saved across page reloads; this avoids resending them unexpectedly.

When reading older messages, new incoming messages do not force you to the bottom.
Use the New messages button to catch up. Open the online count for participants.
Unknown/disconnected counts show a dash instead of a stale popularity number.
Stale network connections normally disappear within about 45 seconds (20-second
Engine.IO ping interval plus a 25-second timeout, with monitoring overhead).

Use a message's three-dot button to block its guest locally or report the message.
Blocking hides that guest's messages in this tab, including after refresh.
Privacy > Unblock all restores any still-recent messages. A report is confirmed
only after SQLite has committed it. Reports are not monitored automatically by a person.

## Owner moderation

There is no owner password in visitor JavaScript, page source or shared links.
The owner uses terminal commands with a server-configured bearer secret.

Copy `.env.example` to `.env`. Generate **two different** values by running this
command twice; put one in `SECRET_KEY`, the other in `OWNER_SECRET`:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Restart the server after changing settings. Keep this server terminal running;
open a second terminal in the same folder. Prefix the commands below with your
virtual-environment Python path if the environment is not activated.

Review the newest 100 reports, including `message_id` and `guest_ref`:

```bash
python app.py owner reports
```

If `next_offset` is returned, review that page (100, 200, and so on):

```bash
python app.py owner reports --offset 100
```

Remove a reported message from all connected clients and recent history:

```bash
python app.py owner remove MESSAGE_ID
```

Mute a guest for ten minutes:

```bash
python app.py owner mute GUEST_REF --minutes 10
```

Disconnect a guest and refuse that temporary session for ten minutes:

```bash
python app.py owner disconnect GUEST_REF --minutes 10
```

Replace the uppercase references with exact values from a report. Restrictions
allow 1–60 minutes. Removal does not erase a report's separate evidence copy.
Expiry or restart may mean a referenced message/guest no longer exists.

For a hosted server, set your local `.env` OWNER_SECRET to the server's secret,
keep local APP_ENV=development, and target its actual HTTPS origin:

```bash
python app.py owner reports --url https://YOUR-ACTUAL-HOST
```

The same `--url` option works with remove/mute/disconnect. The CLI never sends
the secret as a URL parameter and refuses HTTP for non-local hosts. It refuses
redirects, so use the canonical HTTPS origin. Do not post secrets in chat or Git.
Blank OWNER_SECRET disables the owner API locally. Public production requires it.
These are temporary session restrictions; starting a new session can bypass them.

## Get a public HTTPS link

**Localhost cannot be shared on the internet.** The app needs a running Python web
service with Socket.IO/WebSocket support, not a static HTML host. Visitors need
only a browser; the website owner needs a hosting account or their own server.

### Render example

Render's official documentation was checked on **11 November 2026**. It supports
Python web services, HTTPS and inbound WebSockets. Its free web-service tier is
for hobby/testing use: it can sleep after 15 minutes without inbound traffic,
waking can take around a minute, and the workspace has 750 free instance hours
per calendar month. Bandwidth/build limits also apply; charges or suspension can
occur depending on billing settings. Confirm the current terms before choosing.

1. Upload the extracted application's source to a Git repository. Exclude `.env`,
   `instance/`, virtual environments and database files with the supplied `.gitignore`.
2. In Render, create a **Python Web Service**, connect the repository, and select
   the folder containing `app.py` as its root if your repository wraps the folder.
3. Build command: `pip install -r requirements.txt`.
4. Start command: `gunicorn -c gunicorn.conf.py app:app`.
5. Set the variables in the table below. Set the health check to `/healthz` and
   keep the service at **one instance**. Let the platform supply PORT.
6. Use the service's real `https://...onrender.com` origin for PUBLIC_URL. You may
   need to save/redeploy once its assigned hostname is visible. Production fails
   clearly until a valid HTTPS PUBLIC_URL and both secrets are configured.
7. Wait for a successful deploy, open that URL, and test two independent browser
   sessions. Then use Invite Friends or put that HTTPS link in your Instagram bio.

`render.yaml` provides an optional Blueprint with equivalent settings. It prompts
for PUBLIC_URL and generates distinct secret values. Choose a unique service name
if needed. `Procfile` is included for compatible Python process hosts.

| Variable | Public deployment value |
| --- | --- |
| `APP_ENV` | `production` |
| `APP_NAME` | `BaatRoom`, or your chosen name |
| `SECRET_KEY` | Random secret, at least 32 characters |
| `OWNER_SECRET` | Different random secret, at least 32 characters |
| `PUBLIC_URL` | Actual canonical HTTPS origin, no path/query/trailing slash |
| `COOKIE_SECURE` | `true` (also enforced by production mode) |
| `TRUST_PROXY_COUNT` | `1` on Render; only trust the proxies your host actually uses |
| `DATA_DIR` | `/tmp/baatroom` for ephemeral hobby hosting; a persistent disk path otherwise |
| `GUNICORN_THREADS` | `100` initially |
| `PYTHON_VERSION` | `3.12.14` in the supplied Blueprint |

PUBLIC_URL controls both the invitation link and canonical/social metadata.
If you change domains, update it and redeploy. Redirect aliases to that canonical
origin at your host. ALLOWED_HOSTS is inferred from PUBLIC_URL unless explicitly
configured. A wrong origin can prevent chat connections; do not use `*` CORS.
The generic local `static/share.png` preview needs no edit when changing APP_NAME.

Production command on Linux, from the application folder:

```bash
gunicorn -c gunicorn.conf.py app:app
```

The config binds `0.0.0.0:$PORT` (default 10000), uses **one gthread worker** with
100 threads, simple-websocket, no preload, no access log and no debug mode.
Gunicorn is installed on Linux/macOS, not Windows; use `python app.py` for local
Windows development. A self-managed reverse proxy must forward WebSocket Upgrade,
disable buffering on `/socket.io/`, preserve the host/protocol, and allow idle
connections longer than the ping timeout. Terminate TLS at the trusted proxy.

**Free for visitors does not guarantee free hosting for the owner.** No payment
code or visitor charges are built in. The supplied configuration has not been
deployed to a public provider by this delivery.

### Restarts and storage

Ordinary messages, guest sessions, retry receipts and restrictions are **memory
only** and reset on server restart, deployment or host sleep. Guests will need
to rejoin; a nickname may remain prefilled in the current tab. Browser copies
of ordinary messages still expire locally even if the connection is lost.

Only reports use SQLite. On a persistent disk they survive a restart, but expire
after 24 hours; cleanup runs every 30 seconds and at startup/owner review.
While the app is stopped, cleanup resumes on its next startup. Render Free does
not offer persistent disks: reports can be lost earlier on sleep/restart/deploy.
For retained moderation evidence, use a suitable paid service with a persistent
disk and set DATA_DIR to its mounted path, such as `/var/data/baatroom`.

## Privacy and safety model

This is a public room: others can read, copy and screenshot messages. Nicknames
do not verify identity. No complete anonymity or zero-data-collection claim is
made. The server processes connection information to operate the chat and rate
limits; the host may retain technical logs. Messages are **not end-to-end
encrypted**. HTTPS protects transport, not messages from the server or other guests.
Deletion cannot erase screenshots or copies.

No advertising trackers, analytics, fingerprinting, external fonts, uploads,
camera/microphone/location/contacts access or personal profiles are included.
An HttpOnly SameSite=Lax session cookie identifies the temporary guest. Theme
settings use local storage; nickname and blocks use session storage. Browsers
can restore session cookies after reopening, depending on their own settings.

Reported-message copies, reasons, temporary guest references and report times
are the only chat data written to SQLite. Reporter identities and IPs are not
written there. An in-memory keyed hash of the connection IP limits abuse and
is discarded on restart. App logging avoids message bodies, session tokens and
owner secrets; a hosting provider's logs are outside the app's control.

All socket operations validate the signed cookie guest. Connection authentication
also requires a CSRF token. HTTP mutations require the session CSRF token and
same-origin Origin header. Engine.IO validates origins; cross-origin socket
connections are refused. Same-origin polling GETs may omit Origin, so the CSRF
token is required even when no Origin header is available. Owner API calls use
bearer authentication instead of visitor cookies. Text is rendered with textContent,
never as HTML. Security headers restrict scripts, framing and device permissions.

## Bounds and capacity

Initial defaults are limits, not throughput guarantees:

| Setting / control | Default |
| --- | --- |
| `MAX_GUESTS` | 50 connected guest identities |
| `MAX_CONNECTIONS` | 80 Socket.IO connections across guests |
| `MAX_CONNECTIONS_PER_GUEST` | 4 |
| `MAX_GUEST_RECORDS` | 1,000 retained temporary guest records |
| `HISTORY_LIMIT` | 100; configurable downward |
| `MESSAGE_TTL_SECONDS` | 3,600; configurable 5–3,600 for expiry testing |
| `MAX_REPORTS` | 1,000 unexpired reports |
| Message limits | 8/10 seconds, 45/minute, 600 retry receipts per guest/hour |
| Repeated identical text | Refused for 20 seconds; retries of the same ID are idempotent |
| Joining | 5/minute per browser session, 30/minute per connection-IP reference |
| Socket connects | 20/minute per guest, 120/minute per connection-IP reference |
| Typing | 4 events per 5 seconds; expires automatically within 5 seconds |
| Reports | 5/minute per guest; one receipt per guest/message |
| Request sizes | 8 KiB HTTP API, 16 KiB Engine.IO packets |

Disconnected guest records expire after an hour without activity unless a current
restriction needs them. Rate-window and report-receipt tables, per-guest retry
receipts, local pending messages, notices and local blocks are also bounded.
Requests are refused at capacity. Joining limits can affect many friends behind
the same network address. Configure capacity conservatively for your host.

**Use one application process and one replica.** State is protected by a threading
lock within that process. Adding workers or replicas would split the public room.
Shared state and a message queue would require an architectural change. Increasing
MAX_CONNECTIONS also needs thread/memory headroom; 100 threads reserves capacity
above the default 80 connections for HTTP and polling requests.

## Verification for this delivery

- 34 backend acceptance checks passed: independent temporary sessions, duplicate
  nicknames, multi-connection counting, multilingual live messages, sender validation,
  retry idempotency, CSRF/origin/size limits, repeated-text and message rate limits,
  typing expiry, report storage/retention, owner removal/mute/disconnect and leaving.
- The supplied one-worker Gunicorn/threading/simple-websocket setup handled **20
  simultaneous real WebSocket guests and 20 concurrent acknowledged sends** with
  unique message IDs. This is a bounded smoke test, not a sustained load benchmark.
- Shared Chromium UI checks covered joining, a second independent Socket.IO guest,
  multilingual message exchange, distinguishable names, two-tab counting, refresh,
  copying the invite URL, blocking/unblocking, report confirmation, owner removal,
  mute/disconnect, LED themes and a narrow 454-CSS-pixel layout without horizontal
  overflow. Ordinary expiry was also checked with a shortened lifetime.
- A separate automated Chromium launch was blocked by the environment's browser
  policy. Two isolated browser contexts, real iPhone/Android keyboards, native
  mobile share sheets and Instagram's in-app browser were **not fully exercised**.
  The layout uses dynamic viewport sizing/visualViewport and sharing fallbacks;
  verify these on your actual devices and public HTTPS host before announcing it.
- Production HTTPS cookie/header settings were checked locally. A provider account,
  public deployment, free-tier capacity and a public HTTPS connection were not tested.

## Files

`app.py` contains the backend. `templates/chat.html`, `static/css/style.css` and
`static/js/chat.js` contain the interface. `static/vendor/` includes the official
Socket.IO 4.8.4 browser bundle and its MIT licence; no runtime CDN is used.
`static/icon.svg` and `static/share.png` provide the icon and social preview.
The remaining files are pinned requirements, example settings, ignore rules,
these instructions and production configuration. Real secrets, test scripts,
virtual environments, caches, test messages and databases are excluded from the ZIP.

## Official references

- [Flask-SocketIO threading / version compatibility](https://flask-socketio.readthedocs.io/en/stable/intro.html)
- [Flask-SocketIO deployment](https://flask-socketio.readthedocs.io/en/latest/deployment.html)
- [Socket.IO browser client](https://socket.io/docs/v4/client-installation/)
- [Render Flask deployment](https://render.com/docs/deploy-flask)
- [Render WebSockets](https://render.com/docs/websocket)
- [Render free-service restrictions](https://render.com/docs/free)
- [Render persistent disks](https://render.com/docs/disks)
