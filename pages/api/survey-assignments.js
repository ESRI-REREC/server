/* ---------------------------------------------------------------------------
 * POST /api/survey-assignments
 *
 * Assigns a surveyor to a project's field survey. Given a project's
 * reference_number, the server:
 *   1. finds the Facilities feature with the same reference_number and fills in
 *      esritask_assignee, esritask_status (Assigned), esritask_duedate,
 *      esritask_description (and esritask_priority);
 *   2. finds the Projects feature with the same reference_number and sets
 *      surveyed_by.
 *
 * Credentials never reach the browser — the server holds the editing token.
 *
 * Request body (JSON):
 *   {
 *     reference_number: "REC-0803425/26001",  // required
 *     surveyor: "skinyanjui_esriea",           // required (esritask_assignee code)
 *     surveyor_name: "Steve",                  // optional (stored in surveyed_by)
 *     priority: "Medium",                      // optional (Low|Medium|High|...)
 *     due_date: "2026-09-30",                  // optional (YYYY-MM-DD)
 *     description: "Survey the access route"   // optional
 *   }
 *
 * Responses:
 *   200 { ok, reference_number, facility:{objectId}, project:{objectId, surveyed_by} }
 *   400 bad request       404 no facility/project for that reference_number
 *   405 wrong method      500 server misconfigured      502 ArcGIS error
 * ------------------------------------------------------------------------- */

const { CONFIG, queryLayer, updateFeatures } = require("../../lib/arcgis");
const { applyCors, handlePreflight } = require("../../lib/cors");

/** esritask_status coded value for "Assigned". */
const ASSIGNED_STATUS = 1;

/** esritask_priority coded values (from the Facilities domain). */
const PRIORITY_CODES = { None: 0, Low: 1, Medium: 2, High: 3, Critical: 4 };

/** "YYYY-MM-DD" (or ISO) -> epoch ms (UTC), or null. */
function toEpochMs(dateStr) {
  if (!dateStr) return null;
  const iso = String(dateStr).length <= 10 ? `${dateStr}T00:00:00Z` : dateStr;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Return an error string if an ArcGIS edit response failed, else null. */
function editError(json) {
  if (!json) return "no response";
  if (json.error) return json.error.message;
  const results = json.updateResults || [];
  const failed = results.find((r) => r && r.success === false);
  if (failed) return (failed.error && failed.error.description) || "update rejected";
  if (results.length === 0) return "no records updated";
  return null;
}

function oidOf(feature) {
  const a = (feature && feature.attributes) || {};
  return a.objectid ?? a.OBJECTID ?? a.ObjectId ?? null;
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  if (!CONFIG.projectsLayerUrl) {
    return res
      .status(500)
      .json({ error: "Server is missing ARCGIS_PROJECTS_LAYER_URL." });
  }

  const body = req.body || {};
  const reference =
    typeof body.reference_number === "string" ? body.reference_number.trim() : "";
  const surveyor = typeof body.surveyor === "string" ? body.surveyor.trim() : "";
  const surveyorName =
    typeof body.surveyor_name === "string" && body.surveyor_name.trim()
      ? body.surveyor_name.trim()
      : surveyor;
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const dueMs = toEpochMs(body.due_date);

  if (!reference) return res.status(400).json({ error: "reference_number is required." });
  if (!surveyor) return res.status(400).json({ error: "surveyor is required." });

  const whereRef = `reference_number = '${reference.replace(/'/g, "''")}'`;

  try {
    // 1) Facility with this reference_number.
    const facQ = await queryLayer(CONFIG.facilitiesLayerUrl, {
      where: whereRef,
      outFields: "objectid",
    });
    if (facQ.error) return res.status(502).json({ error: facQ.error.message, detail: facQ.error });

    const facOid = oidOf((facQ.features || [])[0]);
    if (facOid == null) {
      return res
        .status(404)
        .json({ error: `No facility found with reference_number ${reference}.` });
    }

    // 2) Fill in the facility's task fields.
    const facAttrs = {
      objectid: facOid,
      esritask_assignee: surveyor,
      esritask_status: ASSIGNED_STATUS,
      esritask_duedate: dueMs,
      esritask_description: description || null,
    };
    if (body.priority && PRIORITY_CODES[body.priority] != null) {
      facAttrs.esritask_priority = PRIORITY_CODES[body.priority];
    }
    const facUpd = await updateFeatures(CONFIG.facilitiesLayerUrl, [{ attributes: facAttrs }]);
    const facErr = editError(facUpd);
    if (facErr) {
      return res.status(502).json({ error: `Facility update failed: ${facErr}`, detail: facUpd });
    }

    // 3) Project with this reference_number -> set surveyed_by.
    const projQ = await queryLayer(CONFIG.projectsLayerUrl, {
      where: whereRef,
      outFields: "objectid",
    });
    if (projQ.error) return res.status(502).json({ error: projQ.error.message, detail: projQ.error });

    const projOid = oidOf((projQ.features || [])[0]);
    if (projOid == null) {
      return res
        .status(404)
        .json({ error: `No project found with reference_number ${reference}.` });
    }

    const projUpd = await updateFeatures(CONFIG.projectsLayerUrl, [
      { attributes: { objectid: projOid, surveyed_by: surveyorName } },
    ]);
    const projErr = editError(projUpd);
    if (projErr) {
      return res.status(502).json({ error: `Project update failed: ${projErr}`, detail: projUpd });
    }

    return res.status(200).json({
      ok: true,
      reference_number: reference,
      facility: { objectId: facOid },
      project: { objectId: projOid, surveyed_by: surveyorName },
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
