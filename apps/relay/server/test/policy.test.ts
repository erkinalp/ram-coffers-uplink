import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { isModelAllowed, resolveModelPermission } from "../src/policy.js";
import { insertApiKey, makeTestDeps } from "./helpers.js";

function setup() {
  const db = openDatabase(":memory:");
  const keyId = insertApiKey(db, "key-1");
  return { db, keyId };
}

describe("model policy resolution", () => {
  it("key allow wins over global blocked", () => {
    const { db, keyId } = setup();
    db.prepare("INSERT INTO global_model_policy (model, mode) VALUES ('m', 'blocked')").run();
    db.prepare("INSERT INTO key_model_policy (key_id, model, mode) VALUES (?, 'm', 'allow')").run(
      keyId,
    );
    expect(isModelAllowed(db, keyId, "m")).toBe(true);
    expect(resolveModelPermission(db, keyId, "m")).toEqual({ allowed: true, source: "key" });
  });

  it("key disallow wins over global allowed", () => {
    const { db, keyId } = setup();
    db.prepare("INSERT INTO global_model_policy (model, mode) VALUES ('m', 'allowed')").run();
    db.prepare(
      "INSERT INTO key_model_policy (key_id, model, mode) VALUES (?, 'm', 'disallow')",
    ).run(keyId);
    expect(isModelAllowed(db, keyId, "m")).toBe(false);
    expect(resolveModelPermission(db, keyId, "m")).toEqual({ allowed: false, source: "key" });
  });

  it("inherit falls back to global allowed and blocked", () => {
    const { db, keyId } = setup();
    db.prepare(
      "INSERT INTO global_model_policy (model, mode) VALUES ('a', 'allowed'), ('b', 'blocked')",
    ).run();
    expect(isModelAllowed(db, keyId, "a")).toBe(true);
    expect(resolveModelPermission(db, keyId, "a")).toEqual({ allowed: true, source: "global" });
    expect(isModelAllowed(db, keyId, "b")).toBe(false);
    expect(resolveModelPermission(db, keyId, "b")).toEqual({ allowed: false, source: "global" });
  });

  it("defaults to allowed when no rows exist", () => {
    const { db, keyId } = setup();
    expect(isModelAllowed(db, keyId, "anything")).toBe(true);
    expect(resolveModelPermission(db, keyId, "anything")).toEqual({
      allowed: true,
      source: "default",
    });
  });
});

describe("collectKnownModels", () => {
  it("unions online, key policy and global policy models", async () => {
    const { collectKnownModels } = await import("../src/policy.js");
    const deps = makeTestDeps();
    insertApiKey(deps.db, "key-1");
    deps.registry.register({
      id: 1,
      name: "s",
      connectedAt: "",
      activeRequests: 0,
      models: ["online-m"],
      session: null as never,
    });
    deps.db
      .prepare("INSERT INTO key_model_policy (key_id, model, mode) VALUES (1, 'key-m', 'allow')")
      .run();
    deps.db
      .prepare("INSERT INTO global_model_policy (model, mode) VALUES ('global-m', 'blocked')")
      .run();
    expect(collectKnownModels(deps.db, deps.registry)).toEqual(["global-m", "key-m", "online-m"]);
  });
});
