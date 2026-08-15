import { sha256Hex } from "@ram-coffers-uplink/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";

export interface ApiKeyRow {
  id: number;
  name: string;
  rpm_limit: number | null;
  tokens_per_day: number | null;
}

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: ApiKeyRow;
  }
}

export function findKeyByHash(db: Db, keyHash: string): ApiKeyRow | null {
  const row = db
    .prepare(
      "SELECT id, name, rpm_limit, tokens_per_day FROM api_keys WHERE key_hash = ? AND revoked = 0",
    )
    .get(keyHash) as ApiKeyRow | undefined;
  return row ?? null;
}

export function apiKeyAuth(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const match = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "");
    const key = match?.[1]?.trim();
    const row = key ? findKeyByHash(db, sha256Hex(key)) : null;
    if (!row) {
      await reply.code(401).send({ error: "invalid or revoked API key" });
      return;
    }
    req.apiKey = row;
  };
}
