"""Database migration helper for the Gaze Observation module (pre-gaze schema -> version 2).

    python scripts/migrate.py --status      show the schema version and gaze-table row counts
    python scripts/migrate.py               apply the migration (also happens automatically on app start)
    python scripts/migrate.py --rollback    back up the database, then remove the gaze tables (pre-gaze schema)

The migration is additive: it only creates new tables (consents, obs_sessions, gaze_samples, obs_markers,
reviewer_annotations, hr_samples). No existing table or column is changed, so every other feature keeps working.

Rollback deletes all gaze-observation and heart-rate data. A timestamped copy of the database is written next to it
first. The tables are created again, empty, the next time this version starts; set GAZE_MODULE=0 to keep the module
hidden. The pre-gaze code (git tag/commit "baseline before gaze module") runs on either database because the change is
additive. Stop Sightline before running this script.
"""
import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db  # noqa: E402


def status(c):
    v = c.execute("PRAGMA user_version").fetchone()[0]
    have = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    print(f"Database: {config.DB_PATH}")
    print(f"Schema version: {v} (this code expects {db.SCHEMA_VERSION})")
    for t in reversed(db.GAZE_TABLES):
        print(f"  {t:22s} {'%d rows' % c.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] if t in have else 'not present'}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--status", action="store_true")
    g.add_argument("--rollback", action="store_true")
    ap.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    a = ap.parse_args()
    if not Path(config.DB_PATH).exists() and not a.rollback and not a.status:
        print("No database yet; it is created with the full schema on first start.")
    if a.status:
        if not Path(config.DB_PATH).exists():
            return print("No database yet.")
        with sqlite3.connect(config.DB_PATH) as c:
            status(c)
        return
    if a.rollback:
        if not Path(config.DB_PATH).exists():
            return print("No database - nothing to roll back.")
        if not a.yes and input("This deletes ALL gaze-observation and heart-rate data. Type ROLLBACK to continue: ").strip() != "ROLLBACK":
            return print("Cancelled.")
        backup = Path(config.DB_PATH).with_name(f"sightline-before-gaze-rollback-{datetime.now():%Y%m%d-%H%M%S}.db")
        with sqlite3.connect(config.DB_PATH) as src, sqlite3.connect(backup) as dst:
            src.backup(dst)
        print(f"Backup written: {backup}")
        with sqlite3.connect(config.DB_PATH) as c:
            c.execute("PRAGMA foreign_keys=OFF")
            for t in db.GAZE_TABLES:              # children first
                c.execute(f"DROP TABLE IF EXISTS {t}")
            c.execute("PRAGMA user_version=0")
            status(c)
        print("Gaze tables removed (schema version 0, as before the module). Use GAZE_MODULE=0 to keep the module hidden.")
        return
    db.init()
    with sqlite3.connect(config.DB_PATH) as c:
        status(c)
    print("Migration applied (or already up to date).")


if __name__ == "__main__":
    main()
