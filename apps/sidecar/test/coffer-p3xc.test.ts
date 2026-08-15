import net from "node:net";
import {
  DTYPE_F32,
  encodeFrame,
  type Frame,
  FrameReader,
  MSG_BERR,
  MSG_BRSP,
  MSG_PONG,
  MSG_RSP,
  NO_EXPERT,
  RSP_FLAG_PER_EXPERT,
} from "@ram-coffers-uplink/p3xc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UpstreamRequest } from "../src/coffer-http.js";
import { createP3xcUpstream } from "../src/coffer-p3xc.js";
import type { SidecarConfig } from "../src/config.js";
import type { Upstream } from "../src/upstream.js";

/** Collects everything an upstream sends back for one tunnelled request. */
function collector() {
  const chunks: string[] = [];
  let status = 0;
  let error: string | null = null;
  let ended = false;
  const responder = {
    sendHead(code: number, _headers: Record<string, string>) {
      status = code;
    },
    sendChunk(chunk: Uint8Array) {
      chunks.push(new TextDecoder().decode(chunk));
    },
    sendEnd() {
      ended = true;
    },
    sendError(message: string) {
      error = message;
    },
    onCancel(_cb: () => void) {},
  };
  return {
    responder,
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    get ended() {
      return ended;
    },
    json<T>(): T {
      return JSON.parse(chunks.join("")) as T;
    },
  };
}

function request(method: string, path: string, body?: unknown): UpstreamRequest {
  return {
    kind: "request_open",
    id: "1",
    method,
    path,
    headers: {},
    body: body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
  } as UpstreamRequest;
}

function f32(values: number[]): Uint8Array {
  const payload = new Uint8Array(values.length * 4);
  const view = new DataView(payload.buffer);
  for (const [index, value] of values.entries()) view.setFloat32(index * 4, value);
  return payload;
}

/** A stub coordinator answering with the frame the test chooses per request. */
class StubCoordinator {
  private readonly server = net.createServer((socket) => {
    this.sockets.push(socket);
    const reader = new FrameReader();
    socket.on("data", (chunk) => {
      for (const frame of reader.push(new Uint8Array(chunk))) {
        this.received.push(frame);
        const reply = this.reply(frame);
        if (reply) socket.write(reply);
      }
    });
    socket.on("error", () => undefined);
  });
  readonly sockets: net.Socket[] = [];
  readonly received: Frame[] = [];
  reply: (frame: Frame) => Uint8Array | null = () => null;
  port = 0;

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    this.port = address.port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

describe("P3XC upstream", () => {
  let node: StubCoordinator;
  let upstream: Upstream;

  function config(): SidecarConfig {
    return {
      relayUrl: "ws://relay/uplink",
      name: "ps3-shelf",
      psk: "psk",
      upstream: "p3xc",
      cofferUrl: null,
      p3xcHost: "127.0.0.1",
      p3xcPort: node.port,
      p3xcTimeoutMs: 2000,
      models: ["deepseek-v3-mxfp4"],
    };
  }

  beforeEach(async () => {
    node = new StubCoordinator();
    await node.listen();
    upstream = createP3xcUpstream(config());
  });

  afterEach(async () => {
    upstream.close();
    await node.close();
  });

  it("advertises the configured models without asking the cluster", async () => {
    expect(await upstream.models()).toEqual(["deepseek-v3-mxfp4"]);
    const tags = collector();
    await upstream.forward(request("GET", "/api/tags"), tags.responder);
    expect(tags.json()).toEqual({
      models: [{ name: "deepseek-v3-mxfp4", model: "deepseek-v3-mxfp4" }],
    });
    expect(node.received).toHaveLength(0);
  });

  it("answers a health probe with the coordinator address and round-trip time", async () => {
    node.reply = () =>
      encodeFrame({
        msgType: MSG_PONG,
        layer: 0,
        expert: NO_EXPERT,
        tokenId: 0,
        dtype: DTYPE_F32,
        shape: [1],
        payload: f32([0]),
      });
    const health = collector();
    await upstream.forward(request("GET", "/coffer/v1/health"), health.responder);
    expect(health.status).toBe(200);
    const body = health.json<{ status: string; coordinator: string; rtt_ms: number }>();
    expect(body.status).toBe("ok");
    expect(body.coordinator).toBe(`127.0.0.1:${node.port}`);
    expect(body.rtt_ms).toBeGreaterThanOrEqual(0);
  });

  it("dispatches one expert and returns its output", async () => {
    node.reply = (frame) =>
      encodeFrame({
        msgType: MSG_RSP,
        layer: frame.layer,
        expert: frame.expert,
        tokenId: frame.tokenId,
        dtype: DTYPE_F32,
        shape: [2],
        payload: f32([0.5, 1.5]),
      });
    const out = collector();
    await upstream.forward(
      request("POST", "/coffer/v1/dispatch", {
        layer: 4,
        expert: 6,
        token_id: 8,
        activation: [1, 2, 3],
      }),
      out.responder,
    );
    expect(out.status).toBe(200);
    expect(out.json()).toEqual({ output: [0.5, 1.5] });
    expect(node.received[0]).toMatchObject({ msgType: 1, layer: 4, expert: 6, tokenId: 8 });
  });

  it("dispatches a batch and reports per-expert contributions", async () => {
    const rows = new Uint8Array(16);
    const view = new DataView(rows.buffer);
    for (const [index, value] of [1, 2, 3, 4].entries()) view.setFloat32(index * 4, value);
    node.reply = (frame) =>
      encodeFrame({
        msgType: MSG_BRSP,
        layer: frame.layer,
        expert: NO_EXPERT,
        tokenId: frame.tokenId,
        dtype: DTYPE_F32,
        shape: [2, 2],
        payload: rows,
        trailer: new Uint8Array([0, 2, 0, RSP_FLAG_PER_EXPERT, 0, 11, 0, 12]),
      });
    const out = collector();
    await upstream.forward(
      request("POST", "/coffer/v1/batch", {
        layer: 3,
        token_id: 77,
        activation: [0.5],
        entries: [
          { expert: 11, gate: 0.75 },
          { expert: 12, gate: 0.25, replica: 1 },
        ],
        deadline_ms: 500,
        request_id: "3735928559",
      }),
      out.responder,
    );
    expect(out.status).toBe(200);
    expect(out.json()).toEqual({
      layer: 3,
      token_id: 77,
      n_reduced: 2,
      per_expert: true,
      experts: [11, 12],
      contributions: [
        [1, 2],
        [3, 4],
      ],
      request_id: null,
    });
    expect(node.received[0]).toMatchObject({ msgType: 6, layer: 3, expert: NO_EXPERT });
  });

  it("turns a BERR reply into a 502 naming the failures", async () => {
    const trailer = new Uint8Array([
      0,
      5, // code: ERR_NODE_ERROR
      0,
      1, // one failure
      0,
      11, // expert
      0,
      4, // reason: ERR_NODE_TIMEOUT
      0,
      6, // node id length
      ...new TextEncoder().encode("ps3-07"),
      0,
      7, // detail length
      ...new TextEncoder().encode("stalled"),
    ]);
    node.reply = (frame) =>
      encodeFrame({
        msgType: MSG_BERR,
        layer: frame.layer,
        expert: NO_EXPERT,
        tokenId: frame.tokenId,
        dtype: DTYPE_F32,
        shape: [1],
        payload: f32([0]),
        trailer,
      });
    const out = collector();
    await upstream.forward(
      request("POST", "/coffer/v1/batch", {
        layer: 3,
        token_id: 77,
        activation: [0.5],
        entries: [{ expert: 11, gate: 1 }],
      }),
      out.responder,
    );
    expect(out.status).toBe(502);
    expect(out.json()).toEqual({
      error: "stalled",
      code: 5,
      failures: [{ expert: 11, reason: 4, nodeId: "ps3-07" }],
    });
  });

  it("rejects malformed dispatch bodies with a 400 and never touches the cluster", async () => {
    const cases: unknown[] = [
      { expert: 1, activation: [1] },
      { layer: 1, expert: 1, activation: [] },
      { layer: 1, expert: 70000, activation: [1] },
      { layer: 1, expert: 1, activation: [1, "x"] },
      { layer: 1, expert: 1, activation: [1], token_id: -1 },
    ];
    for (const body of cases) {
      const out = collector();
      await upstream.forward(request("POST", "/coffer/v1/dispatch", body), out.responder);
      expect(out.status).toBe(400);
    }
    const badEntries = collector();
    await upstream.forward(
      request("POST", "/coffer/v1/batch", { layer: 1, activation: [1], entries: [{ expert: 1 }] }),
      badEntries.responder,
    );
    expect(badEntries.status).toBe(400);
    expect(node.received).toHaveLength(0);
  });

  it("reports unsupported routes as 404 and generation as unavailable", async () => {
    const out = collector();
    await upstream.forward(request("POST", "/api/chat", { model: "x" }), out.responder);
    expect(out.status).toBe(404);
    expect(out.json()).toEqual({ error: "not supported by a P3XC upstream" });
  });

  it("sends a tunnel error when the cluster is unreachable", async () => {
    const unreachable = createP3xcUpstream({ ...config(), p3xcPort: 1, p3xcTimeoutMs: 300 });
    const out = collector();
    await unreachable.forward(request("GET", "/coffer/v1/health"), out.responder);
    expect(out.error).toBe("upstream request failed");
    unreachable.close();
  });
});
