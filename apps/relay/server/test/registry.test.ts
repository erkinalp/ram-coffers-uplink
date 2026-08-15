import type { TunnelSession } from "@ram-coffers-uplink/protocol";
import { describe, expect, it } from "vitest";
import { type OnlineSidecar, SidecarRegistry } from "../src/registry.js";

function fakeSidecar(name: string, models: string[], id = 1): OnlineSidecar {
  return {
    id,
    name,
    connectedAt: "2026-08-13T00:00:00.000Z",
    activeRequests: 0,
    models,
    session: null as unknown as TunnelSession,
  };
}

describe("SidecarRegistry", () => {
  it("lists online sidecars without sessions and updates models", () => {
    const registry = new SidecarRegistry();
    registry.register(fakeSidecar("a", ["m1", "m2"]));
    expect(registry.list()).toEqual([
      {
        id: 1,
        name: "a",
        connectedAt: "2026-08-13T00:00:00.000Z",
        activeRequests: 0,
        models: ["m1", "m2"],
      },
    ]);
    registry.updateModels("a", ["m3"]);
    expect(registry.list()[0]?.models).toEqual(["m3"]);
    expect(registry.allModels()).toEqual(["m3"]);
    registry.unregister("a");
    expect(registry.list()).toEqual([]);
  });

  it("picks round-robin across sidecars offering the model", () => {
    const registry = new SidecarRegistry();
    registry.register(fakeSidecar("a", ["m"]));
    registry.register(fakeSidecar("b", ["m"], 2));
    const picks = [1, 2, 3, 4].map((keyId) => registry.pickForModel("m", keyId)?.name);
    expect(picks).toEqual(["a", "b", "a", "b"]);
  });

  it("sticks a key to its sidecar for 60 minutes", () => {
    let now = 1_000_000;
    const registry = new SidecarRegistry(() => now);
    registry.register(fakeSidecar("a", ["m"]));
    registry.register(fakeSidecar("b", ["m"], 2));
    const first = registry.pickForModel("m", 7)?.name;
    expect(registry.pickForModel("m", 7)?.name).toBe(first);
    now += 61 * 60 * 1000;
    registry.pickForModel("m", 8); // advance round-robin cursor
    const after = registry.pickForModel("m", 7)?.name;
    expect(after).not.toBe(first);
  });

  it("falls back to round-robin when the pinned sidecar goes offline", () => {
    const registry = new SidecarRegistry();
    registry.register(fakeSidecar("a", ["m"]));
    registry.register(fakeSidecar("b", ["m"], 2));
    const pinned = registry.pickForModel("m", 7)?.name ?? "a";
    registry.unregister(pinned);
    const fallback = registry.pickForModel("m", 7);
    expect(fallback).not.toBeNull();
    expect(fallback?.name).not.toBe(pinned);
  });

  it("pickAny round-robins across all online sidecars", () => {
    const registry = new SidecarRegistry();
    registry.register(fakeSidecar("a", ["m1"]));
    registry.register(fakeSidecar("b", ["m2"], 2));
    const picks = [1, 2, 3, 4].map(() => registry.pickAny()?.name);
    expect(picks).toEqual(["a", "b", "a", "b"]);
  });

  it("pickAny returns null when no sidecar is online", () => {
    const registry = new SidecarRegistry();
    expect(registry.pickAny()).toBeNull();
  });

  it("returns null when no online sidecar offers the model", () => {
    const registry = new SidecarRegistry();
    registry.register(fakeSidecar("a", ["other"]));
    expect(registry.pickForModel("m", 1)).toBeNull();
  });
});
