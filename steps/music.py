"""
Step 6 (Part 1): AI Background Music
Per-scene word-level transcripts (from captions.generate_captions) -> one mood
judgment for the whole video -> matching track -> mixed in at a constant low
volume under the dialogue, over the final assembled video.

Adapted from Part 2's steps/music_selection.py -- same mood-judgment/
fetch/mix logic (suggest_music_mood, fetch_track, mix_music are carried over
essentially unchanged), minus Part 2's project-manifest `run(project)` wrapper,
which doesn't apply here since Part 1 doesn't use that pattern.

One real difference from Part 2: Part 2's suggest_music_mood(words) expects a
single flat transcript for an already-assembled video. Part 1's pipeline
produces `words` PER SCENE, with timestamps relative to that scene's own
start (0 at the start of each scene) -- see assembly.py's _render_scene,
which uses scene["words"] timestamps directly against that scene's own
duration. flatten_scene_words() below offsets each scene's word timestamps
by the cumulative duration of all prior scenes (from actual_duration) so the
mood judgment sees one coherent whole-video transcript instead of N
transcripts that all restart at t=0.

Reuses the same FREESOUND_API_KEY/GEMINI_API_KEY env vars as Part 2 -- no
new signup needed, as long as Part 1's .env has them set too.
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


def flatten_scene_words(scenes: List[Dict]) -> List[Dict]:
    """
    Part 1-specific: scenes[i]["words"] timestamps are relative to that
    scene's own start (each scene restarts at t=0). This concatenates every
    scene's words into one list with timestamps offset by the cumulative
    actual_duration of all prior scenes, producing one coherent whole-video
    transcript -- same shape suggest_music_mood() expects (a flat list
    across the whole runtime, mirroring how Part 2 gets it from a single
    already-assembled video).
    """
    flat: List[Dict] = []
    offset = 0.0
    for scene in scenes:
        for w in scene.get("words", []):
            flat.append({**w, "start": w["start"] + offset, "end": w["end"] + offset})
        offset += scene.get("actual_duration", 0) or 0
    return flat


def _words_to_transcript_text(words: List[Dict]) -> str:
    return "\n".join(f"[{w['start']:.1f}-{w['end']:.1f}] {w['word']}" for w in words)


def suggest_music_mood(words: List[Dict]) -> str:
    """
    Takes a flat, whole-video word-level transcript (use flatten_scene_words()
    on Part 1's per-scene scenes list to build this).
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
    tracks repeat, longer tracks get cut off) -- -stream_loop -1 alone never ends,
    so -t caps it explicitly.
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


def add_background_music(scenes: List[Dict], video_path: str) -> str:
    """
    Single entry point for main.py: takes the same `scenes` list already
    passed to assemble_video (post-captions, so each scene has "words" and
    "actual_duration"), plus the final assembled video's path.

    Judges mood from the flattened whole-video transcript, fetches a
    matching track, and mixes it in. On any soft-failure (no
    FREESOUND_API_KEY, no track found for the mood), logs why and returns
    video_path UNCHANGED rather than raising -- background music is a nice-
    to-have, not something that should fail an otherwise-successful
    generation.

    Returns the path to use going forward: the mixed video if music was
    added, otherwise the original video_path.
    """
    try:
        words = flatten_scene_words(scenes)
        mood = suggest_music_mood(words)
        print(f"  Mood: {mood}")
    except Exception as e:
        print(f"  Skipping music -- mood judgment failed: {e}")
        return video_path

    track = fetch_track(mood)
    if not track:
        return video_path

    base, ext = os.path.splitext(video_path)
    output_path = f"{base}_with_music{ext}"
    try:
        mix_music(video_path, track["path"], output_path)
    except Exception as e:
        print(f"  Skipping music -- mix failed: {e}")
        return video_path

    return output_path