import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { setStatsEnabled } from "../src/store.js";
import { insertApiKey, makeTestDeps, type TestDeps } from "./helpers.js";

describe("privacy api", () => {
  let deps: TestDeps;
  let app: FastifyInstance;
  let keyId: number;

  beforeEach(async () => {
    deps = makeTestDeps();
    keyId = insertApiKey(deps.db, "key-1", "alice", { rpm: 60 });
    deps.db
      .prepare(
        "INSERT INTO key_model_policy (key_id, model, mode) VALUES (?, 'secret', 'disallow')",
      )
      .run(keyId);
    deps.registry.register({
      id: 1,
      name: "s",
      connectedAt: "",
      activeRequests: 0,
      models: ["llama3"],
      session: null as never,
    });
    app = await buildServer(deps);
  });

  afterEach(async () => {
    await app.close();
    deps.db.close();
  });

  it("rejects an unknown key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/privacy/session",
      payload: { key: "nope" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns own limits, effective permissions and the zero-logging statement", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/privacy/session",
      payload: { key: "key-1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      name: "alice",
      rpm_limit: 60,
      tokens_per_day: null,
      stats_enabled: false,
      stats: null,
    });
    expect(body.models).toEqual([
      { model: "llama3", allowed: true, source: "default" },
      { model: "secret", allowed: false, source: "key" },
    ]);
    expect(body.statement).toMatch(/never (stored|logged)/i);
  });

  it("includes only the key's own aggregate rows when statistics are enabled", async () => {
    const otherId = insertApiKey(deps.db, "key-2", "bob");
    setStatsEnabled(deps.db, true, false);
    deps.db
      .prepare(
        "INSERT INTO stats_hourly (key_id, model, hour, requests, prompt_tokens, completion_tokens, errors) VALUES (?, 'llama3', '2026-08-13T18', 2, 10, 20, 0)",
      )
      .run(keyId);
    deps.db
      .prepare(
        "INSERT INTO stats_hourly (key_id, model, hour, requests) VALUES (?, 'llama3', '2026-08-13T18', 99)",
      )
      .run(otherId);
    const res = await app.inject({
      method: "POST",
      url: "/api/privacy/session",
      payload: { key: "key-1" },
    });
    const body = res.json();
    expect(body.stats_enabled).toBe(true);
    expect(body.stats).toHaveLength(1);
    expect(body.stats[0]).toMatchObject({
      key_name: "alice",
      requests: 2,
      prompt_tokens: 10,
      completion_tokens: 20,
    });
  });
});
