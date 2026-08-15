import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UpstreamRequest } from "../src/coffer-http.js";
import type { SidecarConfig } from "../src/config.js";
import { createUpstream } from "../src/upstream.js";

describe("createUpstream", () => {
  let service: http.Server;
  let port: number;

  beforeEach(async () => {
    service = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/tags") {
        res.end(JSON.stringify({ models: [{ name: "llama3" }] }));
        return;
      }
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const address = service.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    port = address.port;
  });

  afterEach(async () => {
    await new Promise((resolve) => service.close(resolve));
  });

  function config(overrides: Partial<SidecarConfig> = {}): SidecarConfig {
    return {
      relayUrl: "ws://relay/uplink",
      name: "coffer-01",
      psk: "psk",
      upstream: "http",
      cofferUrl: `http://127.0.0.1:${port}`,
      p3xcHost: "127.0.0.1",
      // Unreachable on purpose: `both` must not consult P3XC for HTTP paths.
      p3xcPort: 1,
      p3xcTimeoutMs: 300,
      models: [],
      ...overrides,
    };
  }

  function collector() {
    const chunks: string[] = [];
    let status = 0;
    return {
      responder: {
        sendHead: (code: number) => {
          status = code;
        },
        sendChunk: (chunk: Uint8Array) => chunks.push(new TextDecoder().decode(chunk)),
        sendEnd: () => {},
        sendError: () => {},
        onCancel: () => {},
      },
      get status() {
        return status;
      },
      body: () => chunks.join(""),
    };
  }

  function get(path: string): UpstreamRequest {
    return {
      kind: "request_open",
      id: "1",
      method: "GET",
      path,
      headers: {},
      body: null,
    } as UpstreamRequest;
  }

  it("lists models from the HTTP service, or from the configuration when pinned", async () => {
    const discovered = createUpstream(config());
    expect(await discovered.models()).toEqual(["llama3"]);
    discovered.close();
    const pinned = createUpstream(config({ models: ["kimi-k3"] }));
    expect(await pinned.models()).toEqual(["kimi-k3"]);
    pinned.close();
  });

  it("routes coffer paths to P3XC and everything else to HTTP in both mode", async () => {
    const upstream = createUpstream(config({ upstream: "both", models: ["kimi-k3"] }));
    const chat = collector();
    await upstream.forward(get("/api/version"), chat.responder);
    expect(chat.status).toBe(200);
    expect(JSON.parse(chat.body())).toEqual({ path: "/api/version" });

    // P3XC is unreachable here, so the coffer route must fail rather than
    // silently fall through to the HTTP service.
    const coffer = collector();
    await upstream.forward(get("/coffer/v1/health"), coffer.responder);
    expect(coffer.status).toBe(0);
    expect(await upstream.models()).toEqual(["llama3", "kimi-k3"]);
    upstream.close();
  });
});
