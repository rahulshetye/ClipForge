"""
FastAPI wrapper for Part 1 (AI Video Generation).
Exposes main.py's `run()` function as an HTTP API, built for deployment
(not just local testing):

- Generation runs in a BACKGROUND TASK, not inline in the request. Most hosts
  (Render, Railway, etc.) kill HTTP requests after ~30-60s, and generation
  takes minutes -- so the endpoint returns immediately with a jobId, and the
  frontend polls GET /jobs/{jobId} until it's done.
- Generated videos are served as downloadable URLs via a mounted static
  directory, not raw local file paths (which mean nothing to a remote client).
- CORS origins, port, and output directory are all read from environment
  variables so this behaves correctly in a deployed environment without
  code changes.
- Every request is authenticated via a Firebase ID token (Authorization:
  Bearer <token>). The verified uid is used to scope jobs in Firestore.
- Jobs persist in Firestore under users/{uid}/jobs/{job_id} instead of an
  in-memory dict -- history survives restarts/redeploys and is naturally
  scoped per-user: a job under one uid's subcollection is unreachable from
  any other uid, so there's no separate ownership check to write or forget.

Run locally with: uvicorn app:app --reload --port 8001
Run in production with: python app.py  (reads PORT from environment, as
most hosts require)
"""

import os
import uuid
import shutil
import threading
from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from main import run
from steps.captions import STYLES
from steps.voiceover import DEFAULT_VOICE, VOICE_OPTIONS
from auth import get_current_uid
import firebase_admin_init  # ensures the Admin SDK (and its default app) is initialized before Firestore is used
from firebase_admin import firestore  # reuses the credentials firebase_admin_init already set up -- NOT google.cloud.firestore, which looks for separate Application Default Credentials

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8001")
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*").split(",")

app = FastAPI(title="ClipForge Part 1 - Generation")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,  # set ALLOWED_ORIGINS env var to your real frontend URL in production
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serves generated videos as downloadable files at /files/<relative_path>
os.makedirs(OUTPUT_DIR, exist_ok=True)
app.mount("/files", StaticFiles(directory=OUTPUT_DIR), name="files")

# Firestore client -- reuses the same service account credentials that
# firebase_admin_init.py already set up for token verification.
db = firestore.client()


def _job_ref(uid: str, job_id: str):
    """Path: users/{uid}/jobs/{job_id}. Scoping jobs as a subcollection
    under the owning user means ownership is structural -- there is no
    way to reach another user's job through this path, so no separate
    uid-match check is needed the way it was with the in-memory dict."""
    return db.collection("users").document(uid).collection("jobs").document(job_id)


class GenerateRequest(BaseModel):
    prompt: str
    captionStyle: str = "default"    # one of steps.captions.STYLES -- validated below
    voice: str = DEFAULT_VOICE       # one of steps.voiceover.VOICE_OPTIONS -- validated below


class JobResponse(BaseModel):
    jobId: str
    status: str


def _run_generation(job_id: str, prompt: str, uid: str, caption_style: str = "default", voice: str = DEFAULT_VOICE):
    """Runs in a background thread so the HTTP request returns immediately."""
    job_ref = _job_ref(uid, job_id)
    try:
        video_path = run(prompt, caption_style=caption_style, voice=voice)

        # main.py's pipeline always writes to the same fixed path
        # (e.g. output/final/final_video.mp4), so without this step every
        # new generation would overwrite the previous one on disk -- all
        # job docs in Firestore would end up pointing at identical,
        # most-recently-generated content. Move it to a job-specific,
        # collision-proof filename before publishing the URL.
        ext = os.path.splitext(video_path)[1] or ".mp4"
        final_dir = os.path.join(OUTPUT_DIR, "final")
        os.makedirs(final_dir, exist_ok=True)
        unique_path = os.path.join(final_dir, f"{job_id}{ext}")
        shutil.move(video_path, unique_path)

        relative_path = os.path.relpath(unique_path, OUTPUT_DIR)
        video_url = f"{PUBLIC_BASE_URL}/files/{relative_path}"
        job_ref.update({"status": "done", "videoUrl": video_url, "error": None})
    except Exception as e:
        job_ref.update({"status": "failed", "videoUrl": None, "error": str(e)})


@app.post("/generate", response_model=JobResponse)
def generate(req: GenerateRequest, uid: str = Depends(get_current_uid)):
    """
    Kicks off video generation for the given prompt in the background.
    Returns immediately with a jobId -- poll GET /jobs/{jobId} for progress/result.
    Requires a valid Firebase ID token; the resulting uid owns this job.
    """
    if req.captionStyle not in STYLES:
        raise HTTPException(status_code=400, detail=f"captionStyle must be one of {STYLES}")
    if req.voice not in VOICE_OPTIONS:
        raise HTTPException(status_code=400, detail=f"voice must be one of {VOICE_OPTIONS}")

    job_id = str(uuid.uuid4())
    _job_ref(uid, job_id).set({
        "status": "processing",
        "videoUrl": None,
        "error": None,
        "prompt": req.prompt,
        "captionStyle": req.captionStyle,
        "voice": req.voice,
        "createdAt": firestore.SERVER_TIMESTAMP,
    })

    thread = threading.Thread(
        target=_run_generation, args=(job_id, req.prompt, uid, req.captionStyle, req.voice), daemon=True
    )
    thread.start()

    return {"jobId": job_id, "status": "processing"}


@app.get("/jobs/{job_id}")
def get_job(job_id: str, uid: str = Depends(get_current_uid)):
    doc = _job_ref(uid, job_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Job not found.")
    return doc.to_dict()


@app.get("/jobs")
def list_jobs(uid: str = Depends(get_current_uid)):
    """Returns this user's job history, most recent first -- this is the
    new capability persistence unlocks: it didn't exist with the in-memory
    dict, since there was no way to list 'all jobs for this uid' before."""
    docs = (
        db.collection("users").document(uid).collection("jobs")
        .order_by("createdAt", direction=firestore.Query.DESCENDING)
        .stream()
    )
    return [{"jobId": doc.id, **doc.to_dict()} for doc in docs]


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)