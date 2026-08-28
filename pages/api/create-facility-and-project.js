/* ---------------------------------------------------------------------------
 * POST /api/create-facility-and-project
 *
 * Creates a facility point AND a matching project record, tied together by a
 * server-generated `reference_number`. The browser posts the facility geometry
 * + attributes and the project info; the server attaches the token, generates
 * the reference number, writes both features, and returns the results. The
 * token never reaches the browser and the server whitelists writable fields.
 *
 * The facility point is also enriched server-side with the administrative area
 * it falls in — county, constituency and ward — by intersecting the point
 * against three boundary layers (in parallel). Enrichment is best-effort: a
 * missed intersection, a query error or a timeout leaves that field null and
 * logs a warning rather than failing the create.
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
 *   200 { reference_number, admin:{county,constituency,ward}, facility:{objectId}, project:{objectId} }
 *   400 bad request       405 wrong method
 *   500 server misconfigured      502 ArcGIS error (partial writes reported)
 * ------------------------------------------------------------------------- */

const { CONFIG, addFeaturesTo, queryLayer } = require("../../lib/arcgis");
const { applyCors, handlePreflight } = require("../../lib/cors");

/**
 * Administrative boundary layers the facility point is intersected against.
 * `key` is the facility (and, where present, project) field to populate;
 * `nameField` is the layer's name attribute (verified against each layer's
 * schema). URLs are overridable via env, with the deployment's layers as the
 * default so enrichment works out of the box.
 */
const BOUNDARY_LOOKUPS = [
  {
    key: "county",
    nameField: "county",
    url:
      process.env.ARCGIS_COUNTIES_LAYER_URL ||
      "https://development.esriea.com/server/rest/services/Hosted/Counties/FeatureServer/0",
  },
  {
    key: "constituency",
    nameField: "constituen",
    url:
      process.env.ARCGIS_CONSTITUENCIES_LAYER_URL ||
      "https://development.esriea.com/server/rest/services/Hosted/Constituencies/FeatureServer/0",
  },
  {
    key: "ward",
    nameField: "name",
    url:
      process.env.ARCGIS_WARDS_LAYER_URL ||
      "https://development.esriea.com/server/rest/services/Hosted/Wards/FeatureServer/0",
  },
];

/** Per-lookup timeout so a slow boundary layer can't hang the create. */
const BOUNDARY_QUERY_TIMEOUT_MS = 8000;

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

/** Default status for a freshly created project (first stage of the workflow;
 * must be a coded value in the layer's implementation_status domain). */
const DEFAULT_IMPLEMENTATION_STATUS = "Survey";

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

/**
 * Resolve the county / constituency / ward a facility point falls in by
 * intersecting it against the three boundary layers in parallel.
 *
 * Best-effort: each lookup independently returns null (with a warning) if no
 * polygon intersects, the service errors, or the request times out — so a
 * boundary problem never blocks facility creation. The point is queried in its
 * own spatial reference (the facility geometry is Web Mercator, not lat/lon),
 * and ArcGIS reprojects against each boundary layer as needed.
 *
 * @returns {Promise<{county:?string, constituency:?string, ward:?string}>}
 */
async function resolveAdminAreas(geometry) {
  const spatialReference = geometry.spatialReference || { wkid: 102100, latestWkid: 3857 };
  const wkid = spatialReference.latestWkid || spatialReference.wkid || 102100;
  const point = { x: geometry.x, y: geometry.y, spatialReference };

  const entries = await Promise.all(
    BOUNDARY_LOOKUPS.map(async ({ key, nameField, url }) => {
      try {
        const json = await queryLayer(
          url,
          {
            geometry: JSON.stringify(point),
            geometryType: "esriGeometryPoint",
            inSR: String(wkid),
            spatialRel: "esriSpatialRelIntersects",
            outFields: nameField,
            returnGeometry: "false",
          },
          { timeoutMs: BOUNDARY_QUERY_TIMEOUT_MS }
        );

        if (json && json.error) {
          console.warn(`[admin-areas] ${key} query error: ${json.error.message}`);
          return [key, null];
        }

        const match = json && json.features && json.features[0];
        const value = match && match.attributes ? match.attributes[nameField] : null;
        if (value == null || value === "") {
          console.warn(`[admin-areas] no ${key} polygon intersects the facility point.`);
          return [key, null];
        }
        return [key, value];
      } catch (err) {
        // Network / timeout / abort — flag for later backfill, don't block create.
        console.warn(`[admin-areas] ${key} lookup failed (${err.name}): ${err.message}`);
        return [key, null];
      }
    })
  );

  return Object.fromEntries(entries);
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

  // ---- reference_number (client-provided; ties facility + project) ----
  const rawRef = body.reference_number || (body.project && body.project.reference_number);
  const reference = typeof rawRef === "string" ? rawRef.trim() : "";
  if (!reference) {
    return res.status(400).json({ error: "reference_number is required." });
  }

  // Resolve county / constituency / ward from the point in parallel with the
  // duplicate check below — it never throws (best-effort), so no try needed.
  const adminPromise = resolveAdminAreas(geometry);

  // Reject a reference number already in use by a project.
  const dupQ = await queryLayer(CONFIG.projectsLayerUrl, {
    where: `project_reference_number = '${reference.replace(/'/g, "''")}'`,
    outFields: "objectid",
    returnCountOnly: "true",
  });
  if (dupQ.error) return res.status(502).json({ error: dupQ.error.message, detail: dupQ.error });
  if ((dupQ.count || 0) > 0) {
    return res.status(409).json({ error: `reference_number ${reference} is already in use.` });
  }

  const admin = await adminPromise; // { county, constituency, ward } — any may be null

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
      // Server-resolved administrative area (null where no polygon matched).
      county: admin.county,
      constituency: admin.constituency,
      ward: admin.ward,
    },
  };

  const projectFeature = {
    attributes: {
      ...pick(body.project, PROJECT_ATTRIBUTES),
      project_name: name,
      project_reference_number: reference,
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
      admin,
      facility: { objectId: facResult.objectId },
      project: { objectId: projResult.objectId },
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
