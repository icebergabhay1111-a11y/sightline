"""DEMO-only synthetic gaze-observation data. Generated numbers; no real person, camera or recording is involved.

Used by the demo seed and by the tests. It deliberately includes periods where measurement is not possible
(face out of view, two faces, low light, eyes closed) so the timeline and the per-question summary show how
unavailable data is handled.
"""
import math
import random

from . import gaze


def _label(x, neg, pos, enter=0.35):
    return neg if x <= -enter else pos if x >= enter else "center"


def synthetic_session(questions=5, seconds_per_question=14, hz=10, seed=11, with_hr=True, calibration="completed"):
    rng = random.Random(seed)
    step = int(1000 / hz)
    total = questions * seconds_per_question * 1000
    samples, markers, hr = [], [], []
    prev, since, closed_at = None, 0, None
    for q in range(questions):
        markers.append({"timestamp_ms": q * seconds_per_question * 1000, "marker_type": "question",
                        "text": f"Question {q + 1} shown (synthetic demo)", "question_marker_id": q + 1})
    markers.append({"timestamp_ms": 23500, "marker_type": "manual", "text": "Subject adjusted chair (demo note)", "question_marker_id": 2})
    markers.append({"timestamp_ms": 47000, "marker_type": "pause", "text": "Capture paused", "question_marker_id": 4})
    markers.append({"timestamp_ms": 49000, "marker_type": "resume", "text": "Capture resumed", "question_marker_id": 4})
    for t in range(0, total, step):
        if 47000 <= t < 49000:          # paused: no samples
            continue
        s = t / 1000.0
        qid = int(t // (seconds_per_question * 1000)) + 1
        face_visible = not (18.0 <= s < 19.5)
        two_faces = 33.0 <= s < 35.0
        dark = 60.0 <= s < 63.0
        yaw = 6 * math.sin(s / 3.1) + rng.gauss(0, 0.8) + (28 if 39.0 <= s < 40.5 else 0)
        pitch = 3 * math.sin(s / 4.3) + rng.gauss(0, 0.5)
        roll = rng.gauss(0, 0.6)
        # blinks roughly every 3 s, one prolonged closure at 52-53.4 s
        phase = (s * 1000) % 3100
        closing = phase < 140 or (52.0 <= s < 53.4)
        h = 0.55 * math.sin(s / 2.2) + (0.6 if 8.0 <= s < 11.0 else 0) - (0.7 if 24.0 <= s < 27.0 else 0) + rng.gauss(0, 0.05)
        v = 0.3 * math.sin(s / 3.7) - (0.6 if 44.0 <= s < 46.0 else 0) + rng.gauss(0, 0.05)
        h, v = max(-1, min(1, h)), max(-1, min(1, v))
        flags = []
        if dark:
            flags.append("low_light")
        if two_faces:
            flags.append("multiple_faces")
        if abs(yaw) > 25:
            flags.append("extreme_head_turn")
        if face_visible and closing:
            flags.append("iris_not_visible")
        if calibration != "completed" and face_visible:
            flags.append("camera_angle_issue")
        conf = 0.0 if (not face_visible or two_faces or closing) else round(max(0.0, min(1.0, 0.92 - (0.5 if dark else 0) - 0.02 * abs(yaw) / 5 + rng.gauss(0, 0.02))), 2)
        if abs(yaw) > 25:
            conf = round(min(conf, 0.3), 2)
        blocked = (not face_visible) or two_faces or closing or abs(yaw) > 25 or conf < gaze.MIN_CONFIDENCE
        blink_event = eyes_closed_event = False
        dur = None
        if face_visible and closing and closed_at is None:
            closed_at = t
        elif closed_at is not None and (not closing or not face_visible):
            if face_visible:
                dur = t - closed_at
                blink_event, eyes_closed_event = dur <= 1000, dur > 1000
            closed_at = None
        if blocked:
            hl = vl = "unavailable"
            ho = vo = None
            stab, shift = 0, False
            prev = None
        else:
            hl, vl = _label(h, "left", "right"), _label(v, "down", "up", 0.4)
            ho, vo = round(h, 3), round(v, 3)
            cur = hl + "/" + vl
            shift = prev is not None and cur != prev
            if prev is None or shift:
                since = t
            prev = cur
            stab = t - since
        samples.append({"timestamp_ms": t, "horizontal_label": hl, "vertical_label": vl, "horizontal_offset": ho, "vertical_offset": vo,
                        "stability_ms": stab, "shift_event": shift, "blink_event": blink_event, "eyes_closed": face_visible and closing,
                        "eyes_closed_event": eyes_closed_event, "closed_duration_ms": dur,
                        "head_yaw": round(yaw, 1) if face_visible else None, "head_pitch": round(pitch, 1) if face_visible else None,
                        "head_roll": round(roll, 1) if face_visible else None, "face_visible": face_visible,
                        "tracking_confidence": conf, "quality_flags": flags, "question_marker_id": qid})
        if with_hr and t % 1000 == 0:
            hr.append({"timestamp_ms": t, "bpm": int(round(74 + 4 * math.sin(s / 9) + rng.gauss(0, 1.2))), "contact": True,
                       "rr_ms": [int(round(60000 / (74 + rng.gauss(0, 2))))]})
    calib = {"status": calibration, "offset_h": 0.04 if calibration == "completed" else 0, "offset_v": -0.02 if calibration == "completed" else 0,
             "usable_fraction": 0.93 if calibration == "completed" else None, "spread_h": 0.05, "spread_v": 0.04,
             "samples": 250 if calibration == "completed" else 0, "duration_ms": 25000 if calibration == "completed" else 0}
    settings = {"note": "synthetic demo data", "sample_hz": hz, "ema_alpha": 0.35, "h_enter": 0.35, "h_exit": 0.2,
                "v_enter": 0.4, "v_exit": 0.25, "min_dwell_ms": 200, "reset_gap_ms": 500, "min_confidence": gaze.MIN_CONFIDENCE}
    software = {"library": "synthetic demo generator", "version": "-", "model": "none (not from a camera)", "achieved_fps": hz}
    return {"samples": samples, "markers": markers, "heart_rate": hr, "calibration": calib, "settings": settings, "software": software}
