"""
Step 5: FFmpeg Assembly
Scene list (with audio_path, visual_path, words from prior steps) -> final rendered video.

For each scene:
    1. Scale/crop visual to 1080x1920 (vertical, for Shorts/Reels/TikTok)
    2. Loop or trim visual to match the scene's actual audio duration
    3. Burn in captions -- rendered as transparent PNGs via captions.py's
       render_caption_chunks (default/boxed/highlight styles), composited with
       FFmpeg's `overlay` filter. This deliberately avoids the `ass`/`subtitles`/
       `drawtext` filters, which depend on libass/libfreetype being compiled into
       FFmpeg -- many minimal/Homebrew FFmpeg builds don't include them, and
       there's no clean way to detect that from Python other than trying and
       failing. `overlay` is a core filter always present in every FFmpeg build,
       so this approach works everywhere.
    4. Mux with the scene's voiceover audio
Then concatenates all rendered scene clips into one final video.

If a scene has no visual_path (fetch failed), falls back to a solid dark background
so the pipeline never hard-fails on a missing clip.

NOTE: caption rendering (fonts, styles, PNG generation) used to live inline in
this file. It's now in captions.py, alongside the transcription step that
produces the word data captions get rendered from -- see that file's module
docstring for why. This file just calls render_caption_chunks(..., style=...)
and composites whatever PNGs come back; it no longer owns any font/style logic.
"""

import os
import subprocess
from typing import List, Dict, Optional
from steps.captions import render_caption_chunks, STYLES

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output", "final")
TARGET_W, TARGET_H = 1080, 1920  # 9:16 vertical
FALLBACK_COLOR = "0x1A1A2E"  # dark navy, used if a scene has no visual
CAPTION_BAND_H = 260  # height of the transparent caption image strip -- must match captions.py's CAPTION_BAND_H


def _run_ffmpeg(cmd: List[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg failed:\n{' '.join(cmd)}\n\nstderr:\n{result.stderr[-3000:]}")


def _render_scene(scene: Dict, index: int, caption_style: str = "default") -> str:
    audio_path = scene["audio_path"]
    visual_path = scene.get("visual_path")
    duration = scene.get("actual_duration", 5)
    words = scene.get("words", [])

    caption_chunks = render_caption_chunks(words, OUTPUT_DIR, index, style=caption_style) if words else []

    out_path = os.path.join(OUTPUT_DIR, f"scene_{index:02d}_rendered.mp4")

    # Base video input (visual or fallback color)
    if visual_path and os.path.exists(visual_path):
        base_input_args = ["-stream_loop", "-1", "-i", visual_path]
    else:
        base_input_args = ["-f", "lavfi", "-i", f"color=c={FALLBACK_COLOR}:s={TARGET_W}x{TARGET_H}:d={duration}"]

    # Caption image inputs -- each looped as a static image for the full scene duration
    caption_input_args = []
    for chunk in caption_chunks:
        caption_input_args += ["-loop", "1", "-t", str(duration), "-i", chunk["path"]]

    # Build filter_complex: scale/crop base, then chain an overlay per caption chunk
    filters = [f"[0:v]scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=increase,"
               f"crop={TARGET_W}:{TARGET_H}[base0]"]

    label = "base0"
    for i, chunk in enumerate(caption_chunks):
        img_input_idx = 2 + i  # input 0 = visual, input 1 = audio, then captions start at 2
        next_label = f"base{i + 1}"
        y_pos = TARGET_H - CAPTION_BAND_H - 140
        filters.append(
            f"[{label}][{img_input_idx}:v]overlay=x=0:y={y_pos}:"
            f"enable='between(t,{chunk['start']},{chunk['end']})'[{next_label}]"
        )
        label = next_label

    filter_complex = ";".join(filters)

    cmd = [
        "ffmpeg", "-y",
        *base_input_args,
        "-i", audio_path,
        *caption_input_args,
        "-filter_complex", filter_complex,
        "-map", f"[{label}]", "-map", "1:a",
        "-t", str(duration),
        "-r", "30",                 # force identical frame rate across all scenes -- source
                                     # stock clips vary (24/25/30fps), which breaks concatenation
        "-c:v", "libx264", "-c:a", "aac",
        "-ar", "44100", "-ac", "2",  # force identical audio sample rate/channels across scenes
        "-pix_fmt", "yuv420p",
        "-shortest",
        out_path,
    ]

    _run_ffmpeg(cmd)
    return out_path


def _concatenate(scene_paths: List[str], out_path: str) -> None:
    """
    Uses FFmpeg's concat FILTER (not the concat demuxer's -c copy mode).
    The demuxer's -c copy approach requires byte-identical stream parameters across
    every segment and silently produces glitchy playback / dropped frames / broken
    audio sync if they differ even slightly. The filter re-encodes, which is slightly
    slower but robust to any small differences between scenes.
    """
    input_args = []
    concat_inputs = []
    for i, p in enumerate(scene_paths):
        input_args += ["-i", p]
        concat_inputs.append(f"[{i}:v][{i}:a]")

    filter_complex = f"{''.join(concat_inputs)}concat=n={len(scene_paths)}:v=1:a=1[outv][outa]"

    cmd = [
        "ffmpeg", "-y",
        *input_args,
        "-filter_complex", filter_complex,
        "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-c:a", "aac",
        "-pix_fmt", "yuv420p",
        out_path,
    ]
    _run_ffmpeg(cmd)


def assemble_video(scenes: List[Dict], output_filename: str = "final_video.mp4", caption_style: str = "default") -> str:
    """
    Takes scenes with audio_path, visual_path, actual_duration, words (from prior steps).
    Renders each scene individually, then concatenates into one final video.

    caption_style: one of captions.STYLES ("default", "boxed", "highlight").
    Applied uniformly across every scene in this video.

    Returns the path to the final video.
    """
    if caption_style not in STYLES:
        raise ValueError(f"caption_style must be one of {STYLES}, got {caption_style!r}")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    scene_paths = []
    for i, scene in enumerate(scenes):
        print(f"  Rendering scene {i}...")
        path = _render_scene(scene, i, caption_style=caption_style)
        scene_paths.append(path)

    final_path = os.path.join(OUTPUT_DIR, output_filename)
    print("  Concatenating all scenes...")
    _concatenate(scene_paths, final_path)

    return final_path


if __name__ == "__main__":
    print("Import this module's assemble_video(scenes) from main.py once the full chain runs.")