import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DTYPE_F32,
  encodeFrame,
  FrameReader,
  MSG_BERR,
  MSG_BRSP,
  MSG_ERR,
  MSG_PONG,
  MSG_RSP,
  NO_EXPERT,
  P3xcClient,
  RSP_FLAG_PER_EXPERT,
} from "../src/index.js";

/** A stub expert node: answers each frame with what the test queued for it. */
class StubNode {
  private readonly server: net.Server;
  readonly sockets: net.Socket[] = [];
  received: Array<{ msgType: number; layer: number; expert: number; tokenId: number }> = [];
  port = 0;

  constructor(private readonly reply: (msgType: number) => Uint8Array | null) {
    this.server = net.createServer((socket) => {
      this.sockets.push(socket);
      const reader = new FrameReader();
      socket.on("data", (chunk) => {
        for (const frame of reader.push(new Uint8Array(chunk))) {
          this.received.push({
            msgType: frame.msgType,
            layer: frame.layer,
            expert: frame.expert,
            tokenId: frame.tokenId,
          });
          const response = this.reply(frame.msgType);
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

function f32Frame(msgType: number, values: number[], trailer?: Uint8Array) {
  const payload = new Uint8Array(values.length * 4);
  const view = new DataView(payload.buffer);
  for (const [index, value] of values.entries()) view.setFloat32(index * 4, value);
  return encodeFrame({
    msgType,
    layer: 1,
    expert: NO_EXPERT,
    tokenId: 3,
    dtype: DTYPE_F32,
    shape: [values.length],
    payload,
    ...(trailer ? { trailer } : {}),
  });
}

describe("P3xcClient", () => {
  let node: StubNode | null = null;
  let client: P3xcClient | null = null;

  afterEach(async () => {
    client?.close();
    await node?.close();
    node = null;
    client = null;
  });

  it("reuses one connection across requests and dispatches an expert", async () => {
    node = new StubNode((msgType) =>
      msgType === 4 ? f32Frame(MSG_PONG, [0]) : f32Frame(MSG_RSP, [3, -5]),
    );
    await node.listen();
    client = new P3xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 2000 });
    expect(await client.ping()).toBeGreaterThanOrEqual(0);
    const output = await client.dispatchExpert({
      layer: 2,
      expert: 5,
      tokenId: 9,
      activation: [1.5, -2.5],
    });
    expect([...output]).toEqual([3, -5]);
    expect(node.sockets).toHaveLength(1);
    expect(node.received.map((f) => f.msgType)).toEqual([4, 1]);
    expect(node.received[1]).toMatchObject({ layer: 2, expert: 5, tokenId: 9 });
  });

  it("surfaces an ERR frame as a failed dispatch", async () => {
    node = new StubNode(() => f32Frame(MSG_ERR, [0]));
    await node.listen();
    client = new P3xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 2000 });
    await expect(
      client.dispatchExpert({ layer: 0, expert: 0, tokenId: 0, activation: [1] }),
    ).rejects.toThrow(/answered ERR/);
  });

  it("parses an exact batch reply and raises BERR as an error", async () => {
    const experts = new Uint8Array([0, 2, 0, RSP_FLAG_PER_EXPERT, 0, 11, 0, 12]);
    const rows = new Uint8Array(16);
    const rowView = new DataView(rows.buffer);
    for (const [index, value] of [1, 2, 3, 4].entries()) rowView.setFloat32(index * 4, value);
    const brsp = encodeFrame({
      msgType: MSG_BRSP,
      layer: 3,
      expert: NO_EXPERT,
      tokenId: 77,
      dtype: DTYPE_F32,
      shape: [2, 2],
      payload: rows,
      trailer: experts,
    });
    node = new StubNode(() => brsp);
    await node.listen();
    client = new P3xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 2000 });
    const response = await client.dispatchBatch({
      layer: 3,
      tokenId: 77,
      activation: [0.5],
      entries: [
        { expert: 11, gate: 0.5 },
        { expert: 12, gate: 0.5 },
      ],
    });
    expect(response.experts).toEqual([11, 12]);
    expect(response.contributions.map((row) => [...row])).toEqual([
      [1, 2],
      [3, 4],
    ]);

    // code 5, no failures, empty detail, no echoed id.
    const berrTrailer = new Uint8Array([0, 5, 0, 0, 0, 0]);
    await node.close();
    node = new StubNode(() => f32Frame(MSG_BERR, [0], berrTrailer));
    await node.listen();
    client.close();
    client = new P3xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 2000 });
    await expect(
      client.dispatchBatch({
        layer: 3,
        tokenId: 77,
        activation: [0.5],
        entries: [{ expert: 11, gate: 1 }],
      }),
    ).rejects.toThrow(/batch failed with code 5/);
  });

  it("times out a silent node and drops the queued request", async () => {
    node = new StubNode(() => null);
    await node.listen();
    client = new P3xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 120 });
    await expect(client.ping()).rejects.toThrow(/timed out/);
    // The socket is discarded, so the next call opens a fresh connection.
    await expect(client.ping()).rejects.toThrow(/timed out/);
    expect(node.sockets).toHaveLength(2);
  });

  it("fails every request queued on a connection it abandons", async () => {
    node = new StubNode(() => null);
    await node.listen();
    const local = new P3xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 120 });
    client = local;
    const first = local.ping();
    const second = local.dispatchExpert({ layer: 0, expert: 0, tokenId: 0, activation: [1] });
    await expect(first).rejects.toThrow(/timed out/);
    await expect(second).rejects.toThrow(/timed out|abandoned/);
  });

  it("rejects in-flight requests when the node disconnects", async () => {
    node = new StubNode(() => null);
    await node.listen();
    const local = new P3xcClient({ host: "127.0.0.1", port: node.port, timeoutMs: 5000 });
    client = local;
    const pending = local.ping();
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const socket of node.sockets) socket.destroy();
    await expect(pending).rejects.toThrow(/connection closed/);
  });

  it("refuses to connect to a closed port", async () => {
    client = new P3xcClient({ host: "127.0.0.1", port: 1, timeoutMs: 500 });
    await expect(client.ping()).rejects.toThrow();
  });
});
