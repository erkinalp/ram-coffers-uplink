import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { insertApiKey, makeTestDeps, type TestDeps } from "./helpers.js";

describe("model list endpoints", () => {
  let deps: TestDeps;
  let app: FastifyInstance;

  beforeEach(async () => {
    deps = makeTestDeps();
    insertApiKey(deps.db, "key-1", "alice");
    insertApiKey(deps.db, "key-2", "blocked-bob");
    deps.db
      .prepare(
        "INSERT INTO key_model_policy (key_id, model, mode) VALUES (2, 'secret', 'disallow')",
      )
      .run();
    deps.registry.register({
      id: 1,
      name: "a",
      connectedAt: "",
      activeRequests: 0,
      models: ["llama3", "secret"],
      session: null as never,
    });
    deps.registry.register({
      id: 2,
      name: "b",
      connectedAt: "",
      activeRequests: 0,
      models: ["mistral"],
      session: null as never,
    });
    app = await buildServer(deps);
  });

  afterEach(async () => {
    await app.close();
    deps.db.close();
  });

  it("rejects missing, unknown and revoked keys", async () => {
    expect((await app.inject({ method: "GET", url: "/api/tags" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/tags",
          headers: { authorization: "Bearer nope" },
        })
      ).statusCode,
    ).toBe(401);
    deps.db.prepare("UPDATE api_keys SET revoked = 1 WHERE id = 1").run();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/tags",
          headers: { authorization: "Bearer key-1" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("GET /api/tags returns the policy-filtered union of online models", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tags",
      headers: { authorization: "Bearer key-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().models.map((m: { name: string }) => m.name)).toEqual([
      "llama3",
      "mistral",
      "secret",
    ]);
    const bob = await app.inject({
      method: "GET",
      url: "/api/tags",
      headers: { authorization: "Bearer key-2" },
    });
    expect(bob.json().models.map((m: { name: string }) => m.name)).toEqual(["llama3", "mistral"]);
  });

  it("GET /v1/models returns the OpenAI shape, filtered", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer key-2" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("list");
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(["llama3", "mistral"]);
    expect(body.data[0]).toMatchObject({ object: "model", owned_by: "ram-coffers-uplink" });
  });
});
