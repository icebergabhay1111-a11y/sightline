"""PDF case report (ReportLab, BSD licence).

Every block is tagged so a reader can tell where it came from:
  MEASURED / RECORDED   - values captured by software or typed in as raw records (timestamps, hashes, answers)
  MODEL OUTPUT          - what a model produced (detections, similarity scores). Uncertain; may be wrong.
  HUMAN-ENTERED         - notes, decisions and conclusions typed by a person.
"""
import io
import os
from xml.sax.saxutils import escape

from reportlab.graphics.shapes import Drawing, Line, PolyLine, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from . import APP_NAME, APP_VERSION, db, vision

NAVY, SLATE = colors.HexColor("#1b2a41"), colors.HexColor("#5b6b8c")
TAGS = {"measured": ("MEASURED / RECORDED", "#2f6f8f"), "model": ("MODEL OUTPUT", "#8a5a00"), "human": ("HUMAN-ENTERED", "#3d6b3d")}
DISCLAIMER = ("Academic prototype. Not validated for real criminal-investigation decisions. Face detection is not "
              "identification; similarity scores are not proof of identity; facial-movement measurements do not "
              "indicate deception, emotion or guilt. All outputs require independent human verification.")
DECISION_LABELS = {"needs_independent_verification": "Lead - needs independent verification", "inconclusive": "Inconclusive",
                   "rejected": "Rejected - not a match"}
SECTIONS = ["case", "interviews", "faces", "matches", "observations", "evidence", "notes", "software"]

_FONT, _FONT_B = "Helvetica", "Helvetica-Bold"


def _register_fonts():
    """Use a TrueType font when available so non-Latin names render; fall back to Helvetica."""
    global _FONT, _FONT_B
    cands = [("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
             ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
             ("/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf")]
    for reg, bold in cands:
        if os.path.exists(reg) and os.path.exists(bold):
            try:
                pdfmetrics.registerFont(TTFont("Body", reg))
                pdfmetrics.registerFont(TTFont("Body-Bold", bold))
                _FONT, _FONT_B = "Body", "Body-Bold"
                return
            except Exception:
                pass


_register_fonts()


def _styles():
    base = dict(fontName=_FONT, fontSize=9, leading=12, alignment=TA_LEFT)
    return {
        "h1": ParagraphStyle("h1", fontName=_FONT_B, fontSize=20, leading=24, textColor=NAVY, spaceAfter=4),
        "h2": ParagraphStyle("h2", fontName=_FONT_B, fontSize=13, leading=16, textColor=NAVY, spaceBefore=10, spaceAfter=4),
        "h3": ParagraphStyle("h3", fontName=_FONT_B, fontSize=10, leading=13, textColor=SLATE, spaceBefore=6, spaceAfter=2),
        "p": ParagraphStyle("p", **base),
        "small": ParagraphStyle("small", **{**base, "fontSize": 7.5, "leading": 10, "textColor": SLATE}),
        "cell": ParagraphStyle("cell", **{**base, "fontSize": 8, "leading": 10}),
        "cellb": ParagraphStyle("cellb", **{**base, "fontName": _FONT_B, "fontSize": 8, "leading": 10}),
        "warn": ParagraphStyle("warn", **{**base, "textColor": colors.HexColor("#7a1f1f"), "backColor": colors.HexColor("#fbeaea"),
                                          "borderPadding": 5, "leading": 12}),
    }


def _p(text, st):
    return Paragraph(escape(str(text if text is not None else "")).replace("\n", "<br/>"), st)


def _tag(kind, S):
    label, col = TAGS[kind]
    return Paragraph(f'<font color="{col}"><b>[{label}]</b></font>', S["small"])


def _table(data, widths, S, header=True):
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    st = [("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#c8cfdb")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
          ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
          ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
    if header:
        st.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8ecf4")))
    t.setStyle(TableStyle(st))
    return t


def _chart(ts, series, events, duration, width=170 * mm, height=38 * mm, title=""):
    """series: list of (label, values, color). Line chart with event ticks."""
    d = Drawing(width, height + 12)
    x0, y0, w, h = 28, 14, width - 34, height - 10
    d.add(Rect(x0, y0, w, h, strokeColor=colors.HexColor("#c8cfdb"), fillColor=colors.white, strokeWidth=0.5))
    d.add(String(x0, y0 + h + 3, title, fontName=_FONT_B, fontSize=7, fillColor=NAVY))
    if not ts or duration <= 0:
        d.add(String(x0 + 6, y0 + h / 2, "no data", fontName=_FONT, fontSize=7))
        return d
    step = max(1, len(ts) // 1500)
    for i, (label, vals, col) in enumerate(series):
        vv = [v for v in vals if v is not None]
        if not vv:
            continue
        lo, hi = min(vv), max(vv)
        span = (hi - lo) or 1.0
        seg = []
        for t, v in list(zip(ts, vals))[::step]:
            if v is None:
                if len(seg) >= 4:
                    d.add(PolyLine(seg, strokeColor=col, strokeWidth=0.7))
                seg = []
                continue
            seg += [x0 + w * t / duration, y0 + h * (v - lo) / span]
        if len(seg) >= 4:
            d.add(PolyLine(seg, strokeColor=col, strokeWidth=0.7))
        d.add(String(x0 - 2, y0 + h - 7 - 8 * i, f"{label} {lo:.1f}..{hi:.1f}", fontName=_FONT, fontSize=5.5,
                     fillColor=col, textAnchor="end"))
    for e in events or []:
        x = x0 + w * min(max(e["t"], 0), duration) / duration
        c = {"blink": colors.HexColor("#2f6f8f"), "marker": colors.HexColor("#c9861a")}.get(e["type"], colors.HexColor("#888888"))
        d.add(Line(x, y0, x, y0 + 4 if e["type"] == "blink" else y0 + h, strokeColor=c, strokeWidth=0.4))
    d.add(String(x0, 3, "0 s", fontName=_FONT, fontSize=6))
    d.add(String(x0 + w, 3, f"{duration:.0f} s", fontName=_FONT, fontSize=6, textAnchor="end"))
    return d


def collect(case_id):
    case = db.row("SELECT c.*, u.username AS created_by_name FROM cases c LEFT JOIN users u ON u.id=c.created_by WHERE c.id=?", (case_id,))
    if not case:
        return {}
    ev = db.rows("SELECT e.*, u.username AS uploaded_by_name FROM evidence e LEFT JOIN users u ON u.id=e.uploaded_by WHERE case_id=? ORDER BY e.id", (case_id,))
    for e in ev:
        e.pop("stored_name", None)
        e["notes"] = db.rows("SELECT n.text,n.created_at,u.username AS author FROM evidence_notes n LEFT JOIN users u ON u.id=n.author_id WHERE evidence_id=? ORDER BY n.id", (e["id"],))
        e["integrity"] = db.rows("SELECT checked_at,ok,sha256_now FROM integrity_checks WHERE evidence_id=? ORDER BY id DESC LIMIT 5", (e["id"],))
    an = db.rows("SELECT a.*, u.username AS created_by_name FROM analyses a LEFT JOIN users u ON u.id=a.created_by WHERE case_id=? ORDER BY a.id", (case_id,))
    for a in an:
        a["result"] = db.loads(a.pop("result_json"), {})
        a["software"] = db.loads(a.pop("software_json"), {})
        a["params"] = db.loads(a.pop("params_json"), {})
        a["matches"] = db.rows("""SELECT m.*, u.username AS decided_by_name FROM matches m LEFT JOIN users u ON u.id=m.decided_by
                                  WHERE analysis_id=? ORDER BY run_id, rank""", (a["id"],))
    iv = db.rows("SELECT i.*, u.username AS created_by_name FROM interviews i LEFT JOIN users u ON u.id=i.created_by WHERE case_id=? ORDER BY i.id", (case_id,))
    for i in iv:
        i["items"] = db.rows("SELECT * FROM interview_items WHERE interview_id=? ORDER BY position", (i["id"],))
        for it in i["items"]:
            it["has_recording"] = bool(it.pop("rec_stored", None))
        i["summary"] = db.loads(i.pop("summary_json"), None)
    ob = db.rows("SELECT * FROM observations WHERE case_id=? ORDER BY id", (case_id,))
    for o in ob:
        for k in ("series", "events", "summary", "software"):
            o[k] = db.loads(o.pop(k + "_json"), [] if k == "events" else {})
    events = db.rows("SELECT ts,username,type,detail FROM events WHERE case_id=? ORDER BY id", (case_id,))
    return {"case": case, "evidence": ev, "analyses": an, "interviews": iv, "observations": ob, "events": events}


def export_json(case_id):
    data = collect(case_id)
    if not data:
        return None
    for o in data["observations"]:       # keep exports compact: drop raw series
        o["series"] = {"points": len(o["series"].get("t", []))}
    for a in data["analyses"]:
        for f in a["result"].get("frames", []):
            for face in f.get("faces", []):
                face.pop("det_row", None)
    data["export_note"] = DISCLAIMER
    data["exported_at"] = db.now()
    data["app"] = f"{APP_NAME} {APP_VERSION}"
    return data


def build_pdf(case_id, sections=None, user=""):
    data = collect(case_id)
    if not data:
        return None
    sections = [s for s in (sections or SECTIONS) if s in SECTIONS] or SECTIONS
    S = _styles()
    case = data["case"]
    buf = io.BytesIO()
    W = A4[0] - 30 * mm

    def deco(canvas, doc):
        canvas.saveState()
        canvas.setFont(_FONT, 7)
        canvas.setFillColor(SLATE)
        canvas.drawString(15 * mm, 9 * mm, f"{APP_NAME} {APP_VERSION} | {case['case_number']} | "
                                           f"{'DEMONSTRATION DATA | ' if case['is_demo'] else ''}Academic prototype - not validated for operational use")
        canvas.drawRightString(A4[0] - 15 * mm, 9 * mm, f"Page {doc.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=14 * mm,
                            bottomMargin=16 * mm, title=f"{case['case_number']} report", author=APP_NAME)
    story = [_p(f"Case report: {case['case_number']}", S["h1"]), _p(case["title"], S["h3"]), _p(DISCLAIMER, S["warn"]), Spacer(1, 4)]
    legend = [[_tag("measured", S), _p("Raw records and measurements: timestamps, hashes, entered answers, tracked values.", S["cell"])],
              [_tag("model", S), _p("Produced by a model or algorithm. Uncertain and can be wrong (false matches, misses).", S["cell"])],
              [_tag("human", S), _p("Notes, decisions and conclusions typed by a person.", S["cell"])]]
    story += [_p("How to read this report", S["h3"]), _table(legend, [40 * mm, W - 40 * mm], S, header=False),
              _p(f"Generated {db.now()} UTC by {user or 'system'}. Sections: {', '.join(sections)}.", S["small"])]
    n = 0

    def head(title):
        nonlocal n
        n += 1
        story.append(_p(f"{n}. {title}", S["h2"]))

    if "case" in sections:
        head("Case summary")
        story.append(_tag("human", S))
        rows = [["Case number", case["case_number"]], ["Title", case["title"]], ["Status", case["status"]], ["Priority", case["priority"]],
                ["Data type", "DEMONSTRATION / fictional" if case["is_demo"] else "Not marked as demonstration"],
                ["Created", f"{case['created_at']} by {case.get('created_by_name') or '-'}"], ["Last updated", case["updated_at"]],
                ["Description", case["description"] or "-"]]
        story.append(_table([[_p(a, S["cellb"]), _p(b, S["cell"])] for a, b in rows], [35 * mm, W - 35 * mm], S, header=False))

    if "interviews" in sections:
        head("Structured interviews")
        if not data["interviews"]:
            story.append(_p("No interviews recorded for this case.", S["p"]))
        for iv in data["interviews"]:
            story.append(_p(f"Interview #{iv['id']} - subject ref {iv['subject_ref']} - {iv['status']}", S["h3"]))
            story.append(_p(f"Consent recorded: {'yes' if iv['consent_confirmed'] else 'no'}; note: {iv['consent_note'] or '-'}; "
                            f"created {iv['created_at']} by {iv.get('created_by_name') or '-'}.", S["small"]))
            story.append(_tag("measured", S))
            rows = [[_p("#", S["cellb"]), _p("Question (as asked)", S["cellb"]), _p("Recorded response", S["cellb"]), _p("Investigator note / follow-up (human)", S["cellb"])]]
            for it in iv["items"]:
                note = (it["notes"] or "-") + ("  [FOLLOW-UP]" if it["follow_up"] else "") + ("  [audio recorded]" if it["has_recording"] else "")
                rows.append([_p(it["position"], S["cell"]), _p(it["question_text"], S["cell"]),
                             _p(it["response_text"] or "(no response recorded)", S["cell"]), _p(note, S["cell"])])
            story.append(_table(rows, [8 * mm, 50 * mm, W - 108 * mm, 50 * mm], S))
            diffs = (iv["summary"] or {}).get("differences_for_review", [])
            story.append(_p("Possible differences flagged for human review (keyword heuristic)", S["h3"]))
            story.append(_tag("model", S))
            if diffs:
                story.append(_table([[_p(f"Q{d['positions'][0]} vs Q{d['positions'][1]}", S["cell"]), _p(d["detail"], S["cell"]),
                                      _p(", ".join(d["shared_terms"]), S["cell"])] for d in diffs], [25 * mm, W - 70 * mm, 45 * mm], S, header=False))
                story.append(_p("These are not findings about honesty; answers can differ for innocent reasons.", S["small"]))
            else:
                story.append(_p("None flagged (or summary not generated yet).", S["p"]))

    if "faces" in sections:
        head("Face-detection results")
        story.append(_tag("model", S))
        story.append(_p("Detection locates faces; it does not identify anyone. Counts depend on lighting, resolution, pose and occlusion and may include false detections or miss faces.", S["small"]))
        if not data["analyses"]:
            story.append(_p("No detection runs for this case.", S["p"]))
        for a in data["analyses"]:
            ev = next((e for e in data["evidence"] if e["id"] == a["evidence_id"]), {})
            s = a["result"].get("summary", {})
            story.append(_p(f"Analysis #{a['id']} - {ev.get('original_name', '?')} ({a['kind']}) - detector: {a['detector']}", S["h3"]))
            story.append(_p(f"Run {a['created_at']} by {a.get('created_by_name') or '-'}. Frames analysed {s.get('frames_analyzed')}, "
                            f"frames with faces {s.get('frames_with_faces')}, max faces in a frame {s.get('max_faces')}.", S["p"]))
            iq = a["result"].get("image_quality")
            if iq:
                story.append(_p(f"Image quality: {iq['width']}x{iq['height']}, brightness {iq['brightness']}, sharpness {iq['sharpness']}, flags: {', '.join(iq['flags']) or 'none'}.", S["small"]))
            rows = [[_p(x, S["cellb"]) for x in ("Frame / time", "Faces", "Face quality flags (per face)")]]
            frames = a["result"].get("frames", [])
            for f in frames[:40]:
                fl = "; ".join(f"#{x['index'] + 1}: {', '.join(x['quality']['flags']) or 'ok'}" for x in f["faces"]) or "-"
                rows.append([_p(f"{f['index']} ({f['t']} s)", S["cell"]), _p(f["face_count"], S["cell"]), _p(fl, S["cell"])])
            story.append(_table(rows, [30 * mm, 15 * mm, W - 45 * mm], S))
            if len(frames) > 40:
                story.append(_p(f"... {len(frames) - 40} more sampled frames omitted.", S["small"]))

    if "matches" in sections:
        head("Optional reference matching")
        story.append(_p("Matching compares a detected face with consented reference images. A similarity score is NOT proof of identity: false matches and false non-matches occur, error rates differ between demographic groups, and low-quality images make results less reliable. Candidates are leads that need independent verification.", S["small"]))
        any_m = False
        for a in data["analyses"]:
            if not a["matches"]:
                continue
            any_m = True
            story.append(_p(f"Analysis #{a['id']}", S["h3"]))
            rows = [[_p(x, S["cellb"]) for x in ("Face", "Rank", "Reference label", "Score [MODEL]", "Above ref. threshold", "Decision [HUMAN-ENTERED]")]]
            for m in a["matches"]:
                dec = DECISION_LABELS.get(m["decision"], m["decision"] or "UNREVIEWED") + (f" - {m['decision_note']}" if m["decision_note"] else "") + (f" ({m.get('decided_by_name')})" if m["decided_by_name"] else "")
                rows.append([_p(f"frame {m['frame']} #{m['face_index'] + 1}", S["cell"]), _p(m["rank"], S["cell"]), _p(m["reference_label"], S["cell"]),
                             _p(f"{m['score']:.3f}", S["cell"]), _p("yes" if m["above_threshold"] else "no", S["cell"]), _p(dec, S["cell"])])
            story.append(_table(rows, [24 * mm, 13 * mm, 34 * mm, 22 * mm, 24 * mm, W - 117 * mm], S))
        if not any_m:
            story.append(_p("No reference matching was run for this case.", S["p"]))

    if "observations" in sections:
        head("Visual-observation timelines (facial movement)")
        story.append(_p("These are measurements of visible head, eye and landmark movement. They are affected by camera angle, lighting, occlusion, tracking failures and normal individual variation. They do not indicate deception, emotion, stress or guilt.", S["small"]))
        if not data["observations"]:
            story.append(_p("No observations recorded for this case.", S["p"]))
        for o in data["observations"]:
            s, ser = o["summary"], o["series"]
            block = [_p(f"Observation #{o['id']} - source: {o['source']} {o['source_name'] or ''}" + (f" - interview #{o['interview_id']}" if o["interview_id"] else ""), S["h3"]),
                     _tag("measured", S),
                     _p(f"Duration {o['duration_s']:.1f} s; face tracked {s.get('tracked_fraction', 0) * 100:.0f}% of samples; blink events {s.get('blink_count')} "
                        f"(about {s.get('blink_rate_per_min')} per minute of tracked time); head turns {s.get('head_turn_count')}; "
                        f"yaw range {s.get('yaw_range')}; pitch range {s.get('pitch_range')}; mean brightness {s.get('mean_brightness')}.", S["p"]),
                     _chart(ser.get("t", []), [("yaw (deg)", ser.get("yaw", []), colors.HexColor("#2f6f8f")),
                                               ("pitch (deg)", ser.get("pitch", []), colors.HexColor("#8a5a00"))], o["events"], o["duration_s"], title="Head orientation over time"),
                     _chart(ser.get("t", []), [("landmark motion", ser.get("energy", []), colors.HexColor("#5b6b8c"))], o["events"], o["duration_s"],
                            title="Landmark motion with event ticks (blue = blink, amber = marker)")]
            ev_rows = [[_p(x, S["cellb"]) for x in ("t (s)", "Event", "Detail")]] + [[_p(f"{e['t']:.1f}", S["cell"]), _p(e["type"], S["cell"]), _p(e.get("detail", ""), S["cell"])]
                                                                                    for e in o["events"] if e["type"] != "blink"][:30]
            story.append(KeepTogether(block[:3]))
            story += block[3:]
            if len(ev_rows) > 1:
                story.append(_table(ev_rows, [18 * mm, 35 * mm, W - 53 * mm], S))
            sw = o["software"]
            story.append(_p(f"Software: {sw.get('library', '?')} {sw.get('version', '')}; model {sw.get('model', '?')}; sample rate about {sw.get('sample_fps', '?')} Hz.", S["small"]))
            story.append(_p("Interpretation [HUMAN-ENTERED, optional]: " + (o["interpretation_note"] or "none recorded"), S["p"]))

    if "evidence" in sections:
        head("Evidence inventory")
        story.append(_tag("measured", S))
        rows = [[_p(x, S["cellb"]) for x in ("ID", "File", "Type / size", "Uploaded", "SHA-256 at upload", "Last integrity check")]]
        for e in data["evidence"]:
            last = e["integrity"][0] if e["integrity"] else None
            rows.append([_p(e["id"], S["cell"]), _p(e["original_name"] + (" [DEMO]" if e["is_demo"] else ""), S["cell"]),
                         _p(f"{e['kind']} / {e['size']} B", S["cell"]), _p(f"{e['uploaded_at']} {e.get('uploaded_by_name') or ''}", S["cell"]),
                         _p(e["sha256"], S["cell"]), _p("never" if not last else f"{last['checked_at']} - {'match' if last['ok'] else 'MISMATCH'}", S["cell"])])
        story.append(_table(rows, [8 * mm, 34 * mm, 24 * mm, 32 * mm, W - 126 * mm, 28 * mm], S))
        story.append(_p("A matching hash shows the stored file is unchanged since upload. It does not prove the file is authentic, original or that a legal chain of custody exists.", S["small"]))

    if "notes" in sections:
        head("Reviewer notes and unresolved items")
        story.append(_tag("human", S))
        notes = [(e["original_name"], nn) for e in data["evidence"] for nn in e["notes"]]
        if notes:
            story.append(_table([[_p(f"{nn['created_at']} {nn['author'] or ''}", S["cell"]), _p(name, S["cell"]), _p(nn["text"], S["cell"])] for name, nn in notes],
                                [40 * mm, 35 * mm, W - 75 * mm], S, header=False))
        else:
            story.append(_p("No evidence notes.", S["p"]))
        unresolved = []
        for iv in data["interviews"]:
            if iv["status"] != "completed":
                unresolved.append(f"Interview #{iv['id']} is not completed.")
            for it in iv["items"]:
                if it["follow_up"]:
                    unresolved.append(f"Interview #{iv['id']} Q{it['position']} marked for follow-up: {it['question_text']}")
        for a in data["analyses"]:
            for m in a["matches"]:
                if not m["decision"] and m["above_threshold"]:
                    unresolved.append(f"Analysis #{a['id']}: candidate '{m['reference_label']}' (score {m['score']:.3f}) has no human decision.")
        story.append(_p("Unresolved items", S["h3"]))
        story += [_p("- " + u, S["p"]) for u in unresolved] or [_p("None.", S["p"])]

    if "software" in sections:
        head("Model and software details")
        story.append(_tag("measured", S))
        sw = vision.engine.software()
        rows = [[_p(k, S["cellb"]), _p(v if not isinstance(v, dict) else "; ".join(f"{a}: {b}" for a, b in v.items()) or "-", S["cell"])] for k, v in sw.items()]
        rows.append([_p("report generator", S["cellb"]), _p(f"{APP_NAME} {APP_VERSION}, ReportLab", S["cell"])])
        story.append(_table(rows, [38 * mm, W - 38 * mm], S, header=False))
        story.append(_p("Published accuracy figures for these models (e.g. SFace 99.40% on LFW; YuNet WIDER FACE AP 0.884/0.866/0.750) come from benchmark data and should not be assumed to hold for your images, cameras or population.", S["small"]))

    doc.build(story, onFirstPage=deco, onLaterPages=deco)
    return buf.getvalue()
