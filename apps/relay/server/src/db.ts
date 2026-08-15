import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rpm_limit INTEGER,
  tokens_per_day INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS key_model_policy (
  key_id INTEGER NOT NULL REFERENCES api_keys(id),
  model TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('allow', 'disallow')),
  PRIMARY KEY (key_id, model)
);
CREATE TABLE IF NOT EXISTS global_model_policy (
  model TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('allowed', 'blocked'))
);
CREATE TABLE IF NOT EXISTS sidecars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  psk_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stats_hourly (
  key_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, model, hour)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
