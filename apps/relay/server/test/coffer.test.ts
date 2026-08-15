import type { TunnelSession } from "@ram-coffers-uplink/protocol";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app.js";
import {
  connectFakeSidecar,
  insertApiKey,
  insertSidecar,
  makeTestDeps,
  type TestDeps,
} from "./helpers.js";

describe("coffer cluster routes", () => {
  let deps: TestDeps;
  let app: FastifyInstance;
  let port: number;
  let sidecarSession: TunnelSession;
  let sidecarWs: { close(): void };

  beforeEach(async () => {
    deps = makeTestDeps();
    insertApiKey(deps.db, "key-1", "alice");
    insertSidecar(deps.db, "ps3-shelf", "psk-1");
    app = await buildServer(deps);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    port = address.port;
  });

  afterEach(async () => {
    sidecarWs?.close();
    await app.close();
    deps.db.close();
  });

  async function connectResponder(models = ["deepseek-v3-mxfp4"]): Promise<void> {
    const fake = await connectFakeSidecar(port, { name: "ps3-shelf", psk: "psk-1", models });
    sidecarSession = fake.session;
    sidecarWs = fake.ws;
    await vi.waitFor(() => expect(deps.registry.list()).toHaveLength(1));
  }

  /** Answers every tunnelled request with the payload registered for its path. */
  function respondByPath(payloads: Record<string, unknown>): string[] {
    const seen: string[] = [];
    sidecarSession.onRequestOpen((msg, responder) => {
      seen.push(msg.path);
      responder.sendHead(200, { "content-type": "application/json" });
      responder.sendChunk(new TextEncoder().encode(JSON.stringify(payloads[msg.path] ?? {})));
      responder.sendEnd(null);
    });
    return seen;
  }

  function request(path: string, body?: unknown, key = "key-1"): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (body === undefined) return fetch(`http://127.0.0.1:${port}${path}`, { headers });
    headers["content-type"] = "application/json";
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("tunnels an expert dispatch to the sidecar", async () => {
    await connectResponder();
    const seen = respondByPath({ "/coffer/v1/dispatch": { output: [1, 2, 3] } });
    const res = await request("/coffer/v1/dispatch", {
      layer: 3,
      expert: 7,
      token_id: 11,
      activation: [0.5, 0.25],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ output: [1, 2, 3] });
    expect(seen).toEqual(["/coffer/v1/dispatch"]);
    await vi.waitFor(() => expect(deps.registry.list()[0]?.activeRequests).toBe(0));
  });

  it("tunnels a batch dispatch and a health probe", async () => {
    await connectResponder();
    const seen = respondByPath({
      "/coffer/v1/batch": { rows: [[1]], experts: [7], request_id: "abc" },
      "/coffer/v1/health": { status: "ok", rtt_ms: 4 },
    });
    const batch = await request("/coffer/v1/batch", {
      layer: 3,
      token_id: 11,
      activation: [0.5],
      experts: [{ expert: 7 }],
    });
    expect(await batch.json()).toEqual({ rows: [[1]], experts: [7], request_id: "abc" });
    const health = await request("/coffer/v1/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", rtt_ms: 4 });
    expect(seen).toEqual(["/coffer/v1/batch", "/coffer/v1/health"]);
  });

  it("requires an API key", async () => {
    await connectResponder();
    const res = await fetch(`http://127.0.0.1:${port}/coffer/v1/health`);
    expect(res.status).toBe(401);
  });

  it("enforces model policies when the body pins a model", async () => {
    await connectResponder(["deepseek-v3-mxfp4", "kimi-k3"]);
    const keyId = deps.db.prepare("SELECT id FROM api_keys").get() as { id: number };
    deps.db
      .prepare("INSERT INTO key_model_policy (key_id, model, mode) VALUES (?, ?, 'disallow')")
      .run(keyId.id, "kimi-k3");
    const res = await request("/coffer/v1/dispatch", { model: "kimi-k3", layer: 0, expert: 0 });
    expect(res.status).toBe(403);
  });

  it("reports 503 when no sidecar serves the requested coffer", async () => {
    const res = await request("/coffer/v1/dispatch", { layer: 0, expert: 0 });
    expect(res.status).toBe(503);
  });

  it("applies the request rate limit", async () => {
    await connectResponder();
    deps.db.prepare("UPDATE api_keys SET rpm_limit = 1").run();
    respondByPath({ "/coffer/v1/health": { status: "ok" } });
    expect((await request("/coffer/v1/health")).status).toBe(200);
    const limited = await request("/coffer/v1/health");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});
