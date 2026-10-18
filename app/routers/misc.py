from datetime import date, timedelta

from fastapi import APIRouter, Depends

from .. import APP_NAME, APP_VERSION, config, db, security, seed, vision

router = APIRouter(prefix="/api")
DISCLAIMER = ("Academic prototype. Not validated for real criminal-investigation decisions. Face detection is not identification; "
              "similarity scores are not proof of identity; facial-movement measurements do not indicate deception, emotion or guilt. "
              "Use fictional or consented demonstration data only.")


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/meta")
def meta(user=Depends(security.viewer)):
    return {"app": APP_NAME, "version": APP_VERSION, "disclaimer": DISCLAIMER, "max_upload_mb": config.MAX_UPLOAD_MB,
            "vision": vision.engine.status(), "match_threshold": config.MATCH_COSINE_THRESHOLD, "gaze_enabled": config.GAZE_ENABLED}


@router.get("/events")
def events(case_id: int | None = None, type: str = "", username: str = "", q: str = "", limit: int = 50, offset: int = 0,
           user=Depends(security.viewer)):
    sql, args = " FROM events e LEFT JOIN cases c ON c.id=e.case_id WHERE 1=1", []
    if case_id:
        sql += " AND e.case_id=?"; args.append(case_id)
    if type:
        sql += " AND e.type=?"; args.append(type)
    if username:
        sql += " AND e.username=?"; args.append(username)
    if q:
        sql += " AND (e.detail LIKE ? OR e.type LIKE ?)"; args += [f"%{q}%"] * 2
    total = db.row("SELECT COUNT(*) AS n" + sql, args)["n"]
    items = db.rows("SELECT e.*, c.case_number" + sql + " ORDER BY e.id DESC LIMIT ? OFFSET ?", [*args, min(max(limit, 1), 200), max(offset, 0)])
    return {"total": total, "items": items,
            "types": [r["type"] for r in db.rows("SELECT DISTINCT type FROM events ORDER BY type")],
            "users": [r["username"] for r in db.rows("SELECT DISTINCT username FROM events ORDER BY username")]}


@router.get("/analytics")
def analytics(user=Depends(security.viewer)):
    by = lambda sql: {r["k"]: r["n"] for r in db.rows(sql)}
    since = (date.today() - timedelta(days=13)).isoformat()
    per_day = {r["d"]: r["n"] for r in db.rows("SELECT substr(ts,1,10) AS d, COUNT(*) AS n FROM events WHERE substr(ts,1,10)>=? GROUP BY d", (since,))}
    days = [(date.today() - timedelta(days=13 - i)).isoformat() for i in range(14)]
    return {
        "cases_total": db.row("SELECT COUNT(*) AS n FROM cases")["n"],
        "cases_by_status": by("SELECT status AS k, COUNT(*) AS n FROM cases GROUP BY status"),
        "demo_cases": db.row("SELECT COUNT(*) AS n FROM cases WHERE is_demo=1")["n"],
        "evidence_total": db.row("SELECT COUNT(*) AS n FROM evidence")["n"],
        "evidence_by_kind": by("SELECT kind AS k, COUNT(*) AS n FROM evidence GROUP BY kind"),
        "analyses_total": db.row("SELECT COUNT(*) AS n FROM analyses")["n"],
        "interviews_by_status": by("SELECT status AS k, COUNT(*) AS n FROM interviews GROUP BY status"),
        "observations_total": db.row("SELECT COUNT(*) AS n FROM observations")["n"],
        "references_total": db.row("SELECT COUNT(*) AS n FROM reference_images")["n"],
        "activity_by_day": [{"day": d, "n": per_day.get(d, 0)} for d in days],
        "open_items": {
            "follow_ups": db.rows("""SELECT i.id AS interview_id, t.position, t.question_text, c.case_number, c.id AS case_id FROM interview_items t
                                     JOIN interviews i ON i.id=t.interview_id JOIN cases c ON c.id=i.case_id WHERE t.follow_up=1 ORDER BY t.id DESC LIMIT 8"""),
            "interviews_in_progress": db.rows("""SELECT i.id, i.subject_ref, c.case_number FROM interviews i JOIN cases c ON c.id=i.case_id
                                                 WHERE i.status='in_progress' ORDER BY i.id DESC LIMIT 8"""),
            "matches_awaiting_review": db.rows("""SELECT m.id, m.analysis_id, m.reference_label, m.score, a.case_id FROM matches m JOIN analyses a ON a.id=m.analysis_id
                                                  WHERE m.above_threshold=1 AND m.decision IS NULL ORDER BY m.id DESC LIMIT 8"""),
        },
        "recent_events": db.rows("SELECT e.ts,e.username,e.type,e.detail,c.case_number FROM events e LEFT JOIN cases c ON c.id=e.case_id ORDER BY e.id DESC LIMIT 8"),
    }


@router.post("/admin/reset-demo")
def reset_demo(user=Depends(security.admin)):
    ids = seed.reset_demo()
    db.log(user, "demo_reset", f"{len(ids)} fictional cases recreated")
    return {"cases": ids}
