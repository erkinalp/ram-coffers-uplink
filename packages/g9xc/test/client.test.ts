import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DTYPE_FP32,
  encodeFrame,
  FLAG_PER_EXPERT,
  type Frame,
  FrameReader,
  G9xcClient,
  MSG_ERROR,
  MSG_EXPERT_RESULT,
  MSG_HELLO_ACK,
  MSG_PING,
  MSG_PONG,
  MSG_STATUS,
  MSG_STATUS_REPLY,
} from "../src/index.js";

/** A stub gen9 node: answers each frame with what the test queued for it. */
class StubNode {
  private readonly server: net.Server;
  readonly sockets: net.Socket[] = [];
  received: Frame[] = [];
  port = 0;

  constructor(private readonly reply: (frame: Frame) => Uint8Array | null) {
    this.server = net.createServer((socket) => {
      this.sockets.push(socket);
      const reader = new FrameReader();
      socket.on("data", (chunk) => {
        for (const frame of reader.push(new Uint8Array(chunk))) {
          this.received.push(frame);
          const response = this.reply(frame);
          if (response) socket.write(response);
        }
      });
      socket.on("error", () => undefined);
    });
  }

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

/** Reply frames echo the request id, as the protocol requires. */
function replyTo(request: Frame, msgType: number, payload: Uint8Array, flags = 0): Uint8Array {
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

function rowsPayload(experts: number[], width: number, fill = 1): Uint8Array {
  const payload = new Uint8Array(6 + experts.length * 2 + experts.length * width * 4);
  const view = new DataView(payload.buffer);
  view.setUint16(0, experts.length, true);
  view.setUint32(2, width, true);
  let off = 6;
  for (const id of experts) {
    view.setUint16(off, id, true);
    off += 2;
  }
  for (let i = 0; i < experts.length * width; i++) {
    view.setFloat32(off + i * 4, fill + i, true);
  }
  return payload;
}

describe("G9xcClient", () => {
  let node: StubNode | null = null;
  let client: G9xcClient | null = null;

  afterEach(async () => {
    client?.close();
    await node?.close();
    node = null;
    client = null;
  });

  it("reuses one connection across ping, status and a batch dispatch", async () => {
    node = new StubNode((frame) => {
      if (frame.msgType === MSG_PING) return replyTo(frame, MSG_PONG, frame.payload);
      if (frame.msgType === MSG_STATUS)
        return replyTo(frame, MSG_STATUS_REPLY, new TextEncoder().encode("all quiet"));
      return replyTo(frame, MSG_EXPERT_RESULT, rowsPayload([9, 11], 2), FLAG_PER_EXPERT);
    });
    await node.listen();
    client = new G9xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 2000 });
    expect(await client.ping()).toBeGreaterThanOrEqual(0);
    expect(await client.status()).toBe("all quiet");
    const result = await client.dispatchBatch({
      layer: 3,
      expertIds: [9, 11],
      gates: [0.6, 0.4],
      token: 12,
      activation: [1.5, -2.5],
    });
    expect(result.perExpert).toBe(true);
    expect(result.experts).toEqual([9, 11]);
    expect(result.rows).toHaveLength(2);
    expect(node.sockets).toHaveLength(1);
    const batch = node.received[2];
    expect(batch?.requestId).not.toBe(0);
    expect(batch?.layer).toBe(3);
    expect(batch?.expert).toBe(9);
    expect(batch?.token).toBe(12);
    // The payload names the full set plus a stated activation width.
    const view = new DataView(new Uint8Array(batch?.payload ?? []).buffer);
    expect(view.getUint16(0, true)).toBe(2);
    expect(view.getUint32(2, true)).toBe(2);
    expect(view.getUint8(6)).toBe(0);
  });

  it("interleaves concurrent requests and matches replies by request id", async () => {
    // Hold both requests, then answer the second one first.
    node = new StubNode(() => null);
    await node.listen();
    client = new G9xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 2000 });
    const first = client.dispatchBatch({
      layer: 0,
      expertIds: [7],
      gates: [1],
      activation: [1],
    });
    const second = client.dispatchBatch({
      layer: 0,
      expertIds: [8],
      gates: [1],
      activation: [2],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(node.received).toHaveLength(2);
    const [requestA, requestB] = node.received;
    const socket = node.sockets[0];
    expect(socket).toBeDefined();
    socket?.write(
      replyTo(requestB as Frame, MSG_EXPERT_RESULT, rowsPayload([8], 1), FLAG_PER_EXPERT),
    );
    socket?.write(
      replyTo(requestA as Frame, MSG_EXPERT_RESULT, rowsPayload([7], 1), FLAG_PER_EXPERT),
    );
    expect((await first).experts).toEqual([7]);
    expect((await second).experts).toEqual([8]);
  });

  it("surfaces an ERROR frame as a failed dispatch", async () => {
    node = new StubNode((frame) =>
      replyTo(frame, MSG_ERROR, new TextEncoder().encode("expert not resident")),
    );
    await node.listen();
    client = new G9xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 2000 });
    await expect(client.dispatchExpert({ layer: 0, expert: 4, activation: [1] })).rejects.toThrow(
      /expert not resident/,
    );
  });

  it("round-trips the node's hello", async () => {
    const strings = ["ps5-001", "ps5", "vulkan", "ps5-linux"];
    const payload = new Uint8Array(25 + strings.reduce((n, s) => n + 2 + s.length, 0));
    const view = new DataView(payload.buffer);
    view.setBigUint64(0, 4096n, true);
    view.setBigUint64(8, 1024n, true);
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
    node = new StubNode((frame) => replyTo(frame, MSG_HELLO_ACK, payload));
    await node.listen();
    client = new G9xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 2000 });
    const hello = await client.hello();
    expect(hello.unitId).toBe("ps5-001");
    expect(hello.sku).toBe("ps5");
    expect(hello.weightBytes).toBe(4096n);
  });

  it("times out a silent node without dropping the connection", async () => {
    node = new StubNode(() => null);
    await node.listen();
    client = new G9xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 120 });
    await expect(client.ping()).rejects.toThrow(/timed out/);
    // Unlike P3XC the replies are not positional, so the socket survives.
    await expect(client.ping()).rejects.toThrow(/timed out/);
    expect(node.sockets).toHaveLength(1);
  });

  it("rejects in-flight requests when the node disconnects", async () => {
    node = new StubNode(() => null);
    await node.listen();
    client = new G9xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 5000 });
    const pending = client.ping();
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const socket of node.sockets) socket.destroy();
    await expect(pending).rejects.toThrow(/connection closed/);
  });

  it("refuses to connect to a closed port", async () => {
    client = new G9xcClient({ host: "127.0.0.1", port: 1, timeoutMs: 500 });
    await expect(client.ping()).rejects.toThrow();
  });
});
