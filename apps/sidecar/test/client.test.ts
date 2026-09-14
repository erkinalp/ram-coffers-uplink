import http from "node:http";
import {
  decodeMessage,
  deriveSessionKeys,
  encodeMessage,
  generateNonce,
  generateSessionId,
  hashPsk,
  type Message,
  TunnelSession,
} from "@ram-coffers-uplink/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { SidecarClient } from "../src/client.js";
import type { SidecarConfig } from "../src/config.js";
import { wsTransport } from "../src/ws-transport.js";

const PSK = "test-psk";

/** The HTTP-upstream half of a sidecar configuration, pointing at the test server. */
function upstreamConfig(
  port: number,
): Pick<
  SidecarConfig,
  | "upstream"
  | "cofferUrl"
  | "p3xcHost"
  | "p3xcPort"
  | "p3xcTimeoutMs"
  | "g9xcHost"
  | "g9xcPort"
  | "g9xcTimeoutMs"
  | "models"
> {
  return {
    upstream: "http",
    cofferUrl: `http://127.0.0.1:${port}`,
    p3xcHost: "127.0.0.1",
    p3xcPort: 5920,
    p3xcTimeoutMs: 1000,
    g9xcHost: "127.0.0.1",
    g9xcPort: 9713,
    g9xcTimeoutMs: 1000,
    models: [],
  };
}

/** A minimal in-test relay: accepts the handshake and exposes the encrypted session. */
class FakeRelay {
  server: http.Server;
  wss: WebSocketServer;
  port = 0;
  sessions: TunnelSession[] = [];
  connections = 0;
  received: Message[] = [];

  constructor() {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => this.onSocket(ws));
    });
  }

  private onSocket(ws: WebSocket): void {
    ws.once("message", (data: Buffer) => {
      const hello = decodeMessage(new Uint8Array(data));
      if (hello.kind !== "hello") return ws.close();
      this.connections += 1;
      const nonceR = generateNonce();
      const sessionId = generateSessionId();
      const keys = deriveSessionKeys(hashPsk(PSK), Buffer.from(hello.nonce_s, "base64"), nonceR);
      ws.send(
        encodeMessage({
          kind: "hello_ack",
          nonce_r: Buffer.from(nonceR).toString("base64"),
          session_id: sessionId,
        }),
      );
      const session = new TunnelSession(wsTransport(ws), keys, sessionId, "relay");
      session.onMessage((msg) => this.received.push(msg));
      this.sessions.push(session);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    this.port = address.port;
  }

  async close(): Promise<void> {
    for (const session of this.sessions) session.close();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

describe("SidecarClient", () => {
  let coffer: http.Server;
  let cofferPort: number;
  let relay: FakeRelay;
  let client: SidecarClient;
  let tagsDelayMs: number;
  const logs: string[] = [];

  beforeEach(async () => {
    logs.length = 0;
    tagsDelayMs = 0;
    coffer = http.createServer((req, res) => {
      if (req.url === "/api/tags") {
        const respond = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ models: [{ name: "llama3" }] }));
        };
        if (tagsDelayMs > 0) setTimeout(respond, tagsDelayMs);
        else respond();
        return;
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end('{"done":true,"prompt_eval_count":1,"eval_count":2}\n');
    });
    await new Promise<void>((resolve) => coffer.listen(0, "127.0.0.1", resolve));
    const address = coffer.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    cofferPort = address.port;
    relay = new FakeRelay();
    await relay.listen();
    client = new SidecarClient(
      {
        relayUrl: `ws://127.0.0.1:${relay.port}/uplink`,
        name: "lab",
        psk: PSK,
        ...upstreamConfig(cofferPort),
      },
      { initialBackoffMs: 10, maxBackoffMs: 50, log: (m) => logs.push(m) },
    );
  });

  afterEach(async () => {
    client.stop();
    await relay.close();
    await new Promise((resolve) => coffer.close(resolve));
  });

  it("connects, pushes the model list and answers requests end to end", async () => {
    const run = client.run();
    await vi.waitFor(() => expect(relay.sessions).toHaveLength(1));
    await vi.waitFor(() =>
      expect(
        relay.received.some((m) => m.kind === "model_update" && m.models.includes("llama3")),
      ).toBe(true),
    );
    const session = relay.sessions[0] as TunnelSession;
    const pending = session.openRequest({
      method: "POST",
      path: "/api/generate",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
    });
    const head = vi.fn();
    const end = vi.fn();
    pending.onHead(head);
    pending.onEnd(end);
    await vi.waitFor(() =>
      expect(end).toHaveBeenCalledWith({ prompt_tokens: 1, completion_tokens: 2 }),
    );
    expect(head).toHaveBeenCalledWith(200, { "content-type": "application/x-ndjson" });
    expect(logs.some((l) => l.includes("connected"))).toBe(true);
    expect(logs.join("\n")).not.toContain("llama3 content");
    client.stop();
    await run;
  });

  it("reconnects after the connection drops", async () => {
    const run = client.run();
    await vi.waitFor(() => expect(relay.sessions.length).toBeGreaterThanOrEqual(1));
    relay.sessions[0]?.close();
    await vi.waitFor(() => expect(relay.connections).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    client.stop();
    await run;
  });

  it("does not crash when the connection drops while a model refresh is in flight", async () => {
    tagsDelayMs = 100;
    const run = client.run();
    await vi.waitFor(() => expect(relay.sessions).toHaveLength(1));
    const session = relay.sessions[0] as TunnelSession;
    const pending = session.openRequest({
      method: "POST",
      path: "/api/generate",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
    });
    const end = vi.fn();
    pending.onEnd(end);
    await vi.waitFor(() => expect(end).toHaveBeenCalled());
    // The completed forward has just triggered pushModels(), which is now stuck
    // awaiting the slow /api/tags response; drop the connection mid-flight.
    relay.sessions[0]?.close();
    await vi.waitFor(() => expect(relay.connections).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    client.stop();
    await run;
  });

  it("resolves run() when stopped during an in-flight handshake", async () => {
    // A relay that accepts the WebSocket upgrade but never answers the handshake.
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    let sawConnection: () => void = () => {};
    const connected = new Promise<void>((resolve) => {
      sawConnection = resolve;
    });
    server.on("upgrade", (req, socket, head) =>
      wss.handleUpgrade(req, socket, head, () => sawConnection()),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    const dangling = new SidecarClient(
      {
        relayUrl: `ws://127.0.0.1:${address.port}`,
        name: "lab",
        psk: PSK,
        ...upstreamConfig(cofferPort),
      },
      { initialBackoffMs: 10, maxBackoffMs: 50, log: (m) => logs.push(m) },
    );
    const run = dangling.run();
    await connected;
    dangling.stop();
    await run;
    await new Promise((resolve) => server.close(resolve));
  });

  it("closes the socket when the handshake response is not hello_ack", async () => {
    // A relay that answers every hello with an unexpected (but valid) message.
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    let closed = 0;
    server.on("upgrade", (req, socket, head) =>
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        ws.once("message", () => ws.send(encodeMessage({ kind: "ping", ts: 0 })));
        ws.on("close", () => {
          closed += 1;
        });
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    const picky = new SidecarClient(
      {
        relayUrl: `ws://127.0.0.1:${address.port}`,
        name: "lab",
        psk: PSK,
        ...upstreamConfig(cofferPort),
      },
      { initialBackoffMs: 10, maxBackoffMs: 50, log: (m) => logs.push(m) },
    );
    const run = picky.run();
    await vi.waitFor(() => expect(closed).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    picky.stop();
    await run;
    await new Promise((resolve) => server.close(resolve));
  });
});
