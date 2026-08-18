"""
Step 5: Assembly (Part 2 - Editor)
Trimmed video + word-level captions -> final edited video with burned-in captions.

Same Pillow-PNG + FFmpeg `overlay` approach validated in Part 1 -- avoids the
`ass`/`subtitles`/`drawtext` filters entirely, since those need libass/libfreetype
which this FFmpeg build doesn't have compiled in.

Difference from Part 1: this is real user footage (not disposable stock video),
so if the source isn't exactly 1080x1920, we PAD instead of CROP -- cropping
stock footage is fine, but cropping someone's real recording risks cutting them
out of frame. Assumes input is already ~9:16 (per project scope).
"""

import os
import subprocess
from typing import List, Dict
from PIL import Image, ImageDraw, ImageFont

TARGET_W, TARGET_H = 1080, 1920
WORDS_PER_CAPTION = 4
CAPTION_BAND_H = 260

FONT_CANDIDATES = [
    os.environ.get("CAPTION_FONT_PATH", ""),
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "C:\\Windows\\Fonts\\arialbd.ttf",
]

_font_cache = {}


def _get_font(size: int) -> ImageFont.FreeTypeFont:
    if size in _font_cache:
        return _font_cache[size]
    for path in FONT_CANDIDATES:
        if path and os.path.exists(path):
            font = ImageFont.truetype(path, size)
            _font_cache[size] = font
            return font
    try:
        font = ImageFont.load_default(size=size)
    except TypeError:
        font = ImageFont.load_default()
    _font_cache[size] = font
    return font


def _make_caption_image(text: str, out_path: str) -> None:
    img = Image.new("RGBA", (TARGET_W, CAPTION_BAND_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _get_font(64)

    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (TARGET_W - text_w) // 2
    y = (CAPTION_BAND_H - text_h) // 2

    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255),
              stroke_width=4, stroke_fill=(0, 0, 0, 255))
    img.save(out_path)


def _make_caption_chunks(words: List[Dict], out_dir: str) -> List[Dict]:
    chunks = []
    for i in range(0, len(words), WORDS_PER_CAPTION):
        chunk = words[i:i + WORDS_PER_CAPTION]
        text = " ".join(w["word"] for w in chunk)
        png_path = os.path.join(out_dir, f"cap_{i:04d}.png")
        _make_caption_image(text, png_path)
        chunks.append({"path": png_path, "start": chunk[0]["start"], "end": chunk[-1]["end"]})
    return chunks


def _get_duration(video_path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def _run_ffmpeg(cmd: List[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg failed:\n{' '.join(cmd)}\n\nstderr:\n{result.stderr[-3000:]}")


def assemble_video(
    video_path: str,
    words: List[Dict],
    output_path: str = "output/final_edited.mp4",
    broll_clips: List[Dict] = None,
) -> str:
    """
    Burns captions (grouped from `words`) onto `video_path` and writes the
    final edited video to `output_path`. Preserves the original audio.

    broll_clips: optional list from broll.fetch_broll_clips(...), each with
    'start', 'end', 'clip_path'. If provided, overlays each clip (video only --
    original audio keeps playing underneath) during its time window.
    """
    out_dir = os.path.dirname(output_path) or "."
    os.makedirs(out_dir, exist_ok=True)

    duration = _get_duration(video_path)
    caption_chunks = _make_caption_chunks(words, out_dir) if words else []
    broll_clips = [b for b in (broll_clips or []) if b.get("clip_path")]

    extra_input_args = []
    for b in broll_clips:
        # Loop the clip across the FULL video timeline (not just its own window length).
        # Constraining it to only `end - start` seconds of decoded frames starting from
        # global t=0 was the bug: by the time the overlay's enable window actually opens
        # (at t=start), that short clip had already run out of frames and FFmpeg just
        # froze on the last one -- looking like a still image instead of a moving clip.
        extra_input_args += ["-stream_loop", "-1", "-t", str(duration), "-i", b["clip_path"]]
    for chunk in caption_chunks:
        extra_input_args += ["-loop", "1", "-t", str(duration), "-i", chunk["path"]]

    # Pad (not crop) to target size -- preserves the full original frame, just adds
    # letterbox bars if the source isn't exactly 1080x1920
    filters = [
        f"[0:v]scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease,"
        f"pad={TARGET_W}:{TARGET_H}:(ow-iw)/2:(oh-ih)/2[base0]"
    ]

    label = "base0"
    next_input_idx = 1  # input 0 = source video

    # B-roll overlays first (sits under captions), each scaled to fill the frame
    for i, b in enumerate(broll_clips):
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

    # Captions overlay on top of everything
    for i, chunk in enumerate(caption_chunks):
        next_label = f"withcap{i}"
        y_pos = TARGET_H - CAPTION_BAND_H - 140
        filters.append(
            f"[{label}][{next_input_idx}:v]overlay=x=0:y={y_pos}:"
            f"enable='between(t,{chunk['start']},{chunk['end']})'[{next_label}]"
        )
        label = next_label
        next_input_idx += 1

    filter_complex = ";".join(filters)

    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        *extra_input_args,
        "-filter_complex", filter_complex,
        "-map", f"[{label}]", "-map", "0:a",
        "-r", "30",
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-c:v", "libx264", "-c:a", "aac",
        "-ar", "44100", "-ac", "2",
        "-pix_fmt", "yuv420p",
        output_path,
    ]
    _run_ffmpeg(cmd)
    return output_path


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from steps.captions import generate_captions

    if len(sys.argv) < 2:
        print("Usage: python steps/assembly.py <path_to_trimmed_video>")
        sys.exit(1)

    video_path = sys.argv[1]
    print(f"Generating captions for: {video_path}")
    words = generate_captions(video_path)
    print(f"{len(words)} words -> assembling final video...")

    result = assemble_video(video_path, words)
    print(f"Done. Final video: {result}")