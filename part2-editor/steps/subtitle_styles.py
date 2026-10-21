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

---------------------------------------------------------------------------
DEVANAGARI (HINDI / MARATHI) SUPPORT
---------------------------------------------------------------------------
Two things must both be right for joined letters (conjuncts like क्ष, ज्ञ, त्र,
द्ध, श्र) and reordered matras (the short "i" ि drawn BEFORE its consonant) to
render correctly:

1) A font that has the glyphs. The Latin display fonts (Anton, Bebas, Bangers,
   ...) have NO Devanagari glyphs and would show empty boxes. So whenever a line
   contains Devanagari and the chosen font can't draw it, _render_line_image()
   swaps to DEVANAGARI_FALLBACK_FONT automatically.

2) A complex-text-layout engine. Pillow only shapes Devanagari correctly when it
   is built with libraqm (HarfBuzz + FriBiDi). Without it, even a perfect font
   draws unjoined letters. Install:
     Linux:   sudo apt install libraqm0 libfribidi0 libharfbuzz0b
     macOS:   brew install fribidi harfbuzz
     Windows: the Pillow wheels bundle it
   Check:  python -c "from PIL import features; print(features.check('raqm'))"
   must print True. A warning is printed at import time if it doesn't.

Fonts for Devanagari (all OFL, use STATIC .ttf files, not variable fonts):
  noto-deva  -> NotoSansDevanagari-Bold.ttf        (best default, widest coverage)
  mukta      -> Mukta-Bold.ttf                      (clean, popular for social video)
  tiro-deva  -> TiroDevanagariMarathi-Regular.ttf   (serif, designed for Marathi)

---------------------------------------------------------------------------
STYLE PRESETS (added on top of the original default/boxed/highlight system)
---------------------------------------------------------------------------
The original system let a caller mix any font with any of the 3 structural
render styles independently. That doesn't match how "looks" actually read in
the wild (VEED/CapCut/Submagic-style templates): font, text color, emphasis
color/treatment, and entry/exit motion are chosen TOGETHER as one cohesive
look ("studio" = condensed caps + red emphasis; "editorial" = serif + soft
highlight; etc).

STYLE_PRESETS bundles those choices under a single name. Passing
preset_name="studio" now picks font + colors + emphasis behavior + transition
together. The old style= / font_name= args still work exactly as before --
_resolve_style() treats them as an implicit, terse preset (render_mode=style,
transition="cut") when no preset_name is given, so nothing already calling
this module needs to change.

Two render_modes now drive emphasis, sharing one drawing path in
_render_line_image():
  - "highlight": one PNG per WORD, active word cycles as it's spoken
    (karaoke-style). This is the original "highlight" behavior, unchanged.
  - "content_aware": one PNG per LINE, with a single word emphasized for the
    whole line's duration, chosen by _pick_emphasis_indices() (skips
    stopwords, picks the longest content word). New in this version -- and
    much cheaper than "highlight" since it doesn't multiply PNGs per word.

Emphasis can be drawn two ways (emphasis_style, per preset):
  - "color": the word is drawn in a different color (original behavior).
  - "box": a solid rounded-rect is drawn behind just that word (the
    "DISCIPLINE" magazine-pullquote look), text drawn on top in a
    contrasting color.

Transitions (transition, per preset) are applied in the ffmpeg burn-in pass,
not by rendering extra PNGs, so they don't affect overlay counts or batching:
  - "cut": hard on/off at start/end (original behavior, unchanged).
  - "fade": short alpha fade-in/out at each overlay's edges.
  - "slide": overlay slides up into its final position over ~150ms on entry.
"""

import os
import subprocess
from typing import List, Dict, Optional, Tuple
from PIL import Image, ImageDraw, ImageFont, features

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
    "modern": "Poppins-Bold.ttf",            # rounded geometric, popular for social captions (has Devanagari)
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
    # --- Devanagari (Hindi / Marathi) fonts -- use static TTFs, not variable fonts ---
    "noto-deva": "NotoSansDevanagari-Bold.ttf",          # best default: widest conjunct + Marathi glyph coverage
    "mukta": "Mukta-Bold.ttf",                           # clean, popular on social video
    "tiro-deva": "TiroDevanagariMarathi-Regular.ttf",    # serif, designed specifically for Marathi
}

# Fonts that can actually draw Devanagari. If a line contains Devanagari and the
# requested font isn't in this set, we swap to DEVANAGARI_FALLBACK_FONT instead of
# rendering empty boxes.
DEVANAGARI_CAPABLE_FONTS = {"noto-deva", "mukta", "tiro-deva", "modern"}
DEVANAGARI_FALLBACK_FONT = "noto-deva"

FONT_PATH = os.getenv("SUBTITLE_FONT_PATH")  # explicit override still wins if set

# Pillow needs libraqm for correct Devanagari shaping (conjuncts, matra reordering).
_RAQM = features.check("raqm")
if not _RAQM:
    print("WARNING: Pillow was built without libraqm. Hindi/Marathi conjuncts and matras "
          "will render incorrectly. Install libraqm (see module docstring) for correct Devanagari.")

BASE_COLOR = (255, 255, 255, 255)      # white
HIGHLIGHT_COLOR = (255, 214, 0, 255)   # yellow, for the active word in "highlight" style
OUTLINE_COLOR = (0, 0, 0, 255)
OUTLINE_WIDTH = 4
BOX_COLOR = (0, 0, 0, 170)             # semi-transparent black, for "boxed" style
BOX_PADDING = 22
LINE_SPACING = 12

# Devanagari has tall headline marks and below-baseline marks; give it extra
# vertical room inside each line so nothing clips at the PNG edges.
DEVANAGARI_EXTRA_LINE_PX = 8

MAX_WORDS_PER_CHUNK = 6
MAX_CHUNK_DURATION = 2.5    # seconds -- keeps lines from lingering on screen too long

MAX_OVERLAYS_PER_PASS = 40  # see module docstring -- caps simultaneous ffmpeg inputs per pass

# Structural render modes. "default"/"boxed" existed before; "highlight" (per-word
# karaoke) existed before too; "content_aware" is new (single emphasized word, one
# PNG per line -- see module docstring).
RENDER_MODES = ["default", "boxed", "highlight", "content_aware"]
STYLES = ["default", "boxed", "highlight"]  # kept for backward compatibility with old callers

# Transition applied at burn-in time (ffmpeg filter graph, not extra PNGs).
TRANSITIONS = ["cut", "fade", "slide"]
TRANSITION_DURATION = 0.15  # seconds, for both fade in/out and slide-in
TRANSITION_SLIDE_PX = 40    # how far below final position the slide-in starts

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output", "subtitles")


def _has_devanagari(text: str) -> bool:
    return any("\u0900" <= ch <= "\u097F" for ch in text)


# ---------------------------------------------------------------------------
# Style presets: font + colors + emphasis behavior + transition, bundled
# ---------------------------------------------------------------------------

STYLE_PRESETS: Dict[str, Dict] = {
    # --- legacy structural styles, kept as named presets for consistency ---
    "classic": {
        "render_mode": "default",
        "font": "default",
        "base_color": BASE_COLOR,
        "transition": "cut",
    },
    "boxed": {
        "render_mode": "boxed",
        "font": "default",
        "base_color": BASE_COLOR,
        "transition": "cut",
    },
    "karaoke": {
        "render_mode": "highlight",
        "font": "default",
        "base_color": BASE_COLOR,
        "emphasis_color": HIGHLIGHT_COLOR,
        "emphasis_style": "color",
        "transition": "cut",
    },

    # --- new looks, matching the reference styles (font + color paired) ---
    "studio": {
        # bold condensed red-on-white caps, red emphasis word -- magazine-cover feel
        "render_mode": "content_aware",
        "font": "anton",
        "base_color": (255, 255, 255, 255),
        "emphasis_color": (237, 28, 36, 255),
        "emphasis_style": "color",
        "transition": "fade",
    },
    "editorial": {
        # soft serif, cream text, muted yellow-green emphasis -- documentary/interview feel
        "render_mode": "content_aware",
        "font": "free-serif",
        "base_color": (240, 235, 222, 255),
        "emphasis_color": (223, 255, 110, 255),
        "emphasis_style": "color",
        "transition": "fade",
    },
    "impact": {
        # heavy black caps, white text, solid highlight block behind the key word
        "render_mode": "content_aware",
        "font": "archivo-black",
        "base_color": (255, 255, 255, 255),
        "emphasis_style": "box",
        "emphasis_box_color": (223, 255, 110, 255),
        "emphasis_text_color": (0, 0, 0, 255),
        "transition": "cut",
    },
    "kinetic": {
        # rounded modern font, yellow emphasis, slides up into place -- punchy social feel
        "render_mode": "content_aware",
        "font": "modern",
        "base_color": (255, 255, 255, 255),
        "emphasis_color": (255, 214, 0, 255),
        "emphasis_style": "color",
        "transition": "slide",
    },
    "poster": {
        # huge bold condensed caps, no emphasis word -- centered poster-title feel
        "render_mode": "default",
        "font": "bebas",
        "base_color": (255, 255, 255, 255),
        "transition": "fade",
    },

    # --- Devanagari-first looks (Marathi / Hindi) ---
    "marathi-bold": {
        # Noto Sans Devanagari, white text, yellow emphasis word, fade in/out
        "render_mode": "content_aware",
        "font": "noto-deva",
        "base_color": (255, 255, 255, 255),
        "emphasis_color": (255, 214, 0, 255),
        "emphasis_style": "color",
        "transition": "fade",
    },
    "marathi-editorial": {
        # Tiro Devanagari Marathi serif, cream text, soft green-yellow emphasis
        "render_mode": "content_aware",
        "font": "tiro-deva",
        "base_color": (240, 235, 222, 255),
        "emphasis_color": (223, 255, 110, 255),
        "emphasis_style": "color",
        "transition": "fade",
    },
}


def _resolve_style(
    style: str = "default",
    font_name: str = "default",
    preset_name: Optional[str] = None,
) -> Dict:
    """
    Returns one resolved style dict (render_mode, font, colors, emphasis
    behavior, transition) used consistently by both rendering and burn-in.

    If preset_name is given, it must be a key in STYLE_PRESETS and wins outright.
    If not, style/font_name are treated as an implicit preset equivalent to the
    original pre-preset behavior (transition="cut", emphasis_color=HIGHLIGHT_COLOR,
    emphasis_style="color") -- so existing calls that only ever passed style=/
    font_name= render identically to before.
    """
    if preset_name is not None:
        if preset_name not in STYLE_PRESETS:
            raise ValueError(f"Unknown preset '{preset_name}'. Choose from: {list(STYLE_PRESETS.keys())}")
        raw = STYLE_PRESETS[preset_name]
    else:
        if style not in STYLES:
            raise ValueError(f"style must be one of {STYLES}, got {style!r}")
        raw = {
            "render_mode": style,
            "font": font_name,
            "base_color": BASE_COLOR,
            "emphasis_color": HIGHLIGHT_COLOR,
            "emphasis_style": "color",
            "transition": "cut",
        }

    return {
        "render_mode": raw.get("render_mode", "default"),
        "font": raw.get("font", "default"),
        "base_color": raw.get("base_color", BASE_COLOR),
        "emphasis_color": raw.get("emphasis_color", HIGHLIGHT_COLOR),
        "emphasis_style": raw.get("emphasis_style", "color"),  # "color" | "box"
        "emphasis_box_color": raw.get("emphasis_box_color", BOX_COLOR),
        "emphasis_text_color": raw.get("emphasis_text_color", raw.get("base_color", BASE_COLOR)),
        "line_box_color": raw.get("line_box_color", BOX_COLOR),
        "transition": raw.get("transition", "cut"),
    }


# ---------------------------------------------------------------------------
# Content-aware emphasis: which word in a line gets the visual punch-up
# ---------------------------------------------------------------------------

_STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "am", "i", "you",
    "he", "she", "it", "we", "they", "and", "or", "but", "of", "to", "in", "on",
    "at", "for", "with", "that", "this", "these", "those", "my", "your", "his",
    "her", "its", "our", "their", "so", "just", "not", "do", "does", "did",
    "will", "would", "can", "could", "should", "if", "as", "by", "from", "up",
    "out", "about", "into", "than", "then", "there", "here", "what", "which",
    "who", "whom",
}

# Marathi + Hindi function words, so the "longest content word" heuristic doesn't
# pick a particle like "आणि" or "में" for emphasis.
_STOPWORDS |= {
    # Marathi
    "आणि", "आहे", "आहेत", "होते", "होता", "होती", "हे", "ही", "हा", "ते", "ती", "तो",
    "मी", "तू", "तुम्ही", "आपण", "आम्ही", "या", "त्या", "त्यांना", "की", "का", "पण",
    "तर", "मध्ये", "साठी", "नाही", "च", "ने", "ला", "ना", "वर", "कडे", "असे", "असा",
    "आणखी", "म्हणून", "जर", "तरी",
    # Hindi
    "है", "हैं", "था", "थी", "थे", "के", "को", "से", "में", "पर", "और",
    "यह", "वह", "ये", "वो", "नहीं", "भी", "तो", "ही", "कि",
}


def _pick_emphasis_indices(chunk_words: List[Dict], max_emphasized: int = 1) -> List[int]:
    """
    Picks the word index/indices (within one chunk) to visually emphasize for
    "content_aware" style: skip stopwords/punctuation-only tokens, then take the
    longest remaining word(s) as a cheap proxy for "the word that matters most".

    This is a heuristic, not an AI call -- see module docstring for why subtitle
    placement doesn't need the closed-vocabulary judgment calls stickers/music/
    sound-effects do. If it picks the wrong word often enough to be annoying,
    the fix is a better heuristic here, not a model call -- keep this cheap.
    """
    candidates = []
    for i, w in enumerate(chunk_words):
        cleaned = w["word"].strip(".,!?;:\"'()-").strip("।").strip()
        if cleaned and cleaned.lower() not in _STOPWORDS:
            candidates.append((i, len(cleaned)))
    if not candidates:
        return []
    candidates.sort(key=lambda c: c[1], reverse=True)
    return [i for i, _ in candidates[:max_emphasized]]


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
# Rendering: one chunk (+ optional emphasized word index) -> a transparent PNG
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
        # RAQM shapes complex scripts (Devanagari conjuncts, matra reordering) correctly.
        engine = ImageFont.Layout.RAQM if _RAQM else ImageFont.Layout.BASIC
        return ImageFont.truetype(path, FONT_SIZE, layout_engine=engine)
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
    render_mode: str,
    video_width: int,
    out_path: str,
    font_name: str = "default",
    base_color: Tuple[int, int, int, int] = BASE_COLOR,
    emphasis_color: Tuple[int, int, int, int] = HIGHLIGHT_COLOR,
    emphasis_style: str = "color",
    emphasis_box_color: Tuple[int, int, int, int] = BOX_COLOR,
    emphasis_text_color: Tuple[int, int, int, int] = BASE_COLOR,
    line_box_color: Tuple[int, int, int, int] = BOX_COLOR,
) -> str:
    words_text = [w["word"] for w in chunk_words]
    has_deva = any(_has_devanagari(t) for t in words_text)

    # Latin display fonts have no Devanagari glyphs (they'd render empty boxes),
    # so swap to a Devanagari-capable font whenever the text needs one.
    if has_deva and font_name not in DEVANAGARI_CAPABLE_FONTS:
        font_name = DEVANAGARI_FALLBACK_FONT

    font = _get_font(font_name)

    scratch = Image.new("RGBA", (10, 10))
    draw = ImageDraw.Draw(scratch)

    max_text_width = video_width - 2 * SIDE_MARGIN
    lines = _wrap_words(draw, words_text, font, max_text_width)

    pad = OUTLINE_WIDTH * 2 + (BOX_PADDING if render_mode == "boxed" else 6)
    ascent, descent = font.getmetrics()
    extra = DEVANAGARI_EXTRA_LINE_PX if has_deva else 0
    line_h = ascent + descent + extra
    text_dy = extra // 2   # nudge glyphs down so tall headline marks don't clip at the top

    line_widths = []
    for line in lines:
        text = " ".join(words_text[i] for i in line)
        line_widths.append(draw.textlength(text, font=font))
    img_w = min(int(max(line_widths, default=0)) + pad * 2, video_width)
    img_h = int(line_h * len(lines) + LINE_SPACING * (len(lines) - 1) + pad * 2)

    img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if render_mode == "boxed":
        draw.rounded_rectangle([0, 0, img_w, img_h], radius=14, fill=line_box_color)

    space_w = draw.textlength(" ", font=font)
    y = pad
    for line in lines:
        text = " ".join(words_text[i] for i in line)
        line_w = draw.textlength(text, font=font)
        x = (img_w - line_w) / 2
        for i in line:
            wt = words_text[i]
            w_width = draw.textlength(wt, font=font)
            is_emphasized = active_index is not None and i == active_index
            ty = y + text_dy

            if is_emphasized and emphasis_style == "box":
                # Word-level highlight block (the "DISCIPLINE" pullquote look) --
                # background behind just this word, text drawn on top in a
                # contrasting color. No outline needed; the block gives contrast.
                draw.rounded_rectangle(
                    [x - 10, y - 4, x + w_width + 10, y + line_h + 4],
                    radius=8, fill=emphasis_box_color,
                )
                draw.text((x, ty), wt, font=font, fill=emphasis_text_color)
            elif render_mode == "boxed":
                # Full-line background already gives contrast; no outline needed.
                color = emphasis_color if (is_emphasized and emphasis_style == "color") else base_color
                draw.text((x, ty), wt, font=font, fill=color)
            else:
                color = emphasis_color if (is_emphasized and emphasis_style == "color") else base_color
                draw.text((x, ty), wt, font=font, fill=color, stroke_width=OUTLINE_WIDTH, stroke_fill=OUTLINE_COLOR)

            x += w_width + space_w
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
    preset_name: Optional[str] = None,
) -> List[Dict]:
    """
    Takes word-level transcript (from captions.generate_captions) plus the target
    video (for its width, so lines wrap correctly). Renders one PNG per caption
    line ("default"/"boxed"/"content_aware") or one PNG per word ("highlight"),
    and returns [{"image_path", "start", "end"}, ...] ready for burn_in_subtitles.

    Two ways to choose a look:
      - preset_name: pick one of STYLE_PRESETS (font+colors+emphasis+transition
        bundled together, e.g. "studio", "editorial", "impact", "kinetic",
        "marathi-bold", "marathi-editorial").
      - style + font_name: the original independent controls (still supported,
        unchanged behavior when preset_name is left as None).
    preset_name wins if both are given.

    Hindi/Marathi (Devanagari) text automatically falls back to a Devanagari-capable
    font if the chosen font can't draw it -- see module docstring.
    """
    resolved = _resolve_style(style, font_name, preset_name)
    if resolved["render_mode"] not in RENDER_MODES:
        raise ValueError(f"render_mode must be one of {RENDER_MODES}, got {resolved['render_mode']!r}")
    if not words:
        return []

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    video_width, _ = _get_video_dims(video_path)
    chunks = _chunk_words(words)

    render_kwargs = dict(
        font_name=resolved["font"],
        base_color=resolved["base_color"],
        emphasis_color=resolved["emphasis_color"],
        emphasis_style=resolved["emphasis_style"],
        emphasis_box_color=resolved["emphasis_box_color"],
        emphasis_text_color=resolved["emphasis_text_color"],
        line_box_color=resolved["line_box_color"],
    )

    overlays = []
    idx = 0
    for chunk in chunks:
        if resolved["render_mode"] == "highlight":
            # One frame per word so the active word can be highlighted as it's spoken.
            for wi, w in enumerate(chunk):
                path = os.path.join(OUTPUT_DIR, f"sub_{idx:04d}.png")
                _render_line_image(chunk, wi, "highlight", video_width, path, **render_kwargs)
                overlays.append({"image_path": path, "start": w["start"], "end": w["end"]})
                idx += 1
        elif resolved["render_mode"] == "content_aware":
            # One frame per LINE -- a single word is emphasized for the whole
            # line's duration, chosen by the heuristic, not per spoken word.
            emphasis_indices = _pick_emphasis_indices(chunk)
            active_index = emphasis_indices[0] if emphasis_indices else None
            path = os.path.join(OUTPUT_DIR, f"sub_{idx:04d}.png")
            _render_line_image(chunk, active_index, "content_aware", video_width, path, **render_kwargs)
            overlays.append({"image_path": path, "start": chunk[0]["start"], "end": chunk[-1]["end"]})
            idx += 1
        else:
            path = os.path.join(OUTPUT_DIR, f"sub_{idx:04d}.png")
            _render_line_image(chunk, None, resolved["render_mode"], video_width, path, **render_kwargs)
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
    transition: str = "cut",
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

        if transition == "fade":
            # Short alpha fade at each overlay's own edges. Clamp fade-out start so
            # it can't go negative-length on a very short-lived overlay.
            fade_out_start = max(ov["start"], ov["end"] - TRANSITION_DURATION)
            filter_parts.append(
                f"[{i+1}:v]format=rgba,"
                f"fade=t=in:st={ov['start']}:d={TRANSITION_DURATION}:alpha=1,"
                f"fade=t=out:st={fade_out_start}:d={TRANSITION_DURATION}:alpha=1[{rgba}]"
            )
        else:
            filter_parts.append(f"[{i+1}:v]format=rgba[{rgba}]")

        base_y = f"main_h-overlay_h-{BOTTOM_MARGIN}"
        if transition == "slide":
            # Slides up from TRANSITION_SLIDE_PX below final position over the
            # first TRANSITION_DURATION seconds of this overlay's visible window.
            y_expr = (
                f"{base_y}+if(lt(t,{ov['start']}+{TRANSITION_DURATION}),"
                f"({ov['start']}+{TRANSITION_DURATION}-t)/{TRANSITION_DURATION}*{TRANSITION_SLIDE_PX},0)"
            )
        else:
            y_expr = base_y

        out_label = f"ov{i}" if i < len(overlays) - 1 else "outv"
        filter_parts.append(
            f"[{prev}][{rgba}]overlay=x=(main_w-overlay_w)/2:y='{y_expr}':"
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
    transition: str = "cut",
) -> str:
    """
    Composites the rendered subtitle PNGs onto video_path at their assigned times.
    Batches overlays into groups of MAX_OVERLAYS_PER_PASS, chaining sequential
    ffmpeg passes -- see module docstring for why a single pass doesn't scale to
    "highlight" style's one-PNG-per-word count on longer videos.

    preset / use_hw_encoder: same tradeoffs as stickers.overlay_stickers.
    transition: "cut" (default, original hard on/off behavior), "fade", or "slide".
    """
    if not overlays:
        raise ValueError("No subtitle overlays to burn in.")
    if transition not in TRANSITIONS:
        raise ValueError(f"transition must be one of {TRANSITIONS}, got {transition!r}")

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
            _burn_pass(current_input, batch, pass_output, total_duration, preset, use_hw_encoder, transition)
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
        print(
            f"Usage: python steps/subtitle_styles.py <path_to_video> "
            f"[preset:<name>] [{'|'.join(STYLES)}] [{'|'.join(FONT_PRESETS)}] [hw]\n"
            f"  Presets: {', '.join(STYLE_PRESETS.keys())}"
        )
        sys.exit(1)

    video_path = sys.argv[1]
    rest = sys.argv[2:]
    use_hw = "hw" in rest

    preset_arg = next((a.split(":", 1)[1] for a in rest if a.startswith("preset:")), None)
    if preset_arg is not None and preset_arg not in STYLE_PRESETS:
        print(f"Unknown preset '{preset_arg}'. Choose from: {list(STYLE_PRESETS.keys())}")
        sys.exit(1)

    style = next((a for a in rest if a in STYLES), "default")
    # Anything left after stripping style/hw/preset is presumed to be the font name -- if it
    # doesn't match a real preset, fail loudly rather than silently falling back to
    # "default" (that silent-fallback bug bit us once already: a typo'd/not-yet-added
    # font name should be an error, not a quiet substitution the user won't notice).
    font_candidates = [a for a in rest if a not in STYLES and a != "hw" and not a.startswith("preset:")]
    if len(font_candidates) > 1:
        print(f"Multiple unrecognized args, expected at most one font name: {font_candidates}")
        sys.exit(1)
    font_name = font_candidates[0] if font_candidates else "default"
    if preset_arg is None and font_name not in FONT_PRESETS:
        print(f"Unknown font preset '{font_name}'. Choose from: {list(FONT_PRESETS.keys())}")
        sys.exit(1)

    label = preset_arg or f"{style}_{font_name}"
    output_path = f"output/with_subtitles_{label}.mp4"
    resolved = _resolve_style(style, font_name, preset_arg)

    print(f"Transcribing: {video_path}")
    words = generate_captions(video_path)

    print(f"Rendering '{label}' subtitle overlays (render_mode={resolved['render_mode']}, "
          f"font={resolved['font']}, transition={resolved['transition']})...")
    overlays = generate_subtitle_overlays(words, video_path, style=style, font_name=font_name, preset_name=preset_arg)
    print(f"Generated {len(overlays)} overlay PNG(s)")

    print(f"Burning in -> {output_path}")
    burn_in_subtitles(video_path, overlays, output_path, use_hw_encoder=use_hw, transition=resolved["transition"])
    print("Done.")

# ---------------------------------------------------------------------------
# Manifest-facing entry point (independently callable pipeline step)
# ---------------------------------------------------------------------------
from steps.project_store import record_step, project_output_dir, require


def run(
    project: dict,
    style: str = "default",
    font_name: str = "default",
    preset_name: Optional[str] = None,
) -> dict:
    require(project, "words", step="captions")
    video_path = project["current_video"]

    resolved = _resolve_style(style, font_name, preset_name)
    overlays = generate_subtitle_overlays(
        project["words"], video_path, style=style, font_name=font_name, preset_name=preset_name,
    )
    output_path = os.path.join(project_output_dir(project), "with_subtitles.mp4")
    burn_in_subtitles(video_path, overlays, output_path, transition=resolved["transition"])

    return record_step(project, "subtitle_styles", new_video=output_path, subtitle_style=(preset_name or style))