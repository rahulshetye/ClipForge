"""
FastAPI wrapper for Part 2 (AI Video Editor).
Manifest-driven: POST /projects creates a project from an uploaded video;
every step is then callable independently (POST /projects/{id}/steps/{name})
or all at once in priority order (POST /projects/{id}/run-all). Both paths
call the exact same steps/registry.py functions -- no duplicated logic.

Every request is authenticated via a Firebase ID token (Authorization:
Bearer <token>). The verified uid is stored on the project manifest at
creation time and checked on every subsequent request for that project,
so one user can never read or modify another user's project.

PERSISTENCE (step 6): the actual project manifest keeps living exactly as
before, in projects/{id}/project.json via steps/project_store.py -- that
part of the pipeline is untouched. Alongside it, a lightweight index entry
is written to Firestore at users/{uid}/projects/{project_id} on creation.
That index is what makes "list my projects" possible and durable: the
manifest file is still the source of truth for project *content*, but the
index is what lets the frontend show project history after login without
scanning the whole projects/ directory. If a project.json file is ever
missing despite an index entry existing, /projects/{project_id} still
404s correctly -- the index is a pointer, not a guarantee.

SUBTITLE PRESETS (subtitle_styles.STYLE_PRESETS): stepParams already forwards
arbitrary per-step kwargs generically (camelCase -> snake_case, see
_to_snake_case below), so a caller passing
{ "subtitle_styles": { "presetName": "studio" } } reaches
subtitle_styles.run() as preset_name="studio" with no wiring needed here.
The one addition below is fail-fast validation: an unknown preset name is
now rejected with 400 before the background job is even queued, instead of
only surfacing later as a failed job status -- same "check before doing any
work" pattern already used for the 404/403 ownership check.

CAPTIONS (steps/captions.py): the same generic forwarding carries
{ "captions": { "language": "auto"|"en"|"hi", "script": "native"|"roman",
"onMismatch": "warn"|"raise"|"use_detected" } } to captions.run(). Those
values are validated up front (400 before queueing). With onMismatch "raise",
a language choice that clearly doesn't match the audio fails the job early
with a LanguageMismatchError; that is recorded in job_status as
details={code: "language_mismatch", requested, detected, confidence} and
returned by GET /projects/{id} as `errorDetails`, so the frontend can ask the
user what to do instead of showing a generic failure.

Run locally with: uvicorn app:app --reload --port 8002
Run in production with: python app.py
"""

import os
import shutil
import threading
import uuid
from typing import Dict, List, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from steps.project_store import create_project, load_project, save_project, MissingDependencyError
from steps.registry import run_step, run_all, STEP_ORDER
from steps.subtitle_styles import STYLE_PRESETS
from steps.captions import LANG_CONFIG, LanguageMismatchError
from auth import get_current_uid
import firebase_admin_init  # ensures the Admin SDK (and its default app) is initialized before Firestore is used
from firebase_admin import firestore  # reuses firebase_admin_init's credentials -- not google.cloud.firestore, which needs separate ADC

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
PROJECTS_DIR = os.path.join(os.path.dirname(__file__), "projects")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8002")
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*").split(",")

app = FastAPI(title="ClipForge Part 2 - Editor")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(PROJECTS_DIR, exist_ok=True)
app.mount("/files", StaticFiles(directory=PROJECTS_DIR), name="files")

# Tracks background-thread status per project -- same in-memory caveat as
# before: fine for single-instance prototype deployment, swap for
# MongoDB/Redis if this ever runs multi-instance. The durable pipeline
# state itself lives in projects/{id}/project.json, not here.
# Entry shape: {"status": str, "error": str|None, "details": dict|None}
job_status = {}
_job_lock = threading.Lock()  # makes "is a job already running? -> claim it" atomic

# Firestore client -- index only, not the source of truth for project data.
db = firestore.client()


def _project_index_ref(uid: str, project_id: str):
    """Path: users/{uid}/projects/{project_id}. A pointer entry, not the
    manifest itself -- lets us list a user's projects without scanning
    the projects/ directory on disk."""
    return db.collection("users").document(uid).collection("projects").document(project_id)


def _video_url(video_path: str) -> str:
    relative_path = os.path.relpath(video_path, PROJECTS_DIR)
    return f"{PUBLIC_BASE_URL}/files/{relative_path}"


def _load_owned_project(project_id: str, uid: str):
    """Loads a project and verifies it belongs to uid. Raises 404 if the
    project doesn't exist, 403 if it exists but belongs to someone else --
    same pattern as Part 1's job ownership check."""
    try:
        project = load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found.")

    if project.get("uid") != uid:
        raise HTTPException(status_code=403, detail="Not your project.")

    return project


def _claim_job(project_id: str) -> None:
    """Marks the project's job as queued, or raises 409 if one is already
    queued/running for it. Two overlapping jobs on one project would both
    read and write project.json and could overwrite each other's results."""
    with _job_lock:
        current = job_status.get(project_id)
        if current and current["status"] in ("queued", "running"):
            raise HTTPException(status_code=409, detail="This project is already being processed.")
        job_status[project_id] = {"status": "queued", "error": None, "details": None}


def _validate_step_names(steps: Optional[List[str]]) -> None:
    """400 for an unknown step name, before anything is queued or run."""
    if not steps:
        return
    valid = set(STEP_REGISTRY_NAMES())
    unknown = [s for s in steps if s not in valid]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown step(s) {unknown}. Valid: {STEP_ORDER}")


def _validate_step_params(step_params: Dict[str, Dict]) -> None:
    """
    Fail-fast checks for step params we can validate without running anything.
    Covers subtitle_styles' preset_name and captions' language / script /
    on_mismatch -- extend this if other steps grow similarly-checkable params.
    Raises HTTPException(400) on a bad value rather than letting it surface
    later as a failed background job.
    """
    subtitle_params = step_params.get("subtitle_styles")
    if subtitle_params and "preset_name" in subtitle_params:
        preset_name = subtitle_params["preset_name"]
        if preset_name is not None and preset_name not in STYLE_PRESETS:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown subtitle preset '{preset_name}'. Valid: {list(STYLE_PRESETS.keys())}",
            )

    caption_params = step_params.get("captions")
    if caption_params:
        language = caption_params.get("language")
        if language is not None and language != "auto" and language not in LANG_CONFIG:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported caption language '{language}'. Valid: auto, {list(LANG_CONFIG.keys())}",
            )
        if caption_params.get("script", "native") not in ("native", "roman"):
            raise HTTPException(status_code=400, detail="Caption script must be 'native' or 'roman'.")
        if caption_params.get("on_mismatch", "warn") not in ("warn", "raise", "use_detected"):
            raise HTTPException(
                status_code=400,
                detail="Caption on_mismatch must be 'warn', 'raise' or 'use_detected'.",
            )


def _run_in_background(project_id: str, fn):
    """Runs `fn(project)` in a background thread and updates job_status."""
    try:
        job_status[project_id] = {"status": "running", "error": None, "details": None}
        project = load_project(project_id)
        project = fn(project)
        job_status[project_id] = {"status": "done", "error": None, "details": None}
    except LanguageMismatchError as e:
        # Structured, so the frontend can offer "switch language" / "continue anyway"
        # instead of only showing an error string.
        job_status[project_id] = {
            "status": "failed",
            "error": str(e),
            "details": {
                "code": "language_mismatch",
                "requested": e.requested,
                "detected": e.detected,
                "confidence": round(e.share, 2),
            },
        }
    except MissingDependencyError as e:
        job_status[project_id] = {"status": "failed", "error": str(e), "details": None}
    except Exception as e:
        job_status[project_id] = {"status": "failed", "error": str(e), "details": None}


class StepRequest(BaseModel):
    """Optional body for POST /steps/{name}: per-step kwargs in camelCase,
    e.g. { "params": { "language": "hi", "script": "roman" } }."""
    params: Optional[Dict] = None


class RunAllRequest(BaseModel):
    """Body for POST /run-all. Both fields optional -- omit `steps` to run
    the full default STEP_ORDER, omit `stepParams` to run every step with
    its own defaults (same behavior as before this existed)."""
    steps: Optional[List[str]] = None
    stepParams: Optional[Dict[str, Dict]] = None


@app.post("/projects")
async def create(file: UploadFile = File(...), uid: str = Depends(get_current_uid)):
    """Uploads a video and creates a new project (manifest) from it,
    tagged with the verified uid that owns it. Also writes a lightweight
    index entry to Firestore so this project shows up in the user's
    project history."""
    # Never trust the client's filename for a path: strip any directory parts
    # and prefix a random id so two uploads named "video.mp4" can't overwrite
    # each other.
    original_name = os.path.basename(file.filename or "upload.mp4")
    upload_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_{original_name}")
    with open(upload_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    project = create_project(upload_path)
    project["uid"] = uid
    save_project(project)

    project_id = project["project_id"]
    _project_index_ref(uid, project_id).set({
        "projectId": project_id,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "filename": original_name,
    })

    return {"projectId": project_id, "status": "created"}


@app.post("/projects/{project_id}/steps/{step_name}")
async def run_one_step(
    project_id: str,
    step_name: str,
    req: StepRequest = StepRequest(),
    uid: str = Depends(get_current_uid),
):
    """Runs a single step against this project's current manifest state.
    Independently callable in any order -- each step checks its own
    dependencies (e.g. broll requires captions to have run first) and
    raises a clear error if they're missing, rather than needing the
    caller to have prior results in hand.
    Optional body { "params": { camelCaseKwarg: value } } is forwarded to the
    step's run() as snake_case kwargs."""
    _load_owned_project(project_id, uid)  # 404/403 before doing any work

    if step_name not in STEP_REGISTRY_NAMES():
        raise HTTPException(status_code=404, detail=f"Unknown step '{step_name}'. Valid: {STEP_ORDER}")

    params = {_to_snake_case(k): v for k, v in (req.params or {}).items()}
    _validate_step_params({step_name: params})  # 400 before queueing

    _claim_job(project_id)  # 409 if this project is already being processed
    thread = threading.Thread(
        target=_run_in_background,
        args=(project_id, lambda p: run_step(step_name, p, **params)),
        daemon=True,
    )
    thread.start()
    return {"projectId": project_id, "step": step_name, "status": "queued"}


@app.post("/projects/{project_id}/run-all")
async def run_all_steps(project_id: str, req: RunAllRequest = RunAllRequest(), uid: str = Depends(get_current_uid)):
    """
    Runs steps sequentially in priority order (default: full STEP_ORDER).
    Body: { "steps": [...], "stepParams": { stepName: { kwarg: value } } }
    -- both optional. stepParams lets a caller pass per-step options (e.g.
    { "subtitle_styles": { "style": "boxed", "fontName": "modern" } },
    { "subtitle_styles": { "presetName": "studio" } }, or
    { "captions": { "language": "hi", "script": "roman", "onMismatch": "raise" } }),
    forwarded to registry.run_all's step_params.

    NOTE: switched from a `?steps=a,b,c` query param to a JSON body, since
    stepParams is a nested object that doesn't serialize cleanly into a
    query string. If anything client-side still sends the old query-string
    form, it's silently ignored now -- update the caller to send a body.
    """
    _load_owned_project(project_id, uid)  # 404/403 before doing any work

    _validate_step_names(req.steps)  # 400 on a typo'd step, before anything runs

    # registry.run_step/subtitle_styles.run expect `font_name`/`preset_name`,
    # not `fontName`/`presetName` -- translate each step's param dict from
    # the wire's camelCase to Python's snake_case here, once, rather than
    # pushing that convention mismatch down into every individual step function.
    step_params = {
        step: {_to_snake_case(k): v for k, v in params.items()}
        for step, params in (req.stepParams or {}).items()
    }
    _validate_step_params(step_params)  # 400 before queueing, not a failed job after

    _claim_job(project_id)  # 409 if this project is already being processed
    thread = threading.Thread(
        target=_run_in_background,
        args=(project_id, lambda p: run_all(p, steps=req.steps, step_params=step_params)),
        daemon=True,
    )
    thread.start()
    return {"projectId": project_id, "status": "queued"}


def _to_snake_case(key: str) -> str:
    return "".join(f"_{c.lower()}" if c.isupper() else c for c in key)


@app.get("/projects")
def list_projects(uid: str = Depends(get_current_uid)):
    """Returns this user's project history, most recent first, from the
    Firestore index. Note: this lists index entries, not full manifests --
    each entry's projectId can be passed to GET /projects/{id} for the
    full state. If a project.json was somehow deleted independently, that
    follow-up call 404s even though it still appears in this list; the
    frontend should handle that gracefully rather than assume the index
    guarantees the file exists."""
    docs = (
        db.collection("users").document(uid).collection("projects")
        .order_by("createdAt", direction=firestore.Query.DESCENDING)
        .stream()
    )
    return [doc.to_dict() for doc in docs]


@app.get("/projects/{project_id}")
def get_project(project_id: str, uid: str = Depends(get_current_uid)):
    """Returns the full manifest -- current video, applied steps, and all
    step data (words, broll clips, keep_ranges, etc). Poll this after
    triggering a step to see when it's done. `errorDetails` is set only for
    failures the frontend can act on (currently: code "language_mismatch")."""
    project = _load_owned_project(project_id, uid)

    status = job_status.get(project_id, {"status": "idle", "error": None, "details": None})
    return {
        **project,
        "status": status["status"],
        "error": status["error"],
        "errorDetails": status.get("details"),
        "videoUrl": _video_url(project["current_video"]) if project.get("current_video") else None,
    }


@app.get("/health")
def health():
    return {"status": "ok"}


def STEP_REGISTRY_NAMES():
    from steps.registry import STEP_REGISTRY
    return STEP_REGISTRY.keys()


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8002))
    uvicorn.run(app, host="0.0.0.0", port=port)