import json

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import db, security, util

router = APIRouter(prefix="/api")
SERIES_KEYS = ["t", "face", "yaw", "pitch", "roll", "energy", "brightness", "sharpness", "blink", "gaze_x", "gaze_y", "mouth_open"]
MAX_POINTS, MAX_EVENTS = 40000, 5000


class ObsIn(BaseModel):
    case_id: int
    interview_id: int | None = None
    source: str = Field(pattern="^(webcam|file)$")
    source_name: str = Field(default="", max_length=200)
    started_at: str | None = None
    duration_s: float = Field(ge=0, le=6 * 3600)
    consent_confirmed: bool = False
    series: dict[str, list[float | int | None]]
    events: list[dict] = Field(default_factory=list)
    software: dict = Field(default_factory=dict)
    is_demo: bool = True


class ObsPatch(BaseModel):
    interpretation_note: str = Field(max_length=4000)


def _arr(series, key):
    return np.array([np.nan if v is None else v for v in series.get(key, [])], dtype=float)


def summarize(series, events, duration):
    n = len(series.get("t", []))
    face = _arr(series, "face")
    tracked = float(np.nanmean(face)) if n and face.size else 0.0
    tracked_time = tracked * duration
    blinks = sum(1 for e in events if e.get("type") == "blink")

    def rng(k):
        a = _arr(series, k)
        a = a[~np.isnan(a)]
        return [round(float(a.min()), 1), round(float(a.max()), 1)] if a.size else None

    def mean(k):
        a = _arr(series, k)
        a = a[~np.isnan(a)]
        return round(float(a.mean()), 1) if a.size else None

    count = lambda t: sum(1 for e in events if e.get("type") == t)
    return {"samples": n, "tracked_fraction": round(tracked, 3), "blink_count": blinks,
            "blink_rate_per_min": round(blinks / (tracked_time / 60), 1) if tracked_time >= 10 else None,
            "head_turn_count": count("head_turn"), "movement_burst_count": count("movement_burst"),
            "tracking_lost_count": count("tracking_lost"), "low_light_count": count("low_light"),
            "yaw_range": rng("yaw"), "pitch_range": rng("pitch"), "roll_range": rng("roll"),
            "mean_brightness": mean("brightness"), "mean_sharpness": mean("sharpness"),
            "note": "Measurements only. They do not indicate deception, emotion or guilt."}


@router.post("/observations")
def create(body: ObsIn, user=Depends(security.investigator)):
    util.case_or_404(body.case_id)
    if body.source == "webcam" and not body.consent_confirmed:
        raise HTTPException(400, "Consent for webcam capture must be confirmed")
    if body.interview_id and not db.row("SELECT 1 FROM interviews WHERE id=? AND case_id=?", (body.interview_id, body.case_id)):
        raise HTTPException(404, "Interview not found in this case")
    n = len(body.series.get("t", []))
    if n == 0 or n > MAX_POINTS or len(body.events) > MAX_EVENTS:
        raise HTTPException(422, "Series empty or too large")
    series = {k: v for k, v in body.series.items() if k in SERIES_KEYS}
    if any(len(v) != n for v in series.values()):
        raise HTTPException(422, "All series must have the same length as 't'")
    events = [{"t": float(e.get("t", 0)), "type": str(e.get("type", ""))[:30], "detail": str(e.get("detail", ""))[:200],
               **({"duration": float(e["duration"])} if e.get("duration") is not None else {})} for e in body.events]
    summ = summarize(series, events, body.duration_s)
    oid = db.run("""INSERT INTO observations(case_id,interview_id,source,source_name,started_at,duration_s,series_json,events_json,summary_json,software_json,is_demo,created_by,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                 (body.case_id, body.interview_id, body.source, body.source_name, body.started_at, body.duration_s, json.dumps(series),
                  json.dumps(events), json.dumps(summ), json.dumps(body.software), int(body.is_demo), user["id"], db.now()))
    util.touch_case(body.case_id)
    db.log(user, "observation_saved", f"{body.source} {body.duration_s:.0f}s, {summ['blink_count']} blink events", body.case_id, "observation", oid)
    return {"id": oid, "summary": summ}


@router.get("/observations")
def list_obs(case_id: int | None = None, interview_id: int | None = None, user=Depends(security.viewer)):
    sql, args = """SELECT o.id,o.case_id,c.case_number,o.interview_id,o.source,o.source_name,o.duration_s,o.summary_json,o.is_demo,o.created_at
                   FROM observations o JOIN cases c ON c.id=o.case_id WHERE 1=1""", []
    if case_id:
        sql += " AND o.case_id=?"; args.append(case_id)
    if interview_id:
        sql += " AND o.interview_id=?"; args.append(interview_id)
    out = db.rows(sql + " ORDER BY o.id DESC", args)
    for o in out:
        o["summary"] = db.loads(o.pop("summary_json"), {})
    return out


@router.get("/observations/{oid}")
def get(oid: int, user=Depends(security.viewer)):
    o = db.row("SELECT * FROM observations WHERE id=?", (oid,))
    if not o:
        raise HTTPException(404, "Observation not found")
    for k in ("series", "events", "summary", "software"):
        o[k] = db.loads(o.pop(k + "_json"), [] if k == "events" else {})
    return o


@router.patch("/observations/{oid}")
def patch(oid: int, body: ObsPatch, user=Depends(security.investigator)):
    o = db.row("SELECT case_id FROM observations WHERE id=?", (oid,))
    if not o:
        raise HTTPException(404, "Observation not found")
    db.run("UPDATE observations SET interpretation_note=? WHERE id=?", (body.interpretation_note, oid))
    db.log(user, "observation_note", "interpretation note edited", o["case_id"], "observation", oid)
    return {"ok": True}


@router.delete("/observations/{oid}")
def delete(oid: int, user=Depends(security.investigator)):
    o = db.row("SELECT case_id FROM observations WHERE id=?", (oid,))
    if not o:
        raise HTTPException(404, "Observation not found")
    db.run("DELETE FROM observations WHERE id=?", (oid,))
    db.log(user, "observation_deleted", f"#{oid}", o["case_id"], "observation", oid)
    return {"deleted": oid}
