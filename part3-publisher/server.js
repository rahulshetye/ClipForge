require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const youtube = require("./platforms/youtube");
const instagram = require("./platforms/instagram");
const facebook = require("./platforms/facebook");
const threads = require("./platforms/threads");
const linkedin = require("./platforms/linkedin");
const reddit = require("./platforms/reddit");
const { uploadToCloudinary } = require("./platforms/cloudinary");
const { requireAuth, app: firebaseApp } = require("./middleware/auth");

// Reuses the exact Admin SDK app middleware/auth.js already initialized
// (service account cert + getApps() singleton guard) -- no separate init
// file needed, since Firestore just needs a reference to that same app.
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const app = express();
app.use(cors());  // allows the frontend (running on a different port) to actually reach this server
app.use(express.json());

const PORT = process.env.PORT || 3001;

const db = getFirestore(firebaseApp);

// Path: users/{uid}/publishes/{publish_id}. Same ownership-by-structure
// pattern as the image service's _job_ref -- a doc under one uid's
// subcollection is unreachable from any other uid, so there's no separate
// uid-match check to write or forget.
function publishRef(uid, publishId) {
  return db.collection("users").doc(uid).collection("publishes").doc(publishId);
}

// Firestore rejects `undefined` field values outright (it throws instead of
// silently dropping them). Optional body fields like `description` or
// `privacyStatus` come through as undefined when the client omits them, so
// strip those keys before every write instead of storing them as null.
function stripUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  );
}

// Creates the initial Firestore record for a publish attempt, before the
// platform call is made, so a crash mid-publish still leaves a "publishing"
// record behind instead of nothing at all.
async function createPublishRecord(uid, platform, payload) {
  const publishId = uuidv4();
  const cleanPayload = stripUndefined(payload);
  console.log(`[firestore] writing users/${uid}/publishes/${publishId} (status: publishing)...`);
  try {
    await publishRef(uid, publishId).set({
      platform,
      status: "publishing",
      payload: cleanPayload,       // videoPath, caption/title/text, etc. -- whatever was sent
      result: null,
      error: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`[firestore] wrote users/${uid}/publishes/${publishId} OK`);
  } catch (err) {
    console.error(`[firestore] FAILED to write users/${uid}/publishes/${publishId}:`, err);
    throw err;
  }
  return publishId;
}

async function markPublishDone(uid, publishId, result) {
  console.log(`[firestore] updating users/${uid}/publishes/${publishId} (status: done)...`);
  try {
    await publishRef(uid, publishId).update({
      status: "done",
      result,
      error: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`[firestore] updated users/${uid}/publishes/${publishId} -> done`);
  } catch (err) {
    console.error(`[firestore] FAILED to mark users/${uid}/publishes/${publishId} done:`, err);
  }
}

async function markPublishFailed(uid, publishId, error) {
  console.log(`[firestore] updating users/${uid}/publishes/${publishId} (status: failed)...`);
  try {
    await publishRef(uid, publishId).update({
      status: "failed",
      error: error.message || String(error),
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`[firestore] updated users/${uid}/publishes/${publishId} -> failed`);
  } catch (err) {
    console.error(`[firestore] FAILED to mark users/${uid}/publishes/${publishId} failed:`, err);
  }
}

// Cache Cloudinary uploads by videoPath so multiple platforms selected in the same
// publish run (e.g. Instagram + Threads) share one upload instead of racing two
// concurrent uploads against each other, which was causing intermittent 499 timeouts
// and "only 1 of 3 platforms published" behavior.
const cloudinaryUploadCache = new Map(); // videoPath -> Promise<url>

async function getPublicVideoUrl(videoPath) {
  if (!cloudinaryUploadCache.has(videoPath)) {
    console.log("Uploading to Cloudinary for a public URL...");
    const uploadPromise = uploadToCloudinary(videoPath).catch((err) => {
      // If the upload fails, remove the cache entry so a later retry can try again
      // instead of being stuck replaying the same failed promise.
      cloudinaryUploadCache.delete(videoPath);
      throw err;
    });
    cloudinaryUploadCache.set(videoPath, uploadPromise);
  }
  return cloudinaryUploadCache.get(videoPath);
}

/** Step 1: send the user here to start YouTube OAuth consent. */
app.get("/auth/youtube", (req, res) => {
  const url = youtube.getAuthUrl();
  res.redirect(url);
});

/** Step 2: Google redirects back here with a ?code=... after the user approves. */
app.get("/auth/youtube/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("Missing ?code in callback URL.");
  }

  try {
    await youtube.saveTokensFromCode(code);
    res.send("YouTube connected! Tokens saved. You can close this tab and go back to testing.");
  } catch (err) {
    console.error(err);
    res.status(500).send(`OAuth exchange failed: ${err.message}`);
  }
});

/**
 * Publish a video to YouTube.
 * Body: { videoPath: string, title: string, description?: string, privacyStatus?: string }
 */
app.post("/publish/youtube", requireAuth, async (req, res) => {
  const { videoPath, title, description, privacyStatus } = req.body;

  if (!videoPath || !title) {
    return res.status(400).json({ error: "videoPath and title are required." });
  }

  const publishId = await createPublishRecord(req.uid, "youtube", { videoPath, title, description, privacyStatus });

  try {
    const result = await youtube.uploadVideo(videoPath, { title, description, privacyStatus });
    const response = {
      success: true,
      videoId: result.id,
      url: `https://youtube.com/watch?v=${result.id}`,
    };
    await markPublishDone(req.uid, publishId, response);
    res.json({ publishId, ...response });
  } catch (err) {
    console.error(err);
    await markPublishFailed(req.uid, publishId, err);
    res.status(500).json({ publishId, error: err.message });
  }
});

/**
 * Publish a Reel to Instagram.
 * Body: { videoPath: string, caption?: string }
 * Uploads the local file to Cloudinary first (Instagram needs a public URL), then publishes.
 * Uses the shared getPublicVideoUrl cache so it doesn't re-upload if Threads is
 * publishing the same video in the same run.
 */
app.post("/publish/instagram", requireAuth, async (req, res) => {
  const { videoPath, caption } = req.body;

  if (!videoPath) {
    return res.status(400).json({ error: "videoPath is required." });
  }

  const publishId = await createPublishRecord(req.uid, "instagram", { videoPath, caption });

  try {
    const videoUrl = await getPublicVideoUrl(videoPath);
    console.log("Public URL:", videoUrl);

    const result = await instagram.publishReel(videoUrl, caption || "");
    const response = { success: true, mediaId: result.id };
    await markPublishDone(req.uid, publishId, response);
    res.json({ publishId, ...response });
  } catch (err) {
    console.error(err);
    await markPublishFailed(req.uid, publishId, err);
    res.status(500).json({ publishId, error: err.message });
  }
});

/**
 * Publish a video to a Facebook Page.
 * Body: { videoPath: string, title?: string, description?: string, published?: boolean }
 * published defaults to true (goes live immediately). Pass published: false to upload
 * as a draft instead (visible only to Page admins).
 */
app.post("/publish/facebook", requireAuth, async (req, res) => {
  const { videoPath, title, description, published } = req.body;

  if (!videoPath) {
    return res.status(400).json({ error: "videoPath is required." });
  }

  const publishId = await createPublishRecord(req.uid, "facebook", { videoPath, title, description, published });

  try {
    const result = await facebook.uploadVideo(videoPath, { title, description, published });
    const response = { success: true, videoId: result.id };
    await markPublishDone(req.uid, publishId, response);
    res.json({ publishId, ...response });
  } catch (err) {
    console.error(err);
    await markPublishFailed(req.uid, publishId, err);
    res.status(500).json({ publishId, error: err.message });
  }
});

/**
 * Publish to Threads.
 * Body: { videoPath: string, text?: string }
 * Uses the shared getPublicVideoUrl cache so it doesn't re-upload if Instagram is
 * publishing the same video in the same run.
 */
app.post("/publish/threads", requireAuth, async (req, res) => {
  const { videoPath, text } = req.body;
  if (!videoPath) return res.status(400).json({ error: "videoPath is required." });

  const publishId = await createPublishRecord(req.uid, "threads", { videoPath, text });

  try {
    const videoUrl = await getPublicVideoUrl(videoPath);
    const result = await threads.publishThread(videoUrl, text || "");
    const response = { success: true, id: result.id };
    await markPublishDone(req.uid, publishId, response);
    res.json({ publishId, ...response });
  } catch (err) {
    console.error(err);
    await markPublishFailed(req.uid, publishId, err);
    res.status(500).json({ publishId, error: err.message });
  }
});

/** Step 1: send the user here to start LinkedIn OAuth consent. */
app.get("/auth/linkedin", (req, res) => {
  const url = linkedin.getAuthUrl();
  res.redirect(url);
});

/** Step 2: LinkedIn redirects back here with a ?code=... after the user approves. */
app.get("/auth/linkedin/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing ?code in callback URL.");

  try {
    await linkedin.saveTokensFromCode(code);
    res.send("LinkedIn connected! Tokens saved. You can close this tab and go back to testing.");
  } catch (err) {
    console.error(err);
    res.status(500).send(`OAuth exchange failed: ${err.message}`);
  }
});

/**
 * Publish to LinkedIn (personal profile).
 * Body: { videoPath: string, text?: string }
 */
app.post("/publish/linkedin", requireAuth, async (req, res) => {
  const { videoPath, text } = req.body;
  if (!videoPath) return res.status(400).json({ error: "videoPath is required." });

  const publishId = await createPublishRecord(req.uid, "linkedin", { videoPath, text });

  try {
    const result = await linkedin.publishVideo(videoPath, text || "");
    const response = { success: true, result };
    await markPublishDone(req.uid, publishId, response);
    res.json({ publishId, ...response });
  } catch (err) {
    console.error(err);
    await markPublishFailed(req.uid, publishId, err);
    res.status(500).json({ publishId, error: err.message });
  }
});

/**
 * Publish to Reddit.
 * Body: { videoPath: string, subreddit: string, title: string }
 */
app.post("/publish/reddit", requireAuth, async (req, res) => {
  const { videoPath, subreddit, title } = req.body;
  if (!videoPath || !subreddit || !title) {
    return res.status(400).json({ error: "videoPath, subreddit, and title are required." });
  }

  const publishId = await createPublishRecord(req.uid, "reddit", { videoPath, subreddit, title });

  try {
    const result = await reddit.publishVideo(videoPath, subreddit, title);
    const response = { success: true, result };
    await markPublishDone(req.uid, publishId, response);
    res.json({ publishId, ...response });
  } catch (err) {
    console.error(err);
    await markPublishFailed(req.uid, publishId, err);
    res.status(500).json({ publishId, error: err.message });
  }
});

/**
 * This user's publish history across all platforms, most recent first.
 * Mirrors GET /jobs in the image service.
 */
app.get("/publishes", requireAuth, async (req, res) => {
  try {
    const snapshot = await db
      .collection("users")
      .doc(req.uid)
      .collection("publishes")
      .orderBy("createdAt", "desc")
      .get();

    const publishes = snapshot.docs.map((doc) => ({ publishId: doc.id, ...doc.data() }));
    res.json(publishes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * A single publish record by id, scoped to the requesting user.
 * Mirrors GET /status/{job_id} in the image service.
 */
app.get("/publishes/:publishId", requireAuth, async (req, res) => {
  try {
    const doc = await publishRef(req.uid, req.params.publishId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Publish record not found" });
    }
    res.json({ publishId: doc.id, ...doc.data() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Part 3 publisher running on http://localhost:${PORT}`);
  console.log(`Start YouTube auth at: http://localhost:${PORT}/auth/youtube`);
});