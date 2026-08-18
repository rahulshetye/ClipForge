/**
 * Reddit API - post a video to a subreddit as yourself.
 * Uses a "script" type OAuth app (free, self-serve, no approval needed for
 * personal use under Reddit's standard rate limits).
 *
 * Reddit's video submission flow:
 *   1. Get an OAuth access token (username/password grant, since this is a
 *      personal script app -- not a full 3-legged OAuth flow).
 *   2. Request an S3 upload lease for the video file.
 *   3. Upload the video to that S3 URL.
 *   4. Submit the post referencing the uploaded video.
 */

const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");

let cachedToken = null;

async function getAccessToken() {
  if (cachedToken) return cachedToken;

  const response = await axios.post(
    "https://www.reddit.com/api/v1/access_token",
    new URLSearchParams({
      grant_type: "password",
      username: process.env.REDDIT_USERNAME,
      password: process.env.REDDIT_PASSWORD,
    }),
    {
      auth: {
        username: process.env.REDDIT_CLIENT_ID,
        password: process.env.REDDIT_CLIENT_SECRET,
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "ClipForge/1.0",
      },
    }
  );

  cachedToken = response.data.access_token;
  return cachedToken;
}

async function requestUploadLease(token, filename) {
  const response = await axios.post(
    "https://oauth.reddit.com/api/media/asset.json",
    new URLSearchParams({ filepath: filename, mimetype: "video/mp4" }),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "ClipForge/1.0",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return response.data; // { args: { action, fields }, asset: { asset_id, websocket_url } }
}

async function uploadToS3(lease, videoPath) {
  const form = new FormData();
  for (const field of lease.args.fields) {
    form.append(field.name, field.value);
  }
  form.append("file", fs.createReadStream(videoPath));

  await axios.post(`https:${lease.args.action}`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
}

async function submitVideoPost(token, subreddit, title, assetId) {
  const response = await axios.post(
    "https://oauth.reddit.com/api/submit",
    new URLSearchParams({
      sr: subreddit,
      title,
      kind: "video",
      video_poster_url: "", // Reddit will generate a thumbnail automatically
      url: `https://reddit-uploaded-video.s3-accelerate.amazonaws.com/${assetId}`,
    }),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "ClipForge/1.0",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return response.data;
}

/**
 * Full end-to-end: local video file -> published Reddit post.
 * @param {string} videoPath - local path to the video file
 * @param {string} subreddit - without "r/" prefix, e.g. "test"
 * @param {string} title
 */
async function publishVideo(videoPath, subreddit, title) {
  console.log("Authenticating with Reddit...");
  const token = await getAccessToken();

  console.log("Requesting upload lease...");
  const filename = videoPath.split("/").pop();
  const lease = await requestUploadLease(token, filename);

  console.log("Uploading video...");
  await uploadToS3(lease, videoPath);

  console.log("Submitting post...");
  const result = await submitVideoPost(token, subreddit, title, lease.asset.asset_id);
  return result;
}

module.exports = { publishVideo };