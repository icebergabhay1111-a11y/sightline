from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .. import db, reports, security, util

router = APIRouter(prefix="/api")


class CaseIn(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    description: str = Field(default="", max_length=4000)
    status: str = "open"
    priority: str = "medium"
    is_demo: bool = True


class CasePatch(BaseModel):
    title: str | None = Field(default=None, min_length=3, max_length=160)
    description: str | None = Field(default=None, max_length=4000)
    status: str | None = None
    priority: str | None = None
    is_demo: bool | None = None


COUNTS = """(SELECT COUNT(*) FROM evidence e WHERE e.case_id=c.id) AS evidence_count,
 (SELECT COUNT(*) FROM analyses a WHERE a.case_id=c.id) AS analyses_count,
 (SELECT COUNT(*) FROM interviews i WHERE i.case_id=c.id) AS interviews_count,
 (SELECT COUNT(*) FROM observations o WHERE o.case_id=c.id) AS observations_count,
 (SELECT COUNT(*) FROM obs_sessions g WHERE g.case_id=c.id) AS gaze_count"""


@router.get("/cases")
def list_cases(q: str = "", status: str = "", demo: str = "", priority: str = "", sort: str = "updated",
               user=Depends(security.viewer)):
    sql, args = f"SELECT c.*, u.username AS created_by_name, {COUNTS} FROM cases c LEFT JOIN users u ON u.id=c.created_by WHERE 1=1", []
    if q:
        sql += " AND (c.case_number LIKE ? OR c.title LIKE ? OR c.description LIKE ?)"
        args += [f"%{q}%"] * 3
    if status:
        sql += " AND c.status=?"; args.append(status)
    if priority:
        sql += " AND c.priority=?"; args.append(priority)
    if demo in ("0", "1"):
        sql += " AND c.is_demo=?"; args.append(int(demo))
    sql += {"created": " ORDER BY c.created_at DESC, c.id DESC", "title": " ORDER BY c.title COLLATE NOCASE",
            "number": " ORDER BY c.case_number"}.get(sort, " ORDER BY c.updated_at DESC, c.id DESC")
    return db.rows(sql, args)


@router.post("/cases")
def create_case(body: CaseIn, user=Depends(security.investigator)):
    if body.status not in util.CASE_STATUSES or body.priority not in util.PRIORITIES:
        raise HTTPException(422, "Invalid status or priority")
    now = db.now()
    num = util.new_case_number(body.is_demo)
    cid = db.run("INSERT INTO cases(case_number,title,description,status,priority,is_demo,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                 (num, body.title.strip(), body.description, body.status, body.priority, int(body.is_demo), user["id"], now, now))
    db.log(user, "case_created", f"{num}: {body.title}", cid, "case", cid)
    return {"id": cid, "case_number": num}


@router.get("/cases/{cid}")
def get_case(cid: int, user=Depends(security.viewer)):
    c = db.row(f"SELECT c.*, u.username AS created_by_name, {COUNTS} FROM cases c LEFT JOIN users u ON u.id=c.created_by WHERE c.id=?", (cid,))
    if not c:
        raise HTTPException(404, "Case not found")
    return c


@router.patch("/cases/{cid}")
def patch_case(cid: int, body: CasePatch, user=Depends(security.investigator)):
    old = util.case_or_404(cid)
    changes = body.model_dump(exclude_none=True)
    if "status" in changes and changes["status"] not in util.CASE_STATUSES:
        raise HTTPException(422, "Invalid status")
    if "priority" in changes and changes["priority"] not in util.PRIORITIES:
        raise HTTPException(422, "Invalid priority")
    if not changes:
        return {"ok": True}
    if "is_demo" in changes:
        changes["is_demo"] = int(changes["is_demo"])
    sets = ", ".join(f"{k}=?" for k in changes)
    db.run(f"UPDATE cases SET {sets}, updated_at=? WHERE id=?", [*changes.values(), db.now(), cid])
    diff = ", ".join(f"{k}: {old[k]!r} -> {v!r}" for k, v in changes.items() if k != "description" and old.get(k) != v)
    db.log(user, "case_updated", diff or "details edited", cid, "case", cid)
    return {"ok": True}


@router.delete("/cases/{cid}")
def delete_case(cid: int, user=Depends(security.admin)):
    c = util.case_or_404(cid)
    util.delete_case_files(cid)
    db.run("DELETE FROM cases WHERE id=?", (cid,))
    db.log(user, "case_deleted", c["case_number"], None, "case", cid)
    return {"deleted": cid}


@router.get("/cases/{cid}/timeline")
def timeline(cid: int, user=Depends(security.viewer)):
    util.case_or_404(cid)
    return db.rows("SELECT ts,username,type,ref_type,ref_id,detail FROM events WHERE case_id=? ORDER BY id DESC LIMIT 500", (cid,))


@router.get("/cases/{cid}/export.json")
def export_json(cid: int, user=Depends(security.viewer)):
    data = reports.export_json(cid)
    if not data:
        raise HTTPException(404, "Case not found")
    db.log(user, "case_exported", "JSON summary", cid, "case", cid)
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="case-{cid}-summary.json"'})


@router.get("/cases/{cid}/report.pdf")
def report_pdf(cid: int, sections: str = Query(default=""), user=Depends(security.viewer)):
    pdf = reports.build_pdf(cid, [s for s in sections.split(",") if s] or None, user["username"])
    if pdf is None:
        raise HTTPException(404, "Case not found")
    db.log(user, "report_generated", f"PDF ({sections or 'all sections'})", cid, "case", cid)
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="case-{cid}-report.pdf"'})
