import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { apiKeyAuth } from "./auth.js";
import { filterModels } from "./policy.js";

export function registerModelRoutes(app: FastifyInstance, deps: AppDeps): void {
  const auth = apiKeyAuth(deps.db);

  app.get("/api/tags", { preHandler: auth }, async (req) => {
    const keyId = (req.apiKey as { id: number }).id;
    const models = filterModels(deps.db, keyId, deps.registry.allModels());
    return {
      models: models.map((name) => ({
        name,
        model: name,
        modified_at: "2026-01-01T00:00:00.000Z",
        size: 0,
        digest: "",
        details: { format: "", family: "", parameter_size: "", quantization_level: "" },
      })),
    };
  });

  app.get("/v1/models", { preHandler: auth }, async (req) => {
    const keyId = (req.apiKey as { id: number }).id;
    const models = filterModels(deps.db, keyId, deps.registry.allModels());
    return {
      object: "list",
      data: models.map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "ram-coffers-uplink",
      })),
    };
  });
}
