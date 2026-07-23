// Read-only. No auth, no DB call.
// Vercel injects VERCEL_GIT_COMMIT_SHA and VERCEL_ENV at deploy time.
// Used by the production promotion workflow to confirm the correct SHA is live.
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.status(200).json({
    sha:     process.env.VERCEL_GIT_COMMIT_SHA     || 'unknown',
    ref:     process.env.VERCEL_GIT_COMMIT_REF     || 'unknown',
    env:     process.env.VERCEL_ENV                || 'unknown',
    message: process.env.VERCEL_GIT_COMMIT_MESSAGE || null,
  });
};
