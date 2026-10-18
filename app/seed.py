"""Fictional demonstration data. Nothing here refers to real people, places or events."""
import json
import math
import random

import cv2
import numpy as np

from . import config, consistency, db, security, storage, util
from .routers.interviews import seed_questions
from .routers.observations import summarize


def seed_users():
    if db.row("SELECT 1 FROM users"):
        return False
    for name, role in (("admin", "admin"), ("investigator", "investigator"), ("viewer", "viewer")):
        db.run("INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)",
               (name, security.hash_password(config.DEMO_PASSWORD), role, db.now()))
    return True


def _synthetic_image():
    img = np.zeros((360, 640, 3), np.uint8)
    for x in range(640):
        img[:, x] = (60 + x // 8, 70 + x // 12, 90)
    cv2.rectangle(img, (40, 200), (240, 330), (30, 30, 30), -1)
    cv2.circle(img, (480, 120), 50, (200, 200, 220), -1)
    cv2.putText(img, "SYNTHETIC DEMO IMAGE", (40, 70), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(img, "no real person or place", (40, 110), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (230, 230, 230), 1, cv2.LINE_AA)
    return cv2.imencode(".png", img)[1].tobytes()


def _add_evidence(cid, uid, name, data, kind, mime, desc):
    return db.run("""INSERT INTO evidence(case_id,original_name,stored_name,mime,kind,size,sha256,description,is_demo,uploaded_by,uploaded_at)
                     VALUES(?,?,?,?,?,?,?,?,1,?,?)""", (cid, name, storage.put(data), mime, kind, len(data), storage.sha256(data), desc, uid, db.now()))


def _synthetic_observation(duration=60.0, hz=10):
    rng = random.Random(7)
    n = int(duration * hz)
    s = {k: [] for k in ("t", "face", "yaw", "pitch", "roll", "energy", "brightness", "sharpness", "blink", "gaze_x", "gaze_y", "mouth_open")}
    for i in range(n):
        t = i / hz
        lost = 20.0 <= t < 21.0
        s["t"].append(round(t, 2))
        s["face"].append(0 if lost else 1)
        vals = {"yaw": 6 * math.sin(2 * math.pi * t / 20) + (22 if 30 <= t < 33.5 else 0) + rng.gauss(0, 0.6),
                "pitch": 3 * math.sin(2 * math.pi * t / 14) + rng.gauss(0, 0.4), "roll": rng.gauss(0, 0.5),
                "energy": abs(rng.gauss(0.18, 0.05)) + (0.9 if 45 <= t < 46 else 0), "blink": 0.05,
                "gaze_x": rng.gauss(0, 0.04), "gaze_y": rng.gauss(0, 0.03), "mouth_open": abs(rng.gauss(0.06, 0.03))}
        for k, v in vals.items():
            s[k].append(None if lost else round(v, 3))
        s["brightness"].append(round(122 + 4 * math.sin(t / 5) - (60 if 50 <= t < 53 else 0), 1))
        s["sharpness"].append(round(95 + rng.gauss(0, 4), 1))
    events, bt = [], 1.5
    while bt < duration:
        if not 20.0 <= bt < 21.0:
            events.append({"t": round(bt, 2), "type": "blink", "detail": "eye closure about 0.15 s", "duration": 0.15})
        bt += rng.uniform(2.2, 5.0)
    events += [{"t": 20.0, "type": "tracking_lost", "detail": "no face for 1.0 s", "duration": 1.0},
               {"t": 30.0, "type": "head_turn", "detail": "|yaw| above 20 deg for 3.5 s", "duration": 3.5},
               {"t": 45.0, "type": "movement_burst", "detail": "landmark motion above 0.8/s for 1.0 s", "duration": 1.0},
               {"t": 50.0, "type": "low_light", "detail": "brightness below 50 for 3.0 s", "duration": 3.0}]
    events += [{"t": float(t0), "type": "marker", "detail": f"Question {q} shown"} for q, t0 in ((1, 2), (2, 14), (3, 26), (4, 38), (5, 50))]
    events.sort(key=lambda e: e["t"])
    return s, events


def seed_demo():
    admin = db.row("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1")
    uid = admin["id"]
    seed_questions()
    now = db.now()
    specs = [("Warehouse inventory discrepancy (fictional)", "FICTIONAL SCENARIO. Stock counts at an imaginary warehouse differ from the ledger. Used only to demonstrate the workflow.", "in_progress", "high"),
             ("Missing laptop at campus lab (fictional)", "FICTIONAL SCENARIO. An imaginary laptop is reported missing from a lab. Demonstration data only.", "open", "medium"),
             ("Archived parking dispute (fictional)", "FICTIONAL SCENARIO. Closed example case showing an archived record.", "closed", "low")]
    ids = []
    for title, desc, status, prio in specs:
        num = util.new_case_number(True)
        cid = db.run("INSERT INTO cases(case_number,title,description,status,priority,is_demo,created_by,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?)",
                     (num, title, desc, status, prio, uid, now, now))
        db.log(admin, "case_created", f"{num}: {title} (demo seed)", cid, "case", cid)
        ids.append(cid)
    c1 = ids[0]
    _add_evidence(c1, uid, "synthetic_scene.png", _synthetic_image(), "image", "image/png", "Synthetic drawing used to demonstrate upload, hashing and detection. Contains no real person.")
    _add_evidence(c1, uid, "inventory_ledger_excerpt.txt", b"FICTIONAL ledger excerpt\nItem A: expected 120, counted 118\nItem B: expected 40, counted 40\n", "document", "text/plain", "Fictional text record")

    qs = db.rows("SELECT position,text,topic FROM questions ORDER BY position")
    answers = {1: "Subject code S-01.", 2: "I went to the warehouse at 8 pm on Friday to check the shelves.",
               3: "I was alone at first. A colleague called Sam arrived later.", 4: "I left the warehouse at 10 pm.",
               5: "I know Sam from work. We share a shift.", 6: "I never went to the warehouse that Friday evening.",
               7: "Nothing unusual, the lights were dim.", 8: "I told my supervisor on Monday."}

    def make_iv(status, upto):
        iid = db.run("INSERT INTO interviews(case_id,subject_ref,status,consent_confirmed,consent_note,is_demo,created_by,created_at,updated_at) VALUES(?,?,?,1,?,1,?,?,?)",
                     (c1, "S-01 (fictional)", status, "Demo consent form DEMO-CF-001", uid, now, now))
        for q in qs:
            ans = answers.get(q["position"], "") if q["position"] <= upto else ""
            db.run("INSERT INTO interview_items(interview_id,position,question_text,topic,response_text,answered_at,follow_up,notes) VALUES(?,?,?,?,?,?,?,?)",
                   (iid, q["position"], q["text"], q["topic"], ans, now if ans else None, 1 if (q["position"] == 6 and ans) else 0,
                    "Ask subject to clarify the timeline." if (q["position"] == 6 and ans) else ""))
        return iid
    done = make_iv("completed", 8)
    items = db.rows("SELECT * FROM interview_items WHERE interview_id=? ORDER BY position", (done,))
    db.run("UPDATE interviews SET summary_json=?, completed_at=? WHERE id=?", (json.dumps(consistency.build_summary({"id": done}, items)), now, done))
    make_iv("in_progress", 3)

    s, ev = _synthetic_observation()
    db.run("""INSERT INTO observations(case_id,interview_id,source,source_name,started_at,duration_s,series_json,events_json,summary_json,software_json,interpretation_note,is_demo,created_by,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)""",
           (c1, done, "file", "synthetic_demo_session (generated, not from a camera)", now, 60.0, json.dumps(s), json.dumps(ev), json.dumps(summarize(s, ev, 60.0)),
            json.dumps({"library": "synthetic demo generator", "version": "-", "model": "none (not from a camera)", "sample_fps": 10}), "", uid, now))
    db.log(admin, "demo_seeded", f"{len(ids)} fictional cases with evidence, interviews and one synthetic observation")
    return ids


def reset_demo():
    for c in db.rows("SELECT id FROM cases WHERE is_demo=1"):
        util.delete_case_files(c["id"])
        db.run("DELETE FROM cases WHERE id=?", (c["id"],))
    return seed_demo()
