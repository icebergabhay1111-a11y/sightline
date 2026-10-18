"""Gaze Observation + heart-rate add-on: consent enforcement, no raw media, unavailable rules, summaries, exports,
reviewer tags, withdrawal, report disclaimers."""
import copy
import csv
import io
import os
import re
import subprocess
import tempfile

import pytest
from conftest import H

from app import gaze, gaze_demo

DEMO = gaze_demo.synthetic_session()


def consent(c, case_id, scope="gaze_observation", interview_id=None):
    r = c.post("/api/consents", json={"case_id": case_id, "interview_id": interview_id, "subject_ref": "S-T", "scope": scope,
                                      "form_ref": "CF-T", "confirmed": True}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def payload(case_id, consent_id, **kw):
    d = copy.deepcopy(DEMO)
    p = {"case_id": case_id, "consent_id": consent_id, "started_at": "2026-10-18T10:00:00+00:00", "ended_at": "2026-10-18T10:01:10+00:00",
         "source_type": "webcam", "source_name": "webcam", "calibration": d["calibration"], "settings_version": gaze.SETTINGS_VERSION,
         "settings": d["settings"], "software": d["software"], "samples": d["samples"], "markers": d["markers"], "heart_rate": []}
    p.update(kw)
    return p


def save(c, p):
    return c.post("/api/gaze/sessions", json=p, headers=H)


# ------------------------------------------------------------------------------------------------ consent
def test_consent_required_and_enforced(inv, viewer, new_case):
    assert save(inv, payload(new_case, 999999)).status_code == 403                       # no such consent
    other = inv.post("/api/cases", json={"title": "Other case"}, headers=H).json()["id"]
    assert save(inv, payload(new_case, consent(inv, other))).status_code == 403           # consent from another case
    assert save(inv, payload(new_case, consent(inv, new_case, "heart_rate"))).status_code == 403  # wrong scope
    cid = consent(inv, new_case)
    assert inv.post(f"/api/consents/{cid}/withdraw", params={"delete_data": "false"}, headers=H).status_code == 200
    r = save(inv, payload(new_case, cid))
    assert r.status_code == 403 and "withdrawn" in r.json()["detail"]
    bad = inv.post("/api/consents", json={"case_id": new_case, "subject_ref": "S", "scope": "gaze_observation", "confirmed": False}, headers=H)
    assert bad.status_code == 422
    assert viewer.post("/api/consents", json={"case_id": new_case, "subject_ref": "S", "scope": "gaze_observation", "confirmed": True},
                       headers=H).status_code == 403
    c2 = consent(inv, new_case)
    assert save(inv, payload(new_case, c2)).status_code == 200
    listed = inv.get("/api/consents", params={"case_id": new_case}).json()
    assert any(x["id"] == c2 and x["withdrawn_at"] is None for x in listed)


def test_heart_rate_needs_its_own_consent(inv, new_case):
    g = consent(inv, new_case)
    p = payload(new_case, g, heart_rate=DEMO["heart_rate"])
    r = save(inv, p)
    assert r.status_code == 403 and "Heart-rate" in r.json()["detail"]
    p["hr_consent_id"] = g                                                                  # gaze consent cannot cover HR
    assert save(inv, p).status_code == 403
    p["hr_consent_id"] = consent(inv, new_case, "heart_rate")
    r = save(inv, p)
    assert r.status_code == 200, r.text
    q = r.json()["summary"]["per_question"][0]
    assert q["heart_rate"]["readings"] > 5 and 60 < q["heart_rate"]["mean_bpm"] < 90


def test_withdrawal_deletes_saved_data_by_default(inv, new_case):
    g = consent(inv, new_case)
    sid = save(inv, payload(new_case, g)).json()["id"]
    assert inv.post(f"/api/consents/{g}/withdraw", headers=H).json()["sessions_affected"] == 1
    assert inv.get(f"/api/gaze/sessions/{sid}").status_code == 404
    from app import db
    assert db.row("SELECT COUNT(*) AS n FROM gaze_samples WHERE session_id=?", (sid,))["n"] == 0


# ------------------------------------------------------------------------------------- no raw media stored
def test_no_raw_video_or_images_accepted(inv, new_case):
    g = consent(inv, new_case)
    p = payload(new_case, g)
    p["samples"][0]["frame"] = "data:image/jpeg;base64,/9j/4AAQ"
    assert save(inv, p).status_code == 422
    p = payload(new_case, g, video="AAAA")
    assert save(inv, p).status_code == 422
    p = payload(new_case, g)
    p["markers"][0]["image"] = "x"
    assert save(inv, p).status_code == 422
    p = payload(new_case, g, settings={"preview": "data:image/png;base64,iVBOR"})
    assert save(inv, p).status_code == 422
    p = payload(new_case, g, software={"blob": "x" * 9000})
    assert save(inv, p).status_code == 422


def test_schema_has_no_binary_or_media_columns(app_client):
    from app import db
    for t in ("obs_sessions", "gaze_samples", "obs_markers", "reviewer_annotations", "hr_samples", "consents"):
        cols = db.rows(f"PRAGMA table_info({t})")
        assert cols, t
        for c in cols:
            assert "BLOB" not in (c["type"] or "").upper(), (t, c["name"])
            assert not re.search(r"image|video|frame|jpeg|png|embedding|iris_img|pupil", c["name"]), (t, c["name"])


# --------------------------------------------------------------------------------------- unavailable rules
@pytest.mark.parametrize("patch", [
    {"quality_flags": ["multiple_faces"]},
    {"quality_flags": ["extreme_head_turn"]},
    {"quality_flags": ["iris_not_visible"]},
    {"tracking_confidence": 0.3},
    {"face_visible": False},
    {"eyes_closed": True},
    {"vertical_label": "unavailable"},
    {"horizontal_offset": None},
])
def test_direction_must_be_unavailable_when_not_measurable(inv, new_case, patch):
    s = {"timestamp_ms": 0, "horizontal_label": "left", "vertical_label": "center", "horizontal_offset": -0.6, "vertical_offset": 0.0,
         "face_visible": True, "tracking_confidence": 0.9, "quality_flags": []}
    s.update(patch)
    r = save(inv, payload(new_case, consent(inv, new_case), samples=[s]))
    assert r.status_code == 422, patch


def test_unavailable_sample_is_accepted_and_offsets_rejected(inv, new_case):
    g = consent(inv, new_case)
    ok = {"timestamp_ms": 0, "horizontal_label": "unavailable", "vertical_label": "unavailable", "face_visible": True,
          "tracking_confidence": 0, "quality_flags": ["multiple_faces"]}
    assert save(inv, payload(new_case, g, samples=[ok])).status_code == 200
    assert save(inv, payload(new_case, g, samples=[{**ok, "horizontal_offset": 0.2, "vertical_offset": 0.1}])).status_code == 422
    assert save(inv, payload(new_case, g, samples=[{**ok, "horizontal_label": "sideways"}])).status_code == 422
    assert save(inv, payload(new_case, g, samples=[{**ok, "quality_flags": ["suspicious"]}])).status_code == 422


# -------------------------------------------------------------------------------------- summary + exports
def test_per_question_summary(inv, new_case):
    sid = save(inv, payload(new_case, consent(inv, new_case))).json()["id"]
    s = inv.get(f"/api/gaze/sessions/{sid}").json()
    summ = s["summary"]
    assert summ["disclaimer"] == gaze.SUMMARY_DISCLAIMER
    assert [q["question_marker_id"] for q in summ["per_question"]] == [1, 2, 3, 4, 5]
    q2 = summ["per_question"][1]                 # contains the 1.5 s face-out-of-view period
    assert q2["unavailable_pct"] > 5 and q2["usable_pct"] + q2["unavailable_pct"] == pytest.approx(100, abs=0.2)
    assert all(q["blink_count"] >= 2 for q in summ["per_question"])
    q4 = summ["per_question"][3]                 # contains the prolonged closure
    assert q4["prolonged_closure_count"] == 1 and q4["eye_closed_total_ms"] >= 1300
    for q in summ["per_question"]:
        if q["usable_pct"] >= 60:
            assert q["dominant_direction"]["horizontal"] in ("left", "center", "right")
        else:
            assert q["dominant_direction"] is None and "Not shown" in q["dominant_note"]
    assert any("low light" in w for q in summ["per_question"] for w in q["quality_warnings"])
    assert s["disclaimers"]["report"] == gaze.REPORT_DISCLAIMER
    assert {m["marker_type"] for m in s["markers"]} >= {"question", "manual", "pause", "resume"}


def test_dominant_direction_hidden_when_tracking_is_poor():
    samples = [{"timestamp_ms": i * 100, "horizontal_label": "left" if i < 4 else "unavailable", "vertical_label": "center" if i < 4 else "unavailable",
                "shift_event": False, "blink_event": False, "eyes_closed_event": False, "closed_duration_ms": None, "face_visible": True,
                "quality_flags": [] if i < 4 else ["low_light"], "question_marker_id": 1} for i in range(10)]
    g = gaze.summarize_group(samples, calibration_status="skipped")
    assert g["usable_pct"] == 40.0 and g["dominant_direction"] is None
    assert any("calibration skipped" in w for w in g["quality_warnings"])


def test_csv_and_versioned_json_export(inv, new_case):
    g = consent(inv, new_case)
    p = payload(new_case, g, heart_rate=DEMO["heart_rate"], hr_consent_id=consent(inv, new_case, "heart_rate"))
    sid = save(inv, p).json()["id"]
    r = inv.get(f"/api/gaze/sessions/{sid}/export.csv")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(r.text)))
    assert rows[0] == gaze.SAMPLE_FIELDS and len(rows) - 1 == len(DEMO["samples"])
    assert any("low_light" in row[16] for row in rows[1:])
    assert {row[1] for row in rows[1:]} <= set(gaze.H_LABELS)
    hr = list(csv.reader(io.StringIO(inv.get(f"/api/gaze/sessions/{sid}/export.csv", params={"kind": "heart_rate"}).text)))
    assert hr[0] == ["timestamp_ms", "bpm", "sensor_contact", "rr_intervals_ms"] and len(hr) - 1 == len(DEMO["heart_rate"])
    j = inv.get(f"/api/gaze/sessions/{sid}/export.json").json()
    assert j["schema"] == "sightline.gaze-session" and j["schema_version"] == 1
    assert j["disclaimers"]["report"] == gaze.REPORT_DISCLAIMER and j["disclaimers"]["summary"] == gaze.SUMMARY_DISCLAIMER
    assert set(j["content_types"]) == {"measured", "model_output", "human_entered"}
    assert len(j["samples"]) == len(DEMO["samples"]) and j["consent"]["scope"] == "gaze_observation"
    assert j["heart_rate_consent"]["scope"] == "heart_rate"


# --------------------------------------------------------------------------------------- reviewer notes
def test_reviewer_annotations_allowed_tags_only(inv, viewer, new_case):
    sid = save(inv, payload(new_case, consent(inv, new_case))).json()["id"]
    post = lambda c, body: c.post(f"/api/gaze/sessions/{sid}/annotations", json=body, headers=H)
    for tag in gaze.REVIEW_TAGS:
        assert post(inv, {"start_ms": 1000, "end_ms": 2000, "tag": tag, "note": "n"}).status_code == 200
    for bad in ("important", "suspicious", "deceptive", "stress"):
        assert post(inv, {"start_ms": 0, "end_ms": 1, "tag": bad}).status_code == 422
    assert post(inv, {"start_ms": 5, "end_ms": 1, "tag": "context_note"}).status_code == 422
    assert post(viewer, {"start_ms": 0, "end_ms": 1, "tag": "context_note"}).status_code == 403
    anns = inv.get(f"/api/gaze/sessions/{sid}").json()["annotations"]
    assert len(anns) == 4 and {a["tag_label"] for a in anns} == set(gaze.REVIEW_TAGS.values())
    assert inv.delete(f"/api/gaze/annotations/{anns[0]['id']}", headers=H).status_code == 200


def test_no_automatic_tags_or_judgement_words_in_output(inv, new_case):
    sid = save(inv, payload(new_case, consent(inv, new_case))).json()["id"]
    s = inv.get(f"/api/gaze/sessions/{sid}").json()
    assert s["annotations"] == []                       # nothing is auto-tagged
    text = str(s["summary"]).lower().replace(gaze.SUMMARY_DISCLAIMER.lower(), "")
    for w in ("lie", "liar", "truth", "deceptive", "suspicious", "guilt", "stress", "emotion", "cognitive", "recall", "score", "risk"):
        assert re.search(rf"\b{w}", text) is None, w


# ------------------------------------------------------------------------------------------ reports
def test_report_and_case_export_include_gaze_section_with_exact_disclaimers(inv, new_case):
    g = consent(inv, new_case)
    sid = save(inv, payload(new_case, g, heart_rate=DEMO["heart_rate"], hr_consent_id=consent(inv, new_case, "heart_rate"))).json()["id"]
    inv.post(f"/api/gaze/sessions/{sid}/annotations", json={"start_ms": 18000, "end_ms": 19500, "tag": "technical_issue",
                                                             "note": "Subject leaned out of frame"}, headers=H)
    pdf = inv.get(f"/api/cases/{new_case}/report.pdf", params={"sections": "gaze"})
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf.content)
    try:
        txt = subprocess.run(["pdftotext", f.name, "-"], capture_output=True, text=True).stdout
    except FileNotFoundError:
        pytest.skip("pdftotext not installed")
    finally:
        os.remove(f.name)
    flat = " ".join(txt.split())
    assert gaze.REPORT_DISCLAIMER in flat
    assert gaze.SUMMARY_DISCLAIMER in flat
    for needle in ("Gaze observation", "MEASURED / RECORDED", "MODEL OUTPUT", "HUMAN-ENTERED", "Subject leaned out of frame",
                   "Technical issue", "Question 1", "heart rate"):
        assert needle.lower() in flat.lower(), needle
    ex = inv.get(f"/api/cases/{new_case}/export.json").json()
    gs = ex["gaze_sessions"]
    assert len(gs) == 1 and gs[0]["per_question_summary"]["per_question"] and gs[0]["annotations"]
    assert ex["gaze_disclaimer"] == gaze.REPORT_DISCLAIMER


def test_case_delete_removes_gaze_data(inv, admin):
    cid = inv.post("/api/cases", json={"title": "Gaze delete"}, headers=H).json()["id"]
    sid = save(inv, payload(cid, consent(inv, cid))).json()["id"]
    admin.delete(f"/api/cases/{cid}", headers=H)
    from app import db
    for t in ("gaze_samples", "obs_markers"):
        assert db.row(f"SELECT COUNT(*) AS n FROM {t} WHERE session_id=?", (sid,))["n"] == 0
    assert db.row("SELECT COUNT(*) AS n FROM consents WHERE case_id=?", (cid,))["n"] == 0


def test_demo_seed_contains_synthetic_gaze_session(inv):
    lst = inv.get("/api/gaze/sessions", params={"case_id": 1}).json()
    assert lst and lst[-1]["is_demo"] == 1 and lst[-1]["sample_count"] > 500
    s = inv.get(f"/api/gaze/sessions/{lst[-1]['id']}").json()
    assert "synthetic" in s["software"]["library"]
