import Head from "next/head";
import { useEffect, useState } from "react";

const COLORS = {
  ok: "#188a42",
  degraded: "#b26a00",
  error: "#d83020",
};

const STATUS_LABEL = {
  ok: "All systems operational",
  degraded: "Degraded",
  error: "Service unavailable",
};

export default function Health() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/health");
      setHealth(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const status = health ? health.status : loading ? "degraded" : "error";
  const color = COLORS[status] || COLORS.error;

  return (
    <>
      <Head>
        <title>REREC Token Server · Health</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main style={S.wrap}>
        <div style={S.card}>
          <div style={S.header}>
            <div>
              <p style={S.eyebrow}>REREC · backend</p>
              <h1 style={S.title}>Token Server</h1>
            </div>
            <span style={{ ...S.dot, background: color }} aria-hidden />
          </div>

          <div style={{ ...S.statusRow, color }}>
            <strong style={S.statusText}>
              {loading && !health ? "Checking…" : STATUS_LABEL[status] || "Unknown"}
            </strong>
            <button style={S.refresh} onClick={load} disabled={loading}>
              {loading ? "…" : "Refresh"}
            </button>
          </div>

          {error && <div style={S.err}>Could not reach /api/health: {error}</div>}

          {health && (
            <>
              <ul style={S.checks}>
                {health.checks.map((c) => (
                  <li key={c.name} style={S.check}>
                    <span style={{ ...S.checkDot, background: c.ok ? COLORS.ok : (c.required ? COLORS.error : COLORS.degraded) }} />
                    <div>
                      <div style={S.checkName}>
                        {c.name.replace(/_/g, " ")}
                        {!c.required && <span style={S.optional}> · optional</span>}
                      </div>
                      <div style={S.checkDetail}>{c.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>

              <div style={S.meta}>
                <span>Uptime {formatUptime(health.uptimeSeconds)}</span>
                <span>Checked {new Date(health.time).toLocaleTimeString()}</span>
              </div>
            </>
          )}

          <div style={S.footer}>
            <a style={S.link} href="/docs">API documentation (Swagger)</a>
            <a style={S.linkMuted} href="/api/openapi">OpenAPI spec</a>
          </div>
        </div>
      </main>
    </>
  );
}

function formatUptime(s) {
  if (s == null) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

const S = {
  wrap: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "2rem",
    background: "#f4f5f7",
    fontFamily: "system-ui, 'Segoe UI', Roboto, sans-serif",
    color: "#2b2b2b",
  },
  card: {
    width: "100%",
    maxWidth: 560,
    background: "#fff",
    borderRadius: 14,
    boxShadow: "0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06)",
    padding: "1.75rem",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  eyebrow: { margin: 0, fontSize: ".72rem", letterSpacing: ".08em", textTransform: "uppercase", color: "#8a8f98" },
  title: { margin: ".15rem 0 0", fontSize: "1.5rem" },
  dot: { width: 16, height: 16, borderRadius: "50%", marginTop: 4, boxShadow: "0 0 0 4px rgba(0,0,0,.05)" },
  statusRow: { display: "flex", alignItems: "center", justifyContent: "space-between", margin: "1.25rem 0 .5rem" },
  statusText: { fontSize: "1.1rem" },
  refresh: {
    border: "1px solid #d0d3d8", background: "#fff", color: "#2b2b2b",
    borderRadius: 8, padding: ".35rem .8rem", fontSize: ".85rem", cursor: "pointer",
  },
  err: { background: "#fdecea", color: COLORS.error, padding: ".6rem .8rem", borderRadius: 8, fontSize: ".85rem" },
  checks: { listStyle: "none", margin: "1rem 0", padding: 0, display: "flex", flexDirection: "column", gap: ".75rem" },
  check: { display: "flex", gap: ".7rem", alignItems: "flex-start" },
  checkDot: { width: 10, height: 10, borderRadius: "50%", marginTop: 5, flex: "0 0 auto" },
  checkName: { fontWeight: 600, fontSize: ".95rem", textTransform: "capitalize" },
  optional: { fontWeight: 400, color: "#8a8f98", textTransform: "none" },
  checkDetail: { fontSize: ".82rem", color: "#6b7280", marginTop: 2 },
  meta: { display: "flex", justifyContent: "space-between", fontSize: ".78rem", color: "#8a8f98", borderTop: "1px solid #eee", paddingTop: ".75rem" },
  footer: { display: "flex", gap: "1.25rem", marginTop: "1.25rem", borderTop: "1px solid #eee", paddingTop: "1rem" },
  link: { color: "#0079c1", textDecoration: "none", fontWeight: 600, fontSize: ".9rem" },
  linkMuted: { color: "#8a8f98", textDecoration: "none", fontSize: ".9rem" },
};
