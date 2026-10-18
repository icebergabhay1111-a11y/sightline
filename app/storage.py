"""Encrypted file vault (Fernet). Files are stored under random names; the DB keeps the original name + SHA-256."""
import hashlib
import os
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path

from cryptography.fernet import Fernet

from . import config

_NAME = re.compile(r"^[0-9a-f]{32}\.bin$")
_fernet = None


def fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(config.data_key().encode())
    return _fernet


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _path(name: str) -> Path:
    if not _NAME.match(name or ""):
        raise ValueError("invalid stored name")
    return config.UPLOAD_DIR / name


def put(data: bytes) -> str:
    name = os.urandom(16).hex() + ".bin"
    _path(name).write_bytes(fernet().encrypt(data))
    return name


def get(name: str) -> bytes:
    return fernet().decrypt(_path(name).read_bytes())


def delete(name):
    if name:
        try:
            _path(name).unlink(missing_ok=True)
        except ValueError:
            pass


@contextmanager
def tempfile_of(name: str, suffix: str = ""):
    """Decrypt to a temp file (needed by cv2.VideoCapture); always removed afterwards (Windows-safe)."""
    fd, p = tempfile.mkstemp(suffix=suffix, dir=config.TMP_DIR)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(get(name))
        yield p
    finally:
        try:
            os.remove(p)
        except OSError:
            pass


def encrypt_bytes(b: bytes) -> bytes:
    return fernet().encrypt(b)


def decrypt_bytes(b: bytes) -> bytes:
    return fernet().decrypt(b)
