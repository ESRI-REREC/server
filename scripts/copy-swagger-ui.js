/* ---------------------------------------------------------------------------
 * copy-swagger-ui.js — vendor the self-hosted Swagger UI assets.
 *
 * Copies the two files the /docs page needs from node_modules/swagger-ui-dist
 * into public/swagger-ui/, so the UI is served from this server (no CDN).
 * Runs on `postinstall`; safe to run by hand any time.
 * ------------------------------------------------------------------------- */

const fs = require("fs");
const path = require("path");

const SRC = path.dirname(require.resolve("swagger-ui-dist/package.json"));
const DEST = path.join(__dirname, "..", "public", "swagger-ui");
const FILES = ["swagger-ui.css", "swagger-ui-bundle.js"];

fs.mkdirSync(DEST, { recursive: true });
for (const file of FILES) {
  fs.copyFileSync(path.join(SRC, file), path.join(DEST, file));
  console.log(`copied ${file} -> public/swagger-ui/`);
}
