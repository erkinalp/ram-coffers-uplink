import { randomBytes, timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import { sha256Hex } from "@ram-coffers-uplink/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "./app.js";
import { collectKnownModels } from "./policy.js";
import { getSetting, getStatsEnabled, setStatsEnabled } from "./store.js";

function tokenEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function body(req: FastifyRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function paramId(req: FastifyRequest): number {
  return Number((req.params as { id: string }).id);
}

function isValidLimit(value: unknown): boolean {
  // Limits below 1 would reject every request (see RateLimiter), so the admin
  // API refuses to store them instead of silently breaking a key.
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// Admin sessions expire after 12 hours; the timestamp is checked on every
// authenticated request so expired entries are also evicted from the map.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  await app.register(cookie, { secret: deps.config.sessionSecret });
  const sessions = new Map<string, number>();

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const raw = req.cookies.rc_session;
    const signed = raw ? req.unsignCookie(raw) : null;
    const sessionId = signed?.valid && signed.value ? signed.value : null;
    const createdAt = sessionId === null ? undefined : sessions.get(sessionId);
    if (sessionId === null || createdAt === undefined) {
      await reply.code(401).send({ error: "authentication required" });
      return;
    }
    if (Date.now() - createdAt >= SESSION_TTL_MS) {
      sessions.delete(sessionId);
      await reply.code(401).send({ error: "authentication required" });
    }
  };

  app.post("/admin/api/login", async (req, reply) => {
    const token = body(req).token;
    if (typeof token !== "string" || !tokenEquals(token, deps.config.adminToken)) {
      return reply.code(401).send({ error: "invalid token" });
    }
    const sessionId = randomBytes(32).toString("hex");
    sessions.set(sessionId, Date.now());
    void reply.setCookie("rc_session", sessionId, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      signed: true,
    });
    return { ok: true };
  });

  app.post("/admin/api/logout", { preHandler: requireAdmin }, async (req, reply) => {
    const signed = req.unsignCookie(req.cookies.rc_session ?? "");
    if (signed.valid && signed.value) sessions.delete(signed.value);
    void reply.clearCookie("rc_session", { path: "/" });
    return { ok: true };
  });

  app.get("/admin/api/keys", { preHandler: requireAdmin }, async () =>
    deps.db
      .prepare(
        "SELECT id, name, created_at, rpm_limit, tokens_per_day, revoked FROM api_keys ORDER BY id",
      )
      .all(),
  );

  app.post("/admin/api/keys", { preHandler: requireAdmin }, async (req, reply) => {
    const { name, rpm_limit, tokens_per_day } = body(req);
    if (typeof name !== "string" || name.trim() === "")
      return reply.code(400).send({ error: "name is required" });
    for (const [field, value] of [
      ["rpm_limit", rpm_limit],
      ["tokens_per_day", tokens_per_day],
    ] as const) {
      if (value !== undefined && value !== null && !isValidLimit(value)) {
        return reply.code(400).send({ error: `invalid ${field}` });
      }
    }
    const key = `rc_sk_${randomBytes(24).toString("hex")}`;
    const info = deps.db
      .prepare(
        "INSERT INTO api_keys (key_hash, name, rpm_limit, tokens_per_day) VALUES (?, ?, ?, ?)",
      )
      .run(sha256Hex(key), name.trim(), rpm_limit ?? null, tokens_per_day ?? null);
    return { id: Number(info.lastInsertRowid), key };
  });

  app.patch("/admin/api/keys/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = paramId(req);
    if (!deps.db.prepare("SELECT id FROM api_keys WHERE id = ?").get(id))
      return reply.code(404).send({ error: "not found" });
    const { name, rpm_limit, tokens_per_day } = body(req);
    // Validate every provided field before writing anything so a rejected
    // patch leaves the key untouched.
    if (name !== undefined && (typeof name !== "string" || name.trim() === ""))
      return reply.code(400).send({ error: "invalid name" });
    for (const [field, value] of [
      ["rpm_limit", rpm_limit],
      ["tokens_per_day", tokens_per_day],
    ] as const) {
      if (value !== undefined && value !== null && !isValidLimit(value))
        return reply.code(400).send({ error: `invalid ${field}` });
    }
    if (name !== undefined) {
      deps.db.prepare("UPDATE api_keys SET name = ? WHERE id = ?").run((name as string).trim(), id);
    }
    for (const [field, value] of [
      ["rpm_limit", rpm_limit],
      ["tokens_per_day", tokens_per_day],
    ] as const) {
      if (value !== undefined) {
        deps.db.prepare(`UPDATE api_keys SET ${field} = ? WHERE id = ?`).run(value, id);
      }
    }
    return { ok: true };
  });

  app.post("/admin/api/keys/:id/revoke", { preHandler: requireAdmin }, async (req, reply) => {
    const info = deps.db.prepare("UPDATE api_keys SET revoked = 1 WHERE id = ?").run(paramId(req));
    if (info.changes === 0) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  app.get("/admin/api/keys/:id/policy", { preHandler: requireAdmin }, async (req) =>
    deps.db
      .prepare("SELECT model, mode FROM key_model_policy WHERE key_id = ? ORDER BY model")
      .all(paramId(req)),
  );

  app.put("/admin/api/keys/:id/policy", { preHandler: requireAdmin }, async (req, reply) => {
    const { model, mode } = body(req);
    if (typeof model !== "string" || model === "")
      return reply.code(400).send({ error: "model is required" });
    const keyId = paramId(req);
    if (!deps.db.prepare("SELECT id FROM api_keys WHERE id = ?").get(keyId))
      return reply.code(404).send({ error: "not found" });
    if (mode === "inherit") {
      deps.db
        .prepare("DELETE FROM key_model_policy WHERE key_id = ? AND model = ?")
        .run(keyId, model);
    } else if (mode === "allow" || mode === "disallow") {
      deps.db
        .prepare(
          "INSERT INTO key_model_policy (key_id, model, mode) VALUES (?, ?, ?) ON CONFLICT (key_id, model) DO UPDATE SET mode = excluded.mode",
        )
        .run(keyId, model, mode);
    } else {
      return reply.code(400).send({ error: "mode must be allow, disallow or inherit" });
    }
    return { ok: true };
  });

  app.get("/admin/api/policy/global", { preHandler: requireAdmin }, async () =>
    deps.db.prepare("SELECT model, mode FROM global_model_policy ORDER BY model").all(),
  );

  app.put("/admin/api/policy/global", { preHandler: requireAdmin }, async (req, reply) => {
    const { model, mode } = body(req);
    if (typeof model !== "string" || model === "")
      return reply.code(400).send({ error: "model is required" });
    if (mode === "default") {
      deps.db.prepare("DELETE FROM global_model_policy WHERE model = ?").run(model);
    } else if (mode === "allowed" || mode === "blocked") {
      deps.db
        .prepare(
          "INSERT INTO global_model_policy (model, mode) VALUES (?, ?) ON CONFLICT (model) DO UPDATE SET mode = excluded.mode",
        )
        .run(model, mode);
    } else {
      return reply.code(400).send({ error: "mode must be allowed, blocked or default" });
    }
    return { ok: true };
  });

  app.get("/admin/api/sidecars", { preHandler: requireAdmin }, async () => {
    const rows = deps.db
      .prepare("SELECT id, name, created_at, revoked FROM sidecars ORDER BY id")
      .all() as Array<{
      id: number;
      name: string;
      created_at: string;
      revoked: number;
    }>;
    const online = new Map(deps.registry.list().map((s) => [s.name, s]));
    return rows.map((row) => {
      const live = online.get(row.name);
      return {
        ...row,
        online: live !== undefined,
        connected_at: live?.connectedAt ?? null,
        active_requests: live?.activeRequests ?? 0,
        models: live?.models ?? [],
      };
    });
  });

  app.post("/admin/api/sidecars", { preHandler: requireAdmin }, async (req, reply) => {
    const { name } = body(req);
    if (typeof name !== "string" || name.trim() === "")
      return reply.code(400).send({ error: "name is required" });
    if (deps.db.prepare("SELECT id FROM sidecars WHERE name = ?").get(name.trim())) {
      return reply.code(409).send({ error: "a sidecar with this name already exists" });
    }
    const psk = `rc_psk_${randomBytes(24).toString("hex")}`;
    const info = deps.db
      .prepare("INSERT INTO sidecars (name, psk_hash) VALUES (?, ?)")
      .run(name.trim(), sha256Hex(psk));
    return { id: Number(info.lastInsertRowid), psk };
  });

  app.post("/admin/api/sidecars/:id/revoke", { preHandler: requireAdmin }, async (req, reply) => {
    const row = deps.db.prepare("SELECT id, name FROM sidecars WHERE id = ?").get(paramId(req)) as
      | { id: number; name: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    deps.db.prepare("UPDATE sidecars SET revoked = 1 WHERE id = ?").run(row.id);
    deps.registry.get(row.name)?.session.close();
    return { ok: true };
  });

  app.get("/admin/api/models", { preHandler: requireAdmin }, async () => ({
    models: collectKnownModels(deps.db, deps.registry),
  }));

  app.get("/admin/api/stats/status", { preHandler: requireAdmin }, async () => ({
    enabled: getStatsEnabled(deps.db, deps.config.statsEnabled),
    source: getSetting(deps.db, "stats_enabled") === null ? "env" : "setting",
  }));

  app.put("/admin/api/stats", { preHandler: requireAdmin }, async (req, reply) => {
    const { enabled, purge } = body(req);
    if (typeof enabled !== "boolean")
      return reply.code(400).send({ error: "enabled must be a boolean" });
    setStatsEnabled(deps.db, enabled, purge === true);
    return { ok: true };
  });

  app.get("/admin/api/stats", { preHandler: requireAdmin }, async () => ({
    rows: deps.db
      .prepare(
        `SELECT s.key_id, k.name AS key_name, s.model, s.hour, s.requests, s.prompt_tokens, s.completion_tokens, s.errors
         FROM stats_hourly s JOIN api_keys k ON k.id = s.key_id
         ORDER BY s.hour DESC, k.name, s.model LIMIT 500`,
      )
      .all(),
  }));
}
