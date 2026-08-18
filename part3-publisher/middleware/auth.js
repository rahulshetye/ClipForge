/**
 * Firebase ID token verification middleware.
 * Every route this wraps requires a valid `Authorization: Bearer <token>`
 * header. On success, attaches the verified, trusted uid to req.uid --
 * routes should use req.uid, never a uid taken from the request body
 * (that would be exactly the spoofable pattern this exists to prevent).
 */
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const serviceAccount = require("../clip-forge-8c199-firebase-adminsdk-fbsvc-9f3c225de0.json");

const app = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: cert(serviceAccount),
    });

const auth = getAuth(app);

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      error: "Missing Authorization header.",
    });
  }

  try {
    const decoded = await auth.verifyIdToken(token);

    req.uid = decoded.uid;
    req.userEmail = decoded.email;

    next();
  } catch (err) {
    console.error("Firebase token verification error:", err);

    return res.status(401).json({
      error: "Invalid or expired token.",
    });
  }
}

module.exports = {
  requireAuth,
  app,
  auth,
};