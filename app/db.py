"""SQLite layer: schema, helpers, event log."""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','investigator','viewer')), active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cases(
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_number TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'medium',
  is_demo INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evidence(
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT, kind TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', is_demo INTEGER NOT NULL DEFAULT 1,
  uploaded_by INTEGER REFERENCES users(id), uploaded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evidence_notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id), text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS integrity_checks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  checked_by INTEGER REFERENCES users(id), checked_at TEXT NOT NULL, ok INTEGER NOT NULL, sha256_now TEXT);
CREATE TABLE IF NOT EXISTS analyses(
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  detector TEXT NOT NULL, params_json TEXT NOT NULL, result_json TEXT NOT NULL, face_count_max INTEGER NOT NULL DEFAULT 0,
  software_json TEXT NOT NULL DEFAULT '{}', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reference_images(
  id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, consent_ref TEXT NOT NULL, stored_name TEXT NOT NULL,
  embedding BLOB NOT NULL, quality_json TEXT NOT NULL DEFAULT '{}', is_demo INTEGER NOT NULL DEFAULT 1,
  review_by TEXT NOT NULL, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS matches(
  id INTEGER PRIMARY KEY AUTOINCREMENT, analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  frame INTEGER NOT NULL DEFAULT 0, face_index INTEGER NOT NULL, reference_id INTEGER, reference_label TEXT,
  rank INTEGER NOT NULL, score REAL NOT NULL, threshold REAL NOT NULL, above_threshold INTEGER NOT NULL,
  run_id TEXT NOT NULL, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
  decision TEXT, decision_note TEXT, decided_by INTEGER REFERENCES users(id), decided_at TEXT);
CREATE TABLE IF NOT EXISTS questions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, position INTEGER NOT NULL, text TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS interviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  subject_ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'in_progress', consent_confirmed INTEGER NOT NULL,
  consent_note TEXT NOT NULL DEFAULT '', is_demo INTEGER NOT NULL DEFAULT 1, summary_json TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE IF NOT EXISTS interview_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, question_text TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', response_text TEXT NOT NULL DEFAULT '',
  answered_at TEXT, notes TEXT NOT NULL DEFAULT '', follow_up INTEGER NOT NULL DEFAULT 0,
  rec_stored TEXT, rec_mime TEXT, rec_sha256 TEXT, rec_size INTEGER, rec_at TEXT,
  UNIQUE(interview_id, position));
CREATE TABLE IF NOT EXISTS observations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  interview_id INTEGER REFERENCES interviews(id) ON DELETE SET NULL, source TEXT NOT NULL, source_name TEXT,
  started_at TEXT, duration_s REAL NOT NULL DEFAULT 0, series_json TEXT NOT NULL, events_json TEXT NOT NULL,
  summary_json TEXT NOT NULL, software_json TEXT NOT NULL DEFAULT '{}', interpretation_note TEXT NOT NULL DEFAULT '',
  is_demo INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, case_id INTEGER, user_id INTEGER, username TEXT,
  type TEXT NOT NULL, ref_type TEXT, ref_id INTEGER, detail TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS ix_events_case ON events(case_id);
CREATE INDEX IF NOT EXISTS ix_evidence_case ON evidence(case_id);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def conn():
    c = sqlite3.connect(config.DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    try:
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()


def init():
    with conn() as c:
        c.executescript(SCHEMA)


def rows(sql, args=()):
    with conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def row(sql, args=()):
    with conn() as c:
        r = c.execute(sql, args).fetchone()
    return dict(r) if r else None


def run(sql, args=()):
    """Execute a write; returns lastrowid."""
    with conn() as c:
        return c.execute(sql, args).lastrowid


def log(user, type_, detail="", case_id=None, ref_type=None, ref_id=None):
    uid = user["id"] if user else None
    uname = user["username"] if user else "system"
    run("INSERT INTO events(ts,case_id,user_id,username,type,ref_type,ref_id,detail) VALUES(?,?,?,?,?,?,?,?)",
        (now(), case_id, uid, uname, type_, ref_type, ref_id, detail[:500]))


def loads(s, default=None):
    try:
        return json.loads(s) if s else default
    except (TypeError, ValueError):
        return default
