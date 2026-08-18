"""
Quick integration test: real prompt -> script_gen -> voiceover -> audio files with real durations.
Run: python main.py "your prompt here" [default|boxed|highlight]
"""

import sys
import json
from steps.script_gen import generate_script
from steps.voiceover import generate_voiceovers, DEFAULT_VOICE, VOICE_OPTIONS
from steps.visuals import fetch_visuals
from steps.captions import generate_captions, STYLES
from steps.assembly import assemble_video
from steps.music import add_background_music


def run(prompt: str, caption_style: str = "default", voice: str = DEFAULT_VOICE):
    print(f"Generating script for: {prompt}\n")
    script = generate_script(prompt)
    print(f"Title: {script['title']}")
    print(f"{len(script['scenes'])} scenes generated.\n")

    print(f"Generating voiceovers (voice: {voice})...")
    scenes_with_audio = generate_voiceovers(script["scenes"], voice=voice)

    print("\nFetching visuals...")
    scenes_with_visuals = fetch_visuals(scenes_with_audio)

    print("\nGenerating captions...")
    scenes_with_captions = generate_captions(scenes_with_visuals)

    print(f"\nAssembling final video (caption style: {caption_style})...")
    final_path = assemble_video(scenes_with_captions, caption_style=caption_style)
    print(f"\nDone assembling: {final_path}")

    print("\nAdding background music...")
    # Always-on, mood auto-detected -- no user-facing toggle. Falls back to the
    # un-mixed video (same final_path) if FREESOUND_API_KEY/GEMINI_API_KEY are
    # missing or no matching track is found, so this step can never fail the
    # overall generation.
    final_path = add_background_music(scenes_with_captions, final_path)
    print(f"\nDone! Final video: {final_path}")

    return final_path


if __name__ == "__main__":
    args = sys.argv[1:]
    caption_style = args[-1] if args and args[-1] in STYLES else "default"
    prompt_args = args[:-1] if (args and args[-1] in STYLES) else args
    prompt = " ".join(prompt_args) or "3 tips to stay productive while working from home"
    run(prompt, caption_style=caption_style)