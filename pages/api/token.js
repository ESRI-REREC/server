/* ---------------------------------------------------------------------------
 * GET /api/token
 *
 * Mints (or returns a cached) short-lived ArcGIS portal token server-side and
 * returns ONLY the token and its expiry. The username and password never leave
 * the server.
 *
 * Client change (README step 2): app.js calls this instead of mintToken().
 * The token returned is bound to ARCGIS_REFERER, so the browser using it must
 * be served from that same origin.
 *
 * Response 200: { token: string, expires: number }   // expires = epoch ms
 * Response 405: wrong method
 * Response 500: minting failed / misconfiguration
 * ------------------------------------------------------------------------- */

const { getToken } = require("../../lib/arcgis");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }

  try {
    const { token, expires } = await getToken();
    // Do not let intermediaries cache the token.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ token, expires });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
