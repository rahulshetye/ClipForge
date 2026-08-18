"""
Step: Trim (P0 -- foundational)
Combines silence_detect.detect_silence + cutter.build_keep_ranges/cut_video
into one manifest-facing pipeline step. The two underlying modules are
untouched; this is just the run() entry point the registry calls.
"""

import os
from steps.silence_detect import detect_silence, _get_duration
from steps.cutter import build_keep_ranges, cut_video
from steps.project_store import record_step, project_output_dir


def run(project: dict) -> dict:
    video_path = project["current_video"]
    duration = _get_duration(video_path)
    silence_ranges = detect_silence(video_path)
    keep_ranges = build_keep_ranges(silence_ranges, duration)

    output_path = os.path.join(project_output_dir(project), "trimmed.mp4")
    cut_video(video_path, keep_ranges, output_path)

    return record_step(
        project, "trim", new_video=output_path,
        duration=duration, silence_ranges=silence_ranges, keep_ranges=keep_ranges,
    )
