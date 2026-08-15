/**
 * A P3XC client: one TCP connection to an expert node, a subcluster coordinator
 * or a layer coordinator, speaking the same frames as `ps3_cluster.transport`.
 *
 * The connection is persistent (a console pays a full TCP handshake per token
 * otherwise) and requests are answered strictly in order, exactly as the Python
 * coordinator expects.
 */

import { connect, type Socket } from "node:net";
import {
  type BatchError,
  type BatchRequestInit,
  type BatchResponse,
  encodeBatchRequest,
  parseBatchError,
  parseBatchResponse,
} from "./batch.js";
import {
  DTYPE_F32,
  encodeFrame,
  type Frame,
  FrameReader,
  MSG_BERR,
  MSG_BRSP,
  MSG_ERR,
  MSG_PING,
  MSG_PONG,
  MSG_REQ,
  MSG_RSP,
  NO_EXPERT,
  P3xcError,
} from "./frame.js";
import { decodeFloat32BE, encodeFloat32BE } from "./tensor.js";

export interface P3xcClientOptions {
  host: string;
  port: number;
  /** Per-request timeout; a slow console must not hold a tunnel open. */
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

interface Waiter {
  resolve(frame: Frame): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class P3xcClient {
  private socket: Socket | null = null;
  private reader = new FrameReader();
  private readonly waiters: Waiter[] = [];
  private connecting: Promise<Socket> | null = null;

  constructor(private readonly options: P3xcClientOptions) {}

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 30_000;
  }

  async connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.options.port });
      socket.setNoDelay(true);
      const timer = setTimeout(
        () => socket.destroy(new P3xcError("connect timed out")),
        this.options.connectTimeoutMs ?? 5_000,
      );
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.reader = new FrameReader();
        socket.on("data", (chunk: Buffer) => this.onData(socket, chunk));
        socket.on("error", (error: Error) => this.fail(socket, error));
        socket.on("close", () => this.fail(socket, new P3xcError("connection closed")));
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
    this.rejectAll(new P3xcError("client closed"));
  }

  private onData(socket: Socket, chunk: Buffer): void {
    if (socket !== this.socket) return;
    let frames: Frame[];
    try {
      frames = this.reader.push(new Uint8Array(chunk));
    } catch (error) {
      this.fail(socket, error instanceof Error ? error : new P3xcError("frame decode failed"));
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  // A socket that has already been replaced (after a timeout, say) must not
  // reject the waiters queued on its successor.
  private fail(socket: Socket, error: Error): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift() as Waiter;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private async exchange(frame: Uint8Array): Promise<Frame> {
    const socket = await this.connect();
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new P3xcError("request timed out"));
        // Responses are positional, so a lost reply desynchronises the stream:
        // drop the connection and fail whatever else was queued on it.
        this.fail(socket, new P3xcError("connection abandoned after a timeout"));
        socket.destroy();
      }, this.timeoutMs);
      this.waiters.push({ resolve, reject, timer });
      socket.write(frame, (error) => {
        if (error) {
          clearTimeout(timer);
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
        layer: 0,
        expert: NO_EXPERT,
        tokenId: 0,
        dtype: DTYPE_F32,
        shape: [1],
        payload: encodeFloat32BE([0]),
      }),
    );
    if (frame.msgType !== MSG_PONG) throw new P3xcError(`expected PONG, got ${frame.msgType}`);
    return Date.now() - started;
  }

  /** One expert's forward pass: send an activation, get its output back. */
  async dispatchExpert(init: {
    layer: number;
    expert: number;
    tokenId: number;
    activation: ArrayLike<number>;
  }): Promise<Float32Array> {
    const frame = await this.exchange(
      encodeFrame({
        msgType: MSG_REQ,
        layer: init.layer,
        expert: init.expert,
        tokenId: init.tokenId,
        dtype: DTYPE_F32,
        shape: [init.activation.length],
        payload: encodeFloat32BE(init.activation),
      }),
    );
    if (frame.msgType === MSG_ERR) throw new P3xcError("expert node answered ERR");
    if (frame.msgType !== MSG_RSP) throw new P3xcError(`expected RSP, got ${frame.msgType}`);
    return decodeFloat32BE(frame.payload);
  }

  /** A batched subcluster dispatch: one activation, many experts. */
  async dispatchBatch(init: BatchRequestInit): Promise<BatchResponse> {
    const frame = await this.exchange(encodeBatchRequest(init));
    if (frame.msgType === MSG_BERR) throw new BatchDispatchError(parseBatchError(frame));
    if (frame.msgType !== MSG_BRSP) throw new P3xcError(`expected BRSP, got ${frame.msgType}`);
    return parseBatchResponse(frame);
  }
}

export class BatchDispatchError extends Error {
  constructor(readonly detail: BatchError) {
    super(detail.detail.length > 0 ? detail.detail : `batch failed with code ${detail.code}`);
    this.name = "BatchDispatchError";
  }
}
