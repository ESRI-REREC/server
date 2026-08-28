import Head from "next/head";
import { useEffect } from "react";

/* Swagger UI rendered from the CDN (swagger-ui-dist) against /api/openapi.
 * Kept as a client-only page so the bundle loads in the browser. */
const SWAGGER_VERSION = "5.17.14";

export default function Docs() {
  useEffect(() => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css`;
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = `https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js`;
    script.crossOrigin = "anonymous";
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
      </Head>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #eee", fontFamily: "system-ui, sans-serif" }}>
        <a href="/" style={{ color: "#0079c1", textDecoration: "none", fontWeight: 600 }}>← Health</a>
      </div>
      <div id="swagger-ui" />
    </>
  );
}
