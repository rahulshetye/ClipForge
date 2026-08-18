"""
Step 2b: Transitions (optional upgrade to Step 2's Cutter)
Keep ranges (from Step 2) -> trimmed video with crossfade transitions between cuts,
instead of hard concatenation.

Approach:
Same trim+concat structure as cutter.py, but uses FFmpeg's xfade (video) and
acrossfade (audio) filters instead of the concat filter, chained sequentially
across all keep ranges. xfade/acrossfade are core FFmpeg filters (no libass/
drawtext dependency), so this works fine on the same build that silence_detect.py's
docstring notes is missing ass/subtitles/drawtext support.

Trade-off vs cutter.py: each transition overlaps two adjacent clips by `duration`
seconds, so total output is shorter than the sum of keep_ranges by
(n-1) * duration. Keep ranges shorter than 2x the transition duration are
dropped for safety (too short to crossfade cleanly on both sides).

UPGRADES:
- Style selection defaults to "smart" (Gemini reads the transcript around each
  cut and picks a style that matches the beat -- plain "fade" when a thought
  continues, "fadeblack"/"wipeleft"/etc when there's a real topic change)
  instead of always using plain "fade" everywhere.
- Crossfade duration is now adaptive per cut instead of one fixed value for
  the whole video: it's scaled to the length of the two clips being joined,
  clamped to [MIN_TRANSITION_DURATION, MAX_TRANSITION_DURATION]. A short
  0.4s clip and a long 8s clip shouldn't get the same blend length -- a fixed
  duration either feels too abrupt on short clips or too slow on long ones.
"""

import os
import random
import subprocess
from typing import List, Dict, Optional, Union
from dotenv import load_dotenv

load_dotenv()

DEFAULT_DURATION = 0.3  # seconds -- used as a fixed value only if you explicitly pass one
MIN_TRANSITION_DURATION = 0.15  # seconds -- floor, even for very short clips
MAX_TRANSITION_DURATION = 0.6   # seconds -- ceiling, so long clips don't get a slow blend
DURATION_RATIO = 0.2            # crossfade = this fraction of the shorter neighboring clip

# Curated subset of ffmpeg's ~50 xfade transitions -- these are the ones that read as
# "basic/clean" for talking-head content rather than gimmicky. Full list is in ffmpeg
# docs (search "xfade") if you want to add more later (pixelize, radial, hblur, etc).
BASIC_TRANSITIONS = [
    "fade",       # classic crossfade -- default, safe for a continuous thought
    "fadeblack",  # crossfade through black -- bigger beat/pause than plain fade
    "wipeleft",
    "wiperight",
    "slideup",
    "slidedown",
    "dissolve",
]

CONTEXT_WORDS = 8  # how many words of transcript to show on each side of a cut, for smart mode


def _resolve_transition(transition: Union[str, List[str]], cut_index: int) -> str:
    """
    transition can be:
      - a single style name (str) -> used for every cut
      - "random" -> random pick per cut from BASIC_TRANSITIONS
      - a list of style names -> cycled through in order, one per cut
        (this is also how "smart" mode's per-cut list gets applied)
    """
    if transition == "random":
        return random.choice(BASIC_TRANSITIONS)
    if isinstance(transition, list):
        return transition[cut_index % len(transition)]
    return transition


def _adaptive_duration(prev_len: float, next_len: float) -> float:
    """Scales the crossfade to the shorter of the two clips being joined, so a
    quick cut doesn't get a blend longer than the clip itself, and a long
    held shot doesn't get an unnecessarily brief one."""
    raw = DURATION_RATIO * min(prev_len, next_len)
    return max(MIN_TRANSITION_DURATION, min(MAX_TRANSITION_DURATION, raw))


def _words_in_range(words: List[Dict], start: float, end: float) -> List[str]:
    return [w["word"] for w in words if start <= w["start"] < end]


def suggest_transition_styles(keep_ranges: List[Dict], words: List[Dict]) -> List[str]:
    """
    "Smart" mode: for each cut between consecutive keep_ranges, shows Gemini the
    transcript text right before and after that cut and asks it to pick a style --
    e.g. a plain "fade" when the sentence/thought just continues across the cut,
    vs. a "wipeleft"/"slidedown"/"dissolve" when there's a clear topic or beat change.

    Returns a list of length len(keep_ranges) - 1 (one style per cut), same shape
    the "list of styles to cycle" mode already accepts.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set. Copy .env.example to .env and add your key.")

    from pydantic import BaseModel, Field
    from google import genai
    from google.genai import types

    class CutChoice(BaseModel):
        style: str = Field(description=f"Transition style. Must be exactly one of: {BASIC_TRANSITIONS}")

    class TransitionPlan(BaseModel):
        choices: List[CutChoice]

    n_cuts = len(keep_ranges) - 1
    if n_cuts <= 0:
        return []

    lines = []
    for i in range(n_cuts):
        before = " ".join(_words_in_range(words, keep_ranges[i]["end"] - 3.0, keep_ranges[i]["end"])[-CONTEXT_WORDS:])
        after = " ".join(_words_in_range(words, keep_ranges[i + 1]["start"], keep_ranges[i + 1]["start"] + 3.0)[:CONTEXT_WORDS])
        lines.append(f"Cut {i}: \"...{before}\" | CUT | \"{after}...\"")
    cuts_text = "\n".join(lines)

    system_instruction = f"""You are a video editor choosing cut transitions for a talking-head video.

For each numbered cut below, you see the transcript text right before and right after that cut.
Pick ONE transition style per cut from this exact list: {BASIC_TRANSITIONS}

Guidance:
- "fade" or "dissolve": the sentence/thought clearly continues across the cut (default choice).
- "fadeblack": there's a natural pause or the speaker is resetting to a new point.
- "wipeleft" / "wiperight" / "slideup" / "slidedown": a clear topic change or new section starting.
Return exactly {n_cuts} choices, in cut order (0 to {n_cuts - 1})."""

    client = genai.Client(api_key=api_key)
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=f"Cuts:\n{cuts_text}",
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
                response_schema=TransitionPlan,
                temperature=0.3,
            ),
        )
    except Exception as e:
        raise RuntimeError(f"Gemini API call failed: {e}") from e

    plan: Optional[TransitionPlan] = response.parsed
    if plan is None:
        raise RuntimeError(f"Gemini did not return parseable JSON. Raw text: {response.text}")

    styles = []
    for i in range(n_cuts):
        style = plan.choices[i].style if i < len(plan.choices) else "fade"
        styles.append(style if style in BASIC_TRANSITIONS else "fade")  # guard against a bad/hallucinated name
    return styles


def concat_with_transitions(
    video_path: str,
    keep_ranges: List[Dict],
    output_path: str,
    transition: Union[str, List[str]] = "fade",
    duration: Optional[float] = None,
) -> str:
    """
    Same inputs as cutter.cut_video (video_path + keep_ranges), but stitches the
    kept segments together with crossfade-style transitions instead of hard cuts.

    transition: style name (e.g. "wipeleft"), "random", or a list of style names
    to cycle through per cut. See BASIC_TRANSITIONS above for the curated set,
    or pass any name from ffmpeg's full xfade transition list.

    duration: fixed crossfade length in seconds for every cut. Leave as None
    (default) to scale each cut's crossfade to the length of its two
    neighboring clips instead -- see _adaptive_duration().
    """
    floor = duration if duration is not None else MIN_TRANSITION_DURATION
    ranges = [r for r in keep_ranges if r["end"] - r["start"] > 2 * floor]
    if len(ranges) < 2:
        raise ValueError("Need at least 2 keep ranges longer than 2x the transition duration to add transitions.")

    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    filter_parts = []
    for i, r in enumerate(ranges):
        filter_parts.append(f"[0:v]trim=start={r['start']}:end={r['end']},setpts=PTS-STARTPTS[v{i}]")
        filter_parts.append(f"[0:a]atrim=start={r['start']}:end={r['end']},asetpts=PTS-STARTPTS[a{i}]")

    # Chain xfade/acrossfade sequentially: v0+v1->vx1, vx1+v2->vx2, ...
    # offset = when (in the running merged timeline) the NEXT clip's fade-in should start
    running_duration = ranges[0]["end"] - ranges[0]["start"]
    prev_v, prev_a = "v0", "a0"
    for i in range(1, len(ranges)):
        style = _resolve_transition(transition, i - 1)
        prev_len = ranges[i - 1]["end"] - ranges[i - 1]["start"]
        seg_duration = ranges[i]["end"] - ranges[i]["start"]
        cut_duration = duration if duration is not None else _adaptive_duration(prev_len, seg_duration)

        offset = running_duration - cut_duration
        out_v, out_a = f"vx{i}", f"ax{i}"
        filter_parts.append(
            f"[{prev_v}][v{i}]xfade=transition={style}:duration={cut_duration}:offset={offset}[{out_v}]"
        )
        filter_parts.append(f"[{prev_a}][a{i}]acrossfade=d={cut_duration}[{out_a}]")

        running_duration = offset + seg_duration
        prev_v, prev_a = out_v, out_a

    filter_complex = ";".join(filter_parts)

    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-filter_complex", filter_complex,
        "-map", f"[{prev_v}]", "-map", f"[{prev_a}]",
        "-c:v", "libx264", "-c:a", "aac",
        "-pix_fmt", "yuv420p",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg transition-concat failed:\n{result.stderr[-3000:]}")

    return output_path


if __name__ == "__main__":
    # Quick manual test -- reuses Step 1 (silence_detect) + Step 2's build_keep_ranges,
    # then stitches with transitions instead of cutter.py's hard concat.
    import sys
    sys.path.insert(0, ".")
    from steps.silence_detect import detect_silence
    from steps.cutter import build_keep_ranges, _get_duration

    if len(sys.argv) < 2:
        print("Usage: python steps/transitions.py <path_to_video> [style ...]")
        print(f'  style: one or more of {BASIC_TRANSITIONS}, "random", "smart", or omit for "smart"')
        print("  examples:")
        print('    python steps/transitions.py video.mp4 fade wipeleft slidedown   # cycle through these')
        print('    python steps/transitions.py video.mp4 random                    # random per cut')
        print('    python steps/transitions.py video.mp4 smart                     # Gemini picks per cut')
        sys.exit(1)

    video_path = sys.argv[1]
    style_args = sys.argv[2:] if len(sys.argv) > 2 else ["smart"]
    output_path = "output/trimmed_with_transitions.mp4"

    print(f"Detecting silence in: {video_path}")
    silence_ranges = detect_silence(video_path)
    total_duration = _get_duration(video_path)
    keep_ranges = build_keep_ranges(silence_ranges, total_duration)
    print(f"Found {len(keep_ranges)} keep ranges")

    if style_args == ["smart"]:
        from steps.captions import generate_captions
        print("Transcribing for context (smart mode)...")
        words = generate_captions(video_path)
        transition = suggest_transition_styles(keep_ranges, words)
        print(f"Gemini picked: {transition}")
    elif style_args == ["random"]:
        transition = "random"
    elif len(style_args) == 1:
        transition = style_args[0]  # single fixed style for every cut
    else:
        transition = style_args  # cycle through the list given, e.g. fade wipeleft slidedown

    print(f"Stitching with transitions ({transition}) -> {output_path}")
    concat_with_transitions(video_path, keep_ranges, output_path, transition=transition)
    print("Done.")

# ---------------------------------------------------------------------------
# Manifest-facing entry point (independently callable pipeline step)
# ---------------------------------------------------------------------------
from steps.project_store import record_step, project_output_dir, require


def run(project: dict, transition: Union[str, List[str]] = "smart") -> dict:
    """
    Re-cuts from the ORIGINAL source_video using trim's keep_ranges (not
    current_video) -- keep_ranges are timestamps relative to the source, and
    this replaces trim's hard-cut concat with a crossfaded one. Treat this as
    an alternate/upgraded rendering of the trim step, not something that
    stacks on top of it.

    Defaults to "smart": if captions have already run, Gemini picks a
    context-appropriate style per cut. If captions haven't run yet, or the
    Gemini call fails for any reason (no key, rate limit, etc), this falls
    back to plain "fade" for every cut rather than failing the whole step --
    transitions are a polish pass, not something that should block the
    pipeline over a missing key.
    """
    require(project, "keep_ranges", step="trim")
    keep_ranges = project["keep_ranges"]
    words = project.get("words")

    resolved_transition = transition
    if transition == "smart":
        if not words:
            print("  transitions: no captions yet -- using plain 'fade' (run captions first for context-aware picks)")
            resolved_transition = "fade"
        else:
            try:
                resolved_transition = suggest_transition_styles(keep_ranges, words)
            except Exception as e:
                print(f"  transitions: smart mode failed ({e}) -- falling back to plain 'fade'")
                resolved_transition = "fade"

    output_path = os.path.join(project_output_dir(project), "with_transitions.mp4")
    concat_with_transitions(project["source_video"], keep_ranges, output_path, transition=resolved_transition)

    style_label = resolved_transition if isinstance(resolved_transition, str) else "smart"
    return record_step(project, "transitions", new_video=output_path, transition_style=style_label)