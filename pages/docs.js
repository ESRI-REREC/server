import Head from "next/head";
import { useEffect } from "react";

/* Swagger UI, self-hosted from /public/swagger-ui (vendored on postinstall from
 * swagger-ui-dist — no CDN). Rendered client-side against /api/openapi. */
export default function Docs() {
  useEffect(() => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/swagger-ui/swagger-ui.css";
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = "/swagger-ui/swagger-ui-bundle.js";
    script.onload = () => {
      if (window.SwaggerUIBundle) {
        window.SwaggerUIBundle({
          url: "/api/openapi",
          dom_id: "#swagger-ui",
          deepLinking: true,
          docExpansion: "list",
          defaultModelsExpandDepth: 0,
        });
      }
    };
    document.body.appendChild(script);

    return () => {
      css.remove();
      script.remove();
    };
  }, []);

  return (
    <>
      <Head>
        <title>REREC Token Server · API Docs</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Force a light theme regardless of the OS/browser preference. */}
        <style>{`
          :root { color-scheme: light; }
          html, body { background: #fff; }
        `}</style>
      </Head>
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid #eee",
          background: "#fff",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <a href="/" style={{ color: "#0079c1", textDecoration: "none", fontWeight: 600 }}>
          ← Health
        </a>
      </div>
      <div id="swagger-ui" style={{ background: "#fff" }} />
    </>
  );
}
