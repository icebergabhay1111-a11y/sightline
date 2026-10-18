"""Authentication, roles, CSRF guard, login throttling."""
import base64
import hashlib
import hmac
import os
import time
from collections import defaultdict

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from . import db

ROLE_RANK = {"viewer": 1, "investigator": 2, "admin": 3}
_ITER = 200_000


def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, _ITER)
    return f"pbkdf2${_ITER}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, it, salt, dk = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), base64.b64decode(salt), int(it))
        return hmac.compare_digest(calc, base64.b64decode(dk))
    except Exception:
        return False


# ---- throttling: 5 failures / 10 min per (username, ip)
_fails = defaultdict(list)


def throttled(key: str) -> bool:
    now = time.time()
    _fails[key] = [t for t in _fails[key] if now - t < 600]
    return len(_fails[key]) >= 5


def record_failure(key: str):
    _fails[key].append(time.time())


def clear_failures(key: str):
    _fails.pop(key, None)


# ---- dependencies
def current_user(request: Request) -> dict:
    uid = request.session.get("uid")
    if not uid:
        raise HTTPException(401, "Not signed in")
    u = db.row("SELECT id,username,role,active FROM users WHERE id=?", (uid,))
    if not u or not u["active"]:
        request.session.clear()
        raise HTTPException(401, "Account disabled or missing")
    return u


def require(role: str):
    need = ROLE_RANK[role]

    def dep(user: dict = Depends(current_user)):
        if ROLE_RANK[user["role"]] < need:
            raise HTTPException(403, f"Requires {role} role")
        return user
    return dep


viewer = require("viewer")
investigator = require("investigator")
admin = require("admin")


async def csrf_guard(request: Request, call_next):
    """State-changing API calls must carry a custom header (cross-site forms cannot set it)."""
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.url.path.startswith("/api/"):
        if request.headers.get("x-requested-with") != "fetch":
            return JSONResponse({"detail": "Missing X-Requested-With header"}, status_code=403)
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self)")
    if request.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp
