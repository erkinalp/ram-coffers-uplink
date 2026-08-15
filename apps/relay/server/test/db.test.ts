import { describe, expect, it } from "vitest";
import { openDatabase, SCHEMA } from "../src/db.js";
import { getStatsEnabled, setStatsEnabled } from "../src/store.js";

describe("openDatabase", () => {
  it("creates the schema idempotently", () => {
    const db = openDatabase(":memory:");
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const table of [
      "api_keys",
      "global_model_policy",
      "key_model_policy",
      "settings",
      "sidecars",
      "stats_hourly",
    ]) {
      expect(tables).toContain(table);
    }
    expect(() => db.exec(SCHEMA)).not.toThrow();
    db.close();
  });
});

describe("stats setting", () => {
  it("falls back to the env default, then the persisted setting wins", () => {
    const db = openDatabase(":memory:");
    expect(getStatsEnabled(db, false)).toBe(false);
    expect(getStatsEnabled(db, true)).toBe(true);
    setStatsEnabled(db, true, false);
    expect(getStatsEnabled(db, false)).toBe(true);
    setStatsEnabled(db, false, false);
    expect(getStatsEnabled(db, true)).toBe(false);
    db.close();
  });

  it("purges stats_hourly when disabling with purge", () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO api_keys (key_hash, name) VALUES ('h', 'k')").run();
    db.prepare(
      "INSERT INTO stats_hourly (key_id, model, hour, requests) VALUES (1, 'm', '2026-08-13T18', 1)",
    ).run();
    setStatsEnabled(db, false, true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM stats_hourly").get()).toEqual({ n: 0 });
    db.close();
  });
});
