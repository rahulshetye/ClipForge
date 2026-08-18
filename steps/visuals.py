"""
Step 3: Visual Sourcing (v5 -- batched scoring, stock-only fallback, no AI image gen)

IMPORTANT QUOTA CONSTRAINT: Google's gemini free tier caps at a low number of
requests/day per API key (a hard daily ceiling on your Google account, not
something adjustable in code). Batched scoring keeps each scene down to
1-3 Gemini calls total, so a full 5-scene video uses roughly 6-16 calls
instead of 100+.

Pipeline per scene:
  1. Search Pexels (single most-specific query, not multiple variants up front)
  2. Send up to 3 candidate thumbnails in ONE Gemini call -> best index + confidence
  3. If confidence < threshold, try Pixabay the same way (1 more batched call)
  4. If still below threshold, retry with a broader query as a genuine last
     resort: take the top-ranked candidate from that broader search
     regardless of threshold (a real stock clip that's an imperfect match
     beats nothing). There is no generative image fallback -- if both
     sources come back empty even on the broad query, the scene is left
     without a visual and downstream steps must handle that.

Each Gemini call tries GEMINI_API_KEY first with GEMINI_MODEL_PRIMARY
(gemini-2.5-flash), and automatically retries on quota exhaustion with
GEMINI_API_KEY_TWO using GEMINI_MODEL_FALLBACK (gemini-3.5-flash) -- see
steps/gemini_client.py.
"""


import os
import re
import requests
from typing import List, Dict, Optional
from google.genai import types
from dotenv import load_dotenv
import shutil


from steps.gemini_client import generate_content_with_fallback

load_dotenv()

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output", "visuals")

PEXELS_API_URL = "https://api.pexels.com/videos/search"
PIXABAY_API_URL = "https://pixabay.com/api/videos/"
CANDIDATES_PER_BATCH = 3  # keep small -- more candidates = bigger request, but still ONE call
CONFIDENCE_THRESHOLD = 0.70  # slightly relaxed since we're now picking the BEST of a small batch

# Primary key uses 2.5, fallback key (on quota exhaustion) uses 3.5.
GEMINI_MODEL_PRIMARY = "gemini-2.5-flash"
GEMINI_MODEL_FALLBACK = "gemini-3.5-flash"

TARGET_W, TARGET_H = 1080, 1920


# ---------- Query generation ----------

def _build_query_variants(keywords: List[str]) -> List[str]:
    """Most specific first, broadest last -- only used if the first attempt fails."""
    full = " ".join(keywords)[:100]
    variants = [full] if full else []
    if keywords and keywords[0] not in variants:
        variants.append(keywords[0])
    return variants or ["abstract background"]


# ---------- Search ----------

def _search_pexels_candidates(query: str, api_key: str) -> List[Dict]:
    try:
        resp = requests.get(
            PEXELS_API_URL,
            headers={"Authorization": api_key},
            params={"query": query, "orientation": "portrait", "per_page": CANDIDATES_PER_BATCH},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException:
        return []

    candidates = []
    for video in data.get("videos", []):
        files = sorted(video.get("video_files", []), key=lambda f: f.get("width", 0))
        video_url = next((f["link"] for f in files if f.get("width", 0) >= 720), None)
        video_url = video_url or (files[-1]["link"] if files else None)
        if video_url:
            candidates.append({"video_url": video_url, "thumbnail_url": video.get("image")})
    return candidates


def _search_pixabay_candidates(query: str, api_key: str) -> List[Dict]:
    try:
        resp = requests.get(
            PIXABAY_API_URL,
            params={"key": api_key, "q": query, "per_page": CANDIDATES_PER_BATCH},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException:
        return []

    candidates = []
    for hit in data.get("hits", []):
        videos = hit.get("videos", {})
        video_url = videos.get("medium", {}).get("url") or videos.get("small", {}).get("url")
        thumbnail_url = hit.get("userImageURL") or hit.get("previewURL")
        if video_url:
            candidates.append({"video_url": video_url, "thumbnail_url": thumbnail_url})
    return candidates


# ---------- Batched confidence scoring (ONE Gemini call scores ALL candidates) ----------

def _score_candidates_batch(
    candidates: List[Dict], scene_text: str, keywords: List[str]
) -> Optional[Dict]:
    """
    Sends all candidate thumbnails in a SINGLE Gemini call. Returns the best
    candidate dict (with a 'confidence' key added) if its score clears the
    threshold, else None.
    """
    if not candidates:
        return None

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {**candidates[0], "confidence": 1.0}  # no key -- can't validate, don't block

    images_content = []
    valid_candidates = []
    for c in candidates:
        if not c.get("thumbnail_url"):
            continue
        try:
            img_resp = requests.get(c["thumbnail_url"], timeout=10)
            img_resp.raise_for_status()
            images_content.append(types.Part.from_bytes(data=img_resp.content, mime_type="image/jpeg"))
            valid_candidates.append(c)
        except requests.RequestException:
            continue

    if not valid_candidates:
        return None

    prompt_text = (
        f"Scene narration: \"{scene_text}\"\nSearch keywords used: {keywords}\n\n"
        f"You are shown {len(valid_candidates)} candidate images, in order (image 1, image 2, ...). "
        f"Pick the ONE that best matches the scene's narration/keywords, and rate how well it "
        f"matches on a scale of 0.0 to 1.0.\n"
        f"Respond in EXACTLY this format, nothing else:\nINDEX: <number starting from 1>\nSCORE: <0.0-1.0>"
    )

    try:
        response = generate_content_with_fallback(
            model=GEMINI_MODEL_PRIMARY,
            fallback_model=GEMINI_MODEL_FALLBACK,
            contents=[*images_content, prompt_text],
        )
        text = response.text or ""
        index_match = re.search(r"INDEX:\s*(\d+)", text)
        score_match = re.search(r"SCORE:\s*([\d.]+)", text)

        if not index_match or not score_match:
            return None

        idx = int(index_match.group(1)) - 1
        score = max(0.0, min(1.0, float(score_match.group(1))))

        if 0 <= idx < len(valid_candidates) and score >= CONFIDENCE_THRESHOLD:
            return {**valid_candidates[idx], "confidence": score}
        return None
    except Exception as e:
        print(f"    Batch scoring failed: {e}")
        return None


def _pick_best_effort(
    candidates: List[Dict], scene_text: str, keywords: List[str]
) -> Optional[Dict]:
    """
    Like _score_candidates_batch, but ignores CONFIDENCE_THRESHOLD -- always
    returns the top-ranked candidate Gemini picks (or the first candidate if
    scoring is unavailable/fails). This is the genuine last resort: a real
    stock clip, even an imperfect match, beats having no visual at all.
    """
    if not candidates:
        return None

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {**candidates[0], "confidence": None}

    images_content = []
    valid_candidates = []
    for c in candidates:
        if not c.get("thumbnail_url"):
            continue
        try:
            img_resp = requests.get(c["thumbnail_url"], timeout=10)
            img_resp.raise_for_status()
            images_content.append(types.Part.from_bytes(data=img_resp.content, mime_type="image/jpeg"))
            valid_candidates.append(c)
        except requests.RequestException:
            continue

    if not valid_candidates:
        return None

    prompt_text = (
        f"Scene narration: \"{scene_text}\"\nSearch keywords used: {keywords}\n\n"
        f"You are shown {len(valid_candidates)} candidate images, in order (image 1, image 2, ...). "
        f"Even if none are a great match, pick the SINGLE best one relative to the others, and rate how "
        f"well it matches on a scale of 0.0 to 1.0.\n"
        f"Respond in EXACTLY this format, nothing else:\nINDEX: <number starting from 1>\nSCORE: <0.0-1.0>"
    )

    try:
        response = generate_content_with_fallback(
            model=GEMINI_MODEL_PRIMARY,
            fallback_model=GEMINI_MODEL_FALLBACK,
            contents=[*images_content, prompt_text],
        )
        text = response.text or ""
        index_match = re.search(r"INDEX:\s*(\d+)", text)
        score_match = re.search(r"SCORE:\s*([\d.]+)", text)

        if not index_match:
            return {**valid_candidates[0], "confidence": None}

        idx = int(index_match.group(1)) - 1
        score = max(0.0, min(1.0, float(score_match.group(1)))) if score_match else None

        if 0 <= idx < len(valid_candidates):
            return {**valid_candidates[idx], "confidence": score}
        return {**valid_candidates[0], "confidence": None}
    except Exception as e:
        print(f"    Best-effort scoring failed: {e}")
        return {**valid_candidates[0], "confidence": None}


# ---------- Download ----------

def _download(url: str, out_path: str) -> None:
    resp = requests.get(url, stream=True, timeout=30)
    resp.raise_for_status()
    with open(out_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)


# ---------- Main entry point ----------

def fetch_visuals(scenes: List[Dict]) -> List[Dict]:
    """
    Takes scenes (each with 'keywords', 'text', and ideally 'actual_duration').
    Returns the same list with each scene extended with:
        - visual_path: local path to the downloaded stock video, or None if
          neither Pexels nor Pixabay returned anything usable
        - visual_source: "pexels" | "pixabay" | None
    Budget per scene: ~1-3 Gemini calls.
    """
    pexels_key = os.getenv("PEXELS_API_KEY")
    pixabay_key = os.getenv("PIXABAY_API_KEY")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    results = []
    for i, scene in enumerate(scenes):
        keywords = scene.get("keywords", [])
        scene_text = scene.get("text", "")
        query_variants = _build_query_variants(keywords)

        chosen, source = None, None

        # Try the specific query first; only try the broader variant if the specific one fails
        for query in query_variants:
            if chosen:
                break

            if pexels_key:
                candidates = _search_pexels_candidates(query, pexels_key)
                best = _score_candidates_batch(candidates, scene_text, keywords)
                if best:
                    chosen, source = best, "pexels"
                    break

            if pixabay_key:
                candidates = _search_pixabay_candidates(query, pixabay_key)
                best = _score_candidates_batch(candidates, scene_text, keywords)
                if best:
                    chosen, source = best, "pixabay"
                    break

        # Nothing cleared the confidence threshold -- genuine last resort:
        # search the broadest query variant and just take the top-ranked
        # candidate, threshold or not. A real stock clip that's an imperfect
        # match beats having no visual at all.
        if not chosen:
            broadest_query = query_variants[-1]

            if pexels_key:
                candidates = _search_pexels_candidates(broadest_query, pexels_key)
                best = _pick_best_effort(candidates, scene_text, keywords)
                if best:
                    chosen, source = best, "pexels"

            if not chosen and pixabay_key:
                candidates = _search_pixabay_candidates(broadest_query, pixabay_key)
                best = _pick_best_effort(candidates, scene_text, keywords)
                if best:
                    chosen, source = best, "pixabay"

        out_path = os.path.join(OUTPUT_DIR, f"scene_{i:02d}.mp4")

        if chosen:
            try:
                _download(chosen["video_url"], out_path)
            except requests.RequestException as e:
                print(f"  Scene {i}: download failed ({e})")
                chosen = None
                out_path = None
                source = None

        if not chosen:
            print(f"  Scene {i}: no stock footage found at all (both sources empty/failed)")
            out_path = None
            source = None

        if chosen and chosen.get("confidence") is not None:
            confidence_note = f" (confidence: {chosen['confidence']:.2f})"
        else:
            confidence_note = ""
        print(f"  Scene {i}: keywords={keywords} -> {source or 'FAILED'}{confidence_note}")
        results.append({**scene, "visual_path": out_path, "visual_source": source})

    return results


if __name__ == "__main__":
    test_scenes = [
        {"text": "Think Hello Kitty is a cat? She's not!", "keywords": ["pink bow ribbon", "cute kawaii accessory"], "actual_duration": 5},
        {"text": "A person types quickly at their laptop", "keywords": ["person typing laptop"], "actual_duration": 4},
    ]

    print("Fetching visuals (batched scoring, stock-only fallback)...")
    result = fetch_visuals(test_scenes)
    for r in result:
        print(r["visual_path"], r["visual_source"])