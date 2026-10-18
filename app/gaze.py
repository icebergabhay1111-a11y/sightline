"""Gaze Observation: shared constants, loading, per-question summaries and exports.

Measurement only. Nothing in this module derives a judgement about honesty, credibility, intent, emotion or mental
state, and nothing here produces a score, rank or alert about a person.
"""
import csv
import io
import json
from collections import Counter

from . import APP_NAME, APP_VERSION, db

SETTINGS_VERSION = "gaze-1.0"
SCHEMA = "sightline.gaze-session"
SCHEMA_VERSION = 1

# ---- exact wording required by the module specification
STATUS_TEXT = "Measuring visible gaze direction and tracking quality only."
SUMMARY_DISCLAIMER = ("Measurements describe camera-observed movement only. They do not show what a person is thinking "
                      "or whether an answer is truthful.")
REPORT_DISCLAIMER = ("Eye and gaze measurements are affected by camera position, lighting, glasses, head movement, fatigue, "
                     "and many other factors. They must not be used to infer truthfulness, deception, guilt, intent, or mental state.")
DIRECTION_NOTE = ("Direction estimates can be affected by camera placement, lighting, glasses, head position, distance, "
                  "and tracking quality.")
PROTOTYPE_NOTE = "Academic prototype. Eye movement does not establish truthfulness or deception."
HR_NOTE = ("Heart rate changes with movement, posture, speaking, temperature, caffeine, fitness, illness and nerves. "
           "It must not be used to infer truthfulness, deception, guilt, intent, or mental state.")
DIRECTION_CONVENTION = ("Left/right are from the subject's own point of view. Offsets run from -1 (subject's left / down) "
                        "to +1 (subject's right / up).")
CONFIDENCE_NOTE = ("Tracking confidence is a heuristic 0-1 quality estimate (face size, head angle, light, blur, agreement "
                   "between the eyes, calibration). It is not a model probability and says nothing about the person.")

CONSENT_TEXT = {
    "gaze_observation": ("I agree that the webcam (or the named recording) may be analysed in this browser to measure visible "
                         "eye and head movement during this session. No video, images or face templates are stored; only "
                         "time-stamped numbers, quality data, markers and reviewer notes. I can withdraw at any time, which "
                         "stops capture, and I can ask for the saved measurements to be deleted."),
    "heart_rate": ("I agree that heart-rate readings from a Bluetooth sensor I am wearing may be recorded during this session as "
                   "time-stamped numbers. I understand heart rate does not show whether anyone is telling the truth. I can "
                   "withdraw at any time, which stops the recording."),
}
CONSENT_VERSION = "1.0"

H_LABELS = ("left", "center", "right", "unavailable")
V_LABELS = ("up", "center", "down", "unavailable")
QUALITY_FLAGS = ("low_light", "glare", "glasses_or_occlusion", "extreme_head_turn", "face_too_small", "motion_blur",
                 "multiple_faces", "iris_not_visible", "camera_angle_issue")
BLOCKING_FLAGS = ("multiple_faces", "extreme_head_turn", "iris_not_visible")
MARKER_TYPES = ("question", "manual", "pause", "resume", "calibration", "camera_lost", "consent_withdrawn")
REVIEW_TAGS = {"review_later": "Review later", "technical_issue": "Technical issue", "context_note": "Context note",
               "not_relevant": "Not relevant"}
MIN_CONFIDENCE = 0.5
DOMINANT_MIN_USABLE = 0.6
FLAG_WARNING_SHARE = 0.2

SAMPLE_FIELDS = ["timestamp_ms", "horizontal_label", "vertical_label", "horizontal_offset", "vertical_offset", "stability_ms",
                 "shift_event", "blink_event", "eyes_closed", "eyes_closed_event", "closed_duration_ms", "head_yaw",
                 "head_pitch", "head_roll", "face_visible", "tracking_confidence", "quality_flags", "question_marker_id"]
BOOL_FIELDS = {"shift_event", "blink_event", "eyes_closed", "eyes_closed_event", "face_visible"}
CONTENT_TYPES = {
    "measured": ["timestamp_ms", "stability_ms", "blink_event", "eyes_closed", "eyes_closed_event", "closed_duration_ms",
                 "head_yaw", "head_pitch", "head_roll", "face_visible", "quality_flags", "markers", "heart_rate", "calibration"],
    "model_output": ["horizontal_label", "vertical_label", "horizontal_offset", "vertical_offset", "shift_event",
                     "tracking_confidence", "per_question_summary.dominant_direction"],
    "human_entered": ["annotations", "manual marker text", "consent records", "glasses_declared"],
}


def disclaimers():
    return {"status": STATUS_TEXT, "summary": SUMMARY_DISCLAIMER, "report": REPORT_DISCLAIMER, "direction": DIRECTION_NOTE,
            "prototype": PROTOTYPE_NOTE, "heart_rate": HR_NOTE, "convention": DIRECTION_CONVENTION, "confidence": CONFIDENCE_NOTE}


# ------------------------------------------------------------------------------------------------ loading
def _sample_row(r):
    d = {k: r[k] for k in SAMPLE_FIELDS}
    for k in BOOL_FIELDS:
        d[k] = bool(d[k])
    d["quality_flags"] = [f for f in (r["quality_flags"] or "").split(";") if f]
    return d


def load_session(sid, with_samples=True):
    s = db.row("""SELECT o.*, u.username AS created_by_name, c.case_number FROM obs_sessions o
                  LEFT JOIN users u ON u.id=o.created_by JOIN cases c ON c.id=o.case_id WHERE o.id=?""", (sid,))
    if not s:
        return None
    for k in ("calibration", "settings", "software", "summary"):
        s[k] = db.loads(s.pop(k + "_json"), {})
    s["consent"] = db.row("SELECT id,scope,subject_ref,statement,statement_version,form_ref,confirmed_at,withdrawn_at FROM consents WHERE id=?",
                          (s["consent_id"],))
    s["hr_consent"] = db.row("SELECT id,scope,subject_ref,statement,statement_version,form_ref,confirmed_at,withdrawn_at FROM consents WHERE id=?",
                             (s["hr_consent_id"],)) if s["hr_consent_id"] else None
    s["markers"] = db.rows("SELECT m.id,m.timestamp_ms,m.marker_type,m.text,m.question_marker_id,u.username AS created_by_name "
                           "FROM obs_markers m LEFT JOIN users u ON u.id=m.created_by WHERE m.session_id=? ORDER BY m.timestamp_ms,m.id", (sid,))
    s["annotations"] = db.rows("SELECT a.*, u.username AS created_by_name FROM reviewer_annotations a LEFT JOIN users u ON u.id=a.created_by "
                               "WHERE a.session_id=? ORDER BY a.start_ms,a.id", (sid,))
    for a in s["annotations"]:
        a["tag_label"] = REVIEW_TAGS.get(a["tag"], a["tag"])
    if with_samples:
        s["samples"] = [_sample_row(r) for r in db.rows("SELECT * FROM gaze_samples WHERE session_id=? ORDER BY timestamp_ms,id", (sid,))]
        s["heart_rate"] = [{"timestamp_ms": r["timestamp_ms"], "bpm": r["bpm"], "contact": None if r["contact"] is None else bool(r["contact"]),
                            "rr_ms": [int(x) for x in (r["rr_ms"] or "").split(";") if x]}
                           for r in db.rows("SELECT * FROM hr_samples WHERE session_id=? ORDER BY timestamp_ms,id", (sid,))]
    return s


# ---------------------------------------------------------------------------------------------- summaries
def _interval(samples):
    if len(samples) < 2:
        return 100
    d = sorted(b["timestamp_ms"] - a["timestamp_ms"] for a, b in zip(samples, samples[1:]) if b["timestamp_ms"] > a["timestamp_ms"])
    return d[len(d) // 2] if d else 100


def _usable(x):
    return x["horizontal_label"] != "unavailable" and x["vertical_label"] != "unavailable"


def summarize_group(samples, hr=None, calibration_status="skipped", interval=None):
    n = len(samples)
    if not n:
        return None
    interval = interval or _interval(samples)
    usable = [x for x in samples if _usable(x)]
    share = len(usable) / n
    out = {
        "samples": n,
        "start_ms": samples[0]["timestamp_ms"],
        "end_ms": samples[-1]["timestamp_ms"],
        "duration_ms": samples[-1]["timestamp_ms"] - samples[0]["timestamp_ms"] + interval,
        "usable_pct": round(100 * share, 1),
        "unavailable_pct": round(100 * (1 - share), 1),
        "gaze_shift_count": sum(1 for x in samples if x["shift_event"]),
        "blink_count": sum(1 for x in samples if x["blink_event"]),
        "eye_closed_total_ms": sum(x["closed_duration_ms"] or 0 for x in samples),
        "prolonged_closure_count": sum(1 for x in samples if x["eyes_closed_event"]),
        "face_visible_pct": round(100 * sum(1 for x in samples if x["face_visible"]) / n, 1),
    }
    if share >= DOMINANT_MIN_USABLE and usable:
        hc = Counter(x["horizontal_label"] for x in usable).most_common(1)[0]
        vc = Counter(x["vertical_label"] for x in usable).most_common(1)[0]
        out["dominant_direction"] = {"horizontal": hc[0], "horizontal_share_pct": round(100 * hc[1] / len(usable), 1),
                                     "vertical": vc[0], "vertical_share_pct": round(100 * vc[1] / len(usable), 1)}
        out["dominant_note"] = f"Most frequent measured direction among usable samples (usable tracking {out['usable_pct']}%)."
    else:
        out["dominant_direction"] = None
        out["dominant_note"] = (f"Not shown: usable tracking {out['usable_pct']}% is below the {int(DOMINANT_MIN_USABLE * 100)}% "
                                "needed for a clear majority.")
    warnings = []
    flags = Counter(f for x in samples for f in x["quality_flags"])
    for f, c in sorted(flags.items(), key=lambda kv: -kv[1]):
        if c / n >= FLAG_WARNING_SHARE:
            warnings.append(f"{f.replace('_', ' ')} in {round(100 * c / n)}% of samples")
    if share < DOMINANT_MIN_USABLE:
        warnings.append(f"usable tracking only {out['usable_pct']}%")
    if calibration_status != "completed":
        warnings.append(f"camera-position calibration {calibration_status}: direction estimates are not corrected for camera placement")
    out["quality_warnings"] = warnings
    if hr:
        inside = [r for r in hr if out["start_ms"] <= r["timestamp_ms"] <= out["end_ms"] + interval]
        if inside:
            b = [r["bpm"] for r in inside]
            cont = [r["contact"] for r in inside if r["contact"] is not None]
            out["heart_rate"] = {"readings": len(b), "mean_bpm": round(sum(b) / len(b), 1), "min_bpm": min(b), "max_bpm": max(b),
                                 "sensor_contact_pct": round(100 * sum(cont) / len(cont), 1) if cont else None}
    return out


def summarize(samples, markers, hr=None, calibration_status="skipped"):
    """Per-question summary plus an all-session summary. Grouped by question_marker_id carried on each sample."""
    interval = _interval(samples)
    qtext = {}
    for m in markers or []:
        if m["marker_type"] == "question" and m.get("question_marker_id") is not None:
            qtext.setdefault(m["question_marker_id"], m["text"])
    groups = {}
    for x in samples:
        groups.setdefault(x["question_marker_id"], []).append(x)
    per_q = []
    for qid in sorted(groups, key=lambda k: (k is None, k if k is not None else 0)):
        g = summarize_group(groups[qid], hr, calibration_status, interval)
        g["question_marker_id"] = qid
        g["question_text"] = qtext.get(qid, "") if qid is not None else "Outside any question marker"
        per_q.append(g)
    return {"overall": summarize_group(samples, hr, calibration_status, interval), "per_question": per_q,
            "sample_interval_ms": interval, "disclaimer": SUMMARY_DISCLAIMER}


# ------------------------------------------------------------------------------------------------- exports
def to_csv(samples):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(SAMPLE_FIELDS)
    for x in samples:
        row = []
        for k in SAMPLE_FIELDS:
            v = x[k]
            if k == "quality_flags":
                v = ";".join(v)
            elif k in BOOL_FIELDS:
                v = int(bool(v))
            row.append("" if v is None else v)
        w.writerow(row)
    return buf.getvalue()


def hr_to_csv(hr):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["timestamp_ms", "bpm", "sensor_contact", "rr_intervals_ms"])
    for r in hr:
        w.writerow([r["timestamp_ms"], r["bpm"], "" if r["contact"] is None else int(r["contact"]), ";".join(map(str, r["rr_ms"]))])
    return buf.getvalue()


def to_json(s):
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "exported_at": db.now(), "app": f"{APP_NAME} {APP_VERSION}",
        "disclaimers": disclaimers(), "content_types": CONTENT_TYPES,
        "session": {k: s[k] for k in ("id", "case_id", "case_number", "interview_id", "consent_id", "hr_consent_id", "started_at", "ended_at",
                                      "source_type", "source_name", "calibration_status", "settings_version", "glasses_declared",
                                      "duration_ms", "sample_count", "is_demo", "created_by_name", "created_at")},
        "consent": s["consent"], "heart_rate_consent": s["hr_consent"],
        "calibration": s["calibration"], "settings": s["settings"], "software": s["software"],
        "per_question_summary": s["summary"],
        "samples": s.get("samples", []), "markers": s["markers"], "annotations": s["annotations"], "heart_rate": s.get("heart_rate", []),
    }


def sessions_for_case(case_id):
    from . import config
    if not config.GAZE_ENABLED:          # module switched off: reports and exports leave the gaze section out
        return []
    out = []
    for r in db.rows("SELECT id FROM obs_sessions WHERE case_id=? ORDER BY id", (case_id,)):
        s = load_session(r["id"], with_samples=True)
        out.append(s)
    return out


def store_session(meta, samples, markers, hr, user_id):
    """Insert a validated session. meta keys: case_id, interview_id, consent_id, hr_consent_id, started_at, ended_at,
    source_type, source_name, calibration (dict with status), settings_version, settings, software, glasses_declared, is_demo."""
    samples = sorted(samples, key=lambda x: x["timestamp_ms"])
    hr = sorted(hr or [], key=lambda x: x["timestamp_ms"])
    status = meta["calibration"]["status"]
    summary = summarize(samples, markers, hr, status)
    duration = samples[-1]["timestamp_ms"] - samples[0]["timestamp_ms"] + summary["sample_interval_ms"]
    with db.conn() as c:
        sid = c.execute("""INSERT INTO obs_sessions(case_id,interview_id,consent_id,hr_consent_id,started_at,ended_at,source_type,source_name,
                           calibration_status,calibration_json,settings_version,settings_json,software_json,glasses_declared,duration_ms,
                           sample_count,summary_json,is_demo,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (meta["case_id"], meta.get("interview_id"), meta["consent_id"], meta.get("hr_consent_id") if hr else None,
                         meta["started_at"], meta["ended_at"], meta["source_type"], meta.get("source_name", ""), status,
                         json.dumps(meta["calibration"]), meta["settings_version"], json.dumps(meta.get("settings", {})),
                         json.dumps(meta.get("software", {})), int(bool(meta.get("glasses_declared"))), duration, len(samples),
                         json.dumps(summary), int(bool(meta.get("is_demo", True))), user_id, db.now())).lastrowid
        c.executemany(f"INSERT INTO gaze_samples(session_id,{','.join(SAMPLE_FIELDS)}) VALUES(?{',?' * len(SAMPLE_FIELDS)})",
                      [(sid, *[";".join(x[k]) if k == "quality_flags" else (int(bool(x[k])) if k in BOOL_FIELDS else x.get(k))
                               for k in SAMPLE_FIELDS]) for x in samples])
        c.executemany("INSERT INTO obs_markers(session_id,timestamp_ms,marker_type,text,question_marker_id,created_by) VALUES(?,?,?,?,?,?)",
                      [(sid, m["timestamp_ms"], m["marker_type"], m.get("text", ""), m.get("question_marker_id"), user_id) for m in markers])
        c.executemany("INSERT INTO hr_samples(session_id,timestamp_ms,bpm,contact,rr_ms) VALUES(?,?,?,?,?)",
                      [(sid, r["timestamp_ms"], r["bpm"], None if r.get("contact") is None else int(r["contact"]),
                        ";".join(map(str, r.get("rr_ms") or []))) for r in hr])
    return sid, summary, duration


def create_consent_record(case_id, interview_id, subject_ref, scope, form_ref, is_demo, user_id):
    return db.run("""INSERT INTO consents(case_id,interview_id,subject_ref,scope,statement,statement_version,form_ref,is_demo,confirmed_by,confirmed_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?)""",
                  (case_id, interview_id, subject_ref, scope, CONSENT_TEXT[scope], CONSENT_VERSION, form_ref, int(is_demo), user_id, db.now()))
