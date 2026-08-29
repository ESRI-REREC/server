/* ---------------------------------------------------------------------------
 * GET /api/project-package
 *
 * Streams a fixed ArcGIS portal item (an ArcGIS Pro project package, .ppkx)
 * back to the browser as a download. The server fetches the item's data with
 * its own referer-bound token and the matching Referer header, so the browser
 * never needs a portal token (which, being referer-bound, otherwise triggers a
 * sign-in prompt when the page origin doesn't match the token binding).
 *
 * Query:
 *   itemId  optional portal item id (defaults to DEFAULT_ITEM_ID)
 *
 * Responses:
 *   200 the package bytes (Content-Disposition: attachment; filename=…)
 *   400 bad itemId   405 wrong method   502 portal error
 * ------------------------------------------------------------------------- */

const { CONFIG, getToken } = require("../../lib/arcgis");
const { applyCors, handlePreflight } = require("../../lib/cors");

/** The project package served by the Mapping & Cartography "Download .ppkx". */
const DEFAULT_ITEM_ID = "93ac6fcbe9be4733945effdf60e0d1c8";
const DOWNLOAD_NAME = "Project_Design.ppkx";

export const config = { api: { responseLimit: false } };

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }

  const itemId =
    (typeof req.query.itemId === "string" && req.query.itemId) || DEFAULT_ITEM_ID;
  if (!/^[A-Za-z0-9]+$/.test(itemId)) {
    return res.status(400).json({ error: "Invalid itemId." });
  }

  try {
    const { token } = await getToken();
    const url =
      `${CONFIG.portalUrl}/sharing/rest/content/items/${itemId}/data` +
      `?token=${encodeURIComponent(token)}`;

    const upstream = await fetch(url, { headers: { Referer: CONFIG.referer } });
    const ctype = upstream.headers.get("content-type") || "";

    // The portal reports errors as HTML/JSON with a 200, so sniff the type too.
    if (!upstream.ok || ctype.includes("text/html") || ctype.includes("application/json")) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 300);
      return res
        .status(502)
        .json({ error: "Could not fetch the package from the portal.", detail });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${DOWNLOAD_NAME}"`);
    res.setHeader("Content-Length", String(buffer.length));
    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
