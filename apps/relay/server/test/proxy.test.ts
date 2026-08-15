import http from "node:http";
import type { TunnelSession } from "@ram-coffers-uplink/protocol";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer, type ServerOptions } from "../src/app.js";
import { getStatsEnabled, setStatsEnabled } from "../src/store.js";
import {
  connectFakeSidecar,
  insertApiKey,
  insertSidecar,
  makeTestDeps,
  type TestDeps,
} from "./helpers.js";

describe("inference proxy", () => {
  let deps: TestDeps;
  let app: FastifyInstance;
  let port: number;
  let sidecarSession: TunnelSession;
  let sidecarWs: { close(): void };

  async function startApp(options?: ServerOptions): Promise<void> {
    app = await buildServer(deps, options);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    port = address.port;
  }

  beforeEach(async () => {
    deps = makeTestDeps();
    insertApiKey(deps.db, "key-1", "alice");
    insertSidecar(deps.db, "homelab", "psk-1");
    await startApp();
  });

  afterEach(async () => {
    sidecarWs?.close();
    await app.close();
    deps.db.close();
  });

  async function connectResponder(): Promise<void> {
    const fake = await connectFakeSidecar(port, {
      name: "homelab",
      psk: "psk-1",
      models: ["llama3"],
    });
    sidecarSession = fake.session;
    sidecarWs = fake.ws;
    await vi.waitFor(() => expect(deps.registry.list()).toHaveLength(1));
  }

  function post(path: string, body: unknown, key = "key-1"): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  }

  it("streams a tunnelled response end to end and records usage", async () => {
    await connectResponder();
    sidecarSession.onRequestOpen((msg, responder) => {
      expect(msg.path).toBe("/api/chat");
      responder.sendHead(200, { "content-type": "application/x-ndjson" });
      responder.sendChunk(new TextEncoder().encode('{"message":{"content":"Hel"}}\n'));
      responder.sendChunk(new TextEncoder().encode('{"message":{"content":"lo"},"done":true}\n'));
      responder.sendEnd({ prompt_tokens: 3, completion_tokens: 5 });
    });
    const res = await post("/api/chat", { model: "llama3", messages: [] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await res.text()).toBe(
      '{"message":{"content":"Hel"}}\n{"message":{"content":"lo"},"done":true}\n',
    );
    await vi.waitFor(() => expect(deps.registry.list()[0]?.activeRequests).toBe(0));
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM stats_hourly").get()).toEqual({ n: 0 });
  });

  it("writes stats_hourly only when statistics are enabled", async () => {
    setStatsEnabled(deps.db, true, false);
    expect(getStatsEnabled(deps.db, false)).toBe(true);
    await connectResponder();
    sidecarSession.onRequestOpen((_msg, responder) => {
      responder.sendHead(200, { "content-type": "application/json" });
      responder.sendChunk(new TextEncoder().encode("{}"));
      responder.sendEnd({ prompt_tokens: 3, completion_tokens: 5 });
    });
    const res = await post("/api/generate", { model: "llama3", prompt: "hi", stream: false });
    expect(res.status).toBe(200);
    await res.text();
    const row = deps.db
      .prepare(
        "SELECT requests, prompt_tokens, completion_tokens, errors FROM stats_hourly WHERE key_id = 1 AND model = 'llama3'",
      )
      .get();
    expect(row).toEqual({ requests: 1, prompt_tokens: 3, completion_tokens: 5, errors: 0 });
  });

  it("returns 503 when no online sidecar offers the model", async () => {
    const res = await post("/api/chat", { model: "llama3" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no sidecar available for the requested model" });
  });

  it("returns 403 when the model policy disallows the key", async () => {
    deps.db
      .prepare(
        "INSERT INTO key_model_policy (key_id, model, mode) VALUES (1, 'llama3', 'disallow')",
      )
      .run();
    const res = await post("/api/chat", { model: "llama3" });
    expect(res.status).toBe(403);
  });

  it("returns 429 with Retry-After when the rpm limit is exceeded", async () => {
    deps.db.prepare("UPDATE api_keys SET rpm_limit = 1 WHERE id = 1").run();
    const first = await post("/api/chat", { model: "llama3" });
    expect(first.status).toBe(503); // no sidecar online; request still counts
    const second = await post("/api/chat", { model: "llama3" });
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("returns 400 when the model is missing", async () => {
    const res = await post("/api/chat", {});
    expect(res.status).toBe(400);
  });

  it("returns 401 without a bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "llama3" }),
    });
    expect(res.status).toBe(401);
  });

  it("propagates cancel to the sidecar when the client disconnects", async () => {
    await connectResponder();
    const cancelled = vi.fn();
    sidecarSession.onRequestOpen((_msg, responder) => {
      responder.onCancel(cancelled);
      responder.sendHead(200, { "content-type": "application/x-ndjson" });
      responder.sendChunk(new TextEncoder().encode("partial\n"));
    });
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          port,
          host: "127.0.0.1",
          path: "/api/chat",
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer key-1" },
        },
        (res) => {
          res.on("data", () => req.destroy());
          res.on("error", () => undefined);
        },
      );
      req.on("error", () => undefined);
      req.on("close", () => resolve());
      req.end(JSON.stringify({ model: "llama3" }));
      setTimeout(() => reject(new Error("timed out waiting for client close")), 5000);
    });
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
  });

  it("returns 502 when the sidecar reports an error before the head", async () => {
    await connectResponder();
    sidecarSession.onRequestOpen((_msg, responder) =>
      responder.sendError("coffer node unreachable"),
    );
    const res = await post("/api/embed", { model: "llama3", input: "x" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "coffer node unreachable" });
  });

  it("returns 504 and frees the slot when the sidecar accepts but goes silent", async () => {
    await app.close();
    await startApp({ proxy: { requestInactivityMs: 100 } });
    await connectResponder();
    sidecarSession.onRequestOpen(() => {
      // Accept the request, then send nothing at all.
    });
    const res = await post("/api/chat", { model: "llama3", messages: [] });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "sidecar inactivity timeout" });
    await vi.waitFor(() => expect(deps.registry.list()[0]?.activeRequests).toBe(0));
  });
});

describe("client-compatibility endpoints", () => {
  let deps: TestDeps;
  let app: FastifyInstance;
  let port: number;
  let sidecarSession: TunnelSession;
  let sidecarWs: { close(): void };

  async function startApp(options?: ServerOptions): Promise<void> {
    app = await buildServer(deps, options);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    port = address.port;
  }

  beforeEach(async () => {
    deps = makeTestDeps();
    insertApiKey(deps.db, "key-1", "alice");
    insertSidecar(deps.db, "homelab", "psk-1");
    await startApp();
  });

  afterEach(async () => {
    sidecarWs?.close();
    await app.close();
    deps.db.close();
  });

  async function connectResponder(): Promise<void> {
    const fake = await connectFakeSidecar(port, {
      name: "homelab",
      psk: "psk-1",
      models: ["llama3"],
    });
    sidecarSession = fake.session;
    sidecarWs = fake.ws;
    await vi.waitFor(() => expect(deps.registry.list()).toHaveLength(1));
  }

  function get(path: string, key = "key-1"): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { authorization: `Bearer ${key}` },
    });
  }

  function post(path: string, body: unknown, key = "key-1"): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  }

  it("GET /api/version returns 401 without a bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`);
    expect(res.status).toBe(401);
  });

  it("GET /api/version returns 503 when no sidecar is online", async () => {
    const res = await get("/api/version");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no sidecar online" });
  });

  it("GET /api/version proxies the version from an online sidecar", async () => {
    await connectResponder();
    sidecarSession.onRequestOpen((msg, responder) => {
      expect(msg.method).toBe("GET");
      expect(msg.path).toBe("/api/version");
      responder.sendHead(200, { "content-type": "application/json" });
      responder.sendChunk(new TextEncoder().encode('{"version":"0.12.6"}'));
      responder.sendEnd(null);
    });
    const res = await get("/api/version");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "0.12.6" });
    await vi.waitFor(() => expect(deps.registry.list()[0]?.activeRequests).toBe(0));
  });

  it("GET /api/ps proxies the running-models list from an online sidecar", async () => {
    await connectResponder();
    sidecarSession.onRequestOpen((msg, responder) => {
      expect(msg.method).toBe("GET");
      expect(msg.path).toBe("/api/ps");
      responder.sendHead(200, { "content-type": "application/json" });
      responder.sendChunk(new TextEncoder().encode('{"models":[]}'));
      responder.sendEnd(null);
    });
    const res = await get("/api/ps");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [] });
    await vi.waitFor(() => expect(deps.registry.list()[0]?.activeRequests).toBe(0));
  });

  it("POST /api/show returns 401 without a bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "llama3" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/show returns 403 when the model policy disallows the key", async () => {
    deps.db
      .prepare(
        "INSERT INTO key_model_policy (key_id, model, mode) VALUES (1, 'llama3', 'disallow')",
      )
      .run();
    const res = await post("/api/show", { model: "llama3" });
    expect(res.status).toBe(403);
  });

  it("POST /api/show proxies the model metadata when allowed", async () => {
    await connectResponder();
    sidecarSession.onRequestOpen((msg, responder) => {
      expect(msg.method).toBe("POST");
      expect(msg.path).toBe("/api/show");
      responder.sendHead(200, { "content-type": "application/json" });
      responder.sendChunk(
        new TextEncoder().encode('{"modelfile":"FROM llama3","parameters":"stop"}'),
      );
      responder.sendEnd(null);
    });
    const res = await post("/api/show", { model: "llama3" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ modelfile: "FROM llama3", parameters: "stop" });
    await vi.waitFor(() => expect(deps.registry.list()[0]?.activeRequests).toBe(0));
  });
});
