import {
  decodeMessage,
  deriveSessionKeys,
  encodeMessage,
  generateNonce,
  hashPsk,
  sha256Hex,
  TunnelSession,
} from "@ram-coffers-uplink/protocol";
import { WebSocket } from "ws";
import type { RelayConfig } from "../src/config.js";
import { type Db, openDatabase } from "../src/db.js";
import { RateLimiter } from "../src/ratelimit.js";
import { SidecarRegistry } from "../src/registry.js";
import { wsTransport } from "../src/ws-transport.js";

export function testConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 8080,
    adminToken: "a".repeat(16),
    sessionSecret: "s".repeat(32),
    databasePath: ":memory:",
    statsEnabled: false,
    allowedOrigins: [],
    webRoot: "/nonexistent",
    ...overrides,
  };
}

export interface TestDeps {
  config: RelayConfig;
  db: Db;
  rateLimiter: RateLimiter;
  registry: SidecarRegistry;
}

export function makeTestDeps(configOverrides: Partial<RelayConfig> = {}): TestDeps {
  return {
    config: testConfig(configOverrides),
    db: openDatabase(":memory:"),
    rateLimiter: new RateLimiter(),
    registry: new SidecarRegistry(),
  };
}

export function insertApiKey(
  db: Db,
  key: string,
  name = "test-key",
  limits: { rpm?: number | null; tokensPerDay?: number | null } = {},
): number {
  const info = db
    .prepare("INSERT INTO api_keys (key_hash, name, rpm_limit, tokens_per_day) VALUES (?, ?, ?, ?)")
    .run(sha256Hex(key), name, limits.rpm ?? null, limits.tokensPerDay ?? null);
  return Number(info.lastInsertRowid);
}

export function insertSidecar(db: Db, name: string, psk: string): void {
  db.prepare("INSERT INTO sidecars (name, psk_hash) VALUES (?, ?)").run(name, sha256Hex(psk));
}

export async function connectFakeSidecar(
  port: number,
  opts: { name: string; psk: string; models: string[] },
): Promise<{ session: TunnelSession; ws: WebSocket }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/uplink`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const nonceS = generateNonce();
  ws.send(
    encodeMessage({
      kind: "hello",
      name: opts.name,
      nonce_s: Buffer.from(nonceS).toString("base64"),
      models: opts.models,
    }),
  );
  const ackData = await new Promise<Uint8Array>((resolve, reject) => {
    ws.once("message", (data: Buffer) => resolve(new Uint8Array(data)));
    ws.once("close", () => reject(new Error("connection closed during handshake")));
  });
  const ack = decodeMessage(ackData);
  if (ack.kind !== "hello_ack") throw new Error(`expected hello_ack, got ${ack.kind}`);
  const keys = deriveSessionKeys(hashPsk(opts.psk), nonceS, Buffer.from(ack.nonce_r, "base64"));
  return { session: new TunnelSession(wsTransport(ws), keys, ack.session_id, "sidecar"), ws };
}
