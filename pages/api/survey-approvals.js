/* ---------------------------------------------------------------------------
 * POST /api/survey-approvals
 *
 * Approves a completed field survey. Given a project's reference_number, the
 * server:
 *   1. finds the Facilities feature with the same reference_number and sets
 *      esritask_status to Completed (coded value 3);
 *   2. finds the Projects feature with the same reference_number and sets
 *      survey_approved_by + survey_approved_date.
 *
 * Mirrors /api/survey-assignments: the task status lives on Facilities, the
 * survey approval fields live on the electrification_projects table. Credentials
 * never reach the browser — the server holds the editing token.
 *
 * Request body (JSON):
 *   {
 *     reference_number: "REC-0803425/26001",  // required
 *     approved_by: "Jane Approver",            // required (survey_approved_by)
 *     approved_date: "2026-08-29"              // optional (YYYY-MM-DD; default now)
 *   }
 *
 * Responses:
 *   200 { ok, reference_number, facility:{objectId},
 *         project:{objectId, survey_approved_by, survey_approved_date} }
 *   400 bad request       404 no facility/project for that reference_number
 *   405 wrong method      500 server misconfigured      502 ArcGIS error
 * ------------------------------------------------------------------------- */

const { CONFIG, queryLayer, updateFeatures } = require("../../lib/arcgis");
const { applyCors, handlePreflight } = require("../../lib/cors");

/** esritask_status coded value for "Completed" (Facilities domain). */
const COMPLETED_STATUS = 3;

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
  const approvedBy =
    typeof body.approved_by === "string" ? body.approved_by.trim() : "";
  // Default the approval date to now when the client doesn't supply one.
  const approvedMs = toEpochMs(body.approved_date) ?? Date.now();

  if (!reference) return res.status(400).json({ error: "reference_number is required." });
  if (!approvedBy) return res.status(400).json({ error: "approved_by is required." });

  // Facilities keep `reference_number`; the Projects layer renamed it to
  // `project_reference_number`, so each side needs its own where clause.
  const whereRef = `reference_number = '${reference.replace(/'/g, "''")}'`;
  const whereProjectRef = `project_reference_number = '${reference.replace(/'/g, "''")}'`;

  try {
    // 1) Facility with this reference_number -> mark the task Completed.
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

    const facUpd = await updateFeatures(CONFIG.facilitiesLayerUrl, [
      { attributes: { objectid: facOid, esritask_status: COMPLETED_STATUS } },
    ]);
    const facErr = editError(facUpd);
    if (facErr) {
      return res.status(502).json({ error: `Facility update failed: ${facErr}`, detail: facUpd });
    }

    // 2) Project with this reference_number -> record the approval.
    const projQ = await queryLayer(CONFIG.projectsLayerUrl, {
      where: whereProjectRef,
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
      {
        attributes: {
          objectid: projOid,
          survey_approved_by: approvedBy,
          survey_approved_date: approvedMs,
        },
      },
    ]);
    const projErr = editError(projUpd);
    if (projErr) {
      return res.status(502).json({ error: `Project update failed: ${projErr}`, detail: projUpd });
    }

    return res.status(200).json({
      ok: true,
      reference_number: reference,
      facility: { objectId: facOid },
      project: {
        objectId: projOid,
        survey_approved_by: approvedBy,
        survey_approved_date: approvedMs,
      },
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
