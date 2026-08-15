import { sha256Hex } from "@ram-coffers-uplink/protocol";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { findKeyByHash } from "./auth.js";
import { collectKnownModels, resolveModelPermission } from "./policy.js";
import { getStatsEnabled } from "./store.js";

const STATEMENT =
  "Prompts and responses are proxied through memory only and are never stored or logged by ram-coffers-uplink. " +
  "Only the aggregate counters shown on this page are recorded, and only while statistics are enabled.";

export function registerPrivacyRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/api/privacy/session", async (req, reply) => {
    const { key } = (req.body ?? {}) as { key?: unknown };
    const row = typeof key === "string" ? findKeyByHash(deps.db, sha256Hex(key)) : null;
    if (!row) return reply.code(401).send({ error: "invalid API key" });
    const statsEnabled = getStatsEnabled(deps.db, deps.config.statsEnabled);
    const models = collectKnownModels(deps.db, deps.registry).map((model) => ({
      model,
      ...resolveModelPermission(deps.db, row.id, model),
    }));
    const stats = statsEnabled
      ? deps.db
          .prepare(
            `SELECT s.key_id, k.name AS key_name, s.model, s.hour, s.requests, s.prompt_tokens, s.completion_tokens, s.errors
             FROM stats_hourly s JOIN api_keys k ON k.id = s.key_id
             WHERE s.key_id = ? ORDER BY s.hour DESC, s.model LIMIT 500`,
          )
          .all(row.id)
      : null;
    return {
      name: row.name,
      rpm_limit: row.rpm_limit,
      tokens_per_day: row.tokens_per_day,
      stats_enabled: statsEnabled,
      models,
      stats,
      statement: STATEMENT,
    };
  });
}
