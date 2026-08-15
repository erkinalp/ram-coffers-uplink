import {
  decodeMessage,
  deriveSessionKeys,
  encodeMessage,
  generateNonce,
  generateSessionId,
  type Message,
  TunnelSession,
} from "@ram-coffers-uplink/protocol";
import type { FastifyInstance } from "fastify";
import { type WebSocket, WebSocketServer } from "ws";
import type { AppDeps } from "./app.js";
import { findSidecarByName } from "./store.js";
import { wsTransport } from "./ws-transport.js";

export const UPLINK_MAX_PAYLOAD = 16 * 1024 * 1024;
export const UPLINK_PING_INTERVAL_MS = 30_000;
export const UPLINK_PONG_TIMEOUT_MS = 90_000;

export interface UplinkOptions {
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export function attachUplink(
  app: FastifyInstance,
  deps: AppDeps,
  options: UplinkOptions = {},
): void {
  const opts = {
    pingIntervalMs: options.pingIntervalMs ?? UPLINK_PING_INTERVAL_MS,
    pongTimeoutMs: options.pongTimeoutMs ?? UPLINK_PONG_TIMEOUT_MS,
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: UPLINK_MAX_PAYLOAD });
  app.server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/uplink") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(app, deps, ws, opts));
  });
}

// decodeMessage only guarantees `kind` is a string; every other field is
// unvalidated, so the hello shape must be checked before any use.
function isHelloShape(msg: Message): msg is Extract<Message, { kind: "hello" }> {
  if (msg.kind !== "hello") return false;
  const hello = msg as { name?: unknown; nonce_s?: unknown; models?: unknown };
  return (
    typeof hello.name === "string" &&
    hello.name.length > 0 &&
    typeof hello.nonce_s === "string" &&
    Array.isArray(hello.models) &&
    hello.models.every((m) => typeof m === "string")
  );
}

function handleConnection(
  app: FastifyInstance,
  deps: AppDeps,
  ws: WebSocket,
  opts: Required<UplinkOptions>,
): void {
  const timeout = setTimeout(() => ws.close(), 10_000);
  ws.once("message", (data: Buffer) => {
    clearTimeout(timeout);
    try {
      const hello = decodeMessage(new Uint8Array(data));
      if (!isHelloShape(hello)) {
        app.log.info("invalid hello");
        ws.close();
        return;
      }
      const row = findSidecarByName(deps.db, hello.name);
      if (!row) {
        app.log.info({ sidecar: hello.name }, "rejected unknown sidecar");
        ws.close();
        return;
      }
      const nonceR = generateNonce();
      const sessionId = generateSessionId();
      const keys = deriveSessionKeys(
        Buffer.from(row.psk_hash, "hex"),
        Buffer.from(hello.nonce_s, "base64"),
        nonceR,
      );
      ws.send(
        encodeMessage({
          kind: "hello_ack",
          nonce_r: Buffer.from(nonceR).toString("base64"),
          session_id: sessionId,
        }),
      );
      const session = new TunnelSession(wsTransport(ws), keys, sessionId, "relay");
      deps.registry.register({
        id: row.id,
        name: row.name,
        connectedAt: new Date().toISOString(),
        activeRequests: 0,
        models: hello.models,
        session,
      });
      app.log.info({ sidecar: row.name }, "sidecar connected");
      session.onMessage((msg) => {
        if (msg.kind === "model_update") deps.registry.updateModels(row.name, msg.models);
      });
      session.onClose(() => {
        // A same-name sidecar may have reconnected and replaced this entry;
        // only unregister if the registry still points at this session.
        if (deps.registry.get(row.name)?.session === session) {
          deps.registry.unregister(row.name);
          app.log.info({ sidecar: row.name }, "sidecar disconnected");
        }
      });
      startLiveness(app, ws, session, row.name, opts);
    } catch {
      ws.close();
    }
  });
  ws.once("error", () => ws.close());
}

// Relay-side liveness: ping on an interval and close the session when no
// inbound frame (pong or otherwise) has arrived within the timeout window.
function startLiveness(
  app: FastifyInstance,
  ws: WebSocket,
  session: TunnelSession,
  name: string,
  opts: Required<UplinkOptions>,
): void {
  let lastSeen = Date.now();
  ws.on("message", () => {
    lastSeen = Date.now();
  });
  const timer = setInterval(() => {
    if (Date.now() - lastSeen > opts.pongTimeoutMs) {
      app.log.info({ sidecar: name }, "sidecar liveness timeout");
      session.close();
      return;
    }
    try {
      session.send({ kind: "ping", ts: Date.now() });
    } catch {
      session.close();
    }
  }, opts.pingIntervalMs);
  timer.unref();
  session.onClose(() => clearInterval(timer));
}
