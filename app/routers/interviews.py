import json

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .. import consistency, db, security, storage, util

router = APIRouter(prefix="/api")

DEFAULT_QUESTIONS = [
    ("Please state your name for the record (use your reference code if anonymised).", ""),
    ("Where were you on the evening of the incident date given in the case file?", "whereabouts"),
    ("Who, if anyone, was with you during that evening?", "whereabouts"),
    ("What time did you arrive at and leave the location in question?", "timeline"),
    ("Do you know the other person(s) named in the case file? How?", "relationships"),
    ("Have you visited the location in question before? When?", "location"),
    ("Did you notice anything unusual that day?", "observations"),
    ("Did you speak to anyone about the incident afterwards? Who and when?", "communications"),
    ("Do you have any documents, messages or items relevant to the case?", "evidence"),
    ("Is there anything you would like to add or correct in your statement?", ""),
]


class QuestionIn(BaseModel):
    text: str = Field(min_length=3, max_length=400)
    topic: str = Field(default="", max_length=40)


class QuestionsIn(BaseModel):
    questions: list[QuestionIn] = Field(min_length=1, max_length=30)


class InterviewIn(BaseModel):
    case_id: int
    subject_ref: str = Field(min_length=1, max_length=80)
    consent_confirmed: bool
    consent_note: str = Field(default="", max_length=500)
    is_demo: bool = True


class ItemPatch(BaseModel):
    response_text: str | None = Field(default=None, max_length=8000)
    notes: str | None = Field(default=None, max_length=4000)
    follow_up: bool | None = None


def seed_questions():
    if not db.row("SELECT 1 FROM questions"):
        for i, (t, topic) in enumerate(DEFAULT_QUESTIONS, 1):
            db.run("INSERT INTO questions(position,text,topic) VALUES(?,?,?)", (i, t, topic))


@router.get("/questions")
def get_questions(user=Depends(security.viewer)):
    return db.rows("SELECT position,text,topic FROM questions ORDER BY position")


@router.put("/questions")
def put_questions(body: QuestionsIn, user=Depends(security.investigator)):
    with db.conn() as c:
        c.execute("DELETE FROM questions")
        for i, q in enumerate(body.questions, 1):
            c.execute("INSERT INTO questions(position,text,topic) VALUES(?,?,?)", (i, q.text.strip(), q.topic.strip()))
    db.log(user, "questions_updated", f"{len(body.questions)} question(s) (applies to new interviews only)")
    return {"count": len(body.questions)}


def _iv(iid):
    iv = db.row("SELECT * FROM interviews WHERE id=?", (iid,))
    if not iv:
        raise HTTPException(404, "Interview not found")
    return iv


def _item(iid, pos):
    it = db.row("SELECT * FROM interview_items WHERE interview_id=? AND position=?", (iid, pos))
    if not it:
        raise HTTPException(404, "Question not found")
    return it


def _editable(iv):
    if iv["status"] == "completed":
        raise HTTPException(409, "Interview is completed. Reopen it to edit.")


@router.get("/interviews")
def list_interviews(case_id: int | None = None, user=Depends(security.viewer)):
    sql = """SELECT i.id,i.case_id,c.case_number,i.subject_ref,i.status,i.is_demo,i.created_at,i.updated_at,i.completed_at,u.username AS created_by_name,
             (SELECT COUNT(*) FROM interview_items t WHERE t.interview_id=i.id) AS total,
             (SELECT COUNT(*) FROM interview_items t WHERE t.interview_id=i.id AND trim(t.response_text)<>'') AS answered,
             (SELECT COUNT(*) FROM interview_items t WHERE t.interview_id=i.id AND t.follow_up=1) AS follow_ups
             FROM interviews i JOIN cases c ON c.id=i.case_id LEFT JOIN users u ON u.id=i.created_by"""
    args = []
    if case_id:
        sql += " WHERE i.case_id=?"; args.append(case_id)
    return db.rows(sql + " ORDER BY i.id DESC", args)


@router.post("/interviews")
def create(body: InterviewIn, user=Depends(security.investigator)):
    util.case_or_404(body.case_id)
    if not body.consent_confirmed:
        raise HTTPException(400, "Documented consent or legal authority must be confirmed before an interview")
    qs = db.rows("SELECT position,text,topic FROM questions ORDER BY position")
    if not qs:
        raise HTTPException(400, "No interview questions configured")
    now = db.now()
    iid = db.run("""INSERT INTO interviews(case_id,subject_ref,consent_confirmed,consent_note,is_demo,created_by,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?)""", (body.case_id, body.subject_ref.strip(), 1, body.consent_note, int(body.is_demo), user["id"], now, now))
    with db.conn() as c:
        for q in qs:
            c.execute("INSERT INTO interview_items(interview_id,position,question_text,topic) VALUES(?,?,?,?)", (iid, q["position"], q["text"], q["topic"]))
    util.touch_case(body.case_id)
    db.log(user, "interview_created", f"subject {body.subject_ref}, {len(qs)} questions", body.case_id, "interview", iid)
    return {"id": iid}


@router.get("/interviews/{iid}")
def get(iid: int, user=Depends(security.viewer)):
    iv = dict(_iv(iid))
    iv["summary"] = db.loads(iv.pop("summary_json"), None)
    iv["items"] = [util.public_item(i) for i in db.rows("SELECT * FROM interview_items WHERE interview_id=? ORDER BY position", (iid,))]
    return iv


@router.patch("/interviews/{iid}/items/{pos}")
def patch_item(iid: int, pos: int, body: ItemPatch, user=Depends(security.investigator)):
    iv = _iv(iid)
    _editable(iv)
    it = _item(iid, pos)
    ch = body.model_dump(exclude_none=True)
    if "follow_up" in ch:
        ch["follow_up"] = int(ch["follow_up"])
    if "response_text" in ch and ch["response_text"] != it["response_text"]:
        ch["answered_at"] = db.now() if ch["response_text"].strip() else None
    if ch:
        db.run(f"UPDATE interview_items SET {', '.join(k + '=?' for k in ch)} WHERE id=?", [*ch.values(), it["id"]])
        db.run("UPDATE interviews SET updated_at=? WHERE id=?", (db.now(), iid))
        if "follow_up" in ch and ch["follow_up"] != it["follow_up"]:
            db.log(user, "interview_follow_up", f"Q{pos} {'marked' if ch['follow_up'] else 'unmarked'}", iv["case_id"], "interview", iid)
    return {"ok": True}


@router.post("/interviews/{iid}/items/{pos}/recording")
def upload_recording(iid: int, pos: int, file: UploadFile = File(...), user=Depends(security.investigator)):
    iv = _iv(iid)
    _editable(iv)
    it = _item(iid, pos)
    mime = (file.content_type or "").split(";")[0]
    if not (mime.startswith("audio/") or mime == "video/webm"):
        raise HTTPException(415, "Only audio recordings are accepted")
    data = util.read_upload(file)
    storage.delete(it["rec_stored"])
    db.run("UPDATE interview_items SET rec_stored=?,rec_mime=?,rec_sha256=?,rec_size=?,rec_at=? WHERE id=?",
           (storage.put(data), mime, storage.sha256(data), len(data), db.now(), it["id"]))
    db.log(user, "interview_recording", f"Q{pos}: {len(data)} B audio", iv["case_id"], "interview", iid)
    return {"ok": True, "size": len(data)}


@router.get("/interviews/{iid}/items/{pos}/recording")
def get_recording(iid: int, pos: int, user=Depends(security.viewer)):
    _iv(iid)
    it = _item(iid, pos)
    if not it["rec_stored"]:
        raise HTTPException(404, "No recording")
    return Response(storage.get(it["rec_stored"]), media_type=it["rec_mime"] or "audio/webm")


@router.delete("/interviews/{iid}/items/{pos}/recording")
def delete_recording(iid: int, pos: int, user=Depends(security.investigator)):
    iv = _iv(iid)
    _editable(iv)
    it = _item(iid, pos)
    if it["rec_stored"]:
        storage.delete(it["rec_stored"])
        db.run("UPDATE interview_items SET rec_stored=NULL,rec_mime=NULL,rec_sha256=NULL,rec_size=NULL,rec_at=NULL WHERE id=?", (it["id"],))
        db.log(user, "interview_recording_deleted", f"Q{pos}", iv["case_id"], "interview", iid)
    return {"ok": True}


def _summarize(iid):
    iv = _iv(iid)
    items = db.rows("SELECT * FROM interview_items WHERE interview_id=? ORDER BY position", (iid,))
    s = consistency.build_summary(iv, items)
    db.run("UPDATE interviews SET summary_json=?, updated_at=? WHERE id=?", (json.dumps(s), db.now(), iid))
    return s


@router.post("/interviews/{iid}/summary")
def summary(iid: int, user=Depends(security.investigator)):
    iv = _iv(iid)
    s = _summarize(iid)
    db.log(user, "interview_summary", "summary regenerated", iv["case_id"], "interview", iid)
    return s


@router.post("/interviews/{iid}/complete")
def complete(iid: int, user=Depends(security.investigator)):
    iv = _iv(iid)
    db.run("UPDATE interviews SET status='completed', completed_at=? WHERE id=?", (db.now(), iid))
    s = _summarize(iid)
    util.touch_case(iv["case_id"])
    db.log(user, "interview_completed", f"{s['answered']}/{s['total_questions']} answered, {len(s['differences_for_review'])} difference(s) for review", iv["case_id"], "interview", iid)
    return s


@router.post("/interviews/{iid}/reopen")
def reopen(iid: int, user=Depends(security.investigator)):
    iv = _iv(iid)
    db.run("UPDATE interviews SET status='in_progress', completed_at=NULL WHERE id=?", (iid,))
    db.log(user, "interview_reopened", "", iv["case_id"], "interview", iid)
    return {"ok": True}


@router.delete("/interviews/{iid}")
def delete(iid: int, user=Depends(security.admin)):
    iv = _iv(iid)
    for r in db.rows("SELECT rec_stored FROM interview_items WHERE interview_id=? AND rec_stored IS NOT NULL", (iid,)):
        storage.delete(r["rec_stored"])
    db.run("DELETE FROM interviews WHERE id=?", (iid,))
    db.log(user, "interview_deleted", f"#{iid}", iv["case_id"], "interview", iid)
    return {"deleted": iid}
