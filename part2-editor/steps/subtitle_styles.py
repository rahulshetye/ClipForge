"""
Step 8: Subtitle Styles
Word-level transcript -> styled, burned-in subtitles.

Same rendering constraint as stickers.py: this ffmpeg build lacks drawtext/libass,
so subtitle lines are rendered as transparent PNGs (via Pillow) and composited
with the `overlay` filter -- the same trick as stickers, applied to text instead
of GIFs.

No Gemini call in this module. Unlike stickers/sound-effects/music, subtitle
placement isn't a judgment call -- it's just "chunk the transcript into
readable lines and show each one while it's being spoken" -- so there's no
closed-vocabulary problem to solve here.

Positioning: stickers.py reserves CAPTION_CLEARANCE px above the bottom edge
specifically so it doesn't collide with burned-in captions. This module owns
that reserved band -- subtitle PNGs are bottom-anchored with a small margin,
sized to stay well inside it.

New failure mode this module introduces (read before changing MAX_WORDS_PER_CHUNK
or switching everything to "highlight" style by default): the "highlight" style
needs one PNG per WORD, not per line, so it can show the active word changing
color as it's spoken. A single ffmpeg -filter_complex pass opens one input file
descriptor per overlay -- fine for stickers.py's ~6 moments, not fine for a
5-minute video's ~700+ words in one pass. That's a different flavor of the same
class of bug as -stream_loop -1 hanging: instead of a hang, this one risks
blowing past the OS's open-file-descriptor limit or producing an unworkable
filter graph. So overlays are burned in batches (MAX_OVERLAYS_PER_PASS per
ffmpeg invocation, chained sequentially) rather than one giant pass.

Each rendered PNG is fed in with `-loop 1 -t <duration>`, not a single frame --
like stickers.py's animated GIFs, a looped image is an infinite stream that
never emits EOF on its own. Same fix applies: bound it with -t.
"""

import os
import subprocess
from typing import List, Dict, Optional
from PIL import Image, ImageDraw, ImageFont

# Mirror of stickers.py's CAPTION_CLEARANCE -- keep these in sync if you tune one.
# Stickers sit ABOVE this band (main_h - overlay_h - CAPTION_CLEARANCE); subtitles
# live INSIDE it, bottom-anchored.
CAPTION_CLEARANCE = 220
BOTTOM_MARGIN = 40          # px from the very bottom edge to the subtitle's baseline
SIDE_MARGIN = 60            # px kept clear on each side before wrapping to a 2nd line

FONT_SIZE = 54              # tuned so 2 wrapped lines + margins still fit inside CAPTION_CLEARANCE

# Fonts are bundled in the repo, not pulled from the OS or a pip package. Two reasons:
# 1) portability -- SUBTITLE_FONT_PATH pointing at a macOS system font breaks the moment
#    this runs on a Linux deploy box (this bit us once already -- see conversation history).
# 2) there's no well-maintained pip package that bundles a real multi-font library; the
#    ones that exist are either single-font (one pip install per font) or unmaintained/alpha.
#    Bundling the .ttf files themselves in assets/fonts/ sidesteps both problems and works
#    identically on your Mac, a Linux server, or a container.
#
# All fonts below are OFL/Apache/public-domain -- explicitly redistributable, unlike Arial.
FONTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "fonts")

FONT_PRESETS = {
    "default": "LiberationSans-Bold.ttf",   # Arial-metric-compatible, reliable, wide coverage
    "serif": "LiberationSerif-Bold.ttf",     # classic, editorial feel
    "mono": "LiberationMono-Bold.ttf",       # typewriter/code aesthetic
    "modern": "Poppins-Bold.ttf",            # rounded geometric, popular for social captions
    "free-sans": "FreeSansBold.ttf",
    "free-serif": "FreeSerifBold.ttf",
    "free-mono": "FreeMonoBold.ttf",
    "carlito": "Carlito-Bold.ttf",           # Calibri-metric-compatible
    "caladea": "Caladea-Bold.ttf",           # Cambria-metric-compatible
    "bebas": "BebasNeue-Regular.ttf",        # tall condensed caps -- classic Reels/TikTok caption look
    "anton": "Anton-Regular.ttf",            # heavy condensed display
    "bangers": "Bangers-Regular.ttf",        # comic-style
    "righteous": "Righteous-Regular.ttf",    # rounded display
    "archivo-black": "ArchivoBlack-Regular.ttf",
    "marker": "PermanentMarker-Regular.ttf", # handwritten marker style
}

FONT_PATH = os.getenv("SUBTITLE_FONT_PATH")  # explicit override still wins if set

BASE_COLOR = (255, 255, 255, 255)      # white
HIGHLIGHT_COLOR = (255, 214, 0, 255)   # yellow, for the active word in "highlight" style
OUTLINE_COLOR = (0, 0, 0, 255)
OUTLINE_WIDTH = 4
BOX_COLOR = (0, 0, 0, 170)             # semi-transparent black, for "boxed" style
BOX_PADDING = 22
LINE_SPACING = 12

MAX_WORDS_PER_CHUNK = 6
MAX_CHUNK_DURATION = 2.5    # seconds -- keeps lines from lingering on screen too long

MAX_OVERLAYS_PER_PASS = 40  # see module docstring -- caps simultaneous ffmpeg inputs per pass

STYLES = ["default", "boxed", "highlight"]

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output", "subtitles")


# ---------------------------------------------------------------------------
# Chunking: word-level transcript -> readable line groups
# ---------------------------------------------------------------------------

def _chunk_words(
    words: List[Dict],
    max_words: int = MAX_WORDS_PER_CHUNK,
    max_duration: float = MAX_CHUNK_DURATION,
) -> List[List[Dict]]:
    """Groups consecutive words into caption-line-sized chunks, breaking on
    whichever limit (word count or on-screen duration) comes first."""
    chunks = []
    current: List[Dict] = []
    for w in words:
        if not current:
            current.append(w)
            continue
        would_span = w["end"] - current[0]["start"]
        if len(current) >= max_words or would_span > max_duration:
            chunks.append(current)
            current = [w]
        else:
            current.append(w)
    if current:
        chunks.append(current)
    return chunks


# ---------------------------------------------------------------------------
# Rendering: one chunk (+ optional active-word index) -> a transparent PNG
# ---------------------------------------------------------------------------

def _resolve_font_path(font_name: str) -> str:
    """
    Resolution order: explicit SUBTITLE_FONT_PATH env override > named preset from
    assets/fonts/ > error. Presets are the supported path -- env override exists for
    one-off testing, not as the normal way to pick a look.
    """
    if FONT_PATH:
        return FONT_PATH
    if font_name not in FONT_PRESETS:
        raise ValueError(f"Unknown font preset '{font_name}'. Choose from: {list(FONT_PRESETS.keys())}")
    return os.path.join(FONTS_DIR, FONT_PRESETS[font_name])


def _get_font(font_name: str = "default") -> ImageFont.FreeTypeFont:
    path = _resolve_font_path(font_name)
    if not os.path.exists(path):
        raise RuntimeError(
            f"Font not found at {path}. Either add the .ttf to {FONTS_DIR}/ (see FONT_PRESETS), "
            f"or set SUBTITLE_FONT_PATH to a valid .ttf directly. This ffmpeg build can't fall "
            f"back to drawtext's built-in fonts, so a real file has to exist at this path."
        )
    try:
        return ImageFont.truetype(path, FONT_SIZE)
    except OSError as e:
        # Pillow's own error here is just "unknown file format" with no path attached --
        # the file exists but isn't a valid/parseable font (corrupted, truncated, or a
        # stale SUBTITLE_FONT_PATH override pointing at something that isn't really a
        # .ttf). Re-raise with the path so this is diagnosable from the error alone.
        source = "SUBTITLE_FONT_PATH override" if FONT_PATH else f"FONT_PRESETS[{font_name!r}]"
        raise RuntimeError(
            f"Could not load font at {path} (from {source}): {e}. "
            f"The file exists but Pillow can't parse it as a font -- it may be corrupted, "
            f"truncated, or not actually a .ttf. Re-download/replace it, or unset "
            f"SUBTITLE_FONT_PATH if that's set."
        ) from e


def _wrap_words(draw: ImageDraw.ImageDraw, words_text: List[str], font, max_width: int) -> List[List[int]]:
    """Greedy word-wrap. Returns a list of lines, each a list of word indices."""
    space_w = draw.textlength(" ", font=font)
    lines: List[List[int]] = [[]]
    line_w = 0.0
    for i, wt in enumerate(words_text):
        w_width = draw.textlength(wt, font=font)
        added_w = w_width if not lines[-1] else space_w + w_width
        if lines[-1] and line_w + added_w > max_width:
            lines.append([i])
            line_w = w_width
        else:
            lines[-1].append(i)
            line_w += added_w
    return lines


def _render_line_image(
    chunk_words: List[Dict],
    active_index: Optional[int],
    style: str,
    video_width: int,
    out_path: str,
    font_name: str = "default",
) -> str:
    font = _get_font(font_name)
    words_text = [w["word"] for w in chunk_words]

    scratch = Image.new("RGBA", (10, 10))
    draw = ImageDraw.Draw(scratch)

    max_text_width = video_width - 2 * SIDE_MARGIN
    lines = _wrap_words(draw, words_text, font, max_text_width)

    pad = OUTLINE_WIDTH * 2 + (BOX_PADDING if style == "boxed" else 6)
    ascent, descent = font.getmetrics()
    line_h = ascent + descent

    line_widths = []
    for line in lines:
        text = " ".join(words_text[i] for i in line)
        line_widths.append(draw.textlength(text, font=font))
    img_w = min(int(max(line_widths, default=0)) + pad * 2, video_width)
    img_h = int(line_h * len(lines) + LINE_SPACING * (len(lines) - 1) + pad * 2)

    img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if style == "boxed":
        draw.rounded_rectangle([0, 0, img_w, img_h], radius=14, fill=BOX_COLOR)

    y = pad
    for line in lines:
        text = " ".join(words_text[i] for i in line)
        line_w = draw.textlength(text, font=font)
        x = (img_w - line_w) / 2
        for i in line:
            wt = words_text[i]
            color = HIGHLIGHT_COLOR if (style == "highlight" and i == active_index) else BASE_COLOR
            if style == "boxed":
                draw.text((x, y), wt, font=font, fill=color)
            else:
                draw.text((x, y), wt, font=font, fill=color, stroke_width=OUTLINE_WIDTH, stroke_fill=OUTLINE_COLOR)
            x += draw.textlength(wt, font=font) + draw.textlength(" ", font=font)
        y += line_h + LINE_SPACING

    img.save(out_path)
    return out_path


def _get_video_dims(video_path: str) -> tuple:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-of", "csv=s=x:p=0", video_path],
        capture_output=True, text=True, check=True,
    )
    w, h = result.stdout.strip().split("x")
    return int(w), int(h)


def _get_duration(video_path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def generate_subtitle_overlays(
    words: List[Dict],
    video_path: str,
    style: str = "default",
    font_name: str = "default",
) -> List[Dict]:
    """
    Takes word-level transcript (from captions.generate_captions) plus the target
    video (for its width, so lines wrap correctly). Renders one PNG per caption
    line ("default"/"boxed") or one PNG per word ("highlight"), and returns
    [{"image_path", "start", "end"}, ...] ready for burn_in_subtitles.

    font_name: key into FONT_PRESETS (e.g. "modern", "serif", "mono"). See that
    dict for the full list.
    """
    if style not in STYLES:
        raise ValueError(f"style must be one of {STYLES}, got {style!r}")
    if not words:
        return []

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    video_width, _ = _get_video_dims(video_path)
    chunks = _chunk_words(words)

    overlays = []
    idx = 0
    for chunk in chunks:
        if style == "highlight":
            # One frame per word so the active word can be highlighted as it's spoken.
            for wi, w in enumerate(chunk):
                path = os.path.join(OUTPUT_DIR, f"sub_{idx:04d}.png")
                _render_line_image(chunk, wi, style, video_width, path, font_name)
                overlays.append({"image_path": path, "start": w["start"], "end": w["end"]})
                idx += 1
        else:
            path = os.path.join(OUTPUT_DIR, f"sub_{idx:04d}.png")
            _render_line_image(chunk, None, style, video_width, path, font_name)
            overlays.append({"image_path": path, "start": chunk[0]["start"], "end": chunk[-1]["end"]})
            idx += 1

    return overlays


def _burn_pass(
    video_path: str,
    overlays: List[Dict],
    output_path: str,
    total_duration: float,
    preset: str,
    use_hw_encoder: bool,
) -> str:
    """Burns in one batch of overlays (<= MAX_OVERLAYS_PER_PASS) in a single ffmpeg call."""
    cmd = ["ffmpeg", "-y", "-i", video_path]
    for ov in overlays:
        # See module docstring: -loop 1 is an infinite stream just like -stream_loop -1,
        # and needs the same -t bound or the overlay filter's framesync can hang.
        cmd += ["-loop", "1", "-t", str(total_duration), "-i", ov["image_path"]]

    filter_parts = []
    prev = "0:v"
    for i, ov in enumerate(overlays):
        rgba = f"sub{i}"
        filter_parts.append(f"[{i+1}:v]format=rgba[{rgba}]")
        out_label = f"ov{i}" if i < len(overlays) - 1 else "outv"
        filter_parts.append(
            f"[{prev}][{rgba}]overlay=x=(main_w-overlay_w)/2:y=main_h-overlay_h-{BOTTOM_MARGIN}:"
            f"enable='between(t,{ov['start']},{ov['end']})'[{out_label}]"
        )
        prev = out_label

    filter_complex = ";".join(filter_parts)
    cmd += ["-filter_complex", filter_complex, "-map", "[outv]", "-map", "0:a?"]

    if use_hw_encoder:
      cmd += ["-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p"]
    else:
      cmd += ["-c:v", "libx264", "-preset", preset, "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac", output_path]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            "FFmpeg subtitle overlay pass timed out after 180s -- something is hanging, "
            "not just slow. Re-check the filter graph rather than waiting longer."
        )
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg subtitle overlay pass failed:\n{result.stderr[-3000:]}")

    return output_path


def burn_in_subtitles(
    video_path: str,
    overlays: List[Dict],
    output_path: str,
    preset: str = "ultrafast",
    use_hw_encoder: bool = False,
) -> str:
    """
    Composites the rendered subtitle PNGs onto video_path at their assigned times.
    Batches overlays into groups of MAX_OVERLAYS_PER_PASS, chaining sequential
    ffmpeg passes -- see module docstring for why a single pass doesn't scale to
    "highlight" style's one-PNG-per-word count on longer videos.

    preset / use_hw_encoder: same tradeoffs as stickers.overlay_stickers.
    """
    if not overlays:
        raise ValueError("No subtitle overlays to burn in.")

    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    total_duration = _get_duration(video_path)
    batches = [overlays[i:i + MAX_OVERLAYS_PER_PASS] for i in range(0, len(overlays), MAX_OVERLAYS_PER_PASS)]

    current_input = video_path
    temp_files = []
    try:
        for batch_num, batch in enumerate(batches):
            is_last = batch_num == len(batches) - 1
            pass_output = output_path if is_last else os.path.join(
                OUTPUT_DIR, f"_pass_{batch_num:02d}.mp4"
            )
            _burn_pass(current_input, batch, pass_output, total_duration, preset, use_hw_encoder)
            if current_input != video_path:
                temp_files.append(current_input)
            current_input = pass_output
    finally:
        for f in temp_files:
            try:
                os.remove(f)
            except OSError:
                pass

    return output_path


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from steps.captions import generate_captions

    if len(sys.argv) < 2:
        print(f"Usage: python steps/subtitle_styles.py <path_to_video> [{'|'.join(STYLES)}] [{'|'.join(FONT_PRESETS)}] [hw]")
        sys.exit(1)

    video_path = sys.argv[1]
    rest = sys.argv[2:]
    style = next((a for a in rest if a in STYLES), "default")
    use_hw = "hw" in rest
    # Anything left after stripping style/hw is presumed to be the font name -- if it
    # doesn't match a real preset, fail loudly rather than silently falling back to
    # "default" (that silent-fallback bug bit us once already: a typo'd/not-yet-added
    # font name should be an error, not a quiet substitution the user won't notice).
    font_candidates = [a for a in rest if a not in STYLES and a != "hw"]
    if len(font_candidates) > 1:
        print(f"Multiple unrecognized args, expected at most one font name: {font_candidates}")
        sys.exit(1)
    font_name = font_candidates[0] if font_candidates else "default"
    if font_name not in FONT_PRESETS:
        print(f"Unknown font preset '{font_name}'. Choose from: {list(FONT_PRESETS.keys())}")
        sys.exit(1)
    output_path = f"output/with_subtitles_{style}_{font_name}.mp4"

    print(f"Transcribing: {video_path}")
    words = generate_captions(video_path)

    print(f"Rendering '{style}' subtitle overlays in '{font_name}' font...")
    overlays = generate_subtitle_overlays(words, video_path, style=style, font_name=font_name)
    print(f"Generated {len(overlays)} overlay PNG(s)")

    print(f"Burning in -> {output_path}")
    burn_in_subtitles(video_path, overlays, output_path, use_hw_encoder=use_hw)
    print("Done.")

# ---------------------------------------------------------------------------
# Manifest-facing entry point (independently callable pipeline step)
# ---------------------------------------------------------------------------
from steps.project_store import record_step, project_output_dir, require


def run(project: dict, style: str = "default", font_name: str = "default") -> dict:
    require(project, "words", step="captions")
    video_path = project["current_video"]

    overlays = generate_subtitle_overlays(project["words"], video_path, style=style, font_name=font_name)
    output_path = os.path.join(project_output_dir(project), "with_subtitles.mp4")
    burn_in_subtitles(video_path, overlays, output_path)

    return record_step(project, "subtitle_styles", new_video=output_path, subtitle_style=style)