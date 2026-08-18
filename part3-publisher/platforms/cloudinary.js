/**
 * Instagram's API can't accept a direct file upload -- it only fetches video from
 * a public URL. Cloudinary gives us that public URL quickly and for free.
 *
 * The Cloudinary SDK auto-reads the CLOUDINARY_URL env var (format:
 * cloudinary://API_KEY:API_SECRET@CLOUD_NAME) -- no explicit .config() call needed.
 */

const cloudinary = require("cloudinary").v2;

/**
 * Uploads a local video file to Cloudinary and returns its public URL.
 * @param {string} videoPath - local path to the video file
 * @returns {string} public HTTPS URL to the uploaded video
 */
async function uploadToCloudinary(videoPath) {
  const result = await cloudinary.uploader.upload(videoPath, {
    resource_type: "video",
    timeout: 120000, // 2 min — default was too short for larger/concurrent uploads
    chunk_size: 6000000, // 6MB chunks, more reliable for video
  });
  return result.secure_url;
}

module.exports = { uploadToCloudinary };