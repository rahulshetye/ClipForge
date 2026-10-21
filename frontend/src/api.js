import { auth } from './firebase.js';

// Base URLs for the backend services.
const PART1_URL = import.meta.env.VITE_PART1_URL || "http://localhost:8001";
const PART2_URL = import.meta.env.VITE_PART2_URL || "http://localhost:8002";
const PART3_URL = import.meta.env.VITE_PART3_URL || "http://localhost:3001";
const IMAGE_SERVICE_URL = import.meta.env.VITE_IMAGE_SERVICE_URL || "http://localhost:8003";
export { PART3_URL };

/**
 * Gets a Firebase ID token for the current user and returns it as an
 * Authorization header. Every authenticated request across all 4 backends
 * goes through this -- backends verify the token via Firebase Admin SDK
 * before trusting the uid inside it, rather than trusting a uid the client
 * claims directly (which anyone could spoof by just editing a request).
 *
 * getIdToken() returns the cached token and only refreshes it when it is
 * expired/near expiry, so callers must call this fresh for every request in
 * a long-running loop (polling) -- never once before the loop, or the token
 * can expire mid-loop and the backend starts returning 401.
 *
 * forceRefresh: pass true to bypass the cache and mint a new token. Used
 * by fetchWithAuth's one-time retry after a 401.
 */
async function getAuthHeaders(forceRefresh = false) {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Not signed in.");
  }
  const token = await user.getIdToken(forceRefresh);
  return { Authorization: `Bearer ${token}` };
}

/**
 * fetch() with a fresh auth header on every call, plus a single retry with
 * a force-refreshed token if the backend answers 401 (covers a token that
 * was valid when read but expired in flight). Used by the polling loops,
 * which can run for minutes. `init.headers` are merged with the auth header.
 */
async function fetchWithAuth(url, init = {}) {
  let headers = await getAuthHeaders();
  let response = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (response.status === 401) {
    headers = await getAuthHeaders(true);
    response = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  }
  return response;
}

async function handleResponse(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    // FastAPI returns `detail` as a string for HTTPException (e.g. our 400s)
    // but as an array of { msg, loc, ... } objects for 422 validation errors.
    const detail = Array.isArray(body.detail)
      ? body.detail.map((d) => d.msg).join("; ")
      : body.detail;
    throw new Error(body.error || detail || `Request failed (${response.status})`);
  }
  return response.json();
}

async function pollJob(baseUrl, jobId, onProgress, { intervalMs = 3000, maxAttempts = 200 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchWithAuth(`${baseUrl}/jobs/${jobId}`);
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
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchWithAuth(`${baseUrl}/projects/${projectId}`);
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

  /**
   * Runs one step on its own. `params` is optional per-step options,
   * e.g. runStep(id, "captions", { language: "hi", script: "roman",
   * onMismatch: "raise" }) -- sent as { params: {...} } and converted from
   * camelCase to snake_case by the backend before reaching the step's run().
   * Requires the backend's POST /projects/{id}/steps/{name} to accept a body.
   */
  async runStep(projectId, stepName, params) {
    const headers = await getAuthHeaders();
    const response = await fetch(`${PART2_URL}/projects/${projectId}/steps/${stepName}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ params }),
    });
    return handleResponse(response);
  },

  /**
   * steps: array of step names (defaults to the full backend STEP_ORDER if
   * omitted). stepParams: optional { stepName: { kwarg: value, ... } } --
   * forwarded to registry.run_all's matching step_params param. Sent as a
   * JSON body since stepParams is a nested object that doesn't serialize
   * cleanly into a query string.
   *
   * For subtitle_styles specifically, there are two ways to pick a look
   * (mirrors backend steps/subtitle_styles.py -- see STYLES/FONT_PRESETS vs
   * STYLE_PRESETS there):
   *   - independent controls: { subtitle_styles: { style: "boxed", fontName: "modern" } }
   *   - a named preset (font+colors+emphasis+transition bundled together):
   *     { subtitle_styles: { presetName: "studio" } }
   * If both are sent, the backend's presetName wins. presetName must be one
   * of subtitle_styles.py's STYLE_PRESETS keys (e.g. "studio", "editorial",
   * "impact", "kinetic", "poster", plus "classic"/"boxed"/"karaoke" which
   * are the old style/font pairs re-exposed as named presets) -- an unknown
   * name is rejected with a 400 before any processing starts.
   *
   * For captions (mirrors backend steps/captions.py):
   *   { captions: { language: "auto" | "en" | "hi",
   *                 script: "native" | "roman",          // Hindi only
   *                 onMismatch: "warn" | "raise" | "use_detected" } }
   * With onMismatch "raise", a language choice that clearly doesn't match the
   * audio fails the job before transcription starts, and GET /projects/{id}
   * then returns errorDetails: { code: "language_mismatch", requested,
   * detected, confidence } so the UI can ask the user what to do. Unknown
   * values are rejected with a 400 before any processing starts.
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
    const response = await fetchWithAuth(`${PART3_URL}/publishes/${publishId}`);
    return handleResponse(response);
  },

  /**
   * Polls a single publish record until it leaves the "publishing" state.
   * server.js writes the record as status: "publishing" before the platform
   * call even starts, then flips it to "done"/"failed" once that call
   * resolves -- this just watches for that transition, same shape as
   * pollJob/pollProject above. getPublish() builds fresh auth headers on
   * every call, so the token can't go stale mid-poll.
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

  /**
   * img2img hits POST /img2img with multipart/form-data (the backend needs
   * this -- JSON can't carry the uploaded image's binary bytes). `formData`
   * is built by the caller (must include an `image` File and a `prompt`
   * field at minimum; style/subject/negative_prompt/strength/seed/
   * num_inference_steps/guidance_scale are all optional form fields the
   * backend defaults if omitted).
   *
   * Deliberately do NOT set a Content-Type header here -- the browser needs
   * to set it itself (multipart/form-data; boundary=...) based on the
   * FormData body. Setting it manually would drop the boundary and break
   * the upload.
   */
  async img2img(formData) {
    const headers = await getAuthHeaders();
    const response = await fetch(`${IMAGE_SERVICE_URL}/img2img`, {
      method: "POST",
      headers,
      body: formData,
    });
    return handleResponse(response);
  },

  async pollJob(jobId, onProgress, { intervalMs = 2000, maxAttempts = 200 } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await fetchWithAuth(`${IMAGE_SERVICE_URL}/status/${jobId}`);
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

  /**
   * Same authenticated-blob-URL pattern as fetchImageBlobUrl, but for
   * GET /download/{job_id}/source -- the original uploaded image an
   * img2img job started from. 404s if the job was txt2img or the source
   * file was cleaned up server-side; callers should expect that and treat
   * it as "no source available" rather than a hard failure.
   */
  async fetchSourceImageBlobUrl(jobId) {
    const headers = await getAuthHeaders();
    const response = await fetch(`${IMAGE_SERVICE_URL}/download/${jobId}/source`, { headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `Download failed (${response.status})`);
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  },
};