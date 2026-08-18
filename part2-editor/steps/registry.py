"""
Step Registry
Maps step name -> its run(project) function, and defines the default
priority order used by run_all() / the API's /run-all route / main.py.

Adding a new step to the pipeline = write its run(project) function, import
it here, add one line to STEP_ORDER + STEP_REGISTRY. Nothing else changes.

Priority order (P0 = foundational, P3 = polish -- see project notes):
  P0  trim, captions        -- everything else needs these
  P1  subtitle_styles, broll -- core paid differentiators
  P2  music_selection, transitions
  P3  sound_effects, stickers

Note: assembly.py is deprecated/unused here -- its pad-to-vertical +
broll-overlay compositing was absorbed into broll.render_broll_overlay(),
and its caption burn-in is superseded by subtitle_styles.py's "default"
style. If you skip the broll step entirely, current_video never gets
padded to 1080x1920 -- flag if you want a standalone "normalize" step
broken out instead of bundling padding into broll.
"""

from steps import trim, captions, subtitle_styles, broll, music_selection, transitions, sound_effects, stickers

STEP_ORDER = [
    "trim",
    "transitions",
    "captions",
    "subtitle_styles",
    "broll",
    "music_selection",
    "sound_effects",
    "stickers",
]

STEP_REGISTRY = {
    "trim": trim.run,
    "captions": captions.run,
    "subtitle_styles": subtitle_styles.run,
    "broll": broll.run,
    "music_selection": music_selection.run,
    "transitions": transitions.run,
    "sound_effects": sound_effects.run,
    "stickers": stickers.run,
}


def run_step(step_name: str, project: dict, **kwargs) -> dict:
    if step_name not in STEP_REGISTRY:
        raise ValueError(f"Unknown step '{step_name}'. Valid steps: {list(STEP_REGISTRY)}")
    return STEP_REGISTRY[step_name](project, **kwargs)


def run_all(project: dict, steps: list = None, step_params: dict = None) -> dict:
    """
    Runs the given steps (default: full STEP_ORDER) in priority order
    against the same project manifest, persisting after each one.

    step_params: optional {step_name: {kwarg: value, ...}} -- lets a caller
    pass per-step options (e.g. {"subtitle_styles": {"style": "boxed",
    "font_name": "modern"}}) without every step needing to accept every
    other step's kwargs. A step with no entry in step_params just runs with
    its own defaults, same as before this param existed.
    """
    step_params = step_params or {}
    for step_name in (steps or STEP_ORDER):
        kwargs = step_params.get(step_name, {})
        project = run_step(step_name, project, **kwargs)
    return project