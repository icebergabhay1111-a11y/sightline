from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import db, security

router = APIRouter(prefix="/api")


class Login(BaseModel):
    username: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=1, max_length=200)


class NewUser(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=200)
    role: str = Field(pattern="^(admin|investigator|viewer)$")


class UserPatch(BaseModel):
    role: str | None = Field(default=None, pattern="^(admin|investigator|viewer)$")
    active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=200)


def _pub(u):
    return {"id": u["id"], "username": u["username"], "role": u["role"], "active": bool(u["active"])}


@router.post("/auth/login")
def login(body: Login, request: Request):
    key = f"{body.username.lower()}|{request.client.host if request.client else '-'}"
    if security.throttled(key):
        raise HTTPException(429, "Too many failed attempts. Try again in 10 minutes.")
    u = db.row("SELECT * FROM users WHERE username=? COLLATE NOCASE", (body.username,))
    if not u or not u["active"] or not security.verify_password(body.password, u["password_hash"]):
        security.record_failure(key)
        db.log(None, "login_failed", body.username[:40])
        raise HTTPException(401, "Invalid username or password")
    security.clear_failures(key)
    request.session.clear()
    request.session["uid"] = u["id"]
    db.log(u, "login")
    return _pub(u)


@router.post("/auth/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@router.get("/auth/me")
def me(user=Depends(security.current_user)):
    return _pub(user)


@router.get("/users")
def users(user=Depends(security.admin)):
    return [_pub(u) | {"created_at": u["created_at"]} for u in db.rows("SELECT * FROM users ORDER BY id")]


@router.post("/users")
def create_user(body: NewUser, user=Depends(security.admin)):
    if db.row("SELECT 1 FROM users WHERE username=? COLLATE NOCASE", (body.username,)):
        raise HTTPException(409, "Username already exists")
    uid = db.run("INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)",
                 (body.username, security.hash_password(body.password), body.role, db.now()))
    db.log(user, "user_created", f"{body.username} ({body.role})", ref_type="user", ref_id=uid)
    return {"id": uid}


@router.patch("/users/{uid}")
def patch_user(uid: int, body: UserPatch, user=Depends(security.admin)):
    target = db.row("SELECT * FROM users WHERE id=?", (uid,))
    if not target:
        raise HTTPException(404, "User not found")
    if uid == user["id"] and (body.active is False or (body.role and body.role != "admin")):
        raise HTTPException(400, "You cannot disable or demote your own account")
    if body.role:
        db.run("UPDATE users SET role=? WHERE id=?", (body.role, uid))
    if body.active is not None:
        db.run("UPDATE users SET active=? WHERE id=?", (int(body.active), uid))
    if body.password:
        db.run("UPDATE users SET password_hash=? WHERE id=?", (security.hash_password(body.password), uid))
    db.log(user, "user_updated", target["username"], ref_type="user", ref_id=uid)
    return {"ok": True}
