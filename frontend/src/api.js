import { auth } from './firebase.js';

// Base URLs for the backend services.
const PART1_URL = import.meta.env.VITE_PART1_URL || "http://localhost:8001";
const PART2_URL = import.meta.env.VITE_PART2_URL || "http://localhost:8002";
const PART3_URL = import.meta.env.VITE_PART3_URL || "http://localhost:3001";
const IMAGE_SERVICE_URL = import.meta.env.VITE_IMAGE_SERVICE_URL || "http://localhost:8003";
export { PART3_URL };

/**
 * Gets a fresh Firebase ID token for the current user and returns it as an
 * Authorization header. Every authenticated request across all 4 backends
 * goes through this -- backends verify the token via Firebase Admin SDK
 * before trusting the uid inside it, rather than trusting a uid the client
 * claims directly (which anyone could spoof by just editing a request).
 *
 * getIdToken() automatically refreshes the token if it's expired/near
 * expiry, so callers don't need to think about token lifetime themselves.
 */
async function getAuthHeaders() {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Not signed in.");
  }
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

async function handleResponse(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || body.detail || `Request failed (${response.status})`);
  }
  return response.json();
}

async function pollJob(baseUrl, jobId, onProgress, { intervalMs = 3000, maxAttempts = 200 } = {}) {
  const headers = await getAuthHeaders();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`${baseUrl}/jobs/${jobId}`, { headers });
    const job = await handleResponse(response);
    onProgress?.(job);

    if (job.status === "done" || job.status === "failed") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for job to complete.");
}

async function pollProject(baseUrl, projectId, onProgress, { intervalMs = 3000, maxAttempts = 200 } = {}) {
  const headers = await getAuthHeaders();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`${baseUrl}/projects/${projectId}`, { headers });
    const project = await handleResponse(response);
    onProgress?.(project);

    if (project.status === "done" || project.status === "failed") {
      return project;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for project to finish processing.");
}

export const part1 = {
  /**
   * captionStyle: one of "default" | "boxed" | "highlight" (mirrors backend
   * steps/captions.py's STYLES). Defaults to "default" if not passed.
   * voice: one of steps/voiceover.py's VOICE_OPTIONS (real edge-tts voice
   * IDs, e.g. "en-US-AndrewNeural"). Defaults to the backend's DEFAULT_VOICE
   * if not passed -- kept as a literal string here since api.js doesn't
   * import backend constants; must match steps/voiceover.py's DEFAULT_VOICE.
   */
  async generate(prompt, captionStyle = 'default', voice = 'en-US-AndrewNeural') {
    const headers = await getAuthHeaders();
    const response = await fetch(`${PART1_URL}/generate`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, captionStyle, voice }),
    });
    return handleResponse(response);
  },

  /**
   * Lists the current user's past video generation jobs (GET /jobs), so the
   * Generator screen can repopulate its results grid after a page reload
   * instead of showing an empty list. Backend response shape may be a bare
   * array or { jobs: [...] } -- this normalizes either to a plain array.
   */
  async listJobs() {
    const headers = await getAuthHeaders();
    const response = await fetch(`${PART1_URL}/jobs`, { headers });
    const data = await handleResponse(response);
    return Array.isArray(data) ? data : data.jobs || [];
  },

  pollJob: (jobId, onProgress) => pollJob(PART1_URL, jobId, onProgress),
};

export const part2 = {
  async createProject(file) {
    const headers = await getAuthHeaders();
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch(`${PART2_URL}/projects`, { method: "POST", headers, body: formData });
    return handleResponse(response);
  },
  async runStep(projectId, stepName) {
    const headers = await getAuthHeaders();
    const response = await fetch(`${PART2_URL}/projects/${projectId}/steps/${stepName}`, { method: "POST", headers });
    return handleResponse(response);
  },

  /**
   * steps: array of step names (defaults to the full backend STEP_ORDER if
   * omitted). stepParams: optional { stepName: { kwarg: value, ... } } --
   * e.g. { subtitle_styles: { style: "boxed", fontName: "modern" } } --
   * forwarded to registry.run_all's matching step_params param. Moved from
   * query-string-only to a JSON body since stepParams is a nested object
   * that doesn't serialize cleanly into a query string.
   */
  async runAll(projectId, steps, stepParams) {
    const headers = await getAuthHeaders();
    const response = await fetch(`${PART2_URL}/projects/${projectId}/run-all`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ steps, stepParams }),
    });
    return handleResponse(response);
  },
  async getProject(projectId) {
    const headers = await getAuthHeaders();
    const response = await fetch(`${PART2_URL}/projects/${projectId}`, { headers });
    return handleResponse(response);
  },

  /**
   * Lists the current user's past projects (GET /projects), backed by the
   * lightweight Firestore index at users/{uid}/projects/{project_id}
   * (projectId, createdAt, filename only -- NOT videoUrl/status). Use
   * getProject(id) to load full detail for a specific project from this list.
   */
  async listProjects() {
    const headers = await getAuthHeaders();
    const response = await fetch(`${PART2_URL}/projects`, { headers });
    const data = await handleResponse(response);
    return Array.isArray(data) ? data : data.projects || [];
  },

  pollProject: (projectId, onProgress) => pollProject(PART2_URL, projectId, onProgress),
};

export const part3 = {
  async publish(platform, payload) {
    const headers = await getAuthHeaders();
    const response = await fetch(`${PART3_URL}/publish/${platform}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return handleResponse(response);
  },

  /**
   * Lists the current user's full publish history across every platform
   * (GET /publishes), backed by users/{uid}/publishes/{publish_id}. Each
   * record already carries platform, status, payload (incl. videoPath),
   * result, and error -- this is the single source of truth for "which
   * video got published where", straight from Firestore rather than
   * relying on in-memory state from the current session.
   */
  async listPublishes() {
    const headers = await getAuthHeaders();
    const response = await fetch(`${PART3_URL}/publishes`, { headers });
    const data = await handleResponse(response);
    return Array.isArray(data) ? data : data.publishes || [];
  },

  /**
   * A single publish record by id (GET /publishes/:publishId), scoped to
   * the requesting user. Useful for re-checking one record's latest status
   * without re-fetching the whole history.
   */
  async getPublish(publishId) {
    const headers = await getAuthHeaders();
    const response = await fetch(`${PART3_URL}/publishes/${publishId}`, { headers });
    return handleResponse(response);
  },

  /**
   * Polls a single publish record until it leaves the "publishing" state.
   * server.js writes the record as status: "publishing" before the platform
   * call even starts, then flips it to "done"/"failed" once that call
   * resolves -- this just watches for that transition, same shape as
   * pollJob/pollProject above.
   */
  async pollPublish(publishId, onProgress, { intervalMs = 2000, maxAttempts = 200 } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const record = await this.getPublish(publishId);
      onProgress?.(record);

      if (record.status === "done" || record.status === "failed") {
        return record;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error("Timed out waiting for publish to complete.");
  },
};

export const imageService = {
  async generate(payload) {
    const headers = await getAuthHeaders();
    const response = await fetch(`${IMAGE_SERVICE_URL}/generate`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return handleResponse(response);
  },
  async pollJob(jobId, onProgress, { intervalMs = 2000, maxAttempts = 200 } = {}) {
    const headers = await getAuthHeaders();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await fetch(`${IMAGE_SERVICE_URL}/status/${jobId}`, { headers });
      const job = await handleResponse(response);
      onProgress?.(job);

      if (job.status === "done" || job.status === "failed") {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error("Timed out waiting for image generation to complete.");
  },

  // NOTE: this deliberately does NOT return a plain URL string anymore.
  // /download/{job_id} requires a Firebase auth header, and <img src>/
  // <a href> can't attach custom headers to their requests -- that
  // mismatch was the source of the 401s. fetchImageBlobUrl() below does
  // a real authenticated fetch and hands back a local blob: URL instead,
  // which *can* be used directly in <img src> / <a href> since the data
  // is already in the browser at that point.
  async fetchImageBlobUrl(jobId) {
    const headers = await getAuthHeaders();
    const response = await fetch(`${IMAGE_SERVICE_URL}/download/${jobId}`, { headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `Download failed (${response.status})`);
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  },
};