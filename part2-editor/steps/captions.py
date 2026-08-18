"""
Step 3: Caption Generation (Part 2 - Editor)
Trimmed video file -> word-level timestamps for the whole video.

Same approach as Part 1's captions.py (faster-whisper, local, free, no API key),
but adapted for ONE continuous video instead of per-scene TTS clips.

Important difference from Part 1: this is REAL speech, not clean TTS audio --
expect background noise, filler words, accented speech, and mumbling to produce
more transcription errors here. That's expected, not a bug. If accuracy is too
low on your footage, bump MODEL_SIZE up further (e.g. "medium" -> "large-v3").

Auto-detects the spoken language instead of assuming Hindi. If the detected
speech comes back in Devanagari script (Hindi), each word is transliterated to
Roman-script Hinglish. English (or any other Latin-script speech) passes through
unchanged. This makes the same function work on both your Hindi and English
test videos without manual toggling.

Hallucination mitigation: Whisper can get stuck in repetition loops on real-world
audio (repeating the same phrase over and over) because by default it conditions
each new prediction on its own previous output -- if it goes wrong once, errors
compound. We disable that (condition_on_previous_text=False) and add VAD
(voice activity detection) filtering to skip non-speech segments, which are the
main trigger for these loops.

faster-whisper can read audio directly out of a video file (via ffmpeg under
the hood), so no separate audio-extraction step is needed.
"""

from typing import List, Dict, Optional
from faster_whisper import WhisperModel
from indic_transliteration import sanscript
from indic_transliteration.sanscript import transliterate

MODEL_SIZE = "medium"  # Hindi ASR benefits noticeably from bigger models; "small" was
                        # still hallucinating/repeating on real-world audio. Slower on CPU
                        # but far more reliable. Try "large-v3" if this still struggles.

_model = None  # lazy singleton, load once and reuse


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    return _model


def _contains_devanagari(text: str) -> bool:
    """Devanagari Unicode block is U+0900-U+097F."""
    return any("\u0900" <= ch <= "\u097F" for ch in text)


def _to_hinglish(devanagari_text: str) -> str:
    """Converts Devanagari text to lowercase Roman-script Hinglish."""
    # Devanagari sentence-ending punctuation (danda) transliterates to a stray "|" -- normalize first
    cleaned = devanagari_text.replace("।", ".").replace("॥", ".")
    romanized = transliterate(cleaned, sanscript.DEVANAGARI, sanscript.ITRANS)
    return romanized.lower()


def _looks_like_urdu_script(text: str) -> bool:
    """Detects Perso-Arabic (Urdu) script characters -- a known Whisper quirk where it
    sometimes transcribes Hindi audio using Urdu script instead of Devanagari."""
    return any("\u0600" <= ch <= "\u06FF" for ch in text)


def generate_captions(video_path: str, language: Optional[str] = None) -> List[Dict]:
    """
    Transcribes the given video file and returns word-level timestamps:
    [{"word": str, "start": float, "end": float}, ...]
    Timestamps are relative to the start of the video.

    language: ISO 639-1 code (e.g. "hi", "en") to force a specific language.
    Leave as None (default) to auto-detect from the audio itself. Hindi/Devanagari
    output gets transliterated to Hinglish automatically; other languages (e.g.
    English) pass through unchanged.
    """
    model = _get_model()
    segments, info = model.transcribe(
        video_path,
        word_timestamps=True,
        language=language,
        condition_on_previous_text=False,  # breaks the repetition-loop feedback cycle
        vad_filter=True,                    # skip non-speech segments (main hallucination trigger)
        vad_parameters={"min_silence_duration_ms": 500},
    )

    print(f"  Detected language: {info.language} (confidence: {info.language_probability:.2f})")

    words = []
    urdu_script_count = 0
    for segment in segments:
        for w in segment.words:
            raw_text = w.word.strip()

            if _looks_like_urdu_script(raw_text):
                urdu_script_count += 1
                final_text = raw_text  # can't transliterate Urdu script with this library
            elif _contains_devanagari(raw_text):
                try:
                    final_text = _to_hinglish(raw_text)
                except Exception:
                    final_text = raw_text
            else:
                final_text = raw_text  # English (or already-Latin-script) -- pass through as-is

            words.append({
                "word": final_text,
                "start": round(w.start, 2),
                "end": round(w.end, 2),
            })

    if urdu_script_count > 0:
        print(f"  WARNING: {urdu_script_count}/{len(words)} words came back in Urdu script, "
              f"not Devanagari -- transliteration was skipped for those and they'll look garbled.")

    return words


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python steps/captions.py <path_to_video>")
        sys.exit(1)

    video_path = sys.argv[1]
    print(f"Transcribing: {video_path}\n(this can take a while on CPU for longer videos)\n")

    words = generate_captions(video_path)
    print(f"{len(words)} words timestamped\n")
    print(" ".join(w["word"] for w in words))

# ---------------------------------------------------------------------------
# Manifest-facing entry point (independently callable pipeline step)
# ---------------------------------------------------------------------------
from steps.project_store import record_step


def run(project: dict) -> dict:
    words = generate_captions(project["current_video"])
    return record_step(project, "captions", words=words)
