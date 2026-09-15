import net from "node:net";
import {
  DTYPE_FP32,
  encodeFrame,
  FLAG_PER_EXPERT,
  type Frame,
  FrameReader,
  MSG_ERROR,
  MSG_EXPERT_RESULT,
  MSG_HELLO_ACK,
  MSG_PONG,
  MSG_STATUS_REPLY,
} from "@ram-coffers-uplink/g9xc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createG9xcUpstream } from "../src/coffer-g9xc.js";
import type { UpstreamRequest } from "../src/coffer-http.js";
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

function rowsPayload(experts: number[], rows: number[][]): Uint8Array {
  const width = rows[0]?.length ?? 0;
  const payload = new Uint8Array(6 + experts.length * 2 + rows.length * width * 4);
  const view = new DataView(payload.buffer);
  view.setUint16(0, experts.length, true);
  view.setUint32(2, width, true);
  let off = 6;
  for (const id of experts) {
    view.setUint16(off, id, true);
    off += 2;
  }
  for (const row of rows)
    for (const value of row) {
      view.setFloat32(off, value, true);
      off += 4;
    }
  return payload;
}

/** A stub gen9 node: answers each frame with what the test queued for it. */
class StubNode {
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

function reply(request: Frame, msgType: number, payload: Uint8Array, flags = 0): Uint8Array {
  return encodeFrame({
    msgType,
    requestId: request.requestId,
    layer: request.layer,
    expert: request.expert,
    token: request.token,
    dtype: DTYPE_FP32,
    rank: 0,
    flags,
    payload,
  });
}

function helloPayload(): Uint8Array {
  const strings = ["ps5-001", "ps5", "vulkan", "ps5-linux"];
  const payload = new Uint8Array(25 + strings.reduce((n, s) => n + 2 + s.length, 0));
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, 1234n, true);
  view.setBigUint64(8, 567n, true);
  view.setFloat64(16, 800, true);
  view.setUint8(24, 2);
  let off = 25;
  for (const text of strings) {
    const raw = new TextEncoder().encode(text);
    view.setUint16(off, raw.length, true);
    off += 2;
    payload.set(raw, off);
    off += raw.length;
  }
  return payload;
}

describe("G9XC upstream", () => {
  let node: StubNode;
  let upstream: Upstream;

  function config(): SidecarConfig {
    return {
      relayUrl: "ws://relay/uplink",
      name: "gen9-shelf",
      psk: "psk",
      upstream: "g9xc",
      cofferUrl: null,
      p3xcHost: "127.0.0.1",
      p3xcPort: 5920,
      p3xcTimeoutMs: 2000,
      g9xcHost: "127.0.0.1",
      g9xcPort: node.port,
      g9xcTimeoutMs: 2000,
      models: ["deepseek-v4.1-flash"],
    };
  }

  beforeEach(async () => {
    node = new StubNode();
    await node.listen();
    upstream = createG9xcUpstream(config());
  });

  afterEach(async () => {
    upstream.close();
    await node.close();
  });

  it("advertises the configured models without asking the node", async () => {
    expect(await upstream.models()).toEqual(["deepseek-v4.1-flash"]);
    const tags = collector();
    await upstream.forward(request("GET", "/api/tags"), tags.responder);
    expect(tags.json()).toEqual({
      models: [{ name: "deepseek-v4.1-flash", model: "deepseek-v4.1-flash" }],
    });
    expect(node.received).toHaveLength(0);
  });

  it("answers a health probe with the node's hello and round-trip time", async () => {
    node.reply = (frame) =>
      frame.msgType === 9
        ? reply(frame, MSG_PONG, frame.payload)
        : reply(frame, MSG_HELLO_ACK, helloPayload());
    const health = collector();
    await upstream.forward(request("GET", "/coffer/v1/health"), health.responder);
    expect(health.status).toBe(200);
    const body = health.json<{
      status: string;
      node: string;
      unit: string;
      sku: string;
      rtt_ms: number;
    }>();
    expect(body.status).toBe("ok");
    expect(body.node).toBe(`127.0.0.1:${node.port}`);
    expect(body.unit).toBe("ps5-001");
    expect(body.sku).toBe("ps5");
    expect(body.rtt_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns the node's status text", async () => {
    node.reply = (frame) =>
      reply(frame, MSG_STATUS_REPLY, new TextEncoder().encode("2 experts resident, 0 queued"));
    const status = collector();
    await upstream.forward(request("GET", "/coffer/v1/status"), status.responder);
    expect(status.status).toBe(200);
    expect(status.json()).toEqual({ status: "2 experts resident, 0 queued" });
  });

  it("dispatches one expert and returns its output", async () => {
    node.reply = (frame) =>
      reply(frame, MSG_EXPERT_RESULT, rowsPayload([frame.expert], [[0.5, 1.5]]), FLAG_PER_EXPERT);
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
    expect(node.received[0]).toMatchObject({ msgType: 3, layer: 4, expert: 6, token: 8 });
  });

  it("dispatches a batch and reports per-expert contributions and flags", async () => {
    node.reply = (frame) =>
      reply(
        frame,
        MSG_EXPERT_RESULT,
        rowsPayload(
          [11, 12],
          [
            [1, 2],
            [3, 4],
          ],
        ),
        FLAG_PER_EXPERT | 32,
      );
    const out = collector();
    await upstream.forward(
      request("POST", "/coffer/v1/batch", {
        layer: 3,
        token_id: 77,
        activation: [0.5],
        entries: [
          { expert: 11, gate: 0.75 },
          { expert: 12, gate: 0.25 },
        ],
        request_id: "3735928559",
      }),
      out.responder,
    );
    expect(out.status).toBe(200);
    expect(out.json()).toEqual({
      layer: 3,
      token_id: 77,
      n_experts: 2,
      per_expert: true,
      experts: [11, 12],
      contributions: [
        [1, 2],
        [3, 4],
      ],
      batch_id: "3735928559",
      replayed: true,
      from_storage: false,
    });
    // request_id lands in the payload as the batch's dedup id.
    const payload = new DataView(new Uint8Array(node.received[0]?.payload ?? []).buffer);
    expect(payload.getUint8(6)).toBe(1);
    expect(payload.getBigUint64(7, true)).toBe(3735928559n);
  });

  it("turns an ERROR reply into a 502 with the node's message", async () => {
    node.reply = (frame) =>
      reply(frame, MSG_ERROR, new TextEncoder().encode("expert not resident"));
    const out = collector();
    await upstream.forward(
      request("POST", "/coffer/v1/batch", {
        layer: 3,
        activation: [0.5],
        entries: [{ expert: 11, gate: 1 }],
      }),
      out.responder,
    );
    expect(out.status).toBe(502);
    expect(out.json()).toEqual({ error: "expert not resident" });
  });

  it("rejects malformed bodies and replica placement with a 400", async () => {
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
    const replica = collector();
    await upstream.forward(
      request("POST", "/coffer/v1/batch", {
        layer: 1,
        activation: [1],
        entries: [{ expert: 1, gate: 1, replica: 2 }],
      }),
      replica.responder,
    );
    expect(replica.status).toBe(400);
    expect(replica.json()).toEqual({
      error: "replica is a coordinator decision; a G9XC node takes none",
    });
    const badId = collector();
    await upstream.forward(
      request("POST", "/coffer/v1/batch", {
        layer: 1,
        activation: [1],
        entries: [{ expert: 1, gate: 1 }],
        request_id: "not-a-number",
      }),
      badId.responder,
    );
    expect(badId.status).toBe(400);
    expect(node.received).toHaveLength(0);
  });

  it("reports generation routes as unavailable on a node upstream", async () => {
    const out = collector();
    await upstream.forward(request("POST", "/api/chat", { model: "x" }), out.responder);
    expect(out.status).toBe(404);
    expect(out.json()).toEqual({ error: "not supported by a G9XC upstream" });
  });

  it("sends a tunnel error when the node is unreachable", async () => {
    const unreachable = createG9xcUpstream({ ...config(), g9xcPort: 1, g9xcTimeoutMs: 300 });
    const out = collector();
    await unreachable.forward(request("GET", "/coffer/v1/health"), out.responder);
    expect(out.error).toBe("upstream request failed");
    unreachable.close();
  });
});
