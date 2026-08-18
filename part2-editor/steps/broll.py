"""
Step 6: B-roll Insertion
Word-level transcript -> suggested B-roll moments -> downloaded stock clips.

Uses Gemini (same structured-output pattern as Part 1's script_gen.py) to read
the transcript and pick a handful of moments where a visual cutaway would help
(concrete, filmable topics mentioned for a few seconds), rather than trying to
hand-write NLP keyword-extraction rules.

Then fetches a matching clip per moment from Pexels (same approach as Part 1's
visuals.py).
"""

import os
import requests
from typing import List, Dict
from pydantic import BaseModel, Field
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()

MODEL = "gemini-2.5-flash"
MAX_BROLL_MOMENTS = 5
MIN_SEGMENT_DURATION = 2.0  # don't bother with B-roll for very short moments

PEXELS_API_URL = "https://api.pexels.com/videos/search"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output", "broll")


class BrollMoment(BaseModel):
    start: float = Field(description="Start time in seconds for this B-roll cutaway")
    end: float = Field(description="End time in seconds for this B-roll cutaway")
    keywords: List[str] = Field(description="2-4 concrete, filmable stock-footage search terms for this moment")


class BrollPlan(BaseModel):
    moments: List[BrollMoment]


SYSTEM_INSTRUCTION = f"""You are a video editor choosing B-roll cutaway moments for a talking-head video.

Given a word-level transcript (with timestamps), pick up to {MAX_BROLL_MOMENTS} moments where
cutting away to stock B-roll footage would enhance the video -- moments where a CONCRETE,
VISUAL topic is being discussed for at least {MIN_SEGMENT_DURATION} seconds continuously
(e.g. "construction", "traffic", "dust storms" -- NOT abstract topics like "the issue" or "this problem").

Rules:
- Only pick moments with genuinely filmable subject matter.
- Each moment's start/end must be an actual sub-range within the transcript's time span.
- Keywords must be concrete and stock-footage-searchable (2-4 words each).
- Prefer fewer, well-chosen moments over cramming in {MAX_BROLL_MOMENTS} weak ones -- it's fine
  to return fewer than {MAX_BROLL_MOMENTS} if the transcript doesn't have enough concrete visual moments.
- Do not pick overlapping moments.
"""


def _words_to_transcript_text(words: List[Dict]) -> str:
    """Formats word list as a timestamped transcript string for the LLM prompt."""
    lines = []
    for w in words:
        lines.append(f"[{w['start']:.1f}-{w['end']:.1f}] {w['word']}")
    return "\n".join(lines)


def suggest_broll_moments(words: List[Dict]) -> List[Dict]:
    """
    Takes word-level transcript (from captions.generate_captions).
    Returns up to MAX_BROLL_MOMENTS moments: [{"start": float, "end": float, "keywords": [...]}, ...]
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set. Copy .env.example to .env and add your key.")

    if not words:
        return []

    client = genai.Client(api_key=api_key)
    transcript_text = _words_to_transcript_text(words)

    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=f"Here is the timestamped transcript:\n\n{transcript_text}",
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                response_mime_type="application/json",
                response_schema=BrollPlan,
                temperature=0.4,
            ),
        )
    except Exception as e:
        raise RuntimeError(f"Gemini API call failed: {e}") from e

    plan: BrollPlan = response.parsed
    if plan is None:
        raise RuntimeError(f"Gemini did not return parseable JSON. Raw text: {response.text}")

    # Basic sanity filtering -- drop anything too short or malformed
    moments = [
        m.model_dump() for m in plan.moments
        if m.end - m.start >= MIN_SEGMENT_DURATION and m.end > m.start
    ]
    return moments[:MAX_BROLL_MOMENTS]


def _search_pexels(query: str, api_key: str, min_duration: float) -> str:
    resp = requests.get(
        PEXELS_API_URL,
        headers={"Authorization": api_key},
        params={"query": query, "orientation": "portrait", "per_page": 5},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()

    videos = data.get("videos", [])
    candidates = [v for v in videos if v.get("duration", 0) >= min_duration] or videos
    if not candidates:
        return None

    video = candidates[0]
    files = sorted(video["video_files"], key=lambda f: f.get("width", 0))
    for f in files:
        if f.get("width", 0) >= 720:
            return f["link"]
    return files[-1]["link"] if files else None


def fetch_broll_clips(moments: List[Dict]) -> List[Dict]:
    """
    Downloads a stock clip per moment. Returns moments extended with 'clip_path'
    (None if nothing found/download failed -- caller should skip those moments).
    """
    pexels_key = os.getenv("PEXELS_API_KEY")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    results = []
    for i, moment in enumerate(moments):
        query = " ".join(moment.get("keywords", []))[:100]
        duration = moment["end"] - moment["start"]
        clip_path = None

        if pexels_key:
            try:
                url = _search_pexels(query, pexels_key, duration)
                if url:
                    clip_path = os.path.join(OUTPUT_DIR, f"broll_{i:02d}.mp4")
                    resp = requests.get(url, stream=True, timeout=30)
                    resp.raise_for_status()
                    with open(clip_path, "wb") as f:
                        for chunk in resp.iter_content(chunk_size=8192):
                            f.write(chunk)
            except requests.RequestException as e:
                print(f"  Moment {i} ('{query}'): download failed ({e})")
                clip_path = None

        print(f"  Moment {i}: {moment['start']:.1f}s-{moment['end']:.1f}s, query='{query}' -> "
              f"{'found' if clip_path else 'NOT FOUND'}")
        results.append({**moment, "clip_path": clip_path})

    return results


if __name__ == "__main__":
    # Quick manual test -- run this AFTER captions.py has produced a word list.
    # Example usage (wire this up once tested):
    #
    # from steps.captions import generate_captions
    # words = generate_captions("output/trimmed.mp4")
    # moments = suggest_broll_moments(words)
    # clips = fetch_broll_clips(moments)
    print("Import suggest_broll_moments(words) and fetch_broll_clips(moments) from main.py once wired in.")

# ---------------------------------------------------------------------------
# Manifest-facing entry point (independently callable pipeline step)
# ---------------------------------------------------------------------------
import subprocess
from steps.project_store import record_step, project_output_dir, require

TARGET_W, TARGET_H = 1080, 1920  # mirrors assembly.py's target frame size


def _video_duration(video_path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def render_broll_overlay(video_path: str, broll_clips: List[Dict], output_path: str) -> str:
    """
    Pads video_path to TARGET_W x TARGET_H (letterbox, never crops real
    footage) and overlays each broll clip during its assigned time window.

    Absorbed from the old assembly.py's pad+broll-overlay logic so broll can
    render on its own instead of being fused into one giant ffmpeg call
    together with caption burn-in (subtitle_styles.py now owns captions).
    Still runs the pad step even with zero clips, so output framing stays
    consistent whether or not broll found anything.
    """
    out_dir = os.path.dirname(output_path) or "."
    os.makedirs(out_dir, exist_ok=True)

    duration = _video_duration(video_path)
    clips = [b for b in (broll_clips or []) if b.get("clip_path")]

    extra_input_args = []
    for b in clips:
        extra_input_args += ["-stream_loop", "-1", "-t", str(duration), "-i", b["clip_path"]]

    filters = [
        f"[0:v]scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease,"
        f"pad={TARGET_W}:{TARGET_H}:(ow-iw)/2:(oh-ih)/2[base0]"
    ]
    label = "base0"
    next_input_idx = 1
    for i, b in enumerate(clips):
        scaled_label = f"broll{i}"
        filters.append(
            f"[{next_input_idx}:v]scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=increase,"
            f"crop={TARGET_W}:{TARGET_H}[{scaled_label}]"
        )
        next_label = f"withbroll{i}"
        filters.append(
            f"[{label}][{scaled_label}]overlay=x=0:y=0:"
            f"enable='between(t,{b['start']},{b['end']})'[{next_label}]"
        )
        label = next_label
        next_input_idx += 1

    filter_complex = ";".join(filters)
    cmd = [
        "ffmpeg", "-y", "-i", video_path, *extra_input_args,
        "-filter_complex", filter_complex,
        "-map", f"[{label}]", "-map", "0:a",
        "-r", "30",
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-c:v", "libx264", "-c:a", "aac",
        "-ar", "44100", "-ac", "2",
        "-pix_fmt", "yuv420p",
        output_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return output_path


def run(project: dict) -> dict:
    require(project, "words", step="captions")
    moments = suggest_broll_moments(project["words"])
    clips = fetch_broll_clips(moments)

    output_path = os.path.join(project_output_dir(project), "with_broll.mp4")
    render_broll_overlay(project["current_video"], clips, output_path)

    return record_step(
        project, "broll", new_video=output_path,
        broll={"moments": moments, "clips": clips},
    )
