import { describe, expect, it } from "vitest";
import { loadSidecarConfig } from "../src/config.js";

describe("loadSidecarConfig", () => {
  it("requires RELAY_URL, SIDECAR_NAME and PSK", () => {
    expect(() => loadSidecarConfig({})).toThrow(/RELAY_URL/);
    expect(() => loadSidecarConfig({ RELAY_URL: "wss://r/uplink" })).toThrow(/SIDECAR_NAME/);
    expect(() => loadSidecarConfig({ RELAY_URL: "wss://r/uplink", SIDECAR_NAME: "lab" })).toThrow(
      /PSK/,
    );
  });

  it("defaults the HTTP upstream", () => {
    const config = loadSidecarConfig({
      RELAY_URL: "wss://r/uplink",
      SIDECAR_NAME: "lab",
      PSK: "p",
    });
    expect(config).toEqual({
      relayUrl: "wss://r/uplink",
      name: "lab",
      psk: "p",
      upstream: "http",
      cofferUrl: "http://localhost:8080",
      p3xcHost: "127.0.0.1",
      p3xcPort: 5920,
      p3xcTimeoutMs: 30_000,
      g9xcHost: "127.0.0.1",
      g9xcPort: 9713,
      g9xcTimeoutMs: 30_000,
      models: [],
    });
  });

  it("reads the P3XC upstream settings and requires a model list", () => {
    expect(() =>
      loadSidecarConfig({
        RELAY_URL: "wss://r/uplink",
        SIDECAR_NAME: "lab",
        PSK: "p",
        UPSTREAM: "p3xc",
      }),
    ).toThrow(/MODELS is required/);
    const config = loadSidecarConfig({
      RELAY_URL: "wss://r/uplink",
      SIDECAR_NAME: "lab",
      PSK: "p",
      UPSTREAM: "p3xc",
      P3XC_HOST: "ps3-head",
      P3XC_PORT: "6000",
      P3XC_TIMEOUT_MS: "1500",
      MODELS: "deepseek-v3-mxfp4, qwen3-30b-a3b",
    });
    expect(config.upstream).toBe("p3xc");
    expect(config.cofferUrl).toBeNull();
    expect(config.p3xcHost).toBe("ps3-head");
    expect(config.p3xcPort).toBe(6000);
    expect(config.p3xcTimeoutMs).toBe(1500);
    expect(config.models).toEqual(["deepseek-v3-mxfp4", "qwen3-30b-a3b"]);
  });

  it("reads the G9XC upstream settings and requires a model list", () => {
    expect(() =>
      loadSidecarConfig({
        RELAY_URL: "wss://r/uplink",
        SIDECAR_NAME: "lab",
        PSK: "p",
        UPSTREAM: "g9xc",
      }),
    ).toThrow(/MODELS is required/);
    const config = loadSidecarConfig({
      RELAY_URL: "wss://r/uplink",
      SIDECAR_NAME: "lab",
      PSK: "p",
      UPSTREAM: "g9xc",
      G9XC_HOST: "ps5-001",
      G9XC_PORT: "9714",
      G9XC_TIMEOUT_MS: "1500",
      MODELS: "deepseek-v4.1-flash",
    });
    expect(config.upstream).toBe("g9xc");
    expect(config.cofferUrl).toBeNull();
    expect(config.g9xcHost).toBe("ps5-001");
    expect(config.g9xcPort).toBe(9714);
    expect(config.g9xcTimeoutMs).toBe(1500);
    expect(config.models).toEqual(["deepseek-v4.1-flash"]);
  });

  it("rejects an unknown upstream kind and a bad P3XC port", () => {
    expect(() =>
      loadSidecarConfig({
        RELAY_URL: "wss://r/uplink",
        SIDECAR_NAME: "lab",
        PSK: "p",
        UPSTREAM: "grpc",
      }),
    ).toThrow(/UPSTREAM must be/);
    expect(() =>
      loadSidecarConfig({
        RELAY_URL: "wss://r/uplink",
        SIDECAR_NAME: "lab",
        PSK: "p",
        P3XC_PORT: "70000",
      }),
    ).toThrow(/P3XC_PORT/);
    expect(() =>
      loadSidecarConfig({
        RELAY_URL: "wss://r/uplink",
        SIDECAR_NAME: "lab",
        PSK: "p",
        G9XC_PORT: "0",
      }),
    ).toThrow(/G9XC_PORT/);
  });

  it("accepts plain ws:// for local and trusted networks", () => {
    const config = loadSidecarConfig({
      RELAY_URL: "ws://relay:8080/uplink",
      SIDECAR_NAME: "lab",
      PSK: "p",
    });
    expect(config.relayUrl).toBe("ws://relay:8080/uplink");
  });

  it("rejects non-websocket RELAY_URL schemes", () => {
    expect(() =>
      loadSidecarConfig({ RELAY_URL: "http://relay/uplink", SIDECAR_NAME: "lab", PSK: "p" }),
    ).toThrow(/ws:\/\/ or wss:\/\//);
  });
});
