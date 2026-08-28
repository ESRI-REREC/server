/* ---------------------------------------------------------------------------
 * POST /api/create-facility-and-project
 *
 * Creates a facility point AND a matching project record, tied together by a
 * server-generated `reference_number`. The browser posts the facility geometry
 * + attributes and the project info; the server attaches the token, generates
 * the reference number, writes both features, and returns the results. The
 * token never reaches the browser and the server whitelists writable fields.
 *
 * Request body (JSON):
 *   {
 *     feature: {
 *       geometry:   { x, y, spatialReference? },
 *       attributes: { name*, id?, electrification_status?, connection_type?,
 *                     electrification_date? }
 *     },
 *     project: { funding_year?, initiator_category?, funding_category? }
 *   }
 *   (a top-level `features: [feature]` is also accepted for the facility.)
 *
 * Responses:
 *   200 { reference_number, facility:{objectId}, project:{objectId} }
 *   400 bad request       405 wrong method
 *   500 server misconfigured      502 ArcGIS error (partial writes reported)
 * ------------------------------------------------------------------------- */

const { CONFIG, addFeaturesTo } = require("../../lib/arcgis");
const { applyCors, handlePreflight } = require("../../lib/cors");

/** Facility fields the client may set. Anything else is dropped. */
const FACILITY_ATTRIBUTES = new Set([
  "name",
  "id",
  "electrification_status",
  "connection_type",
  "electrification_date",
]);

/** Project fields the client may set (the rest are derived server-side). */
const PROJECT_ATTRIBUTES = new Set([
  "funding_year",
  "initiator_category",
  "funding_category",
]);

/** Default status for a freshly created project. */
const DEFAULT_IMPLEMENTATION_STATUS = "Planning";

/** Generate a unique-ish reference number, e.g. REC-1234567/26123. */
function generateReference() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const base = String(Date.now()).slice(-7);
  const seq = String(Math.floor(100 + Math.random() * 900));
  return `REC-${base}/${yy}${seq}`;
}

function pick(source, allowed) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (allowed.has(key) && value !== "" && value != null) out[key] = value;
  }
  return out;
}

function firstResult(json) {
  return (json && json.addResults && json.addResults[0]) || null;
}

function resultError(result, json) {
  if (json && json.error) return json.error.message;
  if (!result) return "the service returned no result";
  if (!result.success) return (result.error && result.error.description) || "the edit was rejected";
  return null;
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  if (!CONFIG.projectsLayerUrl) {
    return res.status(500).json({ error: "Server is missing ARCGIS_PROJECTS_LAYER_URL." });
  }

  const body = req.body || {};
  const feature = body.feature || (Array.isArray(body.features) ? body.features[0] : null);

  // ---- validate the facility ----
  if (!feature || typeof feature !== "object") {
    return res.status(400).json({ error: "A 'feature' (facility) is required." });
  }
  const { geometry, attributes } = feature;
  if (!geometry || typeof geometry.x !== "number" || typeof geometry.y !== "number") {
    return res.status(400).json({ error: "feature.geometry must have numeric x and y." });
  }
  const name = typeof (attributes || {}).name === "string" ? attributes.name.trim() : "";
  if (!name) {
    return res.status(400).json({ error: "feature.attributes.name is required." });
  }

  const reference = generateReference();

  // ---- build the two records ----
  const facilityFeature = {
    geometry: {
      x: geometry.x,
      y: geometry.y,
      spatialReference: geometry.spatialReference || { wkid: 102100, latestWkid: 3857 },
    },
    attributes: {
      ...pick(attributes, FACILITY_ATTRIBUTES),
      name,
      reference_number: reference,
    },
  };

  const projectFeature = {
    attributes: {
      ...pick(body.project, PROJECT_ATTRIBUTES),
      name,
      reference_number: reference,
      implementation_status: DEFAULT_IMPLEMENTATION_STATUS,
    },
  };

  try {
    // 1) Facility.
    const facJson = await addFeaturesTo(CONFIG.facilitiesLayerUrl, [facilityFeature]);
    const facResult = firstResult(facJson);
    const facErr = resultError(facResult, facJson);
    if (facErr) return res.status(502).json({ error: `Facility create failed: ${facErr}`, detail: facJson });

    // 2) Project (tied by reference_number).
    const projJson = await addFeaturesTo(CONFIG.projectsLayerUrl, [projectFeature]);
    const projResult = firstResult(projJson);
    const projErr = resultError(projResult, projJson);
    if (projErr) {
      // Facility was created but the project failed — report the partial write.
      return res.status(502).json({
        error: `Project create failed: ${projErr}`,
        reference_number: reference,
        facility: { objectId: facResult.objectId },
        detail: projJson,
      });
    }

    return res.status(200).json({
      reference_number: reference,
      facility: { objectId: facResult.objectId },
      project: { objectId: projResult.objectId },
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
