import os
import shutil
import tempfile

_TMP = tempfile.mkdtemp(prefix="sightline_test_")
os.environ["DATA_DIR"] = _TMP
os.environ["DEMO_PASSWORD"] = "Test@12345"

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

H = {"X-Requested-With": "fetch"}


@pytest.fixture(scope="session")
def app_client():
    from app.main import app
    with TestClient(app) as c:
        yield c
    shutil.rmtree(_TMP, ignore_errors=True)


def _login(user):
    from app.main import app
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": user, "password": "Test@12345"}, headers=H)
    assert r.status_code == 200, r.text
    return c


@pytest.fixture(scope="session")
def admin(app_client):
    return _login("admin")


@pytest.fixture(scope="session")
def inv(app_client):
    return _login("investigator")


@pytest.fixture(scope="session")
def viewer(app_client):
    return _login("viewer")


@pytest.fixture(scope="session")
def face_jpg():
    """Public-domain NASA sample photo shipped with scikit-image (tests only; never bundled in the app)."""
    from skimage import data
    return cv2.imencode(".jpg", cv2.cvtColor(data.astronaut(), cv2.COLOR_RGB2BGR))[1].tobytes()


@pytest.fixture(scope="session")
def blank_png():
    return cv2.imencode(".png", np.full((200, 300, 3), 90, np.uint8))[1].tobytes()


@pytest.fixture(scope="session")
def video_avi(face_jpg, tmp_path_factory):
    img = cv2.imdecode(np.frombuffer(face_jpg, np.uint8), cv2.IMREAD_COLOR)
    p = tmp_path_factory.mktemp("vid") / "clip.avi"
    w = cv2.VideoWriter(str(p), cv2.VideoWriter_fourcc(*"MJPG"), 10, (img.shape[1], img.shape[0]))
    for i in range(30):
        w.write(img.copy() if i < 20 else np.full_like(img, 100))   # face for 2 s, then blank for 1 s
    w.release()
    return p.read_bytes()


@pytest.fixture()
def new_case(inv):
    return inv.post("/api/cases", json={"title": "Test case", "description": "fictional"}, headers=H).json()["id"]
