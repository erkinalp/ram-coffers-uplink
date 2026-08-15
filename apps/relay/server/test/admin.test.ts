import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app.js";
import { insertApiKey, makeTestDeps, type TestDeps } from "./helpers.js";

describe("admin api", () => {
  let deps: TestDeps;
  let app: FastifyInstance;
  let cookie: string;

  async function login(token = deps.config.adminToken): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/admin/api/login", payload: { token } });
    expect(res.statusCode).toBe(200);
    const found = res.cookies.find((c) => c.name === "rc_session");
    if (!found) throw new Error("no session cookie");
    return found.value;
  }

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildServer(deps);
    cookie = await login();
  });

  afterEach(async () => {
    await app.close();
    deps.db.close();
  });

  it("rejects a wrong admin token and requires auth for admin routes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { token: "wrong" },
    });
    expect(res.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/admin/api/keys" })).statusCode).toBe(401);
  });

  it("creates a key shown once, lists it without the hash, updates limits and revokes it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/api/keys",
      cookies: { rc_session: cookie },
      payload: { name: "alice", rpm_limit: 60 },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.key).toMatch(/^rc_sk_[0-9a-f]{48}$/);
    expect(body.id).toBeGreaterThan(0);
    const list = await app.inject({
      method: "GET",
      url: "/admin/api/keys",
      cookies: { rc_session: cookie },
    });
    const rows = list.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.id,
      name: "alice",
      rpm_limit: 60,
      tokens_per_day: null,
      revoked: 0,
    });
    expect(rows[0].key_hash).toBeUndefined();
    expect(rows[0].key).toBeUndefined();
    const patched = await app.inject({
      method: "PATCH",
      url: `/admin/api/keys/${body.id}`,
      cookies: { rc_session: cookie },
      payload: { rpm_limit: null, tokens_per_day: 100000 },
    });
    expect(patched.statusCode).toBe(200);
    const after = (
      await app.inject({ method: "GET", url: "/admin/api/keys", cookies: { rc_session: cookie } })
    ).json();
    expect(after[0]).toMatchObject({ rpm_limit: null, tokens_per_day: 100000 });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/admin/api/keys/${body.id}/revoke`,
          cookies: { rc_session: cookie },
        })
      ).statusCode,
    ).toBe(200);
    const final = (
      await app.inject({ method: "GET", url: "/admin/api/keys", cookies: { rc_session: cookie } })
    ).json();
    expect(final[0].revoked).toBe(1);
  });

  it("rejects non-positive limit values", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/api/keys",
      cookies: { rc_session: cookie },
      payload: { name: "zero", rpm_limit: 0 },
    });
    expect(created.statusCode).toBe(400);
    const keyId = insertApiKey(deps.db, "k");
    const patched = await app.inject({
      method: "PATCH",
      url: `/admin/api/keys/${keyId}`,
      cookies: { rc_session: cookie },
      payload: { tokens_per_day: 0 },
    });
    expect(patched.statusCode).toBe(400);
  });

  it("rejects a session older than 12 hours", async () => {
    // Only fake Date so light-my-request timers keep working under inject().
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/admin/api/keys",
            cookies: { rc_session: cookie },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes nothing when a patch carries an invalid limit", async () => {
    const keyId = insertApiKey(deps.db, "k", "original", { rpm: 30 });
    const patched = await app.inject({
      method: "PATCH",
      url: `/admin/api/keys/${keyId}`,
      cookies: { rc_session: cookie },
      payload: { name: "renamed", rpm_limit: 0 },
    });
    expect(patched.statusCode).toBe(400);
    const rows = (
      await app.inject({ method: "GET", url: "/admin/api/keys", cookies: { rc_session: cookie } })
    ).json();
    expect(rows[0]).toMatchObject({ name: "original", rpm_limit: 30 });
  });

  it("returns 404 when setting policy for a nonexistent key", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/admin/api/keys/999/policy",
      cookies: { rc_session: cookie },
      payload: { model: "llama3", mode: "allow" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM key_model_policy").get()).toEqual({ n: 0 });
  });

  it("manages per-key model policy with inherit deleting the row", async () => {
    const keyId = insertApiKey(deps.db, "k");
    const put = (mode: string) =>
      app.inject({
        method: "PUT",
        url: `/admin/api/keys/${keyId}/policy`,
        cookies: { rc_session: cookie },
        payload: { model: "llama3", mode },
      });
    expect((await put("allow")).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/admin/api/keys/${keyId}/policy`,
          cookies: { rc_session: cookie },
        })
      ).json(),
    ).toEqual([{ model: "llama3", mode: "allow" }]);
    await put("disallow");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/admin/api/keys/${keyId}/policy`,
          cookies: { rc_session: cookie },
        })
      ).json(),
    ).toEqual([{ model: "llama3", mode: "disallow" }]);
    await put("inherit");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/admin/api/keys/${keyId}/policy`,
          cookies: { rc_session: cookie },
        })
      ).json(),
    ).toEqual([]);
    expect((await put("bogus")).statusCode).toBe(400);
  });

  it("manages the global model policy", async () => {
    const put = (mode: string) =>
      app.inject({
        method: "PUT",
        url: "/admin/api/policy/global",
        cookies: { rc_session: cookie },
        payload: { model: "llama3", mode },
      });
    await put("blocked");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/admin/api/policy/global",
          cookies: { rc_session: cookie },
        })
      ).json(),
    ).toEqual([{ model: "llama3", mode: "blocked" }]);
    await put("default");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/admin/api/policy/global",
          cookies: { rc_session: cookie },
        })
      ).json(),
    ).toEqual([]);
  });

  it("creates a sidecar with a PSK shown once, lists and revokes it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/api/sidecars",
      cookies: { rc_session: cookie },
      payload: { name: "homelab" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().psk).toMatch(/^rc_psk_[0-9a-f]{48}$/);
    const list = (
      await app.inject({
        method: "GET",
        url: "/admin/api/sidecars",
        cookies: { rc_session: cookie },
      })
    ).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "homelab",
      revoked: 0,
      online: false,
      active_requests: 0,
      models: [],
    });
    expect(list[0].psk_hash).toBeUndefined();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/admin/api/sidecars/${created.json().id}/revoke`,
          cookies: { rc_session: cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/admin/api/sidecars",
          cookies: { rc_session: cookie },
        })
      ).json()[0].revoked,
    ).toBe(1);
  });

  it("toggles statistics with purge and reports the source", async () => {
    const status0 = (
      await app.inject({
        method: "GET",
        url: "/admin/api/stats/status",
        cookies: { rc_session: cookie },
      })
    ).json();
    expect(status0).toEqual({ enabled: false, source: "env" });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/admin/api/stats",
          cookies: { rc_session: cookie },
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(200);
    const status1 = (
      await app.inject({
        method: "GET",
        url: "/admin/api/stats/status",
        cookies: { rc_session: cookie },
      })
    ).json();
    expect(status1).toEqual({ enabled: true, source: "setting" });
    const keyId = insertApiKey(deps.db, "k");
    deps.db
      .prepare(
        "INSERT INTO stats_hourly (key_id, model, hour, requests) VALUES (?, 'm', '2026-08-13T18', 2)",
      )
      .run(keyId);
    const rows = (
      await app.inject({ method: "GET", url: "/admin/api/stats", cookies: { rc_session: cookie } })
    ).json().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key_name: "test-key", model: "m", requests: 2 });
    await app.inject({
      method: "PUT",
      url: "/admin/api/stats",
      cookies: { rc_session: cookie },
      payload: { enabled: false, purge: true },
    });
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM stats_hourly").get()).toEqual({ n: 0 });
  });

  it("logs out and rejects the old session", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/admin/api/logout",
          cookies: { rc_session: cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/admin/api/keys", cookies: { rc_session: cookie } }))
        .statusCode,
    ).toBe(401);
  });
});
