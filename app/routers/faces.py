import json
import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .. import config, db, security, storage, util, vision

router = APIRouter(prefix="/api")
LIMITS = ("A detected face is not an identified person. A similarity score is not proof of identity: false matches and "
          "false non-matches occur, error rates differ across demographic groups, and poor image quality lowers reliability. "
          "Treat candidates as leads that need independent human verification.")
DECISIONS = ("rejected", "inconclusive", "needs_independent_verification")


class AnalyzeIn(BaseModel):
    sample_every_s: float = Field(default=1.0, ge=0.1, le=30)
    score_threshold: float = Field(default=0.7, ge=0.3, le=0.99)


class MatchIn(BaseModel):
    frame: int = 0
    face_index: int = Field(ge=0)
    top_k: int = Field(default=5, ge=1, le=10)


class ReviewIn(BaseModel):
    decision: str
    note: str = Field(default="", max_length=1000)


@router.get("/vision/status")
def status(user=Depends(security.viewer)):
    return vision.engine.status() | {"limits": LIMITS, "min_face_px": vision.MIN_FACE_PX}


def _strip(result):
    out = dict(result)
    out["frames"] = [{**f, "faces": [{**{k: v for k, v in x.items() if k != "det_row"}, "has_landmarks": bool(x.get("det_row"))}
                                      for x in f["faces"]]} for f in result["frames"]]
    return out


@router.post("/evidence/{eid}/analyze")
def analyze(eid: int, body: AnalyzeIn, user=Depends(security.investigator)):
    e = db.row("SELECT * FROM evidence WHERE id=?", (eid,))
    if not e:
        raise HTTPException(404, "Evidence not found")
    if e["kind"] not in ("image", "video"):
        raise HTTPException(400, "Only image or video evidence can be analysed")
    try:
        if e["kind"] == "image":
            result = vision.analyze_image(storage.get(e["stored_name"]), body.score_threshold)
        else:
            with storage.tempfile_of(e["stored_name"], ".vid") as p:
                result = vision.analyze_video(p, body.sample_every_s, body.score_threshold)
    except ValueError as ex:
        raise HTTPException(422, str(ex))
    det = vision.engine.detector_name
    aid = db.run("""INSERT INTO analyses(case_id,evidence_id,kind,detector,params_json,result_json,face_count_max,software_json,created_by,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?)""",
                 (e["case_id"], eid, e["kind"], det, json.dumps(body.model_dump()), json.dumps(result),
                  result["summary"]["max_faces"], json.dumps(vision.engine.software()), user["id"], db.now()))
    util.touch_case(e["case_id"])
    db.log(user, "face_detection", f"{e['original_name']}: max {result['summary']['max_faces']} face(s), detector {det}", e["case_id"], "analysis", aid)
    return {"id": aid, "limits": LIMITS}


def _an(aid):
    a = db.row("SELECT a.*, e.original_name, e.stored_name FROM analyses a JOIN evidence e ON e.id=a.evidence_id WHERE a.id=?", (aid,))
    if not a:
        raise HTTPException(404, "Analysis not found")
    a["result"] = db.loads(a["result_json"], {})
    return a


def _frame(a, frame):
    fr = next((f for f in a["result"]["frames"] if f["index"] == frame), None)
    if fr is None:
        raise HTTPException(404, "Frame was not part of this analysis")
    return fr


@router.get("/analyses")
def list_analyses(case_id: int | None = None, evidence_id: int | None = None, user=Depends(security.viewer)):
    sql = """SELECT a.id,a.case_id,a.evidence_id,a.kind,a.detector,a.face_count_max,a.created_at,e.original_name,u.username AS created_by_name,
             (SELECT COUNT(*) FROM matches m WHERE m.analysis_id=a.id) AS match_rows
             FROM analyses a JOIN evidence e ON e.id=a.evidence_id LEFT JOIN users u ON u.id=a.created_by WHERE 1=1"""
    args = []
    if case_id:
        sql += " AND a.case_id=?"; args.append(case_id)
    if evidence_id:
        sql += " AND a.evidence_id=?"; args.append(evidence_id)
    return db.rows(sql + " ORDER BY a.id DESC", args)


@router.get("/analyses/{aid}")
def get_analysis(aid: int, user=Depends(security.viewer)):
    a = _an(aid)
    return {"id": a["id"], "case_id": a["case_id"], "evidence_id": a["evidence_id"], "evidence_name": a["original_name"],
            "kind": a["kind"], "detector": a["detector"], "params": db.loads(a["params_json"], {}), "created_at": a["created_at"],
            "result": _strip(a["result"]), "software": db.loads(a["software_json"], {}), "limits": LIMITS}


@router.get("/analyses/{aid}/image")
def analysis_image(aid: int, frame: int = 0, annotated: int = 1, face: int = -1, user=Depends(security.viewer)):
    a = _an(aid)
    fr = _frame(a, frame)
    try:
        img = vision.read_frame(a["kind"], a["stored_name"], frame)
    except ValueError as ex:
        raise HTTPException(404, str(ex))
    data = vision.annotate(img, fr["faces"], face if face >= 0 else None) if annotated else vision.thumbnail(img, 1600)
    return Response(data, media_type="image/jpeg")


@router.get("/analyses/{aid}/face")
def analysis_face(aid: int, frame: int = 0, index: int = 0, user=Depends(security.viewer)):
    a = _an(aid)
    fr = _frame(a, frame)
    if not 0 <= index < len(fr["faces"]):
        raise HTTPException(404, "Face not found")
    return Response(vision.crop_face(vision.read_frame(a["kind"], a["stored_name"], frame), fr["faces"][index]), media_type="image/jpeg")


@router.delete("/analyses/{aid}")
def delete_analysis(aid: int, user=Depends(security.investigator)):
    a = _an(aid)
    db.run("DELETE FROM analyses WHERE id=?", (aid,))
    db.log(user, "analysis_deleted", f"analysis #{aid} ({a['original_name']})", a["case_id"], "analysis", aid)
    return {"deleted": aid}


# ------------------------------------------------------------ reference images
@router.get("/references")
def list_references(user=Depends(security.viewer)):
    today = date.today().isoformat()
    out = db.rows("""SELECT r.id,r.label,r.consent_ref,r.quality_json,r.is_demo,r.review_by,r.created_at,u.username AS created_by_name
                     FROM reference_images r LEFT JOIN users u ON u.id=r.created_by ORDER BY r.id DESC""")
    for r in out:
        r["quality"] = db.loads(r.pop("quality_json"), {})
        r["expired"] = r["review_by"] < today
    return out


@router.post("/references")
def enroll(image: UploadFile = File(...), label: str = Form(""), consent_ref: str = Form(""), consent_confirmed: str = Form("0"),
           is_demo: str = Form("1"), retention_days: int = Form(config.REFERENCE_RETENTION_DAYS), user=Depends(security.investigator)):
    if not vision.engine.matching_available:
        raise HTTPException(501, "Matching models are not installed. Run `python scripts/fetch_models.py` and restart.")
    if not util.truthy(consent_confirmed) or not consent_ref.strip():
        raise HTTPException(400, "Documented consent (with a consent reference) is required to enrol a reference image")
    if not label.strip():
        raise HTTPException(422, "A label (pseudonym or code) is required")
    if not 1 <= retention_days <= 365:
        raise HTTPException(422, "retention_days must be 1-365")
    try:
        img = vision.decode_image(util.read_upload(image, 15 * 1024 * 1024))
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    faces = vision.engine.detect(img)
    if len(faces) != 1:
        raise HTTPException(422, f"Reference image must contain exactly one face (found {len(faces)})")
    emb = vision.engine.embed(img, faces[0])
    rid = db.run("""INSERT INTO reference_images(label,consent_ref,stored_name,embedding,quality_json,is_demo,review_by,created_by,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?)""",
                 (label.strip()[:80], consent_ref.strip()[:120], storage.put(vision.thumbnail(img, 640)), vision.pack_embedding(emb),
                  json.dumps(faces[0]["quality"]), int(util.truthy(is_demo)), (date.today() + timedelta(days=retention_days)).isoformat(),
                  user["id"], db.now()))
    db.log(user, "reference_enrolled", f"{label} (consent ref {consent_ref})", None, "reference", rid)
    return {"id": rid, "quality": faces[0]["quality"]}


@router.get("/references/{rid}/image")
def reference_image(rid: int, user=Depends(security.viewer)):
    r = db.row("SELECT stored_name FROM reference_images WHERE id=?", (rid,))
    if not r:
        raise HTTPException(404, "Not found")
    return Response(storage.get(r["stored_name"]), media_type="image/jpeg")


@router.delete("/references/{rid}")
def delete_reference(rid: int, user=Depends(security.investigator)):
    r = db.row("SELECT * FROM reference_images WHERE id=?", (rid,))
    if not r:
        raise HTTPException(404, "Not found")
    storage.delete(r["stored_name"])
    db.run("DELETE FROM reference_images WHERE id=?", (rid,))
    db.log(user, "reference_deleted", r["label"], None, "reference", rid)
    return {"deleted": rid}


@router.post("/references/purge-expired")
def purge_expired(user=Depends(security.admin)):
    old = db.rows("SELECT id,stored_name,label FROM reference_images WHERE review_by < ?", (date.today().isoformat(),))
    for r in old:
        storage.delete(r["stored_name"])
        db.run("DELETE FROM reference_images WHERE id=?", (r["id"],))
    db.log(user, "references_purged", f"{len(old)} expired reference image(s) deleted")
    return {"purged": len(old)}


# ---------------------------------------------------------------------- matching
@router.post("/analyses/{aid}/match")
def match(aid: int, body: MatchIn, user=Depends(security.investigator)):
    if not vision.engine.matching_available:
        raise HTTPException(501, "Matching models are not installed. Run `python scripts/fetch_models.py` and restart.")
    refs = db.rows("SELECT id,label,embedding FROM reference_images WHERE review_by >= ?", (date.today().isoformat(),))
    if not refs:
        raise HTTPException(400, "No unexpired consented reference images are enrolled")
    a = _an(aid)
    fr = _frame(a, body.frame)
    if body.face_index >= len(fr["faces"]):
        raise HTTPException(404, "Face not found")
    face = fr["faces"][body.face_index]
    try:
        emb = vision.engine.embed(vision.read_frame(a["kind"], a["stored_name"], body.frame), face)
    except (RuntimeError, ValueError) as ex:
        raise HTTPException(422, str(ex))
    scored = sorted(((vision.cosine(emb, vision.unpack_embedding(r["embedding"])), r) for r in refs), key=lambda x: -x[0])[:body.top_k]
    run_id, thr, now, out = uuid.uuid4().hex[:12], config.MATCH_COSINE_THRESHOLD, db.now(), []
    for rank, (score, r) in enumerate(scored, 1):
        mid = db.run("""INSERT INTO matches(analysis_id,frame,face_index,reference_id,reference_label,rank,score,threshold,above_threshold,run_id,created_by,created_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (aid, body.frame, body.face_index, r["id"], r["label"], rank, round(score, 4), thr, int(score >= thr), run_id, user["id"], now))
        out.append({"id": mid, "rank": rank, "reference_id": r["id"], "reference_label": r["label"], "score": round(score, 4), "above_threshold": score >= thr})
    db.log(user, "reference_match_run", f"analysis #{aid} frame {body.frame} face #{body.face_index + 1}: top score {out[0]['score']}", a["case_id"], "analysis", aid)
    return {"run_id": run_id, "threshold": thr, "face_quality": face["quality"], "candidates": out, "limits": LIMITS}


@router.get("/analyses/{aid}/matches")
def list_matches(aid: int, user=Depends(security.viewer)):
    _an(aid)
    return db.rows("""SELECT m.*, u.username AS decided_by_name, (SELECT 1 FROM reference_images r WHERE r.id=m.reference_id) AS reference_exists
                      FROM matches m LEFT JOIN users u ON u.id=m.decided_by WHERE analysis_id=? ORDER BY m.id DESC""", (aid,))


@router.patch("/matches/{mid}/review")
def review(mid: int, body: ReviewIn, user=Depends(security.investigator)):
    if body.decision not in DECISIONS:
        raise HTTPException(422, f"decision must be one of {DECISIONS}")
    m = db.row("SELECT m.*, a.case_id FROM matches m JOIN analyses a ON a.id=m.analysis_id WHERE m.id=?", (mid,))
    if not m:
        raise HTTPException(404, "Match not found")
    db.run("UPDATE matches SET decision=?,decision_note=?,decided_by=?,decided_at=? WHERE id=?", (body.decision, body.note, user["id"], db.now(), mid))
    db.log(user, "match_reviewed", f"candidate '{m['reference_label']}' (score {m['score']}): {body.decision}", m["case_id"], "match", mid)
    return {"ok": True}
