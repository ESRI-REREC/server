# REREC Token Server

A small [Next.js](https://nextjs.org/) (Pages Router) backend for the REREC
apps. It keeps the ArcGIS portal credentials on the server and exposes routes the
browser can call instead of talking to `development.esriea.com` directly:

| Method | Route                            | Purpose                                                              |
| ------ | -------------------------------- | ------------------------------------------------------------------- |
| `GET`  | `/api/health`                    | Health probe (config + ArcGIS reachability).                        |
| `GET`  | `/api/token`                     | Mint a short-lived portal token server-side; return only the token. |
| `POST` | `/api/create-facility-and-project` | Create a facility point + a matching project, tied by a generated `reference_number`. |
| `POST` | `/api/survey-assignments`        | Assign a surveyor: fill the facility task fields + the project's `surveyed_by`. |
| `GET`  | `/api/openapi`                   | OpenAPI 3.0 spec (rendered by the Swagger UI at `/docs`).           |

`/` is a **health status** page; `/docs` is the **Swagger UI** for the routes.

```
lib/arcgis.js          credentials, token cache, addFeaturesTo / queryLayer / updateFeatures
pages/api/token.js     GET  /api/token
pages/api/health.js    GET  /api/health
pages/api/create-facility-and-project.js  POST create facility + project
pages/api/survey-assignments.js           POST assign a surveyor
pages/api/openapi.js   GET  /api/openapi  (OpenAPI spec)
pages/index.js         health status page
pages/docs.js          Swagger UI
.env.local             real credentials (gitignored)
.env.local.example     template
```

## Setup

```powershell
cd F:\esri\rerec\server
npm install
```

Copy the env template and fill it in (a working `.env.local` with the values
from `facility-creation/config.js` is already present for local dev):

```powershell
copy .env.local.example .env.local
```

| Variable                          | Meaning                                                       |
| --------------------------------- | ------------------------------------------------------------ |
| `ARCGIS_PORTAL_URL`               | Portal base URL. `generateToken` = `${PORTAL}/sharing/rest/generateToken`. |
| `ARCGIS_FACILITIES_LAYER_URL`     | Facilities layer. `addFeatures` = `${LAYER}/addFeatures`.    |
| `ARCGIS_PROJECTS_LAYER_URL`       | Projects table. Used by `/api/survey-assignments`. Optional. |
| `ARCGIS_USERNAME` / `_PASSWORD`   | Account credentials. Prefer a dedicated, least-privilege user. |
| `ARCGIS_REFERER`                  | Origin the referer-based token is bound to. Set to the app's public origin. |
| `ARCGIS_TOKEN_EXPIRATION_MINUTES` | Token lifetime; the server re-mints automatically.           |

## Run

```powershell
npm run dev      # http://localhost:3000
npm run build
npm start
```

## Wiring the client

In the Create Facility app's `app.js`:

**Token route (minimal change).** Replace `mintToken()` with a call to this
server:

```js
async function mintToken() {
  const res = await fetch("http://localhost:3000/api/token");
  const json = await res.json();
  if (!json.token) throw new Error(json.error || "Could not sign in");
  token = json.token;
  tokenExpires = json.expires;
  return token;
}
```

Everything downstream already works off a bare token. Note the browser then uses
that token directly against the portal, so the app must be served from the origin
in `ARCGIS_REFERER`.

**addFeatures proxy (stricter).** Point `addFeature()` at this server instead of
the layer, and drop the token entirely — the server adds it:

```js
async function addFeature(feature) {
  const res = await fetch("http://localhost:3000/api/addFeatures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ features: [feature] }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  const result = (json.addResults || [])[0];
  if (!result || !result.success) throw new Error("The edit was rejected.");
  return result;
}
```

With the proxy, the token never reaches the browser at all.

## Notes

- **Token cache.** `lib/arcgis.js` keeps one token in memory for the whole Node
  process and re-mints a minute before expiry. `/api/addFeatures` retries once
  with a fresh token if the service reports it stale (error 498/499).
- **Field whitelist.** `/api/addFeatures` writes only `name`, `id`,
  `electrification_status`, `connection_type`, `electrification_date`. `name` is
  required; other fields are dropped rather than passed through.
- **Referer binding.** Tokens are bound to `ARCGIS_REFERER`; the proxy sends a
  matching `Referer` header on its outbound request so ArcGIS accepts the token.
- **CORS.** If the client is served from a different origin than this server,
  add CORS handling (or serve both from the same origin / reverse proxy).
