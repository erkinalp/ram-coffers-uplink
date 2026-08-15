import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { makeTestDeps, type TestDeps } from "./helpers.js";

describe("static SPA serving", () => {
  let deps: TestDeps;
  let app: FastifyInstance;

  beforeEach(async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "ou-web-"));
    writeFileSync(join(webRoot, "index.html"), "<html>spa</html>");
    deps = makeTestDeps({ webRoot });
    app = await buildServer(deps);
  });

  afterEach(async () => {
    await app.close();
    deps.db.close();
  });

  it("serves index.html for SPA routes and 404s unknown API paths", async () => {
    const spa = await app.inject({ method: "GET", url: "/admin/models" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toBe("<html>spa</html>");
    const missing = await app.inject({ method: "GET", url: "/api/nonexistent" });
    expect(missing.statusCode).toBe(404);
  });
});
