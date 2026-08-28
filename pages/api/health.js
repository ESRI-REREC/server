/* ---------------------------------------------------------------------------
 * GET /api/health
 *
 * Lightweight health probe. Reports whether the server is configured and can
 * reach ArcGIS (by minting/validating a token). Used by the index page.
 *
 * Response 200: { status: "ok"|"degraded", time, uptimeSeconds, checks:[...] }
 * Response 503: { status: "error", ... }   (a required check failed)
 * ------------------------------------------------------------------------- */

const { CONFIG, getToken } = require("../../lib/arcgis");
const { applyCors, handlePreflight } = require("../../lib/cors");

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }

  const checks = [];

  const configOk = Boolean(
    CONFIG.portalUrl && CONFIG.facilitiesLayerUrl && CONFIG.username && CONFIG.password
  );
  checks.push({
    name: "configuration",
    required: true,
    ok: configOk,
    detail: configOk ? "Required environment variables present." : "Missing required environment variables.",
  });

  checks.push({
    name: "projects_layer",
    required: false,
    ok: Boolean(CONFIG.projectsLayerUrl),
    detail: CONFIG.projectsLayerUrl
      ? "Configured — survey assignment + project creation available."
      : "ARCGIS_PROJECTS_LAYER_URL not set (those routes are disabled).",
  });

  let arcgisOk = false;
  let arcgisDetail = "";
  try {
    const { expires } = await getToken();
    arcgisOk = true;
    arcgisDetail = `Portal reachable; token valid until ${new Date(expires).toISOString()}.`;
  } catch (err) {
    arcgisDetail = `Could not mint a token: ${err.message}`;
  }
  checks.push({ name: "arcgis_portal", required: true, ok: arcgisOk, detail: arcgisDetail });

  const requiredOk = checks.filter((c) => c.required).every((c) => c.ok);
  const allOk = checks.every((c) => c.ok);
  const status = !requiredOk ? "error" : allOk ? "ok" : "degraded";

  res.setHeader("Cache-Control", "no-store");
  return res.status(status === "error" ? 503 : 200).json({
    status,
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks,
  });
}
