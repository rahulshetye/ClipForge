/**
 * Threads API - post publishing.
 * Same Meta app as Instagram, same container/poll/publish pattern, different
 * base URL and a different User ID (Threads User ID, not the Instagram one).
 */

const axios = require("axios");

const GRAPH_API_BASE = "https://graph.threads.net/v1.0";

async function createContainer(videoUrl, text = "") {
  const url = `${GRAPH_API_BASE}/${process.env.THREADS_USER_ID}/threads`;
  const response = await axios.post(url, null, {
    params: {
      media_type: "VIDEO",
      video_url: videoUrl,
      text,
      access_token: process.env.THREADS_ACCESS_TOKEN,
    },
  });
  return response.data.id;
}

async function waitForContainerReady(containerId, { intervalMs = 5000, maxAttempts = 30 } = {}) {
  const url = `${GRAPH_API_BASE}/${containerId}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await axios.get(url, {
      params: { fields: "status", access_token: process.env.THREADS_ACCESS_TOKEN },
    });

    const { status } = response.data;
    console.log(`  Threads container status: ${status} (attempt ${attempt + 1}/${maxAttempts})`);

    if (status === "FINISHED") return true;
    if (status === "ERROR") throw new Error("Threads failed to process the video.");

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for Threads to finish processing the video.");
}

async function publishContainer(containerId) {
  const url = `${GRAPH_API_BASE}/${process.env.THREADS_USER_ID}/threads_publish`;
  const response = await axios.post(url, null, {
    params: { creation_id: containerId, access_token: process.env.THREADS_ACCESS_TOKEN },
  });
  return response.data;
}

/**
 * Full end-to-end: video URL + text -> published Thread.
 * @param {string} videoUrl - PUBLIC URL (e.g. from Cloudinary)
 */
async function publishThread(videoUrl, text = "") {
  console.log("Creating Threads media container...");
  const containerId = await createContainer(videoUrl, text);

  console.log("Waiting for Threads to process the video...");
  await waitForContainerReady(containerId);

  console.log("Publishing...");
  return publishContainer(containerId);
}

module.exports = { publishThread };