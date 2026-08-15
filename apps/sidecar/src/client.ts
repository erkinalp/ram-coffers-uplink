import {
  decodeMessage,
  deriveSessionKeys,
  encodeMessage,
  generateNonce,
  hashPsk,
  type Message,
  TunnelSession,
} from "@ram-coffers-uplink/protocol";
import { WebSocket } from "ws";
import type { SidecarConfig } from "./config.js";
import { createUpstream, type Upstream } from "./upstream.js";
import { wsTransport } from "./ws-transport.js";

export interface SidecarClientOptions {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  upstream?: Upstream;
}

const REFRESH_INTERVAL_MS = 60_000;

export class SidecarClient {
  private stopped = false;
  private session: TunnelSession | null = null;
  private handshakeSocket: WebSocket | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly upstream: Upstream;

  constructor(
    private readonly config: SidecarConfig,
    opts: SidecarClientOptions = {},
  ) {
    this.upstream = opts.upstream ?? createUpstream(config);
    this.initialBackoffMs = opts.initialBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = opts.log ?? ((message) => console.log(message));
  }

  async run(): Promise<void> {
    let backoff = this.initialBackoffMs;
    while (!this.stopped) {
      let connected = false;
      try {
        connected = await this.connectOnce();
      } catch (err) {
        this.log(`connection error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (connected) backoff = this.initialBackoffMs;
      if (!this.stopped) {
        this.log(`reconnecting in ${backoff} ms`);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.handshakeSocket?.close();
    this.session?.close();
    this.upstream.close();
  }

  private async connectOnce(): Promise<boolean> {
    const models = await this.upstream.models().catch(() => [] as string[]);
    this.log(`connecting to ${this.config.relayUrl}`);
    const ws = new WebSocket(this.config.relayUrl);
    this.handshakeSocket = ws;
    const nonceS = generateNonce();
    let ack: Message;
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.send(
        encodeMessage({
          kind: "hello",
          name: this.config.name,
          nonce_s: Buffer.from(nonceS).toString("base64"),
          models,
        }),
      );
      ack = await new Promise<Message>((resolve, reject) => {
        const fail = (err: Error) => {
          clearTimeout(timer);
          reject(err);
        };
        const timer = setTimeout(() => fail(new Error("handshake timeout")), 10_000);
        ws.once("message", (data: Buffer) => {
          try {
            const message = decodeMessage(new Uint8Array(data));
            clearTimeout(timer);
            resolve(message);
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        });
        ws.once("close", () => fail(new Error("connection closed during handshake")));
        ws.once("error", fail);
      });
      if (ack.kind !== "hello_ack") throw new Error("unexpected handshake response from relay");
    } catch (err) {
      // Do not leak the socket of a failed attempt: every reconnect would leave one behind.
      ws.close();
      throw err;
    } finally {
      this.handshakeSocket = null;
    }
    const keys = deriveSessionKeys(
      hashPsk(this.config.psk),
      nonceS,
      Buffer.from(ack.nonce_r, "base64"),
    );
    const session = new TunnelSession(wsTransport(ws), keys, ack.session_id, "sidecar");
    this.session = session;
    this.log(`connected to relay as "${this.config.name}" (${models.length} models available)`);
    session.onRequestOpen((msg, responder) => {
      void this.upstream.forward(msg, responder).then(() => this.pushModels());
    });
    // The first encrypted frame doubles as proof of the PSK: the relay closes the
    // connection if it cannot be decrypted.
    session.send({ kind: "model_update", models });
    this.refreshTimer = setInterval(() => void this.pushModels(), REFRESH_INTERVAL_MS);
    await new Promise<void>((resolve) => session.onClose(resolve));
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.session = null;
    this.log("disconnected from relay");
    return true;
  }

  private async pushModels(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const models = await this.upstream.models().catch(() => null);
    // The connection may have dropped (and reconnected) while the fetch was in flight.
    if (!models || this.session !== session) return;
    try {
      session.send({ kind: "model_update", models });
    } catch {
      // The session closed between the check above and the send; nothing to retry here.
    }
  }
}
