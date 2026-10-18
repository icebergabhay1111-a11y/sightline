"""Gaze Observation API: consent records, session save, review annotations, exports.

The browser does all video processing. This API accepts only numbers, labels from fixed allow-lists, markers,
consent metadata and reviewer notes. Payloads with any unexpected field (for example an image or a video frame) are
rejected, so raw video, screenshots, iris images or face embeddings cannot be stored through it.
"""
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .. import db, gaze, security, util

router = APIRouter(prefix="/api")
Strict = ConfigDict(extra="forbid")

HLabel = Literal["left", "center", "right", "unavailable"]
VLabel = Literal["up", "center", "down", "unavailable"]
Flag = Literal["low_light", "glare", "glasses_or_occlusion", "extreme_head_turn", "face_too_small", "motion_blur",
               "multiple_faces", "iris_not_visible", "camera_angle_issue"]
Tag = Literal["review_later", "technical_issue", "context_note", "not_relevant"]


class ConsentIn(BaseModel):
    model_config = Strict
    case_id: int
    interview_id: int | None = None
    subject_ref: str = Field(min_length=1, max_length=80)
    scope: Literal["gaze_observation", "heart_rate"]
    form_ref: str = Field(default="", max_length=120)
    confirmed: Literal[True]
    is_demo: bool = True


class SampleIn(BaseModel):
    model_config = Strict
    timestamp_ms: int = Field(ge=0, le=6 * 3600 * 1000)
    horizontal_label: HLabel
    vertical_label: VLabel
    horizontal_offset: float | None = Field(default=None, ge=-1, le=1)
    vertical_offset: float | None = Field(default=None, ge=-1, le=1)
    stability_ms: int = Field(default=0, ge=0)
    shift_event: bool = False
    blink_event: bool = False
    eyes_closed: bool = False
    eyes_closed_event: bool = False
    closed_duration_ms: int | None = Field(default=None, ge=0, le=600000)
    head_yaw: float | None = Field(default=None, ge=-180, le=180)
    head_pitch: float | None = Field(default=None, ge=-180, le=180)
    head_roll: float | None = Field(default=None, ge=-180, le=180)
    face_visible: bool
    tracking_confidence: float = Field(ge=0, le=1)
    quality_flags: list[Flag] = Field(default_factory=list, max_length=9)
    question_marker_id: int | None = None

    @model_validator(mode="after")
    def unavailable_rules(self):
        avail_h, avail_v = self.horizontal_label != "unavailable", self.vertical_label != "unavailable"
        if avail_h != avail_v:
            raise ValueError("horizontal and vertical labels must be both available or both unavailable")
        if avail_h:
            blocked = (not self.face_visible or self.eyes_closed or self.tracking_confidence < gaze.MIN_CONFIDENCE
                       or any(f in gaze.BLOCKING_FLAGS for f in self.quality_flags))
            if blocked:
                raise ValueError("direction must be 'unavailable' when the face is not visible, eyes are closed, confidence is "
                                 f"below {gaze.MIN_CONFIDENCE}, or flags {', '.join(gaze.BLOCKING_FLAGS)} are present")
            if self.horizontal_offset is None or self.vertical_offset is None:
                raise ValueError("offsets are required when a direction is reported")
        elif self.horizontal_offset is not None or self.vertical_offset is not None:
            raise ValueError("offsets must be empty when the direction is unavailable")
        return self


class MarkerIn(BaseModel):
    model_config = Strict
    timestamp_ms: int = Field(ge=0)
    marker_type: Literal["question", "manual", "pause", "resume", "calibration", "camera_lost", "consent_withdrawn"]
    text: str = Field(default="", max_length=300)
    question_marker_id: int | None = None


class HeartRateIn(BaseModel):
    model_config = Strict
    timestamp_ms: int = Field(ge=0)
    bpm: int = Field(ge=20, le=250)
    contact: bool | None = None
    rr_ms: list[int] = Field(default_factory=list, max_length=12)


class CalibrationIn(BaseModel):
    model_config = Strict
    status: Literal["completed", "poor", "skipped"]
    offset_h: float = Field(default=0, ge=-1, le=1)
    offset_v: float = Field(default=0, ge=-1, le=1)
    usable_fraction: float | None = Field(default=None, ge=0, le=1)
    spread_h: float | None = None
    spread_v: float | None = None
    samples: int = Field(default=0, ge=0)
    duration_ms: int = Field(default=0, ge=0)


class SessionIn(BaseModel):
    model_config = Strict
    case_id: int
    interview_id: int | None = None
    consent_id: int
    hr_consent_id: int | None = None
    started_at: str = Field(max_length=40)
    ended_at: str = Field(max_length=40)
    source_type: Literal["webcam", "file"]
    source_name: str = Field(default="", max_length=200)
    calibration: CalibrationIn
    settings_version: str = Field(max_length=40)
    settings: dict = Field(default_factory=dict)
    software: dict = Field(default_factory=dict)
    glasses_declared: bool = False
    is_demo: bool = True
    samples: list[SampleIn] = Field(min_length=1, max_length=72000)
    markers: list[MarkerIn] = Field(default_factory=list, max_length=5000)
    heart_rate: list[HeartRateIn] = Field(default_factory=list, max_length=30000)

    @model_validator(mode="after")
    def metadata_is_small_and_textual(self):
        for name, obj in (("settings", self.settings), ("software", self.software)):
            raw = json.dumps(obj)
            if len(raw) > 8000:
                raise ValueError(f"{name} is too large")
            if "data:image" in raw or "data:video" in raw or "base64" in raw.lower():
                raise ValueError(f"{name} must not contain media data")
        return self


class AnnotationIn(BaseModel):
    model_config = Strict
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    tag: Tag
    note: str = Field(default="", max_length=2000)


# ------------------------------------------------------------------------------------------------- config
@router.get("/gaze/config")
def config_(user=Depends(security.viewer)):
    return {"settings_version": gaze.SETTINGS_VERSION, "disclaimers": gaze.disclaimers(), "consent_text": gaze.CONSENT_TEXT,
            "consent_version": gaze.CONSENT_VERSION, "review_tags": gaze.REVIEW_TAGS, "quality_flags": gaze.QUALITY_FLAGS,
            "min_confidence": gaze.MIN_CONFIDENCE, "dominant_min_usable": gaze.DOMINANT_MIN_USABLE}


# ----------------------------------------------------------------------------------------------- consents
def _consent(cid):
    c = db.row("SELECT * FROM consents WHERE id=?", (cid,))
    if not c:
        raise HTTPException(404, "Consent record not found")
    return c


@router.post("/consents")
def create_consent(body: ConsentIn, user=Depends(security.investigator)):
    util.case_or_404(body.case_id)
    if body.interview_id and not db.row("SELECT 1 FROM interviews WHERE id=? AND case_id=?", (body.interview_id, body.case_id)):
        raise HTTPException(404, "Interview not found in this case")
    cid = gaze.create_consent_record(body.case_id, body.interview_id, body.subject_ref.strip(), body.scope, body.form_ref.strip(),
                                     body.is_demo, user["id"])
    db.log(user, "consent_recorded", f"{body.scope} for {body.subject_ref} (form {body.form_ref or '-'})", body.case_id, "consent", cid)
    return {"id": cid, "statement": gaze.CONSENT_TEXT[body.scope]}


@router.get("/consents")
def list_consents(case_id: int, user=Depends(security.viewer)):
    return db.rows("""SELECT c.id,c.scope,c.subject_ref,c.form_ref,c.statement_version,c.confirmed_at,c.withdrawn_at,c.interview_id,
                      u.username AS confirmed_by_name FROM consents c LEFT JOIN users u ON u.id=c.confirmed_by WHERE case_id=? ORDER BY c.id DESC""", (case_id,))


@router.post("/consents/{cid}/withdraw")
def withdraw_consent(cid: int, delete_data: bool = Query(default=True), user=Depends(security.investigator)):
    c = _consent(cid)
    if not c["withdrawn_at"]:
        db.run("UPDATE consents SET withdrawn_at=?, withdrawn_by=? WHERE id=?", (db.now(), user["id"], cid))
    deleted = 0
    if delete_data:
        if c["scope"] == "gaze_observation":
            deleted = db.row("SELECT COUNT(*) AS n FROM obs_sessions WHERE consent_id=?", (cid,))["n"]
            db.run("DELETE FROM obs_sessions WHERE consent_id=?", (cid,))
        else:
            for r in db.rows("SELECT id FROM obs_sessions WHERE hr_consent_id=?", (cid,)):
                db.run("DELETE FROM hr_samples WHERE session_id=?", (r["id"],))
                deleted += 1
    db.log(user, "consent_withdrawn", f"{c['scope']} consent #{cid}; saved data deleted from {deleted} session(s)" if delete_data
           else f"{c['scope']} consent #{cid}; saved data kept", c["case_id"], "consent", cid)
    return {"withdrawn": cid, "sessions_affected": deleted}


def _check_consent(cid, scope, case_id, interview_id):
    c = db.row("SELECT * FROM consents WHERE id=?", (cid,))
    if not c:
        raise HTTPException(403, f"A recorded {scope.replace('_', ' ')} consent is required")
    if c["scope"] != scope:
        raise HTTPException(403, f"Consent #{cid} does not cover {scope.replace('_', ' ')}")
    if c["case_id"] != case_id:
        raise HTTPException(403, "Consent belongs to a different case")
    if interview_id and c["interview_id"] and c["interview_id"] != interview_id:
        raise HTTPException(403, "Consent belongs to a different interview")
    if c["withdrawn_at"]:
        raise HTTPException(403, "Consent has been withdrawn; this data cannot be saved")
    return c


# ----------------------------------------------------------------------------------------------- sessions
@router.post("/gaze/sessions")
def save_session(body: SessionIn, user=Depends(security.investigator)):
    util.case_or_404(body.case_id)
    if body.interview_id and not db.row("SELECT 1 FROM interviews WHERE id=? AND case_id=?", (body.interview_id, body.case_id)):
        raise HTTPException(404, "Interview not found in this case")
    _check_consent(body.consent_id, "gaze_observation", body.case_id, body.interview_id)
    if body.heart_rate:
        if not body.hr_consent_id:
            raise HTTPException(403, "Heart-rate readings need their own recorded consent")
        _check_consent(body.hr_consent_id, "heart_rate", body.case_id, body.interview_id)
    samples = [s.model_dump() for s in body.samples]
    markers = [m.model_dump() for m in body.markers]
    hr = [r.model_dump() for r in body.heart_rate]
    meta = body.model_dump(exclude={"samples", "markers", "heart_rate"})
    sid, summary, duration = gaze.store_session(meta, samples, markers, hr, user["id"])
    util.touch_case(body.case_id)
    o = summary["overall"]
    db.log(user, "gaze_session_saved", f"{body.source_type}, {duration / 1000:.0f} s, {len(samples)} samples, usable {o['usable_pct']}%, "
           f"calibration {body.calibration.status}" + (f", {len(hr)} heart-rate readings" if hr else ""), body.case_id, "gaze_session", sid)
    return {"id": sid, "summary": summary}


@router.get("/gaze/sessions")
def list_sessions(case_id: int | None = None, interview_id: int | None = None, user=Depends(security.viewer)):
    sql = """SELECT o.id,o.case_id,c.case_number,o.interview_id,o.source_type,o.source_name,o.started_at,o.duration_ms,o.sample_count,
             o.calibration_status,o.summary_json,o.is_demo,o.created_at,(SELECT COUNT(*) FROM hr_samples h WHERE h.session_id=o.id) AS hr_count,
             (SELECT COUNT(*) FROM reviewer_annotations a WHERE a.session_id=o.id) AS annotation_count
             FROM obs_sessions o JOIN cases c ON c.id=o.case_id WHERE 1=1"""
    args = []
    if case_id:
        sql += " AND o.case_id=?"; args.append(case_id)
    if interview_id:
        sql += " AND o.interview_id=?"; args.append(interview_id)
    out = db.rows(sql + " ORDER BY o.id DESC", args)
    for o in out:
        s = db.loads(o.pop("summary_json"), {})
        o["usable_pct"] = (s.get("overall") or {}).get("usable_pct")
    return out


def _session(sid, with_samples=True):
    s = gaze.load_session(sid, with_samples)
    if not s:
        raise HTTPException(404, "Gaze session not found")
    return s


@router.get("/gaze/sessions/{sid}")
def get_session(sid: int, user=Depends(security.viewer)):
    s = _session(sid)
    s["disclaimers"] = gaze.disclaimers()
    s["review_tags"] = gaze.REVIEW_TAGS
    return s


@router.delete("/gaze/sessions/{sid}")
def delete_session(sid: int, user=Depends(security.investigator)):
    s = _session(sid, with_samples=False)
    db.run("DELETE FROM obs_sessions WHERE id=?", (sid,))
    db.log(user, "gaze_session_deleted", f"#{sid}", s["case_id"], "gaze_session", sid)
    return {"deleted": sid}


@router.get("/gaze/sessions/{sid}/export.csv")
def export_csv(sid: int, kind: Literal["gaze", "heart_rate"] = "gaze", user=Depends(security.viewer)):
    s = _session(sid)
    data = gaze.to_csv(s["samples"]) if kind == "gaze" else gaze.hr_to_csv(s["heart_rate"])
    db.log(user, "gaze_exported", f"session #{sid} {kind} CSV", s["case_id"], "gaze_session", sid)
    name = f"gaze-session-{sid}.csv" if kind == "gaze" else f"gaze-session-{sid}-heart-rate.csv"
    return Response(data, media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/gaze/sessions/{sid}/export.json")
def export_json(sid: int, user=Depends(security.viewer)):
    s = _session(sid)
    db.log(user, "gaze_exported", f"session #{sid} JSON v{gaze.SCHEMA_VERSION}", s["case_id"], "gaze_session", sid)
    return JSONResponse(gaze.to_json(s), headers={"Content-Disposition": f'attachment; filename="gaze-session-{sid}.json"'})


# -------------------------------------------------------------------------------------------- annotations
@router.post("/gaze/sessions/{sid}/annotations")
def add_annotation(sid: int, body: AnnotationIn, user=Depends(security.investigator)):
    s = _session(sid, with_samples=False)
    if body.end_ms < body.start_ms:
        raise HTTPException(422, "end_ms must not be before start_ms")
    aid = db.run("INSERT INTO reviewer_annotations(session_id,start_ms,end_ms,tag,note,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
                 (sid, body.start_ms, body.end_ms, body.tag, body.note.strip(), user["id"], db.now()))
    db.log(user, "gaze_annotation", f"session #{sid} {body.start_ms / 1000:.1f}-{body.end_ms / 1000:.1f} s: {gaze.REVIEW_TAGS[body.tag]}",
           s["case_id"], "gaze_session", sid)
    return {"id": aid}


@router.delete("/gaze/annotations/{aid}")
def delete_annotation(aid: int, user=Depends(security.investigator)):
    a = db.row("SELECT a.*, o.case_id FROM reviewer_annotations a JOIN obs_sessions o ON o.id=a.session_id WHERE a.id=?", (aid,))
    if not a:
        raise HTTPException(404, "Annotation not found")
    db.run("DELETE FROM reviewer_annotations WHERE id=?", (aid,))
    db.log(user, "gaze_annotation_deleted", f"#{aid}", a["case_id"], "gaze_session", a["session_id"])
    return {"deleted": aid}
