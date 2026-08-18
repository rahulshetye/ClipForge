"""
Step 4: Caption Generation + Styling
Scene list (with audio_path from voiceover step) -> word-level timestamps per
scene -> styled, transparent caption PNGs ready for assembly.py to overlay.

Two things happen in this file:
  1. TRANSCRIPTION: faster-whisper locally (free, no API key, runs on CPU).
  2. RENDERING: word-level transcript -> styled caption images (default/boxed/
     highlight), via Pillow. Captions are burned in INLINE, per-scene, during
     assembly.py's scene rendering -- unlike Part 2, which burns captions in
     as a separate LATER step on an already-fully-assembled plain video.

Note on transcription approach: since we generated the audio FROM known script
text (via edge-tts), we could do pure "forced alignment" (sync known text to
audio) instead of transcription. True forced-alignment libraries (aeneas, etc.)
have painful C-dependency installs though. Running Whisper transcription on TTS
audio is nearly as accurate in practice -- the audio is clean, single-speaker,
no background noise -- so transcription word timestamps are reliable here. We
keep the original script text as ground truth for captions text, and only use
Whisper for the TIMING of each word.

Note on rendering approach: this intentionally does NOT depend on bundled
.ttf files the way Part 2's steps/subtitle_styles.py does. It reuses
assembly.py's original FONT_CANDIDATES fallback pattern (try a few known
system font paths, fall back to Pillow's built-in font) so caption style
variety works immediately without setting up an assets/fonts/ directory
first. If you later want the same named font presets Part 2 offers (Bebas,
Anton, Bangers, etc. for a TikTok-caption look), bundle those .ttf files and
swap _get_font's body for FONT_PRESETS-style resolution -- STYLES/rendering
logic below doesn't need to change either way.
"""

import os
from typing import List, Dict, Optional
from faster_whisper import WhisperModel
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

MODEL_SIZE = "base.en"  # good speed/accuracy balance for clean, single-speaker TTS audio

_model = None  # lazy singleton, load once and reuse across scenes


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        # int8 compute_type keeps this fast on CPU (including Apple Silicon M-series)
        _model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    return _model


def _transcribe_words(audio_path: str) -> List[Dict]:
    """Returns a list of {word, start, end} dicts for one audio file."""
    model = _get_model()
    segments, _ = model.transcribe(audio_path, word_timestamps=True)

    words = []
    for segment in segments:
        for w in segment.words:
            words.append({
                "word": w.word.strip(),
                "start": round(w.start, 2),
                "end": round(w.end, 2),
            })
    return words


def generate_captions(scenes: List[Dict]) -> List[Dict]:
    """
    Takes scenes (each must have 'audio_path' from the voiceover step).
    Returns the same list with each scene extended with:
        - words: [{"word": str, "start": float, "end": float}, ...]
          (timestamps are relative to that scene's own audio file, i.e. start at ~0)
    """
    results = []
    for i, scene in enumerate(scenes):
        audio_path = scene.get("audio_path")
        if not audio_path or not os.path.exists(audio_path):
            print(f"  Scene {i}: no audio_path found, skipping captions")
            results.append({**scene, "words": []})
            continue

        words = _transcribe_words(audio_path)
        print(f"  Scene {i}: {len(words)} words timestamped")
        results.append({**scene, "words": words})

    return results


# ---------------------------------------------------------------------------
# Styled rendering
# ---------------------------------------------------------------------------

TARGET_W = 1080          # matches assembly.py's TARGET_W -- caption images are full video width
CAPTION_BAND_H = 260      # matches assembly.py's CAPTION_BAND_H
WORDS_PER_CAPTION = 4     # matches assembly.py's chunking size

BASE_COLOR = (255, 255, 255, 255)      # white
HIGHLIGHT_COLOR = (255, 214, 0, 255)   # yellow, for the active word in "highlight" style
OUTLINE_COLOR = (0, 0, 0, 255)
OUTLINE_WIDTH = 4
BOX_COLOR = (0, 0, 0, 170)             # semi-transparent black, for "boxed" style
BOX_PADDING = 22

STYLES = ["default", "boxed", "highlight"]

# Same search order assembly.py originally used -- kept here so caption
# rendering and any other text rendering in the pipeline always agree on
# which font actually got picked on this machine.
FONT_CANDIDATES = [
    os.environ.get("CAPTION_FONT_PATH", ""),
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",   # macOS
    "/System/Library/Fonts/Supplemental/Arial.ttf",         # macOS
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",  # Linux
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",  # Linux
    "C:\\Windows\\Fonts\\arialbd.ttf",                       # Windows
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


def _render_caption_image(
    words_in_chunk: List[Dict],
    active_index: Optional[int],
    style: str,
    out_path: str,
) -> None:
    """Renders one caption chunk (a few words) as a transparent PNG, sized
    TARGET_W x CAPTION_BAND_H -- same canvas size assembly.py already overlays
    at a fixed y position, so no changes needed on the assembly.py side for
    where the image gets placed."""
    font = _get_font(64)
    img = Image.new("RGBA", (TARGET_W, CAPTION_BAND_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    text = " ".join(w["word"] for w in words_in_chunk)
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (TARGET_W - text_w) // 2
    y = (CAPTION_BAND_H - text_h) // 2

    if style == "boxed":
        pad = BOX_PADDING
        draw.rounded_rectangle(
            [x - pad, y - pad, x + text_w + pad, y + text_h + pad],
            radius=14,
            fill=BOX_COLOR,
        )
        # boxed style skips the outline -- the box itself provides contrast
        cursor_x = x
        for i, w in enumerate(words_in_chunk):
            wt = w["word"]
            color = HIGHLIGHT_COLOR if (style == "highlight" and i == active_index) else BASE_COLOR
            draw.text((cursor_x, y), wt, font=font, fill=color)
            cursor_x += draw.textlength(wt + " ", font=font)
    else:
        # "default" and "highlight" both use the stroked-outline look;
        # "highlight" additionally colors the active word yellow.
        cursor_x = x
        for i, w in enumerate(words_in_chunk):
            wt = w["word"]
            color = HIGHLIGHT_COLOR if (style == "highlight" and i == active_index) else BASE_COLOR
            draw.text(
                (cursor_x, y), wt, font=font, fill=color,
                stroke_width=OUTLINE_WIDTH, stroke_fill=OUTLINE_COLOR,
            )
            cursor_x += draw.textlength(wt + " ", font=font)

    img.save(out_path)


def render_caption_chunks(
    words: List[Dict],
    out_dir: str,
    scene_index: int,
    style: str = "default",
) -> List[Dict]:
    """
    Drop-in replacement for assembly.py's old _make_caption_chunks, with a
    `style` param added. Groups words into WORDS_PER_CAPTION-sized chunks
    (same as before) and renders each as a styled PNG.

    "highlight" needs one PNG per WORD (not per chunk) so the active word can
    change color as it's spoken -- same one-frame-per-word approach as Part 2's
    subtitle_styles.py, for the same reason.

    Returns [{"path": str, "start": float, "end": float}, ...] -- same shape
    assembly.py's caption_input_args / overlay-chaining code already expects,
    so no changes needed there beyond passing `style` through to this call.
    """
    if style not in STYLES:
        raise ValueError(f"style must be one of {STYLES}, got {style!r}")
    if not words:
        return []

    os.makedirs(out_dir, exist_ok=True)
    chunks = []
    for i in range(0, len(words), WORDS_PER_CAPTION):
        chunk = words[i:i + WORDS_PER_CAPTION]

        if style == "highlight":
            for wi, w in enumerate(chunk):
                png_path = os.path.join(out_dir, f"scene_{scene_index:02d}_cap_{i:03d}_{wi}.png")
                _render_caption_image(chunk, wi, style, png_path)
                chunks.append({"path": png_path, "start": w["start"], "end": w["end"]})
        else:
            png_path = os.path.join(out_dir, f"scene_{scene_index:02d}_cap_{i:03d}.png")
            _render_caption_image(chunk, None, style, png_path)
            chunks.append({"path": png_path, "start": chunk[0]["start"], "end": chunk[-1]["end"]})

    return chunks


if __name__ == "__main__":
    # Quick manual test -- run this AFTER voiceover.py has produced output/audio/scene_00.mp3 etc.
    # Or point it at any existing mp3 for a quick isolated test.
    import glob

    audio_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output", "audio")
    audio_files = sorted(glob.glob(os.path.join(audio_dir, "*.mp3")))

    if not audio_files:
        print(f"No audio files found in {audio_dir}. Run voiceover.py first.")
    else:
        test_scenes = [{"audio_path": f} for f in audio_files]
        print(f"Testing captions on {len(test_scenes)} existing audio file(s)...")
        result = generate_captions(test_scenes)
        for r in result:
            print(f"\n{r['audio_path']}:")
            print(" ".join(w["word"] for w in r["words"]))