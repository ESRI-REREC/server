/* ---------------------------------------------------------------------------
 * scripts/backfill-facility-admin-areas.js
 *
 * One-time backfill: fills the county / constituency / ward fields on EXISTING
 * Facilities point records by intersecting each point against the three
 * administrative boundary layers — the same method /api/create-facility-and-
 * project uses for new points (resolveAdminAreas).
 *
 * Only rows missing at least one of the three fields are considered, and only a
 * currently-blank field is filled (existing values are never overwritten, and a
 * field is left untouched when no polygon intersects). Writes nothing to the
 * electrification_projects table.
 *
 * Usage (from server/):
 *   node scripts/backfill-facility-admin-areas.js            # dry run (default)
 *   node scripts/backfill-facility-admin-areas.js --apply    # actually write
 *   node scripts/backfill-facility-admin-areas.js --limit=50 # cap rows (testing)
 *
 * Reads credentials/URLs from .env.local (same as the server).
 * ------------------------------------------------------------------------- */

// --- load .env.local into process.env BEFORE requiring lib/arcgis (its CONFIG
// reads env at require-time). Minimal parser; no dependency on dotenv. --------
const fs = require("fs");
const path = require("path");

(function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const { CONFIG, queryLayer, updateFeatures } = require("../lib/arcgis");

// --- CLI flags ---------------------------------------------------------------
const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

// --- tunables ----------------------------------------------------------------
const PAGE_SIZE = 1000; // rows fetched per query page (< maxRecordCount 2000)
const CONCURRENCY = 5; // facilities resolved in parallel (3 boundary queries each)
const UPDATE_CHUNK = 200; // features per updateFeatures call
const BOUNDARY_QUERY_TIMEOUT_MS = 8000;

/** Same boundary layers + fields as the create endpoint. */
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

const isBlank = (v) => v == null || v === "";

/**
 * Resolve county / constituency / ward for a point (identical approach to the
 * create endpoint's resolveAdminAreas — best-effort, each lookup independent).
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
        return [key, isBlank(value) ? null : value];
      } catch (err) {
        console.warn(`[admin-areas] ${key} lookup failed (${err.name}): ${err.message}`);
        return [key, null];
      }
    })
  );
  return Object.fromEntries(entries);
}

/** Fetch every facility (with geometry) still missing any admin field. */
async function fetchCandidates() {
  const where =
    "county IS NULL OR county = '' OR constituency IS NULL OR constituency = '' OR " +
    "ward IS NULL OR ward = ''";
  const out = [];
  let offset = 0;
  for (;;) {
    const json = await queryLayer(CONFIG.facilitiesLayerUrl, {
      where,
      outFields: "objectid,county,constituency,ward",
      returnGeometry: "true",
      orderByFields: "objectid",
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
    });
    if (json.error) throw new Error(`Facilities query failed: ${json.error.message}`);
    const feats = json.features || [];
    out.push(...feats);
    if (out.length >= LIMIT || feats.length < PAGE_SIZE || !json.exceededTransferLimit) break;
    offset += feats.length;
  }
  return out.slice(0, Number.isFinite(LIMIT) ? LIMIT : undefined);
}

/** Map a facility feature -> an update patch (only blank fields we resolved). */
function buildPatch(feature, admin) {
  const a = feature.attributes || {};
  const oid = a.objectid ?? a.OBJECTID;
  const attributes = { objectid: oid };
  let changed = false;
  for (const key of ["county", "constituency", "ward"]) {
    if (isBlank(a[key]) && !isBlank(admin[key])) {
      attributes[key] = admin[key];
      changed = true;
    }
  }
  return changed ? { attributes } : null;
}

/** Resolve admin areas for many features with bounded concurrency. */
async function resolveAll(features) {
  const patches = [];
  let done = 0;
  for (let i = 0; i < features.length; i += CONCURRENCY) {
    const batch = features.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (f) => {
        if (!f.geometry || typeof f.geometry.x !== "number") return null;
        const admin = await resolveAdminAreas(f.geometry);
        return buildPatch(f, admin);
      })
    );
    for (const p of results) if (p) patches.push(p);
    done += batch.length;
    process.stdout.write(`\r  resolved ${done}/${features.length}...`);
  }
  process.stdout.write("\n");
  return patches;
}

async function applyUpdates(patches) {
  let updated = 0;
  for (let i = 0; i < patches.length; i += UPDATE_CHUNK) {
    const chunk = patches.slice(i, i + UPDATE_CHUNK);
    const json = await updateFeatures(CONFIG.facilitiesLayerUrl, chunk);
    if (json.error) throw new Error(`updateFeatures failed: ${json.error.message}`);
    const results = json.updateResults || [];
    const failed = results.filter((r) => r && r.success === false);
    updated += results.length - failed.length;
    if (failed.length) {
      console.warn(`  ${failed.length} update(s) rejected in this chunk:`);
      failed.slice(0, 5).forEach((r) =>
        console.warn(`    oid ${r.objectId}: ${(r.error && r.error.description) || "rejected"}`)
      );
    }
  }
  return updated;
}

async function main() {
  console.log(`Facilities layer: ${CONFIG.facilitiesLayerUrl}`);
  console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}`);
  if (Number.isFinite(LIMIT)) console.log(`Row cap: ${LIMIT}`);

  console.log("\nFinding facilities missing county/constituency/ward...");
  const candidates = await fetchCandidates();
  console.log(`  ${candidates.length} candidate facilit${candidates.length === 1 ? "y" : "ies"}.`);
  if (!candidates.length) return;

  console.log("\nResolving administrative areas by point intersection...");
  const patches = await resolveAll(candidates);

  const fieldCounts = { county: 0, constituency: 0, ward: 0 };
  for (const p of patches)
    for (const k of ["county", "constituency", "ward"]) if (k in p.attributes) fieldCounts[k]++;

  console.log(`\n${patches.length} facilit${patches.length === 1 ? "y" : "ies"} would be updated.`);
  console.log(
    `  county: ${fieldCounts.county}  constituency: ${fieldCounts.constituency}  ward: ${fieldCounts.ward}`
  );
  console.log("  sample:");
  patches.slice(0, 10).forEach((p) => {
    const { objectid, ...vals } = p.attributes;
    console.log(`    oid ${objectid}: ${JSON.stringify(vals)}`);
  });

  if (!patches.length) return;

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to write these updates.");
    return;
  }

  console.log("\nApplying updates...");
  const updated = await applyUpdates(patches);
  console.log(`Done. ${updated} facilit${updated === 1 ? "y" : "ies"} updated.`);
}

main().catch((err) => {
  console.error("\nBackfill failed:", err.message);
  process.exit(1);
});
