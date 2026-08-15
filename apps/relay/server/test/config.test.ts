import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = { ADMIN_TOKEN: "a".repeat(16), SESSION_SECRET: "s".repeat(32) };

describe("loadConfig", () => {
  it("throws when ADMIN_TOKEN is missing or short", () => {
    expect(() => loadConfig({ SESSION_SECRET: "s".repeat(32) })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ...validEnv, ADMIN_TOKEN: "short" })).toThrow(/ADMIN_TOKEN/);
  });

  it("throws when SESSION_SECRET is missing or short", () => {
    expect(() => loadConfig({ ADMIN_TOKEN: "a".repeat(16) })).toThrow(/SESSION_SECRET/);
  });

  it("applies defaults", () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(8080);
    expect(config.databasePath).toBe("./data/relay.db");
    expect(config.statsEnabled).toBe(false);
    expect(config.allowedOrigins).toEqual([]);
  });

  it("parses PORT, STATS_ENABLED and ALLOWED_ORIGINS", () => {
    const config = loadConfig({
      ...validEnv,
      PORT: "9090",
      STATS_ENABLED: "true",
      ALLOWED_ORIGINS: "https://a.example, https://b.example",
    });
    expect(config.port).toBe(9090);
    expect(config.statsEnabled).toBe(true);
    expect(config.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
  });

  it("rejects an invalid PORT", () => {
    expect(() => loadConfig({ ...validEnv, PORT: "banana" })).toThrow(/PORT/);
  });
});
