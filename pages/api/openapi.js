/* ---------------------------------------------------------------------------
 * GET /api/openapi
 *
 * The OpenAPI 3.0 description of this server's routes, served as JSON and
 * rendered by the Swagger UI at /docs.
 * ------------------------------------------------------------------------- */

const { applyCors, handlePreflight } = require("../../lib/cors");

const SPEC = {
  openapi: "3.0.3",
  info: {
    title: "REREC Token Server API",
    version: "1.0.0",
    description:
      "Server-side ArcGIS token minting and edit proxies. Portal credentials stay on the server; the browser only ever sees short-lived tokens and the results of proxied edits.",
  },
  servers: [{ url: "/", description: "This server" }],
  tags: [
    { name: "Health" },
    { name: "Auth" },
    { name: "Edits" },
  ],
  paths: {
    "/api/health": {
      get: {
        tags: ["Health"],
        summary: "Health probe",
        description: "Reports configuration and ArcGIS reachability.",
        responses: {
          200: {
            description: "ok or degraded",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Health" },
                example: {
                  status: "ok",
                  time: "2026-08-28T09:00:00.000Z",
                  uptimeSeconds: 3600,
                  checks: [
                    { name: "configuration", required: true, ok: true, detail: "Required environment variables present." },
                    { name: "arcgis_portal", required: true, ok: true, detail: "Portal reachable; token valid until …" },
                  ],
                },
              },
            },
          },
          503: { description: "a required check failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } } },
        },
      },
    },
    "/api/token": {
      get: {
        tags: ["Auth"],
        summary: "Mint a portal token",
        description:
          "Returns a short-lived, referer-bound ArcGIS token. The credentials never leave the server.",
        responses: {
          200: {
            description: "token minted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { token: { type: "string" }, expires: { type: "integer", description: "epoch ms" } },
                },
                example: { token: "AAPT…", expires: 1735689600000 },
              },
            },
          },
          405: { $ref: "#/components/responses/MethodNotAllowed" },
          500: { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/api/create-facility-and-project": {
      post: {
        tags: ["Edits"],
        summary: "Create a facility + a tied project",
        description:
          "Creates a facility point and a matching project record, joined by a server-generated reference_number. Writable fields are whitelisted server-side.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateFacilityAndProject" },
              example: {
                feature: {
                  geometry: { x: 4096000, y: -140200, spatialReference: { wkid: 102100 } },
                  attributes: { name: "Westlands Substation", electrification_status: "ELECTRIFIED", connection_type: "GRID" },
                },
                project: { reference_number: "REC-0803425/26001", funding_year: "2025/2026", initiator_category: "REREC", funding_category: "GoK" },
              },
            },
          },
        },
        responses: {
          200: {
            description: "both records created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    reference_number: { type: "string" },
                    facility: { type: "object", properties: { objectId: { type: "integer" } } },
                    project: { type: "object", properties: { objectId: { type: "integer" } } },
                  },
                },
                example: { reference_number: "REC-1234567/26123", facility: { objectId: 42 }, project: { objectId: 13 } },
              },
            },
          },
          400: { $ref: "#/components/responses/BadRequest" },
          405: { $ref: "#/components/responses/MethodNotAllowed" },
          409: { description: "reference_number already in use", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } },
          502: { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/api/survey-assignments": {
      post: {
        tags: ["Edits"],
        summary: "Assign a surveyor to a project",
        description:
          "Given a project's reference_number, fills the matching facility's task fields (esritask_assignee/status/duedate/description[/priority]) and sets the project's surveyed_by.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SurveyAssignment" },
              example: {
                reference_number: "REC-0803425/26001",
                surveyor: "skinyanjui_esriea",
                surveyor_name: "Steve",
                priority: "Medium",
                due_date: "2026-09-30",
                description: "Survey the access route.",
              },
            },
          },
        },
        responses: {
          200: {
            description: "assigned",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    reference_number: { type: "string" },
                    facility: { type: "object", properties: { objectId: { type: "integer" } } },
                    project: { type: "object", properties: { objectId: { type: "integer" }, surveyed_by: { type: "string" } } },
                  },
                },
              },
            },
          },
          400: { $ref: "#/components/responses/BadRequest" },
          404: { description: "no facility/project with that reference_number", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } },
          405: { $ref: "#/components/responses/MethodNotAllowed" },
          502: { $ref: "#/components/responses/Error" },
        },
      },
    },
  },
  components: {
    schemas: {
      ErrorBody: { type: "object", properties: { error: { type: "string" } } },
      Health: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "degraded", "error"] },
          time: { type: "string", format: "date-time" },
          uptimeSeconds: { type: "integer" },
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, required: { type: "boolean" }, ok: { type: "boolean" }, detail: { type: "string" } },
            },
          },
        },
      },
      Geometry: {
        type: "object",
        required: ["x", "y"],
        properties: { x: { type: "number" }, y: { type: "number" }, spatialReference: { type: "object" } },
      },
      CreateFacilityAndProject: {
        type: "object",
        required: ["feature"],
        properties: {
          feature: {
            type: "object",
            required: ["geometry", "attributes"],
            properties: {
              geometry: { $ref: "#/components/schemas/Geometry" },
              attributes: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  id: { type: "string" },
                  electrification_status: { type: "string" },
                  connection_type: { type: "string" },
                  electrification_date: { type: "integer", description: "epoch ms" },
                },
              },
            },
          },
          project: {
            type: "object",
            required: ["reference_number"],
            properties: {
              reference_number: { type: "string", description: "Ties the facility + project. Required; must be unused." },
              funding_year: { type: "string" },
              initiator_category: { type: "string" },
              funding_category: { type: "string" },
            },
          },
        },
      },
      SurveyAssignment: {
        type: "object",
        required: ["reference_number", "surveyor"],
        properties: {
          reference_number: { type: "string" },
          surveyor: { type: "string", description: "esritask_assignee code (username)" },
          surveyor_name: { type: "string", description: "stored in project.surveyed_by" },
          priority: { type: "string", enum: ["Low", "Medium", "High"] },
          due_date: { type: "string", format: "date" },
          description: { type: "string" },
        },
      },
    },
    responses: {
      BadRequest: { description: "invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } },
      MethodNotAllowed: { description: "wrong HTTP method", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } },
      Error: { description: "server or upstream error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } },
    },
  },
};

export default function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(SPEC);
}
