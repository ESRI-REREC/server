/* ---------------------------------------------------------------------------
 * lib/cors.js — cross-origin support for the API routes.
 *
 * The Create Facility page is served from a different origin than this server
 * (e.g. a static host, or localhost:8000), so the browser needs CORS headers to
 * read /api/token and to POST to /api/addFeatures.
 *
 * ALLOWED_ORIGINS (comma-separated) restricts who may call the API.
 *   - unset or "*"  → reflect any origin (convenient for a POC)
 *   - a list        → only those exact origins are allowed
 * ------------------------------------------------------------------------- */

const ALLOWED = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOW_ANY = ALLOWED.includes("*");

/** Set CORS response headers based on the request's Origin. */
function applyCors(req, res) {
  const origin = req.headers.origin;

  if (ALLOW_ANY) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (origin && ALLOWED.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  // Responses differ per Origin, so caches must key on it.
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * Handle a CORS preflight (OPTIONS) request. Returns true if it did, in which
 * case the caller should stop. A JSON POST to /api/addFeatures triggers this.
 */
function handlePreflight(req, res) {
  if (req.method === "OPTIONS") {
    applyCors(req, res);
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = { applyCors, handlePreflight };
