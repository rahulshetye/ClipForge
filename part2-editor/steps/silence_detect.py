"""
Step 1: Silence Detection
Raw video file -> list of silent time ranges.

Uses FFmpeg's `silencedetect` filter (core, always available -- no external
libs needed, unlike ass/subtitles/drawtext which your build lacks).

We run FFmpeg with -f null (no output file, just analyze) and parse the
silence_start/silence_end markers it prints to stderr.
"""

import re
import subprocess
from typing import List, Dict

NOISE_THRESHOLD_DB = "-30dB"   # anything quieter than this counts as "silence"
MIN_SILENCE_DURATION = 0.5     # seconds -- ignore blips shorter than this


def _get_duration(video_path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def detect_silence(
    video_path: str,
    noise_threshold_db: str = NOISE_THRESHOLD_DB,
    min_silence_duration: float = MIN_SILENCE_DURATION,
) -> List[Dict]:
    """
    Returns a list of silent ranges: [{"start": float, "end": float}, ...]
    Timestamps are in seconds, relative to the start of the video.

    Note: if the video ends WHILE still silent, FFmpeg won't print a
    silence_end marker for that final range (the stream just ends) --
    we close it off ourselves using the video's total duration.
    """
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", f"silencedetect=noise={noise_threshold_db}:d={min_silence_duration}",
        "-f", "null", "-",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    stderr = result.stderr

    starts = [float(m) for m in re.findall(r"silence_start:\s*([\d.]+)", stderr)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*([\d.]+)", stderr)]

    ranges = []
    for i, start in enumerate(starts):
        if i < len(ends):
            ranges.append({"start": start, "end": ends[i]})
        else:
            # Silence ran to the end of the file with no explicit silence_end marker
            duration = _get_duration(video_path)
            ranges.append({"start": start, "end": duration})

    return ranges


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python steps/silence_detect.py <path_to_video>")
        sys.exit(1)

    video_path = sys.argv[1]
    print(f"Analyzing silence in: {video_path}\n")
    ranges = detect_silence(video_path)

    if not ranges:
        print("No silence detected (or none longer than the minimum duration).")
    else:
        total_silent = sum(r["end"] - r["start"] for r in ranges)
        print(f"Found {len(ranges)} silent range(s), {total_silent:.2f}s total:\n")
        for r in ranges:
            print(f"  {r['start']:.2f}s -> {r['end']:.2f}s  ({r['end'] - r['start']:.2f}s)")