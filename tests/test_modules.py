"""Face detection, matching plumbing, interviews, observations, reports, analytics."""
import os
import subprocess
import tempfile

import numpy as np
from conftest import H


def _upload(c, cid, name, data, mime):
    return c.post(f"/api/cases/{cid}/evidence", files={"file": (name, data, mime)}, headers=H).json()["id"]


def test_image_detection_and_views(inv, new_case, face_jpg):
    eid = _upload(inv, new_case, "face.jpg", face_jpg, "image/jpeg")
    r = inv.post(f"/api/evidence/{eid}/analyze", json={}, headers=H)
    assert r.status_code == 200
    a = inv.get(f"/api/analyses/{r.json()['id']}").json()
    res = a["result"]
    assert res["summary"]["max_faces"] >= 1 and res["frames"][0]["face_count"] >= 1
    face = res["frames"][0]["faces"][0]
    assert len(face["box"]) == 4 and "det_row" not in face and "flags" in face["quality"]
    assert res["image_quality"]["width"] == 512
    img = inv.get(f"/api/analyses/{a['id']}/image", params={"frame": 0})
    assert img.headers["content-type"] == "image/jpeg" and img.content[:2] == b"\xff\xd8"
    assert inv.get(f"/api/analyses/{a['id']}/face", params={"frame": 0, "index": 0}).status_code == 200
    assert inv.get(f"/api/analyses/{a['id']}/face", params={"frame": 0, "index": 99}).status_code == 404
    assert "not an identified person" in a["limits"]


def test_no_face_image_and_wrong_kind(inv, new_case, blank_png):
    eid = _upload(inv, new_case, "blank.png", blank_png, "image/png")
    aid = inv.post(f"/api/evidence/{eid}/analyze", json={}, headers=H).json()["id"]
    assert inv.get(f"/api/analyses/{aid}").json()["result"]["summary"]["max_faces"] == 0
    doc = _upload(inv, new_case, "n.txt", b"hello", "text/plain")
    assert inv.post(f"/api/evidence/{doc}/analyze", json={}, headers=H).status_code == 400


def test_video_detection_over_time(inv, new_case, video_avi):
    eid = _upload(inv, new_case, "clip.avi", video_avi, "video/x-msvideo")
    r = inv.post(f"/api/evidence/{eid}/analyze", json={"sample_every_s": 1.0}, headers=H)
    assert r.status_code == 200, r.text
    a = inv.get(f"/api/analyses/{r.json()['id']}").json()
    frames = a["result"]["frames"]
    assert [f["index"] for f in frames] == [0, 10, 20]
    assert frames[0]["face_count"] >= 1 and frames[2]["face_count"] == 0
    assert a["result"]["video"]["duration_s"] == 3.0
    assert inv.get(f"/api/analyses/{a['id']}/image", params={"frame": 10}).status_code == 200
    assert inv.get(f"/api/analyses/{a['id']}/image", params={"frame": 7}).status_code == 404


def test_matching_unavailable_gives_clear_error(inv, face_jpg, monkeypatch):
    from app import vision
    monkeypatch.setattr(type(vision.engine), "matching_available", property(lambda s: False))
    r = inv.post("/api/references", files={"image": ("r.jpg", face_jpg, "image/jpeg")}, data={"label": "ref", "consent_ref": "CF-1", "consent_confirmed": "1"}, headers=H)
    assert r.status_code == 501 and "fetch_models" in r.json()["detail"]


def test_reference_matching_pipeline_with_stub_embedder(inv, viewer, admin, new_case, face_jpg, monkeypatch):
    """Plumbing test only: a stub embedder replaces SFace so enrolment, scoring, storage and review run without model files."""
    import cv2
    from app import vision
    monkeypatch.setattr(type(vision.engine), "matching_available", property(lambda s: True))

    def stub(bgr, face):
        x, y, w, h = face["box"]
        v = cv2.resize(cv2.cvtColor(bgr[y:y + h, x:x + w], cv2.COLOR_BGR2GRAY), (8, 8)).astype(np.float32).reshape(-1)
        return v - v.mean()
    monkeypatch.setattr(vision.engine, "embed", stub)
    post = lambda data: inv.post("/api/references", files={"image": ("r.jpg", face_jpg, "image/jpeg")}, data=data, headers=H)
    assert post({"label": "A", "consent_ref": "", "consent_confirmed": "1"}).status_code == 400
    assert post({"label": "A", "consent_ref": "CF-1", "consent_confirmed": "0"}).status_code == 400
    assert post({"label": "", "consent_ref": "CF-1", "consent_confirmed": "1"}).status_code == 422
    ok = post({"label": "Ref A (consented demo)", "consent_ref": "CF-1", "consent_confirmed": "1", "retention_days": "7"})
    assert ok.status_code == 200, ok.text
    refs = inv.get("/api/references").json()
    assert refs[0]["label"].startswith("Ref A") and "embedding" not in refs[0] and refs[0]["expired"] is False
    assert inv.get(f"/api/references/{ok.json()['id']}/image").content[:2] == b"\xff\xd8"

    eid = _upload(inv, new_case, "probe.jpg", face_jpg, "image/jpeg")
    aid = inv.post(f"/api/evidence/{eid}/analyze", json={}, headers=H).json()["id"]
    m = inv.post(f"/api/analyses/{aid}/match", json={"frame": 0, "face_index": 0}, headers=H)
    assert m.status_code == 200, m.text
    top = m.json()["candidates"][0]
    assert top["score"] > 0.99 and top["above_threshold"] is True        # same image -> same stub vector
    assert "not proof" in m.json()["limits"]
    assert viewer.patch(f"/api/matches/{top['id']}/review", json={"decision": "rejected"}, headers=H).status_code == 403
    assert inv.patch(f"/api/matches/{top['id']}/review", json={"decision": "guilty"}, headers=H).status_code == 422
    assert inv.patch(f"/api/matches/{top['id']}/review", json={"decision": "needs_independent_verification", "note": "check ID card"}, headers=H).status_code == 200
    rows = inv.get(f"/api/analyses/{aid}/matches").json()
    assert rows[0]["decision"] == "needs_independent_verification" and rows[0]["decided_by_name"] == "investigator"
    assert inv.get(f"/api/cases/{new_case}/report.pdf").content[:4] == b"%PDF"
    from app import db
    db.run("UPDATE reference_images SET review_by='2000-01-01'")
    assert inv.post(f"/api/analyses/{aid}/match", json={"frame": 0, "face_index": 0}, headers=H).status_code == 400
    assert admin.post("/api/references/purge-expired", headers=H).json()["purged"] >= 1


def test_interview_flow(inv, viewer, new_case):
    assert len(inv.get("/api/questions").json()) == 10
    assert inv.post("/api/interviews", json={"case_id": new_case, "subject_ref": "S-9", "consent_confirmed": False}, headers=H).status_code == 400
    iid = inv.post("/api/interviews", json={"case_id": new_case, "subject_ref": "S-9", "consent_confirmed": True, "consent_note": "CF-9"}, headers=H).json()["id"]
    assert len(inv.get(f"/api/interviews/{iid}").json()["items"]) == 10
    p = lambda pos, **b: inv.patch(f"/api/interviews/{iid}/items/{pos}", json=b, headers=H)
    assert p(2, response_text="I went to the warehouse at 8 pm on Friday.").status_code == 200
    assert p(6, response_text="I never went to the warehouse on Friday.", notes="clarify", follow_up=True).status_code == 200
    assert p(4, response_text="We left the harbour at 10 pm.").status_code == 200
    assert p(5, response_text="We left the harbour at 9 pm.").status_code == 200
    it = inv.get(f"/api/interviews/{iid}").json()["items"]
    assert it[1]["answered_at"] and it[5]["follow_up"] == 1 and it[5]["notes"] == "clarify"
    assert viewer.patch(f"/api/interviews/{iid}/items/1", json={"response_text": "x"}, headers=H).status_code == 403
    s = inv.post(f"/api/interviews/{iid}/complete", headers=H).json()
    assert s["answered"] == 4 and s["follow_up_positions"] == [6]
    assert {"polarity", "time"} <= {d["type"] for d in s["differences_for_review"]}
    assert all("Not an indication of deception" in d["caution"] for d in s["differences_for_review"])
    assert p(1, response_text="late edit").status_code == 409                      # completed = read-only
    assert inv.post(f"/api/interviews/{iid}/reopen", headers=H).status_code == 200
    assert p(1, response_text="late edit").status_code == 200


def test_interview_audio_recording(inv, new_case):
    iid = inv.post("/api/interviews", json={"case_id": new_case, "subject_ref": "S-1", "consent_confirmed": True}, headers=H).json()["id"]
    audio = b"OggS-fake-audio"
    assert inv.post(f"/api/interviews/{iid}/items/1/recording", files={"file": ("a.webm", audio, "audio/webm;codecs=opus")}, headers=H).status_code == 200
    assert inv.get(f"/api/interviews/{iid}/items/1/recording").content == audio
    assert inv.get(f"/api/interviews/{iid}").json()["items"][0]["has_recording"] is True
    assert inv.post(f"/api/interviews/{iid}/items/1/recording", files={"file": ("a.exe", audio, "application/x-msdownload")}, headers=H).status_code == 415
    assert inv.delete(f"/api/interviews/{iid}/items/1/recording", headers=H).status_code == 200
    assert inv.get(f"/api/interviews/{iid}").json()["items"][0]["has_recording"] is False


def test_questions_editable(inv):
    old = inv.get("/api/questions").json()
    new = [{"text": "Custom question one?", "topic": "t"}, {"text": "Custom question two?", "topic": ""}]
    assert inv.put("/api/questions", json={"questions": new}, headers=H).status_code == 200
    assert [q["text"] for q in inv.get("/api/questions").json()] == [q["text"] for q in new]
    assert inv.put("/api/questions", json={"questions": []}, headers=H).status_code == 422
    inv.put("/api/questions", json={"questions": [{"text": q["text"], "topic": q["topic"]} for q in old]}, headers=H)


def _obs_payload(case_id, interview_id=None, n=200, source="file"):
    t = [i / 10 for i in range(n)]
    return {"case_id": case_id, "interview_id": interview_id, "source": source, "source_name": "t.mp4", "duration_s": n / 10, "is_demo": True,
            "series": {"t": t, "face": [1] * n, "yaw": [float(i % 7) for i in range(n)], "pitch": [0.0] * n, "energy": [0.1] * n, "brightness": [120.0] * n},
            "events": [{"t": 1.0, "type": "blink"}, {"t": 5.0, "type": "blink", "duration": None}, {"t": 8.0, "type": "head_turn", "detail": "x", "duration": 1.0}],
            "software": {"library": "test"}}


def test_observations(inv, viewer, new_case):
    r = inv.post("/api/observations", json=_obs_payload(new_case), headers=H)
    assert r.status_code == 200, r.text
    s = r.json()["summary"]
    assert s["blink_count"] == 2 and s["head_turn_count"] == 1 and s["tracked_fraction"] == 1.0 and s["blink_rate_per_min"] == 6.0
    assert "do not indicate deception" in s["note"]
    oid = r.json()["id"]
    assert inv.patch(f"/api/observations/{oid}", json={"interpretation_note": "camera was low"}, headers=H).status_code == 200
    assert viewer.get(f"/api/observations/{oid}").json()["interpretation_note"] == "camera was low"
    bad = _obs_payload(new_case)
    bad["series"]["yaw"] = [0.0]
    assert inv.post("/api/observations", json=bad, headers=H).status_code == 422
    assert inv.post("/api/observations", json=_obs_payload(new_case, source="video_file"), headers=H).status_code == 422
    web = _obs_payload(new_case, source="webcam")
    assert inv.post("/api/observations", json=web, headers=H).status_code == 400   # consent missing
    web["consent_confirmed"] = True
    assert inv.post("/api/observations", json=web, headers=H).status_code == 200


def test_report_sections_and_export(inv, new_case, blank_png):
    _upload(inv, new_case, "e.png", blank_png, "image/png")
    iid = inv.post("/api/interviews", json={"case_id": new_case, "subject_ref": "S-2", "consent_confirmed": True}, headers=H).json()["id"]
    inv.patch(f"/api/interviews/{iid}/items/1", json={"response_text": "My <b>answer</b> & more"}, headers=H)
    inv.post(f"/api/interviews/{iid}/complete", headers=H)
    inv.post("/api/observations", json=_obs_payload(new_case, iid), headers=H)
    r = inv.get(f"/api/cases/{new_case}/report.pdf")
    assert r.status_code == 200 and r.content[:4] == b"%PDF"
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(r.content)
    try:
        txt = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True).stdout
    except FileNotFoundError:
        txt = None
    os.remove(f.name)
    if txt is not None:
        for needle in ("Case summary", "Structured interviews", "Face-detection results", "Evidence inventory", "Reviewer notes",
                       "MODEL OUTPUT", "HUMAN-ENTERED", "MEASURED / RECORDED", "Not validated for real criminal-investigation", "My <b>answer</b> & more", "SHA-256"):
            assert needle in txt, needle
    only = inv.get(f"/api/cases/{new_case}/report.pdf", params={"sections": "case"})
    assert len(only.content) < len(r.content)
    ex = inv.get(f"/api/cases/{new_case}/export.json").json()
    assert ex["case"]["id"] == new_case and ex["evidence"] and "export_note" in ex
    assert all("stored_name" not in e for e in ex["evidence"])
    assert inv.get("/api/cases/99999/report.pdf").status_code == 404


def test_demo_report_renders_seeded_observation(inv):
    r = inv.get("/api/cases/1/report.pdf")
    assert r.status_code == 200 and len(r.content) > 20000


def test_analytics_events_meta(inv, admin):
    a = inv.get("/api/analytics").json()
    assert a["cases_total"] >= 3 and len(a["activity_by_day"]) == 14
    ev = inv.get("/api/events", params={"limit": 5}).json()
    assert ev["total"] > 0 and len(ev["items"]) <= 5 and "case_created" in ev["types"]
    assert "not validated" in inv.get("/api/meta").json()["disclaimer"].lower()
    assert len(admin.post("/api/admin/reset-demo", headers=H).json()["cases"]) == 3


# ---------------------------------------------------------------- real models (skipped unless fetch_models.py was run)
import pytest  # noqa: E402

from app import vision as _vision  # noqa: E402

needs_models = pytest.mark.skipif(not _vision.engine.matching_available, reason="YuNet/SFace not downloaded (run scripts/fetch_models.py)")


@needs_models
def test_yunet_gives_landmarks_and_score(inv, new_case, face_jpg):
    eid = _upload(inv, new_case, "yunet.jpg", face_jpg, "image/jpeg")
    a = inv.get(f"/api/analyses/{inv.post(f'/api/evidence/{eid}/analyze', json={}, headers=H).json()['id']}").json()
    f = a["result"]["frames"][0]["faces"]
    assert len(f) == 1 and f[0]["score"] > 0.8 and len(f[0]["landmarks"]) == 5 and f[0]["has_landmarks"] is True
    assert a["detector"].startswith("YuNet")


@needs_models
def test_real_sface_matching_same_person_variants(inv, new_case, face_jpg):
    """Same public-domain photo, altered (brightness, scale, crop) -> SFace similarity should stay above the reference threshold.
    This only shows the pipeline works; it says nothing about accuracy on different people."""
    import cv2
    img = cv2.imdecode(np.frombuffer(face_jpg, np.uint8), cv2.IMREAD_COLOR)
    probe = cv2.convertScaleAbs(cv2.resize(img[20:500, 30:490], None, fx=1.4, fy=1.4), alpha=0.8, beta=25)
    ref_id = inv.post("/api/references", files={"image": ("ref.jpg", face_jpg, "image/jpeg")},
                      data={"label": "REF-SFACE", "consent_ref": "public-domain test image", "consent_confirmed": "1"}, headers=H).json()["id"]
    eid = _upload(inv, new_case, "probe2.jpg", cv2.imencode(".jpg", probe)[1].tobytes(), "image/jpeg")
    aid = inv.post(f"/api/evidence/{eid}/analyze", json={}, headers=H).json()["id"]
    r = inv.post(f"/api/analyses/{aid}/match", json={"frame": 0, "face_index": 0}, headers=H).json()
    top = next(c for c in r["candidates"] if c["reference_id"] == ref_id)
    assert top["score"] > 0.6 and top["above_threshold"] is True
    inv.delete(f"/api/references/{ref_id}", headers=H)


@needs_models
def test_reference_with_no_face_rejected(inv, blank_png):
    r = inv.post("/api/references", files={"image": ("blank.png", blank_png, "image/png")},
                 data={"label": "none", "consent_ref": "x", "consent_confirmed": "1"}, headers=H)
    assert r.status_code == 422 and "exactly one face" in r.json()["detail"]
