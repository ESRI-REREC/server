/* ---------------------------------------------------------------------------
 * lib/arcgis.js — server-side ArcGIS helpers.
 *
 * Everything credential-bearing lives here and runs ONLY on the server (Node).
 * The browser never imports this file. Credentials come from environment
 * variables (see .env.local.example); nothing is hard-coded.
 *
 * The module keeps a single in-memory token, minted on demand and re-minted a
 * minute before it expires. Because Next.js API routes share one Node process,
 * one cached token serves every request until it goes stale.
 * ------------------------------------------------------------------------- */

const CONFIG = {
  portalUrl: reqEnv("ARCGIS_PORTAL_URL"),
  // Feature layer URLs — one per layer, each named ARCGIS_<NAME>_LAYER_URL.
  facilitiesLayerUrl: reqEnv("ARCGIS_FACILITIES_LAYER_URL"),
  // The Projects table. Optional: only the survey-assignment endpoint needs it,
  // so a missing value must not break token minting / addFeatures.
  projectsLayerUrl: process.env.ARCGIS_PROJECTS_LAYER_URL || null,
  username: reqEnv("ARCGIS_USERNAME"),
  password: reqEnv("ARCGIS_PASSWORD"),
  // Referer the token is bound to. ArcGIS validates the Referer header on every
  // request made with a referer-based token, so this value must match:
  //   - the browser's origin, when the browser uses a token from /api/token, and
  //   - the Referer header this server sends when it proxies /api/addFeatures.
  // Set it to the app's public origin.
  referer: process.env.ARCGIS_REFERER || "http://localhost:3000",
  expirationMinutes: Number(process.env.ARCGIS_TOKEN_EXPIRATION_MINUTES || 60),
};

function reqEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.local.example to .env.local and fill it in.`
    );
  }
  return value;
}

/** In-memory token cache, shared across requests in this Node process. */
let cached = { token: null, expires: 0 };

/**
 * Exchange the configured username/password for a portal token.
 * Uses a referer-based token bound to CONFIG.referer.
 */
async function mintToken() {
  const body = new URLSearchParams({
    username: CONFIG.username,
    password: CONFIG.password,
    client: "referer",
    referer: CONFIG.referer,
    expiration: String(CONFIG.expirationMinutes),
    f: "json",
  });

  const res = await fetch(`${CONFIG.portalUrl}/sharing/rest/generateToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json();
  if (!json.token) {
    const detail = (json.error && json.error.message) || "Unknown error";
    throw new Error(`Could not mint ArcGIS token: ${detail}`);
  }

  cached = { token: json.token, expires: json.expires }; // expires: epoch ms
  return cached;
}

/**
 * Return a valid token/expires pair, re-minting when the cached one is missing
 * or within a minute of expiry.
 */
async function getToken({ forceRefresh = false } = {}) {
  if (forceRefresh || !cached.token || Date.now() > cached.expires - 60_000) {
    await mintToken();
  }
  return { token: cached.token, expires: cached.expires };
}

/** Invalidate the cached token (e.g. after the service reports it stale). */
function clearToken() {
  cached = { token: null, expires: 0 };
}

/**
 * POST features to any layer's /addFeatures endpoint using the server-held
 * token. Retries once with a fresh token if the service reports it stale
 * (498/499). Returns the parsed ArcGIS response.
 */
async function addFeaturesTo(layerUrl, features) {
  return withToken(async () => {
    const { token } = await getToken();
    const body = new URLSearchParams({
      features: JSON.stringify(features),
      rollbackOnFailure: "true",
      f: "json",
      token,
    });
    const res = await fetch(`${layerUrl}/addFeatures`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Referer must match the token binding or ArcGIS rejects the token.
        Referer: CONFIG.referer,
      },
      body,
    });
    return res.json();
  });
}

/** Add features to the Facilities layer (kept for callers using the default). */
async function addFeatures(features) {
  return addFeaturesTo(CONFIG.facilitiesLayerUrl, features);
}

/** Run once, retrying with a fresh token if the service reports it stale. */
async function withToken(makeRequest) {
  let json = await makeRequest();
  if (json.error && (json.error.code === 498 || json.error.code === 499)) {
    clearToken();
    json = await makeRequest();
  }
  return json;
}

/** fetch() with an optional AbortController timeout (ms). Without a timeout it
 * behaves exactly like fetch. Rejects with an AbortError if the timeout elapses,
 * so a slow ArcGIS response can't hang the caller. */
async function fetchWithTimeout(url, options = {}, timeoutMs) {
  if (!timeoutMs) return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Query any feature layer with the server-held token. `params` is merged into
 * the form body (e.g. { where, outFields } or a spatial query). Pass
 * { timeoutMs } to abort a slow request. Returns the parsed response. */
async function queryLayer(layerUrl, params = {}, { timeoutMs } = {}) {
  return withToken(async () => {
    const { token } = await getToken();
    const body = new URLSearchParams({
      f: "json",
      returnGeometry: "false",
      token,
      ...params,
    });
    const res = await fetchWithTimeout(
      `${layerUrl}/query`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: CONFIG.referer,
        },
        body,
      },
      timeoutMs
    );
    return res.json();
  });
}

/** POST updates to any layer's /updateFeatures with the server-held token. */
async function updateFeatures(layerUrl, features) {
  return withToken(async () => {
    const { token } = await getToken();
    const body = new URLSearchParams({
      features: JSON.stringify(features),
      rollbackOnFailure: "true",
      f: "json",
      token,
    });
    const res = await fetch(`${layerUrl}/updateFeatures`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: CONFIG.referer,
      },
      body,
    });
    return res.json();
  });
}

module.exports = {
  CONFIG,
  getToken,
  clearToken,
  addFeatures,
  addFeaturesTo,
  queryLayer,
  updateFeatures,
};
