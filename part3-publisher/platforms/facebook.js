/**
 * Facebook Page video upload.
 * Uses the OLDER Facebook Graph API (graph.facebook.com) with your Page Access
 * Token (the "EAA..." one from Graph API Explorer -- NOT the "IGAA..." Instagram
 * Login token used in instagram.js, these are different tokens for different systems).
 *
 * Unlike Instagram, Facebook accepts a direct file_url without a container/polling
 * dance -- one API call does it.
 */

const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

/**
 * Uploads a video to a Facebook Page.
 * @param {string} videoPath - local path to the video file
 * @param {object} options - { title?, description?, published? }
 *   published: true (default) -- video goes live on the Page immediately.
 *   Set published: false if you want to upload as a draft instead (visible only
 *   to Page admins, not the public) -- useful for testing without going live.
 * @returns {object} { id: "<video_id>" }
 */
async function uploadVideo(videoPath, options = {}) {
  const { title = "", description = "", published = true } = options;

  const url = `${GRAPH_API_BASE}/${process.env.FB_PAGE_ID}/videos`;

  const form = new FormData();
  form.append("source", fs.createReadStream(videoPath));
  form.append("title", title);
  form.append("description", description);
  form.append("published", String(published));
  form.append("access_token", process.env.FB_PAGE_ACCESS_TOKEN);

  const response = await axios.post(url, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return response.data; // { id: "<video_id>" }
}

module.exports = { uploadVideo };