import { encodeMessage, generateNonce } from "@ram-coffers-uplink/protocol";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { buildServer } from "../src/app.js";
import { UPLINK_MAX_PAYLOAD } from "../src/uplink.js";
import { connectFakeSidecar, insertSidecar, makeTestDeps, type TestDeps } from "./helpers.js";

describe("uplink endpoint", () => {
  let deps: TestDeps;
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    deps = makeTestDeps();
    insertSidecar(deps.db, "homelab", "correct-psk");
    app = await buildServer(deps);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    port = address.port;
  });

  afterEach(async () => {
    await app.close();
    deps.db.close();
  });

  it("accepts a sidecar with a known PSK and registers it", async () => {
    const { session, ws } = await connectFakeSidecar(port, {
      name: "homelab",
      psk: "correct-psk",
      models: ["llama3"],
    });
    // Prove the encrypted channel works: a model_update must decrypt.
    session.send({ kind: "model_update", models: ["llama3", "mistral"] });
    await vi.waitFor(() => {
      expect(deps.registry.list()).toHaveLength(1);
      expect(deps.registry.list()[0]).toMatchObject({
        name: "homelab",
        models: ["llama3", "mistral"],
        activeRequests: 0,
      });
    });
    ws.close();
  });

  it("rejects an unknown sidecar name", async () => {
    await expect(
      connectFakeSidecar(port, { name: "stranger", psk: "correct-psk", models: [] }),
    ).rejects.toThrow(/closed/);
  });

  it("rejects a revoked sidecar", async () => {
    deps.db.prepare("UPDATE sidecars SET revoked = 1 WHERE name = 'homelab'").run();
    await expect(
      connectFakeSidecar(port, { name: "homelab", psk: "correct-psk", models: [] }),
    ).rejects.toThrow(/closed/);
  });

  it("closes the connection when the PSK is wrong", async () => {
    const { session, ws } = await connectFakeSidecar(port, {
      name: "homelab",
      psk: "wrong-psk",
      models: ["llama3"],
    });
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    session.send({ kind: "model_update", models: ["llama3"] });
    await closed;
    expect(deps.registry.list()).toEqual([]);
  });

  it("unregisters the sidecar on disconnect", async () => {
    const { ws } = await connectFakeSidecar(port, {
      name: "homelab",
      psk: "correct-psk",
      models: [],
    });
    await vi.waitFor(() => expect(deps.registry.list()).toHaveLength(1));
    ws.close();
    await vi.waitFor(() => expect(deps.registry.list()).toHaveLength(0));
  });

  it("keeps the registry entry when the old connection closes after a same-name reconnect", async () => {
    const first = await connectFakeSidecar(port, {
      name: "homelab",
      psk: "correct-psk",
      models: [],
    });
    await vi.waitFor(() => expect(deps.registry.list()).toHaveLength(1));
    const second = await connectFakeSidecar(port, {
      name: "homelab",
      psk: "correct-psk",
      models: [],
    });
    await vi.waitFor(() => {
      expect(deps.registry.list()).toHaveLength(1);
      expect(deps.registry.get("homelab")?.session).not.toBe(first.session);
    });
    first.ws.close();
    // Give the old connection's close handler a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(deps.registry.list()).toHaveLength(1);
    expect(deps.registry.get("homelab")).toMatchObject({ name: "homelab" });
    second.ws.close();
  });

  const malformedHellos: Array<[string, unknown]> = [
    ["an object name", { kind: "hello", name: {}, nonce_s: "AAAA", models: [] }],
    ["a numeric nonce_s", { kind: "hello", name: "homelab", nonce_s: 123, models: [] }],
    ["a string models", { kind: "hello", name: "homelab", nonce_s: "AAAA", models: "llama3" }],
  ];
  for (const [label, frame] of malformedHellos) {
    it(`closes the socket and survives a hello with ${label}`, async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/uplink`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
      ws.send(JSON.stringify(frame));
      await closed;
      expect(deps.registry.list()).toEqual([]);
      // The relay survives and still completes a valid handshake afterwards.
      const good = await connectFakeSidecar(port, {
        name: "homelab",
        psk: "correct-psk",
        models: [],
      });
      await vi.waitFor(() => expect(deps.registry.list()).toHaveLength(1));
      good.ws.close();
      await vi.waitFor(() => expect(deps.registry.list()).toHaveLength(0));
    });
  }

  it("configures a 16 MiB maxPayload for the uplink socket", () => {
    expect(UPLINK_MAX_PAYLOAD).toBe(16 * 1024 * 1024);
  });

  it("rejects frames over the configured maxPayload", async () => {
    // Exercise the ws maxPayload mechanism with a small limit on a locally
    // constructed server rather than moving 16 MiB in a test.
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 1024 });
    wss.on("connection", (socket) => {
      // ws surfaces the oversized frame as an error on the server socket.
      socket.on("error", () => undefined);
      socket.on("message", () => undefined);
    });
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
    const address = wss.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(Buffer.alloc(2048));
    expect(await closed).toBe(1009);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});

describe("uplink liveness", () => {
  let deps: TestDeps;
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    deps = makeTestDeps();
    insertSidecar(deps.db, "homelab", "correct-psk");
    app = await buildServer(deps, { uplink: { pingIntervalMs: 50, pongTimeoutMs: 150 } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    port = address.port;
  });

  afterEach(async () => {
    await app.close();
    deps.db.close();
  });

  it("keeps a responsive sidecar connected", async () => {
    const { ws } = await connectFakeSidecar(port, {
      name: "homelab",
      psk: "correct-psk",
      models: [],
    });
    await vi.waitFor(() => expect(deps.registry.list()).toHaveLength(1));
    // Several ping/pong rounds; a responsive sidecar must stay registered.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(deps.registry.list()).toHaveLength(1);
    ws.close();
  });

  it("closes a sidecar that stops answering pings", async () => {
    // Handshake by hand, then never decrypt or answer anything again.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/uplink`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(
      encodeMessage({
        kind: "hello",
        name: "homelab",
        nonce_s: Buffer.from(generateNonce()).toString("base64"),
        models: [],
      }),
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("message", () => resolve());
      ws.once("close", () => reject(new Error("connection closed during handshake")));
    });
    await vi.waitFor(() => expect(deps.registry.list()).toHaveLength(1));
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await closed;
    await vi.waitFor(() => expect(deps.registry.list()).toHaveLength(0));
  });
});
