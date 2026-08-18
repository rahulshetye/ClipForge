"""
Step 1: Script Generation
Prompt (string) -> Scene JSON (dict)

Uses Gemini's structured output mode (response_schema) so we get back
guaranteed valid JSON -- no markdown fences, no preamble text to strip.
"""

import os
from typing import List
from pydantic import BaseModel, Field
from google.genai import types
from dotenv import load_dotenv

from steps.gemini_client import generate_content_with_fallback

load_dotenv()

MODEL = "gemini-3.5-flash"  # free tier, fast, plenty for scriptwriting


class Scene(BaseModel):
    text: str = Field(description="Narration text for this scene, 1-2 short sentences max")
    keywords: List[str] = Field(description="2-4 concrete visual search terms for stock footage/images matching this scene")
    estimated_duration: int = Field(description="Estimated seconds to narrate this scene's text aloud, typically 3-7")


class Script(BaseModel):
    title: str = Field(description="Short catchy title for the video")
    scenes: List[Scene]


SYSTEM_INSTRUCTION = """You are a short-form video scriptwriter (YouTube Shorts / Instagram Reels / TikTok style).

Given a topic or prompt, break it into 4-6 scenes for a punchy, fast-paced short video (target total length: 30-60 seconds).

Rules:
- Each scene's narration text must be 1-2 short sentences, written to be spoken aloud naturally (no stage directions, no emojis).
- Each scene needs 2-4 concrete, visual, stock-footage-searchable keywords.
- CRITICAL: keywords will be used to search REAL-WORLD stock footage libraries (Pexels/Pixabay).
  They can NEVER depict copyrighted characters, cartoons, brands, or fictional beings -- no stock
  footage library has real footage of e.g. "Hello Kitty" or "Mickey Mouse". Instead, translate the
  topic into GENERIC, PHOTOGRAPHABLE real-world equivalents that fit the theme:
  e.g. for a scene about Hello Kitty's bow, use keywords like "pink bow ribbon", "cute pink accessory" --
  NOT "Hello Kitty bow" or "Hello Kitty cartoon". For a scene about a fictional city, use keywords like
  "cityscape skyline" or "urban street" -- not the fictional city's name.
- estimated_duration should be a realistic spoken-word estimate (~2-3 words per second of narration).
- Keep total scenes tight -- no filler, no repeated ideas.
- Do not include intro/outro disclaimers or calls to subscribe unless the prompt asks for it.
"""


def generate_script(prompt: str) -> dict:
    """
    Takes a topic/prompt string, returns a dict matching the Script schema:
    {
        "title": str,
        "scenes": [
            {"text": str, "keywords": [str, ...], "estimated_duration": int},
            ...
        ]
    }
    Raises RuntimeError if the API call fails or returns unparseable content.
    """
    if not os.getenv("GEMINI_API_KEY"):
        raise RuntimeError("GEMINI_API_KEY not set. Copy .env.example to .env and add your key.")

    try:
        response = generate_content_with_fallback(
            model=MODEL,
            contents=f"Create a short video script for this topic: {prompt}",
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                response_mime_type="application/json",
                response_schema=Script,
                temperature=0.8,
            ),
        )
    except Exception as e:
        raise RuntimeError(f"Gemini API call failed: {e}") from e

    script: Script = response.parsed
    if script is None:
        raise RuntimeError(f"Gemini did not return parseable JSON. Raw text: {response.text}")

    return script.model_dump()


if __name__ == "__main__":
    test_prompts = [
        "3 tips to stay productive while working from home",
        "the history of the internet in 60 seconds",
    ]

    for p in test_prompts:
        print(f"\n{'='*60}\nPROMPT: {p}\n{'='*60}")
        result = generate_script(p)
        print(f"Title: {result['title']}")
        for i, scene in enumerate(result["scenes"], 1):
            print(f"\nScene {i} (~{scene['estimated_duration']}s):")
            print(f"  Text: {scene['text']}")
            print(f"  Keywords: {scene['keywords']}")