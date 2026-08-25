import Head from "next/head";
import { useState } from "react";

export default function Home() {
  const [token, setToken] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function testToken() {
    setLoading(true);
    setError(null);
    setToken(null);
    try {
      const res = await fetch("/api/token");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setToken(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Head>
        <title>Facility Token Server</title>
        <meta
          name="description"
          content="Server-side ArcGIS token minting and addFeatures proxy for the Create Facility app."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main className="wrap">
        <header className="hero">
          <p className="eyebrow">Create Facility · backend</p>
          <h1>Facility Token Server</h1>
          <p className="lead">
            A small Next.js server that stands between the browser and{" "}
            <code>development.esriea.com</code>. It holds the ArcGIS credentials
            in environment variables so they never reach the browser, mints
            short-lived portal tokens, and can post edits to the Facilities layer
            on the client&apos;s behalf.
          </p>
        </header>

        <section>
          <h2>What it does</h2>
          <p style={{ color: "var(--muted)" }}>
            The <code>Create Facility</code> page originally shipped a username
            and password to every browser (see the app&apos;s{" "}
            <em>Security</em> section). This server removes that: the credentials
            live only in <code>.env.local</code> on the server, and the browser
            talks to two routes instead of talking to the portal directly.
          </p>
        </section>

        <section>
          <h2>Routes</h2>

          <div className="route">
            <h3>
              <span className="method get">GET</span>/api/token
            </h3>
            <p>
              Mints (or returns a cached) portal token server-side and returns
              only the token and its expiry. Replaces <code>mintToken()</code> in
              the client&apos;s <code>app.js</code> — everything downstream
              already works off a bare token.
            </p>
            <pre>
              <code>{`{ "token": "AAPT…", "expires": 1735689600000 }`}</code>
            </pre>
          </div>

          <div className="route">
            <h3>
              <span className="method post">POST</span>/api/addFeatures
            </h3>
            <p>
              The stricter option: the browser posts the feature here and the
              server attaches the token and forwards it to the layer&apos;s{" "}
              <code>/addFeatures</code> endpoint. The token never reaches the
              browser, and the server validates and whitelists the fields being
              written.
            </p>
            <pre>
              <code>{`POST /api/addFeatures
Content-Type: application/json

{
  "features": [
    {
      "geometry": { "x": 4096000, "y": -140200,
                    "spatialReference": { "wkid": 102100 } },
      "attributes": {
        "name": "Westlands Substation",
        "electrification_status": "ELECTRIFIED",
        "connection_type": "GRID"
      }
    }
  ]
}

→ { "addResults": [ { "objectId": 42, "success": true } ] }`}</code>
            </pre>
            <p>
              Writable fields: <code>name</code> (required), <code>id</code>,{" "}
              <code>electrification_status</code>,{" "}
              <code>connection_type</code>, <code>electrification_date</code>.
              Anything else is dropped.
            </p>
          </div>
        </section>

        <section>
          <h2>Request flow</h2>
          <ol className="flow">
            <li>
              Browser calls <code>GET /api/token</code> (or posts a feature to{" "}
              <code>/api/addFeatures</code>).
            </li>
            <li>
              Server reads the credentials from the environment and calls{" "}
              <code>generateToken</code> on the portal, caching the token in
              memory until a minute before it expires.
            </li>
            <li>
              For <code>/api/addFeatures</code>, the server validates the
              payload and forwards it to the Facilities layer with the token and
              a matching <code>Referer</code> header.
            </li>
            <li>The portal&apos;s response is relayed back to the browser.</li>
          </ol>
        </section>

        <section>
          <h2>Try it</h2>
          <div className="demo">
            <button onClick={testToken} disabled={loading}>
              {loading ? "Minting…" : "GET /api/token"}
            </button>
            {token && (
              <div className="result ok">
                {`token: ${token.token.slice(0, 16)}…\nexpires: ${new Date(
                  token.expires
                ).toISOString()}`}
              </div>
            )}
            {error && <div className="result err">error: {error}</div>}
          </div>
          <div className="note">
            The token is bound to the origin in <code>ARCGIS_REFERER</code>. For
            a browser to use a <code>/api/token</code> response directly against
            the portal, serve the app from that same origin. The{" "}
            <code>/api/addFeatures</code> proxy has no such constraint — the
            server sends the matching referer itself.
          </div>
        </section>

        <footer>
          Configure <code>.env.local</code> from{" "}
          <code>.env.local.example</code>, then <code>npm run dev</code>. See{" "}
          <code>README.md</code> for wiring the client&apos;s <code>app.js</code>{" "}
          to these routes.
        </footer>
      </main>
    </>
  );
}
