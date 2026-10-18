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

# ---- Schema v2: Gaze Observation + heart-rate add-on. Additive only (new tables), so existing data is untouched.
# Rollback: stop the app and run  python scripts/migrate.py --rollback  (drops only these tables).
GAZE_TABLES = ["hr_samples", "reviewer_annotations", "obs_markers", "gaze_samples", "obs_sessions", "consents"]
GAZE_SCHEMA = """
CREATE TABLE IF NOT EXISTS consents(
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  interview_id INTEGER REFERENCES interviews(id) ON DELETE SET NULL, subject_ref TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('gaze_observation','heart_rate')), statement TEXT NOT NULL,
  statement_version TEXT NOT NULL, form_ref TEXT NOT NULL DEFAULT '', is_demo INTEGER NOT NULL DEFAULT 1,
  confirmed_by INTEGER REFERENCES users(id), confirmed_at TEXT NOT NULL,
  withdrawn_by INTEGER REFERENCES users(id), withdrawn_at TEXT);
CREATE TABLE IF NOT EXISTS obs_sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  interview_id INTEGER REFERENCES interviews(id) ON DELETE SET NULL,
  consent_id INTEGER NOT NULL REFERENCES consents(id) ON DELETE CASCADE,
  hr_consent_id INTEGER REFERENCES consents(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('webcam','file')),
  source_name TEXT NOT NULL DEFAULT '', calibration_status TEXT NOT NULL CHECK(calibration_status IN ('completed','poor','skipped')),
  calibration_json TEXT NOT NULL DEFAULT '{}', settings_version TEXT NOT NULL, settings_json TEXT NOT NULL DEFAULT '{}',
  software_json TEXT NOT NULL DEFAULT '{}', glasses_declared INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0, summary_json TEXT NOT NULL DEFAULT '{}', is_demo INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gaze_samples(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES obs_sessions(id) ON DELETE CASCADE,
  timestamp_ms INTEGER NOT NULL, horizontal_label TEXT NOT NULL, vertical_label TEXT NOT NULL,
  horizontal_offset REAL, vertical_offset REAL, stability_ms INTEGER NOT NULL DEFAULT 0, shift_event INTEGER NOT NULL DEFAULT 0,
  blink_event INTEGER NOT NULL DEFAULT 0, eyes_closed INTEGER NOT NULL DEFAULT 0, eyes_closed_event INTEGER NOT NULL DEFAULT 0,
  closed_duration_ms INTEGER, head_yaw REAL, head_pitch REAL, head_roll REAL, face_visible INTEGER NOT NULL,
  tracking_confidence REAL NOT NULL, quality_flags TEXT NOT NULL DEFAULT '', question_marker_id INTEGER);
CREATE INDEX IF NOT EXISTS ix_gaze_samples_session ON gaze_samples(session_id, timestamp_ms);
CREATE TABLE IF NOT EXISTS obs_markers(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES obs_sessions(id) ON DELETE CASCADE,
  timestamp_ms INTEGER NOT NULL, marker_type TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', question_marker_id INTEGER,
  created_by INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS reviewer_annotations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES obs_sessions(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  tag TEXT NOT NULL CHECK(tag IN ('review_later','technical_issue','context_note','not_relevant')),
  note TEXT NOT NULL DEFAULT '', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hr_samples(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES obs_sessions(id) ON DELETE CASCADE,
  timestamp_ms INTEGER NOT NULL, bpm INTEGER NOT NULL, contact INTEGER, rr_ms TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS ix_hr_samples_session ON hr_samples(session_id, timestamp_ms);
"""
SCHEMA_VERSION = 2


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
        c.executescript(GAZE_SCHEMA)
        if c.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
            c.execute(f"PRAGMA user_version={SCHEMA_VERSION}")


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
