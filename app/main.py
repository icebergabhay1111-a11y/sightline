"""Sightline - AI-assisted investigation workbench (ACADEMIC PROTOTYPE).  Start with:  python run.py"""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from . import APP_NAME, APP_VERSION, config, db, security, seed
from .routers import auth, cases, evidence, faces, gaze, interviews, misc, observations

STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app):
    db.init()
    fresh = seed.seed_users()
    interviews.seed_questions()
    if fresh:
        seed.seed_demo()
        print(f"\n  First run: created demo accounts admin / investigator / viewer  (password: {config.DEMO_PASSWORD})\n")
    yield


app = FastAPI(title=f"{APP_NAME} (academic prototype)", version=APP_VERSION, lifespan=lifespan)
app.middleware("http")(security.csrf_guard)
app.add_middleware(SessionMiddleware, secret_key=config.session_secret(), session_cookie="sightline_session",
                   max_age=config.SESSION_HOURS * 3600, same_site="lax", https_only=config.COOKIE_SECURE)
for r in (auth, cases, evidence, faces, interviews, observations, misc):
    app.include_router(r.router)
if config.GAZE_ENABLED:
    app.include_router(gaze.router)


@app.get("/models/face_landmarker.task")
def landmarker_model():
    p = config.MODELS_DIR / "face_landmarker.task"
    if not p.exists():
        return JSONResponse({"detail": "not installed"}, status_code=404)
    return FileResponse(p, media_type="application/octet-stream")


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
