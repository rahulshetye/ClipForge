"""
Project Store
Persists pipeline state (the "manifest") to a JSON file per project, so any
step can be called independently -- each step reads what it needs from this
file and writes its results back into it, instead of receiving them as
in-memory function arguments from a prior step's return value (which is what
main.py's hand-written chain required).
"""

import os
import json
import uuid
from datetime import datetime, timezone
from typing import Dict, Optional

PROJECTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "projects")


class MissingDependencyError(Exception):
    """Raised when a step needs a field the manifest doesn't have yet
    (e.g. 'broll' needs 'words' from the captions step)."""
    def __init__(self, missing: str, step: str = None):
        self.missing = missing
        self.step = step
        msg = f"Missing required data: '{missing}'"
        if step:
            msg += f" (run the '{step}' step first)"
        super().__init__(msg)


def _project_path(project_id: str) -> str:
    return os.path.join(PROJECTS_DIR, project_id, "project.json")


def create_project(source_video: str) -> Dict:
    project_id = str(uuid.uuid4())
    os.makedirs(os.path.join(PROJECTS_DIR, project_id, "output"), exist_ok=True)
    project = {
        "project_id": project_id,
        "source_video": source_video,
        "current_video": source_video,
        "applied_steps": [],
        "history": [],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    return save_project(project)


def load_project(project_id: str) -> Dict:
    path = _project_path(project_id)
    if not os.path.exists(path):
        raise FileNotFoundError(f"No project found with id '{project_id}'")
    with open(path, "r") as f:
        return json.load(f)


def save_project(project: Dict) -> Dict:
    project["updated_at"] = datetime.now(timezone.utc).isoformat()
    project_dir = os.path.join(PROJECTS_DIR, project["project_id"])
    os.makedirs(project_dir, exist_ok=True)
    with open(_project_path(project["project_id"]), "w") as f:
        json.dump(project, f, indent=2)
    return project


def project_output_dir(project: Dict) -> str:
    d = os.path.join(PROJECTS_DIR, project["project_id"], "output")
    os.makedirs(d, exist_ok=True)
    return d


def require(project: Dict, key: str, step: str = None):
    """Raise MissingDependencyError if `key` isn't present/populated yet."""
    if key not in project or project[key] in (None, [], {}):
        raise MissingDependencyError(key, step)


def record_step(project: Dict, step_name: str, new_video: Optional[str] = None, **fields) -> Dict:
    """Common bookkeeping every step's run() calls at the end: merge in
    whatever data the step produced, bump current_video + history if this
    step rendered a new file, log it to applied_steps, and persist."""
    project.update(fields)
    if new_video:
        project["history"].append({"step": step_name, "output": new_video})
        project["current_video"] = new_video
    if step_name not in project["applied_steps"]:
        project["applied_steps"].append(step_name)
    return save_project(project)
