"""Settings from environment / .env (tiny parser, no extra dependency)."""
import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_env():
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()

DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
if not DATA_DIR.is_absolute():
    DATA_DIR = ROOT / DATA_DIR
UPLOAD_DIR = DATA_DIR / "vault"
TMP_DIR = DATA_DIR / "tmp"
MODELS_DIR = ROOT / "models"
for d in (DATA_DIR, UPLOAD_DIR, TMP_DIR, MODELS_DIR):
    d.mkdir(parents=True, exist_ok=True)

DB_PATH = Path(os.environ.get("DB_PATH", DATA_DIR / "sightline.db"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "50"))
SESSION_HOURS = int(os.environ.get("SESSION_HOURS", "8"))
DEMO_PASSWORD = os.environ.get("DEMO_PASSWORD", "Demo@1234")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"

# Matching: cosine-similarity reference value from the OpenCV SFace tutorial. NOT validated on our data.
MATCH_COSINE_THRESHOLD = float(os.environ.get("MATCH_COSINE_THRESHOLD", "0.363"))
REFERENCE_RETENTION_DAYS = int(os.environ.get("REFERENCE_RETENTION_DAYS", "30"))


def _key_file(name, env, maker):
    if os.environ.get(env):
        return os.environ[env]
    p = DATA_DIR / name
    if not p.exists():
        p.write_text(maker(), encoding="utf-8")
    return p.read_text(encoding="utf-8").strip()


def data_key() -> str:
    from cryptography.fernet import Fernet
    return _key_file("vault.key", "DATA_KEY", lambda: Fernet.generate_key().decode())


def session_secret() -> str:
    return _key_file("session.key", "SESSION_SECRET", lambda: secrets.token_urlsafe(48))
