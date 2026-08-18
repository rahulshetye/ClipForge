"""
Step 7: Stickers & GIFs
Word-level transcript -> suggested sticker moments (keywords + when + where) -> overlaid video.

Same reasoning as broll.py: let Gemini read the transcript and pick moments where a
reaction sticker would land well, and describe *what* with search keywords rather
than a literal emoji character -- then fetch an actual animated sticker (GIPHY's
Stickers API: illustrated, transparent-background GIFs, not plain emoji glyphs) and
composite it with the `overlay` filter.

Rendering note: your ffmpeg build lacks drawtext/libass (see silence_detect.py's
docstring), but overlay/scale/format are core filters -- no special build needed,
including for looping an animated GIF with its alpha channel intact.
"""

import os
import requests
from typing import List, Dict
from pydantic import BaseModel, Field
from google import genai
from google.genai import types
from dotenv import load_dotenv
import subprocess

load_dotenv()

MODEL = "gemini-2.5-flash"
MAX_STICKERS = 6
STICKER_SIZE = 160  # px, square
CAPTION_CLEARANCE = 220  # px from the bottom -- tune this to sit just above where your
                          # burned-in captions actually sit; increase if stickers still overlap text

GIPHY_STICKER_SEARCH_URL = "https://api.giphy.com/v1/stickers/search"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output", "stickers")

# name -> (x expr, y expr) for ffmpeg overlay, with a small margin from the edges
POSITIONS = {
    "top-left": ("30", "30"),
    "top-right": ("main_w-overlay_w-30", "30"),
    "bottom-left": ("30", "main_h-overlay_h-30"),
    "bottom-right": ("main_w-overlay_w-30", "main_h-overlay_h-30"),
    "bottom-center": ("(main_w-overlay_w)/2", f"main_h-overlay_h-{CAPTION_CLEARANCE}"),
    "center": ("(main_w-overlay_w)/2", "(main_h-overlay_h)/2"),
}


# Closed vocabulary of generic reaction concepts -- these reliably exist as sticker packs.
# Gemini picks FROM this list based on the tone of the moment, rather than describing
# the specific topic being discussed (topic-specific phrases like "vote rigging scandal"
# don't match sticker packs; "shocked face" does, regardless of what's actually being said).
REACTION_CONCEPTS = [
    "mind blown", "shocked face", "eye roll", "facepalm", "thumbs down", "thumbs up",
    "side eye", "thinking face", "laughing", "clapping", "money rain", "red flag",
    "question mark", "fire", "100 emoji", "crying laughing", "side eye suspicious",
]


class StickerMoment(BaseModel):
    start: float = Field(description="Start time in seconds to show the sticker")
    end: float = Field(description="End time in seconds to hide the sticker")
    keywords: str = Field(description=f"MUST be exactly one entry, verbatim, from this list: {REACTION_CONCEPTS}")
    position: str = Field(description=f"One of: {list(POSITIONS.keys())}")


class StickerPlan(BaseModel):
    moments: List[StickerMoment]


SYSTEM_INSTRUCTION = f"""You are a video editor adding reaction stickers to a talking-head video.

Given a word-level transcript, pick up to {MAX_STICKERS} moments where an animated reaction
sticker would land well (a laugh, a strong claim, a number, an emotional beat, a punchline)
-- NOT every sentence, only the moments that genuinely earn it.

IMPORTANT: keywords must be the generic REACTION/EMOTION the moment calls for, not a
description of what's literally being discussed. Sticker packs exist for reactions
("shocked face", "facepalm"), not for specific topics ("vote rigging scandal",
"election pressure") -- those searches return nothing. Pick the reaction a viewer
would have, from the closed list only: {REACTION_CONCEPTS}

Rules:
- Each moment should last 1-2.5 seconds.
- keywords must be copied verbatim from the list above -- do not invent new phrases.
- Default to "bottom-center" for position -- it keeps the viewer's eyes near the subject's
  face instead of darting to a corner. Only use a corner (top-left, top-right, bottom-left,
  bottom-right) or "center" if bottom-center would visually clash with a previous sticker
  that's still on screen, or with on-screen captions in that area.
- Don't cluster moments -- space them out across the video.
- It's fine to return fewer than {MAX_STICKERS} if the transcript doesn't have enough good beats.
"""


def _words_to_transcript_text(words: List[Dict]) -> str:
    return "\n".join(f"[{w['start']:.1f}-{w['end']:.1f}] {w['word']}" for w in words)


def suggest_stickers(words: List[Dict]) -> List[Dict]:
    """
    Takes word-level transcript (from captions.generate_captions).
    Returns up to MAX_STICKERS moments: [{"start", "end", "keywords", "position"}, ...]
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set. Copy .env.example to .env and add your key.")
    if not words:
        return []

    client = genai.Client(api_key=api_key)
    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=f"Here is the timestamped transcript:\n\n{_words_to_transcript_text(words)}",
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                response_mime_type="application/json",
                response_schema=StickerPlan,
                temperature=0.5,
            ),
        )
    except Exception as e:
        raise RuntimeError(f"Gemini API call failed: {e}") from e

    plan: StickerPlan = response.parsed
    if plan is None:
        raise RuntimeError(f"Gemini did not return parseable JSON. Raw text: {response.text}")

    moments = [
        m.model_dump() for m in plan.moments
        if m.end > m.start and m.position in POSITIONS
    ]
    return moments[:MAX_STICKERS]


def _search_giphy_sticker(query: str, api_key: str) -> str:
    resp = requests.get(
        GIPHY_STICKER_SEARCH_URL,
        params={"api_key": api_key, "q": query, "limit": 1, "rating": "pg-13"},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json().get("data", [])
    if not data:
        return None
    return data[0]["images"]["original"]["url"]  # animated GIF, transparent background


def fetch_sticker_images(stickers: List[Dict]) -> List[Dict]:
    """
    Downloads a GIPHY sticker GIF per moment. Returns moments extended with
    'gif_path' (None if the search/download failed -- caller should skip those moments).
    """
    giphy_key = os.getenv("GIPHY_API_KEY")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    results = []
    for i, s in enumerate(stickers):
        gif_path = None
        query = s.get("keywords", "").strip()
        if query not in REACTION_CONCEPTS:  # guard against Gemini inventing an off-list phrase
            query = "mind blown"

        if giphy_key:
            try:
                url = _search_giphy_sticker(query, giphy_key)
                if url:
                    gif_path = os.path.join(OUTPUT_DIR, f"sticker_{i:02d}.gif")
                    resp = requests.get(url, timeout=30)
                    resp.raise_for_status()
                    with open(gif_path, "wb") as f:
                        f.write(resp.content)
            except requests.RequestException as e:
                print(f"  Sticker {i} ('{query}'): download failed ({e})")
                gif_path = None
        else:
            print("  GIPHY_API_KEY not set -- skipping sticker fetch.")

        print(f"  Sticker {i}: query='{query}' -> {'found' if gif_path else 'NOT FOUND'}")
        results.append({**s, "gif_path": gif_path})

    return results


def _get_duration(video_path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def overlay_stickers(
    video_path: str,
    stickers: List[Dict],
    output_path: str,
    preset: str = "ultrafast",
    use_hw_encoder: bool = False,
) -> str:
    """
    Composites the fetched animated sticker GIFs onto video_path at their assigned
    times/positions, looping each GIF for its whole enable window and preserving
    its alpha (transparent background). Skips any moment whose gif_path is None.

    preset: x264 speed/quality tradeoff -- "ultrafast" for fast test iterations,
    "medium"/"slow" for a final export (bigger CPU/time cost, better compression).
    use_hw_encoder: on Mac, use Apple's hardware encoder (h264_videotoolbox) instead
    of libx264 -- much cooler/faster, but slightly worse quality-per-filesize. Good
    for quick previews, not recommended for final export.
    """
    valid = [s for s in stickers if s.get("gif_path")]
    if not valid:
        raise ValueError("No sticker GIFs available to overlay.")

    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    total_duration = _get_duration(video_path)

    cmd = ["ffmpeg", "-y", "-i", video_path]
    for s in valid:
        # -stream_loop -1 makes this an infinite stream (never emits EOF on its own) --
        # -t caps how much of it ffmpeg actually reads, bounding it to the main video's
        # length. Without this, overlay's framesync can hang waiting on a stream that
        # never ends (this was the cause of the 30-min stall).
        cmd += ["-stream_loop", "-1", "-t", str(total_duration), "-i", s["gif_path"]]

    filter_parts = []
    prev = "0:v"
    for i, s in enumerate(valid):
        x, y = POSITIONS[s["position"]]
        scaled = f"scaled{i}"
        # format=rgba keeps the GIF's transparency instead of flattening it to a solid box
        filter_parts.append(f"[{i+1}:v]scale={STICKER_SIZE}:{STICKER_SIZE},format=rgba[{scaled}]")
        out_label = f"ov{i}" if i < len(valid) - 1 else "outv"
        filter_parts.append(
            f"[{prev}][{scaled}]overlay=x={x}:y={y}:enable='between(t,{s['start']},{s['end']})'[{out_label}]"
        )
        prev = out_label

    filter_complex = ";".join(filter_parts)
    cmd += ["-filter_complex", filter_complex, "-map", "[outv]", "-map", "0:a?"]

    if use_hw_encoder:
        cmd += ["-c:v", "h264_videotoolbox"]
    else:
        cmd += ["-c:v", "libx264", "-preset", preset, "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac", output_path]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            "FFmpeg sticker overlay timed out after 120s -- something is hanging, "
            "not just slow. Re-check the filter graph rather than waiting longer."
        )
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg sticker overlay failed:\n{result.stderr[-3000:]}")

    return output_path


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from steps.captions import generate_captions

    if len(sys.argv) < 2:
        print("Usage: python steps/stickers.py <path_to_video> [hw]")
        print('  pass "hw" as a second arg to use the Mac hardware encoder (faster, cooler, slightly lower quality)')
        sys.exit(1)

    video_path = sys.argv[1]
    use_hw = len(sys.argv) > 2 and sys.argv[2] == "hw"
    output_path = "output/with_stickers.mp4"

    print(f"Transcribing: {video_path}")
    words = generate_captions(video_path)

    print("Asking Gemini for sticker moments...")
    moments = suggest_stickers(words)
    print(f"Got {len(moments)} moments: {[(m['keywords'], m['position']) for m in moments]}")

    print("Fetching sticker GIFs from GIPHY...")
    moments = fetch_sticker_images(moments)

    print(f"Compositing -> {output_path}")
    overlay_stickers(video_path, moments, output_path, use_hw_encoder=use_hw)
    print("Done.")

# ---------------------------------------------------------------------------
# Manifest-facing entry point (independently callable pipeline step)
# ---------------------------------------------------------------------------
from steps.project_store import record_step, project_output_dir, require


def run(project: dict) -> dict:
    require(project, "words", step="captions")
    stickers = suggest_stickers(project["words"])
    images = fetch_sticker_images(stickers)

    valid = [s for s in images if s.get("gif_path")]
    if not valid:
        return record_step(project, "stickers", stickers={"moments": images})

    output_path = os.path.join(project_output_dir(project), "with_stickers.mp4")
    overlay_stickers(project["current_video"], images, output_path)

    return record_step(project, "stickers", new_video=output_path, stickers={"moments": images})
