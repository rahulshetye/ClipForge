"""
Shared Gemini client helper with automatic key fallback.

Google's free tier caps at a low daily request quota per account/project.
Rather than manually swapping GEMINI_API_KEY in .env when it runs out, this
tries the primary key first and automatically falls back to a second key
(GEMINI_API_KEY_TWO, from a separate Google account) if the primary hits a
quota-exhausted (429 RESOURCE_EXHAUSTED) error.

Callers can optionally pass a different model for the fallback key via
`fallback_model` -- e.g. primary key on gemini-2.5-flash, fallback key on
gemini-3.5-flash. If `fallback_model` isn't given, the fallback call reuses
the same `model` as the primary attempt.

Used by both script_gen.py and visuals.py so there's one place that knows
about key fallback instead of duplicating this logic per file.
"""

import os
from google import genai
from google.genai import errors as genai_errors

_clients = {}  # cached per API key, so we don't recreate a Client on every call


def _get_client(api_key: str) -> genai.Client:
    if api_key not in _clients:
        _clients[api_key] = genai.Client(api_key=api_key)
    return _clients[api_key]


def _is_quota_error(exc: Exception) -> bool:
    return isinstance(exc, genai_errors.ClientError) and "RESOURCE_EXHAUSTED" in str(exc)


def generate_content_with_fallback(*, model: str, fallback_model: str = None, **kwargs):
    """
    Tries GEMINI_API_KEY first using `model`. On a quota-exhausted error,
    retries with GEMINI_API_KEY_TWO (if set) using `fallback_model` (falls
    back to reusing `model` if `fallback_model` isn't given). Raises the
    original error if both keys fail, or if only one key is configured and
    it fails.
    """
    primary_key = os.getenv("GEMINI_API_KEY")
    fallback_key = os.getenv("GEMINI_API_KEY_TWO")

    if not primary_key:
        raise RuntimeError("GEMINI_API_KEY not set.")

    try:
        client = _get_client(primary_key)
        return client.models.generate_content(model=model, **kwargs)
    except Exception as e:
        if fallback_key and _is_quota_error(e):
            use_model = fallback_model or model
            print(f"    [gemini_client] Primary key quota exhausted -- retrying with GEMINI_API_KEY_TWO ({use_model})")
            client = _get_client(fallback_key)
            return client.models.generate_content(model=use_model, **kwargs)
        raise