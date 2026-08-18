"""
Step 2: Voiceover Generation
Scene list (from script_gen) -> per-scene .mp3 files + actual measured durations.

Uses edge-tts (free, no API key, runs locally via Microsoft Edge's TTS service).
Requires ffprobe (comes with FFmpeg) to measure real audio duration --
the LLM's estimated_duration is a guess, this is ground truth.
"""

import asyncio
import json
import os
import subprocess
from typing import List, Dict

import edge_tts

# A natural-sounding, widely-used English voice. Run `edge-tts --list-voices`
# to see all options (accents, languages, genders).
DEFAULT_VOICE = "en-US-AndrewNeural"

# Curated subset of real edge-tts voice IDs (confirmed via
# `edge-tts --list-voices`, not invented) offered as picker options in the
# frontend. Kept as a flat list of real IDs -- app.py validates incoming
# `voice` against this directly, same pattern as steps/captions.py's STYLES.
VOICE_OPTIONS = [
    "en-US-AndrewNeural",      # US male
    "en-US-JennyNeural",       # US female
    "en-US-GuyNeural",         # US male
    "en-US-AriaNeural",        # US female
    "en-US-ChristopherNeural", # US male
    "en-US-MichelleNeural",    # US female
    "en-GB-SoniaNeural",       # British female
    "en-GB-RyanNeural",        # British male
    "en-AU-NatashaNeural",     # Australian female
    "en-IN-NeerjaNeural",      # Indian English female
    "en-IN-PrabhatNeural",     # Indian English male
]

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output", "audio")


def _get_audio_duration(filepath: str) -> float:
    """Returns duration in seconds using ffprobe. Raises RuntimeError if ffprobe is missing/fails."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                filepath,
            ],
            capture_output=True, text=True, check=True,
        )
        return float(result.stdout.strip())
    except FileNotFoundError as e:
        raise RuntimeError(
            "ffprobe not found. Install FFmpeg (e.g. `brew install ffmpeg` on Mac) "
            "and make sure it's on your PATH."
        ) from e
    except (subprocess.CalledProcessError, ValueError) as e:
        raise RuntimeError(f"Could not read duration for {filepath}: {e}") from e


async def _generate_one(text: str, out_path: str, voice: str) -> None:
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(out_path)


async def _generate_all(scenes: List[Dict], voice: str) -> List[Dict]:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    results = []

    for i, scene in enumerate(scenes):
        out_path = os.path.join(OUTPUT_DIR, f"scene_{i:02d}.mp3")
        await _generate_one(scene["text"], out_path, voice)
        actual_duration = _get_audio_duration(out_path)

        results.append({
            **scene,
            "audio_path": out_path,
            "actual_duration": round(actual_duration, 2),
        })
        print(f"  Scene {i}: '{scene['text'][:40]}...' -> {actual_duration:.2f}s (estimated was {scene.get('estimated_duration')}s)")

    return results


def generate_voiceovers(scenes: List[Dict], voice: str = DEFAULT_VOICE) -> List[Dict]:
    """
    Takes the `scenes` list from a Script dict (script_gen.generate_script(...)['scenes']).
    Returns the same list, with each scene dict extended with:
        - audio_path: path to the generated .mp3 file
        - actual_duration: real measured duration in seconds (use THIS downstream,
          not estimated_duration, for timing visuals/captions)
    """
    return asyncio.run(_generate_all(scenes, voice))


if __name__ == "__main__":
    # Quick manual test -- run: python steps/voiceover.py
    # Uses a small hardcoded scene list so this can run standalone without script_gen/API calls.
    test_scenes = [
        {"text": "Did you know the internet started as a military research project?", "keywords": ["vintage computer research"], "estimated_duration": 5},
        {"text": "In 1969, the first message was sent between two computers.", "keywords": ["old computer terminal"], "estimated_duration": 4},
    ]

    print("Generating voiceovers...")
    result = generate_voiceovers(test_scenes)

    print("\nDone. Output:")
    print(json.dumps(result, indent=2))