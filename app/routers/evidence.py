import os
from urllib.parse import quote

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .. import db, security, storage, util, vision

router = APIRouter(prefix="/api")
SIGNATURES = {".png": b"\x89PNG", ".jpg": b"\xff\xd8", ".jpeg": b"\xff\xd8", ".pdf": b"%PDF"}


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@router.get("/evidence")
def list_evidence(case_id: int | None = None, kind: str = "", q: str = "", user=Depends(security.viewer)):
    sql = """SELECT e.id,e.case_id,c.case_number,e.original_name,e.kind,e.mime,e.size,e.sha256,e.description,e.is_demo,
             e.uploaded_at,u.username AS uploaded_by_name,
             (SELECT COUNT(*) FROM evidence_notes n WHERE n.evidence_id=e.id) AS notes_count,
             (SELECT ok FROM integrity_checks i WHERE i.evidence_id=e.id ORDER BY i.id DESC LIMIT 1) AS last_integrity_ok
             FROM evidence e JOIN cases c ON c.id=e.case_id LEFT JOIN users u ON u.id=e.uploaded_by WHERE 1=1"""
    args = []
    if case_id:
        sql += " AND e.case_id=?"; args.append(case_id)
    if kind:
        sql += " AND e.kind=?"; args.append(kind)
    if q:
        sql += " AND (e.original_name LIKE ? OR e.description LIKE ? OR e.sha256 LIKE ?)"; args += [f"%{q}%"] * 3
    return db.rows(sql + " ORDER BY e.id DESC", args)


@router.post("/cases/{cid}/evidence")
def upload(cid: int, file: UploadFile = File(...), description: str = Form(""), is_demo: str = Form("1"),
           user=Depends(security.investigator)):
    util.case_or_404(cid)
    name = util.safe_name(file.filename)
    ext = os.path.splitext(name)[1].lower()
    kind = util.EXT_KIND.get(ext)
    if not kind:
        raise HTTPException(415, f"File type {ext or '(none)'} is not allowed. Allowed: {', '.join(sorted(util.EXT_KIND))}")
    data = util.read_upload(file)
    sig = SIGNATURES.get(ext)
    if sig and not data.startswith(sig):
        raise HTTPException(400, "File content does not match its extension")
    if kind == "image" and cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR) is None:
        raise HTTPException(400, "Image could not be decoded")
    digest = storage.sha256(data)
    stored = storage.put(data)
    eid = db.run("""INSERT INTO evidence(case_id,original_name,stored_name,mime,kind,size,sha256,description,is_demo,uploaded_by,uploaded_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                 (cid, name, stored, file.content_type, kind, len(data), digest, description[:1000], int(util.truthy(is_demo)), user["id"], db.now()))
    util.touch_case(cid)
    db.log(user, "evidence_uploaded", f"{name} ({kind}, {len(data)} B) sha256={digest[:12]}...", cid, "evidence", eid)
    return {"id": eid, "sha256": digest, "kind": kind, "size": len(data)}


def _ev(eid):
    e = db.row("SELECT * FROM evidence WHERE id=?", (eid,))
    if not e:
        raise HTTPException(404, "Evidence not found")
    return e


@router.get("/evidence/{eid}")
def get_evidence(eid: int, user=Depends(security.viewer)):
    e = _ev(eid)
    e.pop("stored_name")
    e["notes"] = db.rows("SELECT n.id,n.text,n.created_at,u.username AS author FROM evidence_notes n LEFT JOIN users u ON u.id=n.author_id WHERE evidence_id=? ORDER BY n.id", (eid,))
    e["integrity_checks"] = db.rows("SELECT i.checked_at,i.ok,i.sha256_now,u.username AS checked_by FROM integrity_checks i LEFT JOIN users u ON u.id=i.checked_by WHERE evidence_id=? ORDER BY i.id DESC LIMIT 10", (eid,))
    e["analyses"] = db.rows("SELECT id,kind,detector,face_count_max,created_at FROM analyses WHERE evidence_id=? ORDER BY id DESC", (eid,))
    return e


@router.get("/evidence/{eid}/file")
def download(eid: int, inline: int = 0, user=Depends(security.viewer)):
    e = _ev(eid)
    try:
        data = storage.get(e["stored_name"])
    except Exception:
        raise HTTPException(500, "Stored file failed decryption/authentication (possible tampering or missing key)")
    show = bool(inline) and e["kind"] == "image"
    mime = (e["mime"] or "") if show else "application/octet-stream"
    if show and not mime.startswith("image/"):
        mime = "image/jpeg"
    db.log(user, "evidence_viewed" if show else "evidence_downloaded", e["original_name"], e["case_id"], "evidence", eid)
    return Response(data, media_type=mime, headers={
        "Content-Disposition": f"{'inline' if show else 'attachment'}; filename*=UTF-8''{quote(e['original_name'])}"})


@router.get("/evidence/{eid}/thumb")
def thumb(eid: int, user=Depends(security.viewer)):
    e = _ev(eid)
    if e["kind"] != "image":
        raise HTTPException(400, "Not an image")
    return Response(vision.thumbnail(vision.decode_image(storage.get(e["stored_name"]))), media_type="image/jpeg")


@router.post("/evidence/{eid}/verify")
def verify(eid: int, user=Depends(security.viewer)):
    e = _ev(eid)
    try:
        now_hash, note = storage.sha256(storage.get(e["stored_name"])), ""
    except Exception:
        now_hash, note = None, "Stored file failed decryption/authentication or is missing."
    ok = now_hash == e["sha256"]
    db.run("INSERT INTO integrity_checks(evidence_id,checked_by,checked_at,ok,sha256_now) VALUES(?,?,?,?,?)", (eid, user["id"], db.now(), int(ok), now_hash))
    db.log(user, "integrity_check", f"{e['original_name']}: {'MATCH' if ok else 'MISMATCH'}", e["case_id"], "evidence", eid)
    return {"ok": ok, "sha256_at_upload": e["sha256"], "sha256_now": now_hash, "note": note or (
        "Hash matches the value recorded at upload. This shows the stored bytes are unchanged; it does not prove authenticity or chain of custody." if ok
        else "Hash does NOT match the value recorded at upload.")}


@router.post("/evidence/{eid}/notes")
def add_note(eid: int, body: NoteIn, user=Depends(security.investigator)):
    e = _ev(eid)
    nid = db.run("INSERT INTO evidence_notes(evidence_id,author_id,text,created_at) VALUES(?,?,?,?)", (eid, user["id"], body.text.strip(), db.now()))
    util.touch_case(e["case_id"])
    db.log(user, "evidence_note", f"{e['original_name']}: {body.text[:80]}", e["case_id"], "evidence", eid)
    return {"id": nid}


@router.delete("/evidence/{eid}")
def delete(eid: int, user=Depends(security.admin)):
    e = _ev(eid)
    storage.delete(e["stored_name"])
    db.run("DELETE FROM evidence WHERE id=?", (eid,))
    util.touch_case(e["case_id"])
    db.log(user, "evidence_deleted", e["original_name"], e["case_id"], "evidence", eid)
    return {"deleted": eid}
