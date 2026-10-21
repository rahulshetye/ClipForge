"""
Step 3: Caption Generation (Part 2 - Editor)
Trimmed video file -> word-level timestamps for the whole video.

Languages: English ("en"), Hindi ("hi") and Marathi ("mr").
Hindi / Marathi can be returned in native Devanagari or in Roman letters ("roman").

Pipeline
  1. Audio prep (ffmpeg): 16 kHz mono, high-pass + loudness normalisation.
     Real footage is noisy; cleaning first is the cheapest accuracy win.
  2. faster-whisper (local, free, no API key) with the language FORCED by the
     caller. Auto-detect only looks at the first ~30 s and often guesses wrong
     on mixed footage, so the editor UI should let the user pick.
     NOTE: Hindi vs Marathi is the weakest detection pair (same script, shared
     vocabulary). For Devanagari content, prefer an explicit user choice.
  3. Hotwords: names/brand terms from GLOSSARY are passed to the decoder to
     bias it toward the right spelling (e.g. a person's name like Dhairya).
  4. Optional Roman output for Hindi/Marathi: each Devanagari word is
     transliterated one-to-one, so start/end/confidence stay valid.

Hallucination mitigation (unchanged idea from before): condition_on_previous_text
is off (breaks repetition-loop feedback), VAD skips non-speech, plus
compression-ratio / no-speech / silence thresholds.

Each word dict: {"word", "start", "end", "confidence"}. "confidence" is
faster-whisper's word probability (0-1) so the editor can flag shaky words.

generate_caption_lines() groups words into short phrase chunks for on-screen
display. get_low_confidence_words() returns words below a threshold.

Accuracy note: "90%" ~ 10% WER. Measure it on your own footage with `jiwer`
against hand-corrected transcripts; don't assume it. Marathi is noticeably
less accurate than Hindi/English in Whisper, so keep the low-confidence flagging
and let users edit words before burning in.
"""

import os
import re
import subprocess
import tempfile
import threading
from typing import Dict, List, Optional

from faster_whisper import WhisperModel

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

# Per-language model + a short prompt in the target script (prompt only
# influences the first ~30 s window when condition_on_previous_text=False).
# Model names can be overridden with env vars, e.g. WHISPER_MODEL_HI=medium
# if large-v3 is too slow on your CPU. "turbo" needs faster-whisper >= 1.1;
# if it can't load, we fall back to "medium".
LANG_CONFIG = {
    "en": {
        "model": os.getenv("WHISPER_MODEL_EN", "turbo"),
        "prompt": None,
    },
    "hi": {
        "model": os.getenv("WHISPER_MODEL_HI", "large-v3"),
        "prompt": "नमस्ते दोस्तों, आज हम इस वीडियो में बात करेंगे।",
    },
    "mr": {
        "model": os.getenv("WHISPER_MODEL_MR", "large-v3"),
        "prompt": "नमस्कार मित्रांनो, आज आपण या व्हिडिओमध्ये बोलणार आहोत.",
    },
}
DEFAULT_LANGUAGE = "auto"

# Languages written in Devanagari (these support script="roman" via transliteration).
DEVANAGARI_LANGS = {"hi", "mr"}

# Names / brand terms that must come out right, per language.
# Key = Devanagari spelling, value = the Roman spelling you want.
# Edit freely (or load from the project).
GLOSSARY: Dict[str, Dict[str, str]] = {
    "hi": {"धैर्य": "Dhairya"},
    "mr": {"धैर्य": "Dhairya"},
}

# Words with a pause of at least this many seconds before them start a new
# caption line in generate_caption_lines().
_LINE_BREAK_GAP_SECONDS = 0.6
# A caption line is also cut at this many words.
_MAX_WORDS_PER_LINE = 6

_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")  # set to "cuda" if you have a GPU
_COMPUTE_TYPE = "float16" if _DEVICE == "cuda" else "int8"

# Mismatch guard: only flag when the detector is at least this sure the audio
# is a DIFFERENT supported language than the one the user picked.
MISMATCH_MIN_SHARE = 0.7
# Hindi <-> Marathi are easily confused by the detector, so demand more certainty
# before telling the user their choice looks wrong.
MISMATCH_MIN_SHARE_DEVANAGARI = 0.9
# If the average word confidence is below this, hint that the language may be wrong.
LOW_AVG_CONFIDENCE = 0.4


class LanguageMismatchError(Exception):
    """Raised (on_mismatch="raise") when the chosen language doesn't match the audio."""

    def __init__(self, message: str, requested: str, detected: str, share: float):
        super().__init__(message)
        self.requested = requested
        self.detected = detected
        self.share = share


_models: Dict[str, WhisperModel] = {}  # lazy cache, one model per size
# The API runs each job in its own thread, so two projects can ask for the same
# model at once. RLock (not Lock) because the fallback path calls _get_model again.
_model_lock = threading.RLock()
_xlit_engines: Dict[str, object] = {}  # lazy transliteration engines, one per language


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _get_model(size: str) -> WhisperModel:
    with _model_lock:
        if size not in _models:
            try:
                _models[size] = WhisperModel(size, device=_DEVICE, compute_type=_COMPUTE_TYPE)
            except Exception as e:
                if size == "medium":
                    raise
                print(f"  Could not load model '{size}' ({e}); falling back to 'medium'.")
                _models[size] = _get_model("medium")
        return _models[size]


def _prepare_audio(video_path: str) -> str:
    """Extract clean 16 kHz mono WAV from the video. Caller deletes the file."""
    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", video_path,
            "-vn", "-ac", "1", "-ar", "16000",
            "-af", "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11",
            out,
        ],
        check=True,
        capture_output=True,
    )
    return out


def _looks_like_urdu_script(text: str) -> bool:
    """Perso-Arabic characters: a known Whisper quirk on Hindi audio."""
    return any("\u0600" <= ch <= "\u06FF" for ch in text)


def _has_devanagari(text: str) -> bool:
    return any("\u0900" <= ch <= "\u097F" for ch in text)


_PUNCT_RE = re.compile(r"^([^\w\u0900-\u097F]*)(.*?)([^\w\u0900-\u097F]*)$", re.UNICODE)


def _to_roman(word: str, language: str) -> str:
    """
    Devanagari word -> Roman letters for the given language ("hi" or "mr").
    Glossary wins; Latin words pass through.
    Uses ai4bharat-transliteration (pip install ai4bharat-transliteration);
    check its README if the API differs in your installed version.
    If the engine isn't available, the original word is returned unchanged.
    """
    lead, core, trail = _PUNCT_RE.match(word).groups()
    if not core or not _has_devanagari(core):
        return word
    # the danda "।" is punctuation, not part of the word
    core = core.replace("।", "")

    glossary = GLOSSARY.get(language, {})
    if core in glossary:
        return f"{lead}{glossary[core]}{trail}"

    try:
        if language not in _xlit_engines:
            from ai4bharat.transliteration import XlitEngine
            _xlit_engines[language] = XlitEngine(language, beam_width=10, src_script_type="indic")
        roman = _xlit_engines[language].translit_word(core, topk=1)[language][0]
        return f"{lead}{roman}{trail}"
    except Exception:
        return word


def _hotwords_for(language: str, script: str) -> Optional[str]:
    if language == "en":
        # English mode: Roman spellings from every glossary, deduped.
        vals = {v for g in GLOSSARY.values() for v in g.values()}
        return " ".join(sorted(vals)) or None
    glossary = GLOSSARY.get(language)
    if not glossary:
        return None
    # Whisper writes Hindi/Marathi in Devanagari, so bias with Devanagari spellings.
    return " ".join(glossary.keys())


def _detect_language(audio_path: str, candidates=("en", "hi", "mr")) -> tuple:
    """
    Picks between the supported languages only. Samples three 30 s windows
    (~20%, 50%, 80% into the audio) instead of just the start, sums the
    probabilities Whisper assigns to each candidate, and returns the winner.
    Uses a small model: telling English from Hindi/Marathi doesn't need a big one.
    Returns (language, share) where share is the winner's fraction (0-1) of
    the combined candidate probability, i.e. how sure the detector is.
    Note: mixed-language footage gets ONE language (the dominant one), and
    Hindi vs Marathi is the least reliable pair to separate.
    """
    from faster_whisper.audio import decode_audio

    audio = decode_audio(audio_path, sampling_rate=16000)
    win = 30 * 16000
    if len(audio) <= win:
        windows = [audio]
    else:
        windows = []
        for frac in (0.2, 0.5, 0.8):
            start = min(int(len(audio) * frac), len(audio) - win)
            windows.append(audio[start:start + win])

    detector = _get_model("small")
    totals = {c: 0.0 for c in candidates}
    for chunk in windows:
        result = detector.detect_language(chunk)
        all_probs = result[2] if len(result) > 2 else [(result[0], result[1])]
        for lang, prob in all_probs:
            if lang in totals:
                totals[lang] += prob

    best = max(totals, key=totals.get)
    share = totals[best] / (sum(totals.values()) or 1.0)
    print(f"  Language check: {best} ({share:.0%} of {'/'.join(candidates)} probability)")
    return best, share


# --------------------------------------------------------------------------
# Main API
# --------------------------------------------------------------------------

def generate_captions_with_meta(
    video_path: str,
    language: str = DEFAULT_LANGUAGE,
    script: str = "native",
    on_mismatch: str = "warn",
) -> Dict:
    """
    Transcribes the video and returns word-level timestamps:
    [{"word": str, "start": float, "end": float, "confidence": float}, ...]
    Timestamps are relative to the start of the video.

    language: "auto" (detect en / hi / mr from 3 points in the video), "en", "hi" or "mr".
    on_mismatch: what to do when the user-chosen language clearly doesn't match
        the audio (checked BEFORE the slow transcription starts):
        "warn" (default) - continue, report it in the result's warnings
        "raise"          - raise LanguageMismatchError so the UI can ask the user
        "use_detected"   - switch to the detected language and report it

    Returns a dict:
    {"words", "language" (actually used), "requested_language",
     "detected_language", "detect_confidence", "mismatch", "avg_confidence",
     "warnings": [str, ...]}
    script:   "native" (Devanagari for Hindi/Marathi) or "roman" (Hindi/Marathi
              in Roman letters). Ignored for English.
    """
    if language != "auto" and language not in LANG_CONFIG:
        raise ValueError(f"Unsupported language '{language}'. Use 'auto' or one of {list(LANG_CONFIG)}.")
    if script not in ("native", "roman"):
        raise ValueError("script must be 'native' or 'roman'")
    if on_mismatch not in ("warn", "raise", "use_detected"):
        raise ValueError("on_mismatch must be 'warn', 'raise' or 'use_detected'")

    audio_path = _prepare_audio(video_path)
    requested = language
    warnings: List[str] = []
    mismatch = False

    detected, detect_share = None, None
    try:
        detected, detect_share = _detect_language(audio_path)
    except Exception as e:
        if language == "auto":
            os.remove(audio_path)
            raise
        print(f"  (Language check skipped: {e})")

    if language == "auto":
        language = detected
    elif detected and detected != language:
        # Hindi <-> Marathi are easily confused, so require more certainty there.
        needed = (
            MISMATCH_MIN_SHARE_DEVANAGARI
            if {language, detected} <= DEVANAGARI_LANGS
            else MISMATCH_MIN_SHARE
        )
        if detect_share >= needed:
            mismatch = True
            msg = (f"You chose '{language}' but the audio sounds like '{detected}' "
                   f"({detect_share:.0%} sure).")
            if on_mismatch == "raise":
                os.remove(audio_path)
                raise LanguageMismatchError(msg, requested=language, detected=detected, share=detect_share)
            if on_mismatch == "use_detected":
                msg += f" Using '{detected}' instead."
                language = detected
            warnings.append(msg)
            print(f"  WARNING: {msg}")

    cfg = LANG_CONFIG[language]
    model = _get_model(cfg["model"])

    transcribe_kwargs = dict(
        language=language,
        initial_prompt=cfg["prompt"],
        word_timestamps=True,
        beam_size=5,
        condition_on_previous_text=False,   # breaks the repetition-loop feedback cycle
        vad_filter=True,                    # skip non-speech (main hallucination trigger)
        vad_parameters={"min_silence_duration_ms": 500},
        no_speech_threshold=0.6,
        compression_ratio_threshold=2.4,
        hallucination_silence_threshold=2,  # requires word_timestamps=True
    )
    hotwords = _hotwords_for(language, script)
    if hotwords:
        transcribe_kwargs["hotwords"] = hotwords

    try:
        try:
            segments, info = model.transcribe(audio_path, **transcribe_kwargs)
        except TypeError:
            # older faster-whisper without hotwords / hallucination_silence_threshold
            transcribe_kwargs.pop("hotwords", None)
            transcribe_kwargs.pop("hallucination_silence_threshold", None)
            segments, info = model.transcribe(audio_path, **transcribe_kwargs)

        print(f"  Language: {info.language} (forced: {language}, model: {cfg['model']})")

        words: List[Dict] = []
        urdu_script_count = 0
        for segment in segments:
            for w in segment.words:
                raw_text = w.word.strip()
                if not raw_text:
                    continue

                if _looks_like_urdu_script(raw_text):
                    urdu_script_count += 1

                text = raw_text
                if language in DEVANAGARI_LANGS and script == "roman":
                    text = _to_roman(raw_text, language)

                words.append({
                    "word": text,
                    "start": round(w.start, 2),
                    "end": round(w.end, 2),
                    "confidence": round(w.probability, 3),
                })
    finally:
        try:
            os.remove(audio_path)
        except OSError:
            pass

    if urdu_script_count > 0:
        print(f"  WARNING: {urdu_script_count}/{len(words)} words came back in Urdu script "
              f"instead of Devanagari. Whisper sometimes does this on Hindi audio.")

    avg_conf = round(sum(w["confidence"] for w in words) / len(words), 3) if words else None
    if avg_conf is not None and avg_conf < LOW_AVG_CONFIDENCE:
        msg = (f"Average word confidence is very low ({avg_conf}). "
               f"The selected language ('{language}') may be wrong, or the audio is very noisy.")
        warnings.append(msg)
        print(f"  WARNING: {msg}")

    return {
        "words": words,
        "language": language,
        "requested_language": requested,
        "detected_language": detected,
        "detect_confidence": round(detect_share, 2) if detect_share is not None else None,
        "mismatch": mismatch,
        "avg_confidence": avg_conf,
        "warnings": warnings,
    }


def generate_captions(
    video_path: str,
    language: str = DEFAULT_LANGUAGE,
    script: str = "native",
    on_mismatch: str = "warn",
) -> List[Dict]:
    """
    Backwards-compatible wrapper: returns only the flat word list
    [{"word", "start", "end", "confidence"}, ...]. Use
    generate_captions_with_meta() if you also want the mismatch/warning info.
    """
    return generate_captions_with_meta(video_path, language, script, on_mismatch)["words"]


def generate_caption_lines(
    words: List[Dict],
    max_words_per_line: int = _MAX_WORDS_PER_LINE,
    gap_seconds: float = _LINE_BREAK_GAP_SECONDS,
) -> List[Dict]:
    """
    Groups a flat word list into short phrase chunks for on-screen display:
    [{"text": str, "start": float, "end": float, "words": [...]}, ...]

    A new line starts when the pause before the next word is >= gap_seconds,
    or the current line has reached max_words_per_line words.
    """
    if not words:
        return []

    lines: List[Dict] = []
    current: List[Dict] = [words[0]]

    for prev_word, word in zip(words, words[1:]):
        gap = word["start"] - prev_word["end"]
        if gap >= gap_seconds or len(current) >= max_words_per_line:
            lines.append(_words_to_line(current))
            current = [word]
        else:
            current.append(word)

    if current:
        lines.append(_words_to_line(current))

    return lines


def _words_to_line(line_words: List[Dict]) -> Dict:
    return {
        "text": " ".join(w["word"] for w in line_words),
        "start": line_words[0]["start"],
        "end": line_words[-1]["end"],
        "words": line_words,
    }


def get_low_confidence_words(words: List[Dict], threshold: float = 0.6) -> List[Dict]:
    """Words below the confidence threshold, for the UI to flag for review."""
    return [w for w in words if w.get("confidence", 1.0) < threshold]


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python steps/captions.py <path_to_video> [auto|en|hi|mr] [native|roman] [warn|raise|use_detected]")
        sys.exit(1)

    video_path = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_LANGUAGE
    scr = sys.argv[3] if len(sys.argv) > 3 else "native"
    mm = sys.argv[4] if len(sys.argv) > 4 else "warn"
    print(f"Transcribing: {video_path} (language={lang}, script={scr})\n"
          f"(this can take a while on CPU for longer videos)\n")

    try:
        result = generate_captions_with_meta(video_path, language=lang, script=scr, on_mismatch=mm)
    except LanguageMismatchError as e:
        print(f"Stopped: {e}")
        sys.exit(2)
    words = result["words"]
    for w_msg in result["warnings"]:
        print(f"! {w_msg}")
    print(f"{len(words)} words timestamped\n")
    print(" ".join(w["word"] for w in words))

    low_conf = get_low_confidence_words(words)
    if low_conf:
        print(f"\n{len(low_conf)} low-confidence word(s) (<0.6):")
        for w in low_conf:
            print(f"  {w['word']!r} at {w['start']}s (confidence {w['confidence']})")

    lines = generate_caption_lines(words)
    print(f"\nGrouped into {len(lines)} caption line(s):")
    for line in lines:
        print(f"  [{line['start']}-{line['end']}] {line['text']}")

# ---------------------------------------------------------------------------
# Manifest-facing entry point (independently callable pipeline step)
# ---------------------------------------------------------------------------
from steps.project_store import record_step


def run(
    project: dict,
    language: str = DEFAULT_LANGUAGE,
    script: str = "native",
    on_mismatch: str = "warn",
) -> dict:
    result = generate_captions_with_meta(
        project["current_video"], language=language, script=script, on_mismatch=on_mismatch
    )
    meta = {k: v for k, v in result.items() if k != "words"}
    # NOTE: assumes record_step accepts extra keyword fields; if it only takes
    # `words=`, drop caption_meta here and return `meta` to the caller instead.
    return record_step(project, "captions", words=result["words"], caption_meta=meta)