/**
 * YouTube Data API v3 adapter.
 * Handles OAuth2 flow (get consent URL, exchange code for tokens) and video upload.
 *
 * Tokens are saved to a local tokens.json file for now (simple prototype persistence).
 * When this gets wired into the real Express backend later, swap that for MongoDB
 * (one document per user per platform, encrypted refresh token) -- same pattern
 * flagged when we scoped this part originally.
 */

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const TOKENS_PATH = path.join(__dirname, "..", "tokens.json");
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload"];

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/** Step 1 of OAuth: build the URL to send the user to for consent. */
function getAuthUrl() {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline", // needed to get a refresh_token back, not just a short-lived access_token
    prompt: "consent",       // forces Google to always return a refresh_token, even on repeat auth
    scope: SCOPES,
  });
}

/** Step 2 of OAuth: exchange the code Google sent back for real tokens, then save them. */
async function saveTokensFromCode(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  return tokens;
}

function loadSavedTokens() {
  if (!fs.existsSync(TOKENS_PATH)) {
    throw new Error("No saved YouTube tokens found. Visit /auth/youtube first to authorize.");
  }
  return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf-8"));
}

function getAuthorizedClient() {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(loadSavedTokens());
  return oauth2Client;
}

/**
 * Uploads a video file to YouTube.
 * @param {string} videoPath - local path to the video file to upload
 * @param {object} metadata - { title, description, tags, privacyStatus }
 * @returns {object} the created video's data (includes id, so you can build the watch URL)
 */
async function uploadVideo(videoPath, metadata = {}) {
  const auth = getAuthorizedClient();
  const youtube = google.youtube({ version: "v3", auth });

  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: metadata.title || "Untitled",
        description: metadata.description || "",
        tags: metadata.tags || [],
        categoryId: "22", // "People & Blogs" -- fine default for Shorts-style content
      },
      status: {
        privacyStatus: metadata.privacyStatus || "private", // "private" | "unlisted" | "public"
      },
    },
    media: {
      body: fs.createReadStream(videoPath),
    },
  });

  return response.data;
}

module.exports = { getAuthUrl, saveTokensFromCode, uploadVideo };