/* Landing page: the server's purpose, a live health badge, and a link to the
 * Swagger docs. Detailed checks live at /api/health; the JSON at /api/health. */

import Head from "next/head";

const { getToken } = require("../lib/arcgis");

export async function getServerSideProps() {
  let status = "ok";
  try {
    await getToken();
  } catch (err) {
    status = "error";
  }
  return { props: { status, timestamp: new Date().toISOString() } };
}

export default function Index({ status, timestamp }) {
  const ok = status === "ok";
  return (
    <>
      <Head>
        <title>REREC Token Server</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main style={S.wrap}>
        <div style={S.card}>
          <div style={S.badgeRow}>
            <span style={{ ...S.badge, background: ok ? "#e7f6ec" : "#fdecea", color: ok ? "#188a42" : "#d83020" }}>
              <span style={{ ...S.dot, background: ok ? "#188a42" : "#d83020" }} />
              {ok ? "operational" : "error"}
            </span>
            <span style={S.time}>{new Date(timestamp).toLocaleString()}</span>
          </div>

          <h1 style={S.title}>REREC Token Server</h1>

          <p style={S.lead}>
            A small backend for the REREC ArcGIS apps. It keeps the portal
            credentials on the server so they never reach the browser, mints
            short-lived tokens, and proxies edits — creating a facility and its
            tied project, and assigning surveyors — with server-side validation.
          </p>

          <div style={S.actions}>
            <a style={S.primary} href="/docs">API documentation (Swagger)</a>
            <a style={S.secondary} href="/api/health">Health JSON</a>
          </div>
        </div>
      </main>
    </>
  );
}

const S = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem", background: "#f4f5f7" },
  card: { width: "100%", maxWidth: 560, background: "#fff", borderRadius: 14, boxShadow: "0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06)", padding: "2rem" },
  badgeRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" },
  badge: { display: "inline-flex", alignItems: "center", gap: ".4rem", padding: ".2rem .6rem", borderRadius: 999, fontSize: ".78rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" },
  dot: { width: 8, height: 8, borderRadius: "50%" },
  time: { fontSize: ".78rem", color: "#8a8f98" },
  title: { margin: ".25rem 0 .75rem", fontSize: "1.6rem" },
  lead: { margin: 0, color: "#4b5563", fontSize: "1rem" },
  actions: { display: "flex", gap: ".75rem", marginTop: "1.75rem", flexWrap: "wrap" },
  primary: { background: "#0079c1", color: "#fff", textDecoration: "none", fontWeight: 600, padding: ".6rem 1.1rem", borderRadius: 8, fontSize: ".92rem" },
  secondary: { color: "#0079c1", textDecoration: "none", fontWeight: 600, padding: ".6rem 1.1rem", borderRadius: 8, fontSize: ".92rem", border: "1px solid #cfe6f5" },
};
