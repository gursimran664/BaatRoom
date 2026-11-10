"""One process is essential: guests, history and restrictions live in memory."""
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))

bind = "0.0.0.0:" + os.getenv("PORT", "10000")
workers = 1
worker_class = "gthread"
threads = int(os.getenv("GUNICORN_THREADS", "100"))
timeout = 120
graceful_timeout = 30
keepalive = 5
preload_app = False
accesslog = None
errorlog = "-"
loglevel = "warning"
capture_output = False
# ProxyFix is configured explicitly by TRUST_PROXY_COUNT in app.py.
forwarded_allow_ips = "127.0.0.1,::1"
