/* ---------------------------------------------------------------------------
 * scripts/reposition-facilities-by-name.js
 *
 * Repositions existing Facilities points so each lands inside the administrative
 * area its NAME refers to (e.g. "Dagoretti Market" -> inside Dagoretti), then
 * recomputes county / constituency / ward from the new position using the same
 * point-intersection method as /api/create-facility-and-project.
 *
 * Matching: the facility's first word is treated as the place token (true for
 * this dataset). It is matched as a WHOLE WORD against ward names first, then
 * constituency names (so "Karen" hits ward KAREN, not KIPKAREN). A small alias
 * table handles spellings with no polygon of their own.
 *
 * Placement: a random interior point of the matched polygon (rejection sampling
 * within its bounding box + point-in-polygon test), so points look natural and
 * are not stacked on a centroid. Falls back to the polygon centroid.
 *
 * Usage (from server/):
 *   node scripts/reposition-facilities-by-name.js            # dry run (default)
 *   node scripts/reposition-facilities-by-name.js --apply    # write geometry+fields
 *   node scripts/reposition-facilities-by-name.js --only=9,14 # limit to oids
 *
 * Reads credentials/URLs from .env.local (same as the server).
 * ------------------------------------------------------------------------- */

const fs = require("fs");
const path = require("path");

(function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim();
  }
})();

const { CONFIG, queryLayer, updateFeatures } = require("../lib/arcgis");

const APPLY = process.argv.includes("--apply");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.split("=")[1].split(",").map((s) => Number(s.trim()))) : null;

const WKID = 102100;
const SR = { wkid: 102100, latestWkid: 3857 };
const TIMEOUT = 8000;

const COUNTIES_URL =
  process.env.ARCGIS_COUNTIES_LAYER_URL ||
  "https://development.esriea.com/server/rest/services/Hosted/Counties/FeatureServer/0";
const CONSTITUENCIES_URL =
  process.env.ARCGIS_CONSTITUENCIES_LAYER_URL ||
  "https://development.esriea.com/server/rest/services/Hosted/Constituencies/FeatureServer/0";
const WARDS_URL =
  process.env.ARCGIS_WARDS_LAYER_URL ||
  "https://development.esriea.com/server/rest/services/Hosted/Wards/FeatureServer/0";

/** Boundary layers, finest first, for the name match. */
const MATCH_LAYERS = [
  { level: "ward", url: WARDS_URL, nameField: "name" },
  { level: "constituency", url: CONSTITUENCIES_URL, nameField: "constituen" },
];

/** Boundary layers for recomputing the three admin fields after the move. */
const ADMIN_LOOKUPS = [
  { key: "county", nameField: "county", url: COUNTIES_URL },
  { key: "constituency", nameField: "constituen", url: CONSTITUENCIES_URL },
  { key: "ward", nameField: "name", url: WARDS_URL },
];

/** Place tokens with no admin polygon of their own -> the admin word to use. */
const ALIASES = { KIBERA: "KIBRA", MIREMA: "ROYSAMBU" };

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9\s]/g, " ").trim();
const words = (s) => norm(s).split(/\s+/).filter(Boolean);
const isBlank = (v) => v == null || v === "";

/** Place token for a facility name: first word, alias-mapped. */
function placeToken(name) {
  const first = words(name)[0] || "";
  return ALIASES[first] || first;
}

/* ---- geometry helpers ---------------------------------------------------- */

/** Even-odd point-in-polygon across all rings of an esri polygon. */
function pointInPolygon(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
  }
  return inside;
}

function ringsBBox(rings) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const ring of rings)
    for (const [x, y] of ring) {
      if (x < xmin) xmin = x;
      if (y < ymin) ymin = y;
      if (x > xmax) xmax = x;
      if (y > ymax) ymax = y;
    }
  return { xmin, ymin, xmax, ymax };
}

/** A random point strictly inside the polygon (rejection sampling). */
function randomInteriorPoint(rings, centroid) {
  const { xmin, ymin, xmax, ymax } = ringsBBox(rings);
  for (let i = 0; i < 400; i++) {
    const x = xmin + Math.random() * (xmax - xmin);
    const y = ymin + Math.random() * (ymax - ymin);
    if (pointInPolygon(x, y, rings)) return { x, y };
  }
  return centroid; // fallback — rare for these shapes
}

/* ---- matching ------------------------------------------------------------ */

/** Find the polygon whose name contains `token` as a whole word, finest level
 * first. Returns { level, name, rings, centroid } or null. */
async function matchArea(token) {
  for (const { level, url, nameField } of MATCH_LAYERS) {
    const json = await queryLayer(
      url,
      {
        where: `UPPER(${nameField}) LIKE UPPER('%${token.replace(/'/g, "''")}%')`,
        outFields: nameField,
        returnGeometry: "true",
        returnCentroid: "true",
        outSR: String(WKID),
      },
      { timeoutMs: TIMEOUT }
    );
    if (json.error) throw new Error(`${level} match query failed: ${json.error.message}`);
    const hits = (json.features || [])
      .filter((f) => words(f.attributes[nameField]).includes(token))
      .sort((a, b) => String(a.attributes[nameField]).localeCompare(b.attributes[nameField]));
    if (hits.length) {
      const f = hits[0];
      return {
        level,
        name: f.attributes[nameField],
        rings: f.geometry.rings,
        centroid: f.centroid || null,
      };
    }
  }
  return null;
}

/** Recompute county/constituency/ward for a point (same as create endpoint). */
async function resolveAdminAreas(x, y) {
  const point = { x, y, spatialReference: SR };
  const entries = await Promise.all(
    ADMIN_LOOKUPS.map(async ({ key, nameField, url }) => {
      try {
        const json = await queryLayer(
          url,
          {
            geometry: JSON.stringify(point),
            geometryType: "esriGeometryPoint",
            inSR: String(WKID),
            spatialRel: "esriSpatialRelIntersects",
            outFields: nameField,
            returnGeometry: "false",
          },
          { timeoutMs: TIMEOUT }
        );
        if (json && json.error) return [key, null];
        const m = json && json.features && json.features[0];
        const v = m && m.attributes ? m.attributes[nameField] : null;
        return [key, isBlank(v) ? null : v];
      } catch {
        return [key, null];
      }
    })
  );
  return Object.fromEntries(entries);
}

/* ---- main ---------------------------------------------------------------- */

async function fetchFacilities() {
  const json = await queryLayer(CONFIG.facilitiesLayerUrl, {
    where: "1=1",
    outFields: "objectid,name,county,constituency,ward",
    returnGeometry: "true",
    outSR: String(WKID),
    orderByFields: "objectid",
  });
  if (json.error) throw new Error(`Facilities query failed: ${json.error.message}`);
  return json.features || [];
}

async function main() {
  console.log(`Facilities layer: ${CONFIG.facilitiesLayerUrl}`);
  console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}`);
  if (ONLY) console.log(`Only oids: ${[...ONLY].join(", ")}`);

  const facilities = (await fetchFacilities()).filter(
    (f) => !ONLY || ONLY.has(f.attributes.objectid)
  );
  console.log(`\n${facilities.length} facilit${facilities.length === 1 ? "y" : "ies"} to process.\n`);

  const updates = [];
  const skipped = [];
  for (const f of facilities) {
    const a = f.attributes;
    const token = placeToken(a.name);
    const area = token ? await matchArea(token) : null;
    if (!area) {
      skipped.push({ oid: a.objectid, name: a.name, token });
      console.log(`  oid ${a.objectid} "${a.name}" -> no match for "${token}" (skipped)`);
      continue;
    }
    const pt = randomInteriorPoint(area.rings, area.centroid);
    const admin = await resolveAdminAreas(pt.x, pt.y);
    updates.push({
      geometry: { x: pt.x, y: pt.y, spatialReference: SR },
      attributes: {
        objectid: a.objectid,
        county: admin.county,
        constituency: admin.constituency,
        ward: admin.ward,
      },
    });
    console.log(
      `  oid ${a.objectid} "${a.name}" -> ${area.level} ${area.name}` +
        `  =>  ${admin.county} / ${admin.constituency} / ${admin.ward}`
    );
  }

  console.log(
    `\n${updates.length} to reposition, ${skipped.length} skipped.` +
      (APPLY ? "" : "  (dry run — nothing written)")
  );
  if (!APPLY || !updates.length) {
    if (!APPLY && updates.length) console.log("Re-run with --apply to write these changes.");
    return;
  }

  console.log("\nApplying updates (geometry + admin fields)...");
  const json = await updateFeatures(CONFIG.facilitiesLayerUrl, updates);
  if (json.error) throw new Error(`updateFeatures failed: ${json.error.message}`);
  const results = json.updateResults || [];
  const failed = results.filter((r) => r && r.success === false);
  results
    .filter((r) => r && r.success === false)
    .forEach((r) => console.warn(`  oid ${r.objectId}: ${(r.error && r.error.description) || "rejected"}`));
  console.log(`Done. ${results.length - failed.length} updated, ${failed.length} failed.`);
}

main().catch((err) => {
  console.error("\nReposition failed:", err.message);
  process.exit(1);
});
