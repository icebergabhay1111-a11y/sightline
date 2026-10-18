import re
import unicodedata
from datetime import date

from fastapi import HTTPException

from . import config, db, storage

CASE_STATUSES = ["open", "in_progress", "under_review", "closed", "archived"]
PRIORITIES = ["low", "medium", "high"]
EXT_KIND = {".jpg": "image", ".jpeg": "image", ".png": "image", ".bmp": "image", ".webp": "image",
            ".mp4": "video", ".avi": "video", ".mov": "video", ".mkv": "video", ".webm": "video",
            ".pdf": "document", ".txt": "document", ".csv": "document", ".json": "document", ".docx": "document",
            ".wav": "audio", ".mp3": "audio", ".m4a": "audio", ".ogg": "audio"}
MAX_BYTES = config.MAX_UPLOAD_MB * 1024 * 1024


def case_or_404(cid):
    c = db.row("SELECT * FROM cases WHERE id=?", (cid,))
    if not c:
        raise HTTPException(404, "Case not found")
    return c


def touch_case(cid):
    db.run("UPDATE cases SET updated_at=? WHERE id=?", (db.now(), cid))


def safe_name(name):
    name = unicodedata.normalize("NFKC", name or "file").replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip() or "file"
    return name[:120]


def read_upload(upload, limit=None):
    limit = limit or MAX_BYTES
    data = upload.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"File larger than {max(1, limit // (1024 * 1024))} MB limit")
    if not data:
        raise HTTPException(400, "Empty file")
    return data


def truthy(v):
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def new_case_number(is_demo):
    prefix, year = ("DEMO" if is_demo else "CASE"), date.today().year
    n = db.row("SELECT COUNT(*) AS n FROM cases WHERE case_number LIKE ?", (f"{prefix}-{year}-%",))["n"] + 1
    while db.row("SELECT 1 FROM cases WHERE case_number=?", (f"{prefix}-{year}-{n:03d}",)):
        n += 1
    return f"{prefix}-{year}-{n:03d}"


def delete_case_files(cid):
    for r in db.rows("SELECT stored_name FROM evidence WHERE case_id=?", (cid,)):
        storage.delete(r["stored_name"])
    for r in db.rows("""SELECT rec_stored FROM interview_items WHERE rec_stored IS NOT NULL AND interview_id IN
                        (SELECT id FROM interviews WHERE case_id=?)""", (cid,)):
        storage.delete(r["rec_stored"])


def public_item(it):
    d = dict(it)
    d["has_recording"] = bool(d.pop("rec_stored", None))
    return d
