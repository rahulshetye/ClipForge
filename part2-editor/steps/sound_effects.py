"""
Step 8: Sound Effects
Word-level transcript -> suggested SFX moments (when + what) -> mixed-in audio.

Same reasoning as broll.py/stickers.py: Gemini reads the transcript and picks moments
where a sound effect would land well, described with a closed vocabulary of generic,
searchable SFX concepts (not a literal description of the topic -- same lesson learned
from stickers.py: "cash register" is searchable, "corruption scandal" is not).

Fetches actual sound clips from Freesound (freesound.org) and mixes them into the
existing audio track at the right offsets. Unlike stickers.py, this never touches the
video stream at all (-c:v copy), so it should be fast regardless of video length --
only the (short) audio filter graph needs processing.
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
MAX_SFX = 8
SFX_VOLUME = 0.6  # relative volume of each SFX clip vs. the original dialogue track

FREESOUND_SEARCH_URL = "https://freesound.org/apiv2/search/text/"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output", "sfx")

# Closed vocabulary of generic, reliably-searchable SFX concepts -- same lesson as
# stickers.py's REACTION_CONCEPTS: Gemini should pick a generic sound category based
# on the BEAT (a reveal, a transition, a joke, a number), not paraphrase the topic.
SFX_CONCEPTS = [
    "whoosh", "ding", "pop", "applause", "record scratch", "cash register",
    "drum roll", "boing", "camera shutter", "notification ding", "error buzzer",
    "swoosh transition", "click", "success chime",
]


class SfxMoment(BaseModel):
    time: float = Field(description="Point in time in seconds to play the sound effect")
    keywords: str = Field(description=f"MUST be exactly one entry, verbatim, from this list: {SFX_CONCEPTS}")


class SfxPlan(BaseModel):
    moments: List[SfxMoment]


SYSTEM_INSTRUCTION = f"""You are a video editor adding sound effect accents to a talking-head video.

Given a word-level transcript, pick up to {MAX_SFX} moments where a short sound effect
would land well -- a reveal, a punchline, a transition between topics, a strong claim,
a number/statistic being stated -- NOT constantly, only moments that genuinely earn it.

IMPORTANT: keywords must be the generic SOUND CONCEPT the moment calls for, not a
description of what's literally being discussed. Sound libraries have "cash register"
and "record scratch", not "corruption scandal" -- those searches return nothing.
Pick from the closed list only: {SFX_CONCEPTS}

Rules:
- keywords must be copied verbatim from the list above -- do not invent new phrases.
- Don't cluster moments -- space them out, and don't put two SFX within 1.5s of each other.
- It's fine to return fewer than {MAX_SFX} if the transcript doesn't have enough good beats.
"""


def _words_to_transcript_text(words: List[Dict]) -> str:
    return "\n".join(f"[{w['start']:.1f}-{w['end']:.1f}] {w['word']}" for w in words)


def suggest_sfx_moments(words: List[Dict]) -> List[Dict]:
    """
    Takes word-level transcript (from captions.generate_captions).
    Returns up to MAX_SFX moments: [{"time": float, "keywords": str}, ...]
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
                response_schema=SfxPlan,
                temperature=0.5,
            ),
        )
    except Exception as e:
        raise RuntimeError(f"Gemini API call failed: {e}") from e

    plan: SfxPlan = response.parsed
    if plan is None:
        raise RuntimeError(f"Gemini did not return parseable JSON. Raw text: {response.text}")

    moments = [m.model_dump() for m in plan.moments if m.time >= 0]
    moments.sort(key=lambda m: m["time"])
    return moments[:MAX_SFX]


def _search_freesound(query: str, api_key: str) -> str:
    resp = requests.get(
        FREESOUND_SEARCH_URL,
        params={
            "query": query,
            "token": api_key,
            "fields": "previews",
            "filter": "duration:[0.1 TO 3]",  # short one-shots only, not long ambience/music
            "sort": "score",
            "page_size": 1,
        },
        timeout=15,
    )
    resp.raise_for_status()
    results = resp.json().get("results", [])
    if not results:
        return None
    # preview-hq-mp3 is a Freesound-generated preview, doesn't require the original file's license terms
    return results[0]["previews"]["preview-hq-mp3"]


def fetch_sfx_clips(moments: List[Dict]) -> List[Dict]:
    """
    Downloads a Freesound clip per moment. Returns moments extended with 'clip_path'
    (None if the search/download failed -- caller should skip those moments).
    """
    fs_key = os.getenv("FREESOUND_API_KEY")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    results = []
    for i, m in enumerate(moments):
        clip_path = None
        query = m.get("keywords", "").strip()
        if query not in SFX_CONCEPTS:  # guard against Gemini inventing an off-list phrase
            query = "ding"

        if fs_key:
            try:
                url = _search_freesound(query, fs_key)
                if url:
                    clip_path = os.path.join(OUTPUT_DIR, f"sfx_{i:02d}.mp3")
                    resp = requests.get(url, timeout=30)
                    resp.raise_for_status()
                    with open(clip_path, "wb") as f:
                        f.write(resp.content)
            except requests.RequestException as e:
                print(f"  SFX {i} ('{query}'): download failed ({e})")
                clip_path = None
        else:
            print("  FREESOUND_API_KEY not set -- skipping SFX fetch.")

        print(f"  SFX {i}: time={m['time']:.1f}s, query='{query}' -> {'found' if clip_path else 'NOT FOUND'}")
        results.append({**m, "clip_path": clip_path})

    return results


def mix_sfx(video_path: str, sfx_list: List[Dict], output_path: str, sfx_volume: float = SFX_VOLUME) -> str:
    """
    Mixes the fetched SFX clips into video_path's existing audio track at their
    assigned times. Video stream is copied untouched (-c:v copy) -- only audio is
    processed, so this stays fast regardless of video length. Skips any moment
    whose clip_path is None.
    """
    valid = [m for m in sfx_list if m.get("clip_path")]
    if not valid:
        raise ValueError("No SFX clips available to mix.")

    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    cmd = ["ffmpeg", "-y", "-i", video_path]
    for m in valid:
        cmd += ["-i", m["clip_path"]]

    filter_parts = []
    mix_inputs = ["0:a"]
    for i, m in enumerate(valid):
        delay_ms = int(m["time"] * 1000)
        label = f"sfx{i}"
        # adelay shifts this clip to start at the right offset; all=1 applies the same
        # delay to every channel so it works regardless of mono/stereo source.
        filter_parts.append(f"[{i+1}:a]adelay=delays={delay_ms}:all=1,volume={sfx_volume}[{label}]")
        mix_inputs.append(label)

    n = len(mix_inputs)
    mix_labels = "".join(f"[{lbl}]" for lbl in mix_inputs)
    # amix quietens everything by ~1/n by design -- volume={n} compensates back to roughly
    # original dialogue loudness. If it sounds too hot/clipped, lower sfx_volume above instead.
    filter_parts.append(f"{mix_labels}amix=inputs={n}:duration=first,volume={n}[aout]")

    filter_complex = ";".join(filter_parts)
    cmd += [
        "-filter_complex", filter_complex,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac",
        output_path,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise RuntimeError("FFmpeg SFX mix timed out after 120s -- something is hanging, not just slow.")
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg SFX mix failed:\n{result.stderr[-3000:]}")

    return output_path


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from steps.captions import generate_captions

    if len(sys.argv) < 2:
        print("Usage: python steps/sound_effects.py <path_to_video>")
        sys.exit(1)

    video_path = sys.argv[1]
    output_path = "output/with_sfx.mp4"

    print(f"Transcribing: {video_path}")
    words = generate_captions(video_path)

    print("Asking Gemini for SFX moments...")
    moments = suggest_sfx_moments(words)
    print(f"Got {len(moments)} moments: {[(m['time'], m['keywords']) for m in moments]}")

    print("Fetching SFX clips from Freesound...")
    moments = fetch_sfx_clips(moments)

    print(f"Mixing -> {output_path}")
    mix_sfx(video_path, moments, output_path)
    print("Done.")

# ---------------------------------------------------------------------------
# Manifest-facing entry point (independently callable pipeline step)
# ---------------------------------------------------------------------------
from steps.project_store import record_step, project_output_dir, require


def run(project: dict) -> dict:
    require(project, "words", step="captions")
    moments = suggest_sfx_moments(project["words"])
    clips = fetch_sfx_clips(moments)

    valid = [m for m in clips if m.get("clip_path")]
    if not valid:
        return record_step(project, "sound_effects", sfx={"moments": clips})

    output_path = os.path.join(project_output_dir(project), "with_sfx.mp4")
    mix_sfx(project["current_video"], clips, output_path)

    return record_step(project, "sound_effects", new_video=output_path, sfx={"moments": clips})
