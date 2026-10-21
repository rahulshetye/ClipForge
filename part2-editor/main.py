"""
Part 2 orchestrator -- CLI entry point over the manifest-driven pipeline.
Creates a project from the given video, then runs steps against it (either
the full default order, or just the ones you name) via steps/registry.py.
Each step is independently re-runnable through the same registry from
app.py's API routes -- this script just runs them sequentially for CLI use.

Usage:
    python main.py output/trimmed.mp4
    python main.py output/trimmed.mp4 --steps captions,broll,subtitle_styles
    python main.py output/trimmed.mp4 --steps subtitle_styles --subtitle-style boxed --subtitle-font modern
    python main.py output/trimmed.mp4 --steps subtitle_styles --subtitle-preset studio

--subtitle-preset picks one of subtitle_styles.STYLE_PRESETS (font + colors +
emphasis + transition bundled together, e.g. "studio", "editorial", "impact",
"kinetic"). If given, it wins over --subtitle-style/--subtitle-font for that
run -- same precedence as subtitle_styles.run()'s preset_name argument.
--subtitle-style/--subtitle-font still work on their own exactly as before.
"""

import sys
from steps.project_store import create_project
from steps.registry import run_all, STEP_ORDER
from steps.subtitle_styles import STYLE_PRESETS


def run(video_path: str, steps: list = None, step_params: dict = None):
    project = create_project(video_path)
    print(f"Created project {project['project_id']} from: {video_path}")

    project = run_all(project, steps=steps, step_params=step_params)

    print(f"\nDone! Final video: {project['current_video']}")
    print(f"Steps applied: {project['applied_steps']}")
    return project


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(
            "Usage: python main.py <path_to_trimmed_video> [--steps step1,step2,...] "
            "[--subtitle-style default|boxed|highlight] [--subtitle-font FONT_PRESET] "
            "[--subtitle-preset PRESET_NAME]"
        )
        print(f"Available steps: {STEP_ORDER}")
        print(f"Available subtitle presets: {list(STYLE_PRESETS.keys())}")
        sys.exit(1)

    video_path = sys.argv[1]
    args = sys.argv[2:]

    steps = None
    if "--steps" in args:
        idx = args.index("--steps")
        steps = args[idx + 1].split(",")

    # Only subtitle_styles gets CLI-level param support for now -- extend
    # this pattern (another --foo-bar flag + step_params entry) if other
    # steps need the same treatment later.
    step_params = {}
    if "--subtitle-style" in args:
        idx = args.index("--subtitle-style")
        step_params.setdefault("subtitle_styles", {})["style"] = args[idx + 1]
    if "--subtitle-font" in args:
        idx = args.index("--subtitle-font")
        step_params.setdefault("subtitle_styles", {})["font_name"] = args[idx + 1]
    if "--subtitle-preset" in args:
        idx = args.index("--subtitle-preset")
        preset_name = args[idx + 1]
        if preset_name not in STYLE_PRESETS:
            print(f"Unknown preset '{preset_name}'. Choose from: {list(STYLE_PRESETS.keys())}")
            sys.exit(1)
        step_params.setdefault("subtitle_styles", {})["preset_name"] = preset_name

    run(video_path, steps=steps, step_params=step_params or None)