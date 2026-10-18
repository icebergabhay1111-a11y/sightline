"""Auth, roles, CSRF, cases and evidence."""
import hashlib

from conftest import H


def test_unauthenticated_blocked(app_client):
    assert app_client.get("/api/cases").status_code == 401
    assert app_client.get("/api/evidence/1/file").status_code == 401


def test_csrf_header_required(inv):
    assert inv.post("/api/cases", json={"title": "No header"}).status_code == 403


def test_login_wrong_password_and_throttle(app_client):
    from fastapi.testclient import TestClient
    from app.main import app
    from app import security
    c = TestClient(app)
    for _ in range(5):
        assert c.post("/api/auth/login", json={"username": "viewer", "password": "bad"}, headers=H).status_code == 401
    assert c.post("/api/auth/login", json={"username": "viewer", "password": "bad"}, headers=H).status_code == 429
    security._fails.clear()


def test_roles(viewer, inv, admin, new_case):
    assert viewer.get("/api/cases").status_code == 200
    assert viewer.post("/api/cases", json={"title": "Nope nope"}, headers=H).status_code == 403
    assert inv.delete(f"/api/cases/{new_case}", headers=H).status_code == 403
    assert admin.get("/api/users").status_code == 200
    assert inv.get("/api/users").status_code == 403


def test_user_admin_rules(admin):
    r = admin.post("/api/users", json={"username": "newbie", "password": "longenough1", "role": "viewer"}, headers=H)
    assert r.status_code == 200
    assert admin.post("/api/users", json={"username": "newbie", "password": "longenough1", "role": "viewer"}, headers=H).status_code == 409
    me = admin.get("/api/auth/me").json()
    assert admin.patch(f"/api/users/{me['id']}", json={"active": False}, headers=H).status_code == 400
    assert admin.patch(f"/api/users/{r.json()['id']}", json={"role": "investigator"}, headers=H).status_code == 200


def test_case_crud_search_filter(inv, admin):
    r = inv.post("/api/cases", json={"title": "Alpha harbour inquiry", "description": "fictional", "priority": "high", "is_demo": False}, headers=H)
    cid = r.json()["id"]
    assert r.json()["case_number"].startswith("CASE-")
    assert inv.get("/api/cases", params={"q": "harbour"}).json()[0]["id"] == cid
    assert all(c["is_demo"] == 0 for c in inv.get("/api/cases", params={"demo": "0"}).json())
    assert inv.patch(f"/api/cases/{cid}", json={"status": "under_review"}, headers=H).status_code == 200
    assert inv.get(f"/api/cases/{cid}").json()["status"] == "under_review"
    assert inv.patch(f"/api/cases/{cid}", json={"status": "bogus"}, headers=H).status_code == 422
    assert any(e["type"] == "case_updated" for e in inv.get(f"/api/cases/{cid}/timeline").json())
    assert admin.delete(f"/api/cases/{cid}", headers=H).status_code == 200
    assert inv.get(f"/api/cases/{cid}").status_code == 404


def test_evidence_upload_hash_verify_tamper(inv, new_case, blank_png):
    r = inv.post(f"/api/cases/{new_case}/evidence", files={"file": ("../../evil name.png", blank_png, "image/png")}, data={"description": "x"}, headers=H)
    assert r.status_code == 200
    eid = r.json()["id"]
    assert r.json()["sha256"] == hashlib.sha256(blank_png).hexdigest()
    ev = inv.get(f"/api/evidence/{eid}").json()
    assert ev["original_name"] == "evil name.png" and "stored_name" not in ev
    assert inv.get(f"/api/evidence/{eid}/file").content == blank_png
    assert inv.post(f"/api/evidence/{eid}/verify", headers=H).json()["ok"] is True
    from app import config, db
    p = config.UPLOAD_DIR / db.row("SELECT stored_name FROM evidence WHERE id=?", (eid,))["stored_name"]
    raw = p.read_bytes()
    assert blank_png[:8] not in raw            # encrypted at rest
    p.write_bytes(raw[:-5] + b"XXXXX")          # tamper
    assert inv.post(f"/api/evidence/{eid}/verify", headers=H).json()["ok"] is False
    assert inv.get(f"/api/evidence/{eid}").json()["integrity_checks"][0]["ok"] == 0


def test_evidence_upload_rules(inv, viewer, new_case, blank_png):
    assert inv.post(f"/api/cases/{new_case}/evidence", files={"file": ("a.exe", b"MZ", "application/octet-stream")}, headers=H).status_code == 415
    assert inv.post(f"/api/cases/{new_case}/evidence", files={"file": ("a.png", b"not a png", "image/png")}, headers=H).status_code == 400
    assert inv.post(f"/api/cases/{new_case}/evidence", files={"file": ("a.txt", b"", "text/plain")}, headers=H).status_code == 400
    assert viewer.post(f"/api/cases/{new_case}/evidence", files={"file": ("a.png", blank_png, "image/png")}, headers=H).status_code == 403
    import app.util as util
    old = util.MAX_BYTES
    util.MAX_BYTES = 1000
    try:
        assert inv.post(f"/api/cases/{new_case}/evidence", files={"file": ("big.txt", b"x" * 2000, "text/plain")}, headers=H).status_code == 413
    finally:
        util.MAX_BYTES = old


def test_evidence_notes_and_filters(inv, new_case, blank_png):
    eid = inv.post(f"/api/cases/{new_case}/evidence", files={"file": ("n.png", blank_png, "image/png")}, headers=H).json()["id"]
    assert inv.post(f"/api/evidence/{eid}/notes", json={"text": "reviewer note"}, headers=H).status_code == 200
    assert inv.get(f"/api/evidence/{eid}").json()["notes"][0]["text"] == "reviewer note"
    assert any(e["id"] == eid for e in inv.get("/api/evidence", params={"case_id": new_case, "kind": "image"}).json())
    assert inv.get("/api/evidence", params={"case_id": new_case, "kind": "video"}).json() == []


def test_html_never_served_inline(inv, new_case):
    eid = inv.post(f"/api/cases/{new_case}/evidence", files={"file": ("n.txt", b"<script>alert(1)</script>", "text/html")}, headers=H).json()["id"]
    r = inv.get(f"/api/evidence/{eid}/file", params={"inline": 1})
    assert r.headers["content-type"] == "application/octet-stream" and "attachment" in r.headers["content-disposition"]


def test_case_delete_removes_encrypted_files(inv, admin, blank_png):
    from app import config, db
    cid = inv.post("/api/cases", json={"title": "To be deleted"}, headers=H).json()["id"]
    eid = inv.post(f"/api/cases/{cid}/evidence", files={"file": ("d.png", blank_png, "image/png")}, headers=H).json()["id"]
    p = config.UPLOAD_DIR / db.row("SELECT stored_name FROM evidence WHERE id=?", (eid,))["stored_name"]
    assert p.exists()
    admin.delete(f"/api/cases/{cid}", headers=H)
    assert not p.exists()
