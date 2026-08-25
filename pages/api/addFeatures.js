/* ---------------------------------------------------------------------------
 * POST /api/addFeatures
 *
 * The stricter pattern (README step 4): the browser posts the feature(s) here;
 * the server attaches the token and forwards to the Facilities layer's
 * /addFeatures endpoint. The token NEVER reaches the browser, and the server
 * gets a chance to validate what is being written.
 *
 * Request body (JSON): { features: [ { geometry, attributes }, ... ] }
 *   or a single { feature: { geometry, attributes } } for convenience.
 *
 * Response mirrors the ArcGIS /addFeatures response:
 *   200: { addResults: [ { objectId, success } ] }
 *   400: bad request (no/invalid features, or a field failed validation)
 *   405: wrong method
 *   502: the ArcGIS service returned an error
 * ------------------------------------------------------------------------- */

const { addFeatures } = require("../../lib/arcgis");

/** Fields this endpoint is willing to write. Anything else is dropped. */
const ALLOWED_ATTRIBUTES = new Set([
  "name",
  "id",
  "electrification_status",
  "connection_type",
  "electrification_date",
]);

/** Basic shape + content validation for one feature before it hits ArcGIS. */
function validateFeature(feature, index) {
  if (!feature || typeof feature !== "object") {
    return `features[${index}] is not an object.`;
  }

  const { geometry, attributes } = feature;

  if (!geometry || typeof geometry.x !== "number" || typeof geometry.y !== "number") {
    return `features[${index}].geometry must have numeric x and y.`;
  }

  if (!attributes || typeof attributes !== "object") {
    return `features[${index}].attributes is required.`;
  }

  const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
  if (!name) {
    return `features[${index}].attributes.name is required.`;
  }

  return null;
}

/** Keep only writable attributes; normalise the geometry's spatial reference. */
function sanitizeFeature(feature) {
  const attributes = {};
  for (const [key, value] of Object.entries(feature.attributes || {})) {
    if (ALLOWED_ATTRIBUTES.has(key) && value !== "" && value != null) {
      attributes[key] = value;
    }
  }

  const geometry = {
    x: feature.geometry.x,
    y: feature.geometry.y,
    // Layer is Web Mercator; default the SR if the client did not send one.
    spatialReference: feature.geometry.spatialReference || {
      wkid: 102100,
      latestWkid: 3857,
    },
  };

  return { geometry, attributes };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // Accept { features: [...] } or a single { feature: {...} }.
  const body = req.body || {};
  const incoming = Array.isArray(body.features)
    ? body.features
    : body.feature
    ? [body.feature]
    : null;

  if (!incoming || incoming.length === 0) {
    return res
      .status(400)
      .json({ error: "Provide a non-empty 'features' array or a single 'feature'." });
  }

  for (let i = 0; i < incoming.length; i++) {
    const problem = validateFeature(incoming[i], i);
    if (problem) return res.status(400).json({ error: problem });
  }

  const features = incoming.map(sanitizeFeature);

  try {
    const json = await addFeatures(features);

    if (json.error) {
      return res.status(502).json({ error: json.error.message, detail: json.error });
    }

    const results = json.addResults || [];
    const failed = results.find((r) => r && r.success === false);
    if (failed) {
      const description =
        (failed.error && failed.error.description) || "The edit was rejected.";
      return res.status(400).json({ error: description, addResults: results });
    }

    return res.status(200).json({ addResults: results });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
