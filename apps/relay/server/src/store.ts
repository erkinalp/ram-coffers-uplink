import type { Usage } from "@ram-coffers-uplink/protocol";
import type { Db } from "./db.js";

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getStatsEnabled(db: Db, envDefault: boolean): boolean {
  const persisted = getSetting(db, "stats_enabled");
  return persisted === null ? envDefault : persisted === "true";
}

export function setStatsEnabled(db: Db, enabled: boolean, purge: boolean): void {
  setSetting(db, "stats_enabled", String(enabled));
  if (!enabled && purge) db.exec("DELETE FROM stats_hourly");
}

export function findSidecarByName(
  db: Db,
  name: string,
): { id: number; name: string; psk_hash: string } | null {
  const row = db
    .prepare("SELECT id, name, psk_hash FROM sidecars WHERE name = ? AND revoked = 0")
    .get(name) as { id: number; name: string; psk_hash: string } | undefined;
  return row ?? null;
}

export function recordStats(
  db: Db,
  keyId: number,
  model: string,
  usage: Usage | null,
  isError: boolean,
): void {
  const hour = new Date().toISOString().slice(0, 13);
  db.prepare(
    `INSERT INTO stats_hourly (key_id, model, hour, requests, prompt_tokens, completion_tokens, errors)
     VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (key_id, model, hour) DO UPDATE SET
       requests = requests + 1,
       prompt_tokens = prompt_tokens + excluded.prompt_tokens,
       completion_tokens = completion_tokens + excluded.completion_tokens,
       errors = errors + excluded.errors`,
  ).run(
    keyId,
    model,
    hour,
    usage?.prompt_tokens ?? 0,
    usage?.completion_tokens ?? 0,
    isError ? 1 : 0,
  );
}
