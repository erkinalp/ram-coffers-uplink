import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { makeTestDeps } from "./helpers.js";

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const app = await buildServer(makeTestDeps());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
