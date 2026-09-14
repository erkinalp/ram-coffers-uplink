/**
 * A G9XC client: one persistent, multiplexed TCP connection to a gen9 node —
 * the console-side worker (`gen9_cluster.node.NodeServer`) or anything else
 * that answers the framing.
 *
 * Replies are matched by `request_id`, not by position, so unlike the P3XC
 * client several requests may be in flight at once — the whole point of the
 * v2 transport is that a wide shelf's fan-out does not serialise.
 */

import { connect, type Socket } from "node:net";
import {
  type ExpertBatchInit,
  type ExpertResult,
  encodeExpertBatch,
  type Hello,
  parseExpertResult,
  parseHello,
} from "./batch.js";
import {
  DTYPE_FP32,
  encodeFrame,
  type Frame,
  FrameReader,
  G9xcError,
  MSG_HELLO,
  MSG_HELLO_ACK,
  MSG_PING,
  MSG_PONG,
  MSG_STATUS,
  MSG_STATUS_REPLY,
} from "./frame.js";
import { decodeFloat32LE, encodeFloat32LE } from "./tensor.js";

export interface G9xcClientOptions {
  host: string;
  port: number;
  /** Per-request deadline; a slow console must not hold a tunnel open. */
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

interface Waiter {
  resolve(frame: Frame): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class G9xcClient {
  private socket: Socket | null = null;
  private reader = new FrameReader();
  private readonly waiters = new Map<number, Waiter>();
  private connecting: Promise<Socket> | null = null;
  private nextRequestId = 0;

  constructor(private readonly options: G9xcClientOptions) {}

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 30_000;
  }

  async connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.options.port });
      // Nagle off is a correctness requirement, not an optimisation: a
      // delayed-ACK interaction can dominate a forward pass.
      socket.setNoDelay(true);
      const timer = setTimeout(
        () => socket.destroy(new G9xcError("connect timed out")),
        this.options.connectTimeoutMs ?? 5_000,
      );
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.reader = new FrameReader();
        socket.on("data", (chunk: Buffer) => this.onData(socket, chunk));
        socket.on("error", (error: Error) => this.fail(socket, error));
        socket.on("close", () => this.fail(socket, new G9xcError("connection closed")));
        resolve(socket);
      });
      socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.rejectAll(new G9xcError("client closed"));
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private onData(socket: Socket, chunk: Buffer): void {
    if (socket !== this.socket) return;
    let frames: Frame[];
    try {
      frames = this.reader.push(new Uint8Array(chunk));
    } catch (error) {
      this.fail(socket, error instanceof Error ? error : new G9xcError("frame decode failed"));
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      const waiter = this.waiters.get(frame.requestId);
      if (!waiter) continue; // a reply for a timed-out request
      this.waiters.delete(frame.requestId);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  // A socket that has already been replaced (after a reconnect, say) must not
  // reject the waiters queued on its successor.
  private fail(socket: Socket, error: Error): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.rejectAll(error);
  }

  private allocateRequestId(): number {
    // Per-connection ids, wrapping at 2^32 and skipping 0.
    for (;;) {
      this.nextRequestId = (this.nextRequestId + 1) % 0x1_0000_0000;
      if (this.nextRequestId === 0) continue;
      if (!this.waiters.has(this.nextRequestId)) return this.nextRequestId;
    }
  }

  private async exchange(frame: Uint8Array): Promise<Frame> {
    const socket = await this.connect();
    // The transport allocates the request id; rewrite it into the header.
    const requestId = this.allocateRequestId();
    new DataView(frame.buffer, frame.byteOffset).setUint32(8, requestId, true);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new G9xcError("request timed out"));
      }, this.timeoutMs);
      this.waiters.set(requestId, {
        timer,
        reject,
        resolve: (reply) => {
          if (reply.requestId !== requestId) {
            reject(new G9xcError("a reply echoed the wrong request id"));
            return;
          }
          resolve(reply);
        },
      });
      socket.write(frame, (error) => {
        if (error) {
          clearTimeout(timer);
          this.waiters.delete(requestId);
          reject(error);
        }
      });
    });
  }

  /** Liveness probe; resolves with the round-trip time in milliseconds. */
  async ping(): Promise<number> {
    const started = Date.now();
    const frame = await this.exchange(
      encodeFrame({
        msgType: MSG_PING,
        requestId: 0,
        layer: 0,
        expert: 0,
        token: 0,
        dtype: DTYPE_FP32,
        rank: 1,
        flags: 0,
        payload: encodeFloat32LE([0]),
      }),
    );
    if (frame.msgType !== MSG_PONG) throw new G9xcError(`expected PONG, got ${frame.msgType}`);
    return Date.now() - started;
  }

  /** The node's self-announcement: what it is, not what the plan believes. */
  async hello(): Promise<Hello> {
    const frame = await this.exchange(
      encodeFrame({
        msgType: MSG_HELLO,
        requestId: 0,
        layer: 0,
        expert: 0,
        token: 0,
        dtype: DTYPE_FP32,
        rank: 0,
        flags: 0,
      }),
    );
    if (frame.msgType !== MSG_HELLO_ACK)
      throw new G9xcError(`expected HELLO_ACK, got ${frame.msgType}`);
    return parseHello(frame.payload);
  }

  /** The node's operational counters, as its STATUS_REPLY text. */
  async status(): Promise<string> {
    const frame = await this.exchange(
      encodeFrame({
        msgType: MSG_STATUS,
        requestId: 0,
        layer: 0,
        expert: 0,
        token: 0,
        dtype: DTYPE_FP32,
        rank: 0,
        flags: 0,
      }),
    );
    if (frame.msgType !== MSG_STATUS_REPLY)
      throw new G9xcError(`expected STATUS_REPLY, got ${frame.msgType}`);
    return new TextDecoder().decode(frame.payload);
  }

  /** One EXPERT_BATCH and its tagged rows (or collapsed sum under `fast`). */
  async dispatchBatch(init: ExpertBatchInit): Promise<ExpertResult> {
    const frame = await this.exchange(encodeExpertBatch(init));
    return parseExpertResult(frame, { expertIds: init.expertIds, fast: init.fast === true });
  }

  /** A single-expert dispatch; returns that expert's weighted row. */
  async dispatchExpert(init: {
    layer: number;
    expert: number;
    token?: number;
    activation: ArrayLike<number>;
  }): Promise<Float32Array> {
    const result = await this.dispatchBatch({
      layer: init.layer,
      expertIds: [init.expert],
      gates: [1.0],
      token: init.token,
      activation: init.activation,
    });
    if (!result.perExpert) throw new G9xcError("single dispatch answered with a partial sum");
    const index = result.experts.indexOf(init.expert);
    if (index < 0) throw new G9xcError("the reply does not carry the asked expert");
    return result.rows[index] as Float32Array;
  }

  /** Decode a raw activation vector, for tests and tooling. */
  static decodeVector(payload: Uint8Array): Float32Array {
    return decodeFloat32LE(payload);
  }
}
