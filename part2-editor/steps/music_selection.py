"""
Step 9: AI Music Selection
Word-level transcript (whole video) -> one mood judgment -> matching track -> mixed
in at a constant low volume under the dialogue.

Different shape from broll.py/stickers.py/sound_effects.py: those pick MANY short
moments. This picks ONE mood for the ENTIRE video (music underscore is a single
continuous choice, not a per-moment one), then finds one track and loops/trims it
to the video's length.

Reuses the same FREESOUND_API_KEY as sound_effects.py -- no new signup needed.
Note: Freesound is a sound-library site first, music-library second, so mood/genre
matching will be looser than a dedicated music service (e.g. Jamendo) -- worth
comparing a few runs before committing to this over a dedicated music API.

Licensing note: Freesound clips carry per-sound Creative Commons licenses (shown
in the "license" field) -- some need attribution, some are CC0/public-domain-
equivalent. Check the license on whatever track gets picked before publishing.
"""

import os
import requests
from typing import List, Dict, Optional
from pydantic import BaseModel, Field
from google import genai
from google.genai import types
from dotenv import load_dotenv
import subprocess

load_dotenv()

MODEL = "gemini-2.5-flash"
MUSIC_VOLUME = 0.25  # constant relative volume under dialogue, regardless of whether someone's speaking
MIN_TRACK_DURATION = 15  # seconds -- Freesound's music-tagged results skew short/loop-length,
MAX_TRACK_DURATION = 300  # 30s was too strict and was returning zero results for several moods

FREESOUND_SEARCH_URL = "https://freesound.org/apiv2/search/text/"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output", "music")

# Closed vocabulary for the mood judgment. Appended with "music" at search time since
# Freesound isn't music-tag-first the way a dedicated music API would be.
MOOD_TAGS = [
    "chill", "upbeat", "dramatic", "sad", "energetic", "dark",
    "hopeful", "epic", "mysterious", "calm", "tense", "romantic",
]


class MoodChoice(BaseModel):
    mood: str = Field(description=f"MUST be exactly one entry, verbatim, from this list: {MOOD_TAGS}")


def _words_to_transcript_text(words: List[Dict]) -> str:
    return "\n".join(f"[{w['start']:.1f}-{w['end']:.1f}] {w['word']}" for w in words)


def suggest_music_mood(words: List[Dict]) -> str:
    """
    Takes word-level transcript (from captions.generate_captions) for the WHOLE video.
    Returns a single mood tag (one of MOOD_TAGS) that fits the overall tone.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set. Copy .env.example to .env and add your key.")
    if not words:
        return "chill"

    system_instruction = f"""You are a video editor choosing ONE background music mood for a
talking-head video's entire runtime (not per-moment -- one consistent underscore for the whole thing).

Read the full transcript and judge its OVERALL tone -- pick exactly one mood from this
closed list, the one that best fits the video as a whole: {MOOD_TAGS}
"""

    client = genai.Client(api_key=api_key)
    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=f"Here is the timestamped transcript:\n\n{_words_to_transcript_text(words)}",
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                response_schema=MoodChoice,
                temperature=0.3,
            ),
        )
    except Exception as e:
        raise RuntimeError(f"Gemini API call failed: {e}") from e

    choice: Optional[MoodChoice] = response.parsed
    if choice is None or choice.mood not in MOOD_TAGS:
        return "chill"  # safe default if Gemini strays off-list
    return choice.mood


def _search_freesound_music(mood: str, api_key: str) -> Optional[Dict]:
    def _query(q: str) -> Optional[Dict]:
        resp = requests.get(
            FREESOUND_SEARCH_URL,
            params={
                "query": q,
                "token": api_key,
                "fields": "name,username,license,previews,duration",
                "filter": f"duration:[{MIN_TRACK_DURATION} TO {MAX_TRACK_DURATION}]",
                "sort": "score",
                "page_size": 1,
            },
            timeout=15,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
        return results[0] if results else None

    track = _query(f"{mood} music")
    if track:
        return track
    print(f"  No results for '{mood} music' -- falling back to a generic 'background music' search.")
    return _query("background music")


def fetch_track(mood: str) -> Optional[Dict]:
    """
    Searches Freesound for a track matching the mood and downloads it.
    Returns {"path", "name", "username", "license"} or None if unavailable.
    """
    api_key = os.getenv("FREESOUND_API_KEY")
    if not api_key:
        print("  FREESOUND_API_KEY not set -- skipping music fetch.")
        return None

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    try:
        track = _search_freesound_music(mood, api_key)
        if not track or not track.get("previews", {}).get("preview-hq-mp3"):
            print(f"  No track found for mood '{mood}'.")
            return None

        track_path = os.path.join(OUTPUT_DIR, "background_music.mp3")
        url = track["previews"]["preview-hq-mp3"]
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        with open(track_path, "wb") as f:
            f.write(resp.content)

        print(f"  Picked: \"{track.get('name')}\" by {track.get('username')} "
              f"(mood: {mood}) -- license: {track.get('license', 'unknown')}")
        return {
            "path": track_path,
            "name": track.get("name"),
            "username": track.get("username"),
            "license": track.get("license"),
        }
    except requests.RequestException as e:
        print(f"  Track fetch failed: {e}")
        return None


def _get_duration(video_path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def mix_music(video_path: str, track_path: str, output_path: str, music_volume: float = MUSIC_VOLUME) -> str:
    """
    Mixes the given track under video_path's existing dialogue at a constant low
    volume for the whole runtime. Video stream is copied untouched (-c:v copy).
    The track is looped/bounded to the video's exact duration either way (shorter
    tracks repeat, longer tracks get cut off) -- same fix as stickers.py's hang:
    -stream_loop -1 alone never ends, so -t caps it explicitly.
    """
    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    total_duration = _get_duration(video_path)

    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-stream_loop", "-1", "-t", str(total_duration), "-i", track_path,
    ]

    # amix halves each input's volume by default (for 2 inputs) -- pre-scaling by 2x
    # before the mix cancels that out, so dialogue lands back at ~its original level
    # and music lands at ~music_volume of the original, instead of everything sounding quiet.
    filter_complex = (
        f"[0:a]volume=2[dia];"
        f"[1:a]volume={music_volume * 2}[music];"
        f"[dia][music]amix=inputs=2:duration=first[aout]"
    )

    cmd += [
        "-filter_complex", filter_complex,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac",
        output_path,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise RuntimeError("FFmpeg music mix timed out after 120s -- something is hanging, not just slow.")
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg music mix failed:\n{result.stderr[-3000:]}")

    return output_path


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from steps.captions import generate_captions

    if len(sys.argv) < 2:
        print("Usage: python steps/music_selection.py <path_to_video>")
        sys.exit(1)

    video_path = sys.argv[1]
    output_path = "output/with_music.mp4"

    print(f"Transcribing: {video_path}")
    words = generate_captions(video_path)

    print("Asking Gemini for overall mood...")
    mood = suggest_music_mood(words)
    print(f"Mood: {mood}")

    print("Fetching a matching track from Freesound...")
    track = fetch_track(mood)
    if not track:
        print("No track available -- exiting.")
        sys.exit(1)

    print(f"Mixing -> {output_path}")
    mix_music(video_path, track["path"], output_path)
    print("Done.")

# ---------------------------------------------------------------------------
# Manifest-facing entry point (independently callable pipeline step)
# ---------------------------------------------------------------------------
from steps.project_store import record_step, project_output_dir, require


def run(project: dict) -> dict:
    require(project, "words", step="captions")
    mood = suggest_music_mood(project["words"])
    track = fetch_track(mood)

    if not track:  # no FREESOUND_API_KEY / nothing found -- record the mood, skip render
        return record_step(project, "music_selection", music={"mood": mood, "track": None})

    output_path = os.path.join(project_output_dir(project), "with_music.mp4")
    mix_music(project["current_video"], track["path"], output_path)

    return record_step(project, "music_selection", new_video=output_path, music={"mood": mood, "track": track})
