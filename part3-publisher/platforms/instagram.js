/**
 * Instagram API with Instagram Login - Reels publishing.
 * (Not the older Facebook Page-linked Graph API -- this is Meta's newer direct
 * Instagram Login flow, identifiable by access tokens starting with "IGAA...".
 * It uses graph.instagram.com instead of graph.facebook.com, and doesn't need
 * a linked Facebook Page.)
 *
 * Flow (this is how Instagram's API works, not a design choice we made):
 *   1. Create a "media container" -- tell Instagram the video's public URL + caption.
 *      Instagram starts downloading/processing it server-side.
 *   2. Poll the container's status until it's FINISHED (processing takes a while).
 *   3. Publish the container -- this actually makes it live on the account.
 */

const axios = require("axios");

const GRAPH_API_BASE = "https://graph.instagram.com/v21.0";

/** Step 1: create the media container. Returns a container ID. */
async function createContainer(videoUrl, caption = "") {
  const url = `${GRAPH_API_BASE}/${process.env.IG_USER_ID}/media`;
  const response = await axios.post(url, null, {
    params: {
      media_type: "REELS",
      video_url: videoUrl,
      caption,
      access_token: process.env.IG_ACCESS_TOKEN,
    },
  });
  return response.data.id; // this is the container ID
}

/** Step 2: poll the container's processing status until it's ready. */
async function waitForContainerReady(containerId, { intervalMs = 5000, maxAttempts = 30 } = {}) {
  const url = `${GRAPH_API_BASE}/${containerId}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await axios.get(url, {
      params: {
        fields: "status_code,status",
        access_token: process.env.IG_ACCESS_TOKEN,
      },
    });

    const { status_code, status } = response.data;
    console.log(`  Container status: ${status_code} (attempt ${attempt + 1}/${maxAttempts})`);

    if (status_code === "FINISHED") return true;
    if (status_code === "ERROR") {
      throw new Error(`Instagram failed to process the video: ${status || "unknown error"}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out waiting for Instagram to finish processing the video.");
}

/** Step 3: publish the ready container -- goes live on the account. */
async function publishContainer(containerId) {
  const url = `${GRAPH_API_BASE}/${process.env.IG_USER_ID}/media_publish`;
  const response = await axios.post(url, null, {
    params: {
      creation_id: containerId,
      access_token: process.env.IG_ACCESS_TOKEN,
    },
  });
  return response.data; // { id: "<published_media_id>" }
}

/**
 * Full end-to-end: video URL + caption -> published Reel.
 * @param {string} videoUrl - PUBLIC URL to the video (e.g. from Cloudinary)
 * @param {string} caption
 * @returns {object} { id: "<published_media_id>" }
 */
async function publishReel(videoUrl, caption = "") {
  console.log("Creating Instagram media container...");
  const containerId = await createContainer(videoUrl, caption);

  console.log("Waiting for Instagram to process the video...");
  await waitForContainerReady(containerId);

  console.log("Publishing...");
  const result = await publishContainer(containerId);

  return result;
}

module.exports = { publishReel };