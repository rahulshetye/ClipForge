/**
 * LinkedIn API - post a video to your own personal profile.
 * Uses the free "Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect"
 * products (no partner approval needed for posting to your own profile -- that's
 * only required for company Pages).
 *
 * Unlike Reddit's username/password grant, LinkedIn requires full OAuth2 with a
 * browser consent step (same pattern as YouTube's OAuth flow).
 *
 * LinkedIn's video upload is a 3-step process (after OAuth):
 *   1. Register the upload -- tells LinkedIn you want to upload a video, get back an upload URL.
 *   2. Upload the raw video bytes to that URL.
 *   3. Create the actual post referencing the uploaded video asset.
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.linkedin.com/v2";
const TOKENS_PATH = path.join(__dirname, "..", "linkedin_tokens.json");
const SCOPES = "openid profile w_member_social";

/** Step 1 of OAuth: build the URL to send the user to for consent. */
function getAuthUrl() {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.LINKEDIN_CLIENT_ID,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
    scope: SCOPES,
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

/** Step 2 of OAuth: exchange the code LinkedIn sent back for an access token. */
async function saveTokensFromCode(code) {
  const response = await axios.post(
    "https://www.linkedin.com/oauth/v2/accessToken",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
      client_id: process.env.LINKEDIN_CLIENT_ID,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const accessToken = response.data.access_token;

  // Fetch the person's unique LinkedIn ID (needed to construct the author URN for posts)
  const userInfo = await axios.get("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const personId = userInfo.data.sub;

  const tokens = { accessToken, personId };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  return tokens;
}

function loadSavedTokens() {
  if (!fs.existsSync(TOKENS_PATH)) {
    throw new Error("No saved LinkedIn tokens found. Visit /auth/linkedin first to authorize.");
  }
  return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf-8"));
}

async function registerUpload(accessToken, personId) {
  const url = `${API_BASE}/assets?action=registerUpload`;
  const response = await axios.post(
    url,
    {
      registerUploadRequest: {
        recipes: ["urn:li:digitalmediaRecipe:feedshare-video"],
        owner: `urn:li:person:${personId}`,
        serviceRelationships: [
          { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
        ],
      },
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const uploadUrl =
    response.data.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]
      .uploadUrl;
  const asset = response.data.value.asset;
  return { uploadUrl, asset };
}

async function uploadVideoBytes(accessToken, uploadUrl, videoPath) {
  const videoBuffer = fs.readFileSync(videoPath);
  await axios.put(uploadUrl, videoBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
}

async function createPost(accessToken, personId, asset, text) {
  const url = `${API_BASE}/ugcPosts`;
  const response = await axios.post(
    url,
    {
      author: `urn:li:person:${personId}`,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "VIDEO",
          media: [{ status: "READY", media: asset }],
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    }
  );
  return response.data;
}

/**
 * Full end-to-end: local video file + text -> published LinkedIn post.
 * Uses tokens saved from the /auth/linkedin OAuth flow.
 * @param {string} videoPath - LOCAL path (unlike Instagram/Threads, LinkedIn accepts direct upload)
 * @param {string} text
 */
async function publishVideo(videoPath, text = "") {
  const { accessToken, personId } = loadSavedTokens();

  console.log("Registering upload with LinkedIn...");
  const { uploadUrl, asset } = await registerUpload(accessToken, personId);

  console.log("Uploading video bytes...");
  await uploadVideoBytes(accessToken, uploadUrl, videoPath);

  console.log("Creating post...");
  const result = await createPost(accessToken, personId, asset, text);
  return result;
}

module.exports = { getAuthUrl, saveTokensFromCode, publishVideo };