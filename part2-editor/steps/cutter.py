"""
Step 2: Cutter
Silence ranges (from Step 1) -> Edit Decision List (EDL) of "keep" ranges -> trimmed video.

Approach:
1. Shrink each silence range inward by a small padding buffer, so we don't cut right up
   against a word's start/end (natural speech has a bit of breath/trail-off around pauses).
2. Invert the (padded) silence ranges into "keep" ranges -- the segments we actually want.
3. Cut and concatenate those keep ranges using FFmpeg's trim/atrim + concat FILTER
   (not the demuxer) -- same lesson learned in Part 1: re-encoding via filter is robust,
   -c copy stream-splicing at arbitrary timestamps is not (it can only cut on keyframes
   and produces glitches otherwise).
"""

import os
import subprocess
from typing import List, Dict

PADDING = 0.15  # seconds -- how much of each silence to leave in, as a buffer around speech


def _get_duration(video_path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def build_keep_ranges(
    silence_ranges: List[Dict],
    total_duration: float,
    padding: float = PADDING,
) -> List[Dict]:
    """
    Takes silence ranges (from silence_detect.detect_silence) and the video's total
    duration. Returns the inverse: [{"start": float, "end": float}, ...] segments
    to KEEP in the final cut.
    """
    # Shrink each silence range inward by `padding` on both sides
    padded = []
    for r in silence_ranges:
        start = r["start"] + padding
        end = r["end"] - padding
        if end > start:  # skip ranges that vanish entirely after padding
            padded.append({"start": start, "end": end})

    # Invert: build keep ranges from the gaps between (padded) silences
    keep = []
    cursor = 0.0
    for silence in padded:
        if silence["start"] > cursor:
            keep.append({"start": cursor, "end": silence["start"]})
        cursor = max(cursor, silence["end"])

    if cursor < total_duration:
        keep.append({"start": cursor, "end": total_duration})

    # Drop any accidentally-tiny/negative segments
    keep = [k for k in keep if k["end"] - k["start"] > 0.05]

    return keep


def cut_video(video_path: str, keep_ranges: List[Dict], output_path: str) -> str:
    """
    Cuts `video_path` down to just the given keep_ranges and concatenates them
    into one continuous output video at `output_path`.
    """
    if not keep_ranges:
        raise ValueError("No keep ranges provided -- nothing to cut.")

    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    filter_parts = []
    concat_inputs = []
    for i, r in enumerate(keep_ranges):
        filter_parts.append(
            f"[0:v]trim=start={r['start']}:end={r['end']},setpts=PTS-STARTPTS[v{i}]"
        )
        filter_parts.append(
            f"[0:a]atrim=start={r['start']}:end={r['end']},asetpts=PTS-STARTPTS[a{i}]"
        )
        concat_inputs.append(f"[v{i}][a{i}]")

    filter_parts.append(f"{''.join(concat_inputs)}concat=n={len(keep_ranges)}:v=1:a=1[outv][outa]")
    filter_complex = ";".join(filter_parts)

    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-filter_complex", filter_complex,
        "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-c:a", "aac",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg cut failed:\n{result.stderr[-3000:]}")

    return output_path


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from steps.silence_detect import detect_silence

    if len(sys.argv) < 2:
        print("Usage: python steps/cutter.py <path_to_video>")
        sys.exit(1)

    video_path = sys.argv[1]
    output_path = "output/trimmed.mp4"

    print(f"Detecting silence in: {video_path}")
    silence_ranges = detect_silence(video_path)
    print(f"Found {len(silence_ranges)} silent ranges")

    total_duration = _get_duration(video_path)
    keep_ranges = build_keep_ranges(silence_ranges, total_duration)
    kept_duration = sum(r["end"] - r["start"] for r in keep_ranges)
    print(f"Keeping {len(keep_ranges)} segments, {kept_duration:.2f}s of {total_duration:.2f}s original")

    print(f"Cutting video -> {output_path}")
    cut_video(video_path, keep_ranges, output_path)
    print("Done.")