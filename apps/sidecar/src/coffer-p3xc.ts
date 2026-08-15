/**
 * The P3XC upstream: translates the relay's JSON coffer routes into P3XC frames
 * for a RAM Coffers expert node, subcluster coordinator or layer coordinator.
 *
 * Only cluster-level operations live here (liveness, expert dispatch, batched
 * subcluster dispatch); token generation stays on the HTTP upstream, which is
 * what `both` mode exists for.
 */

import { BatchDispatchError, type BatchEntry, P3xcClient } from "@ram-coffers-uplink/p3xc";
import type { Responder } from "@ram-coffers-uplink/protocol";
import type { UpstreamRequest } from "./coffer-http.js";
import type { SidecarConfig } from "./config.js";
import type { Upstream } from "./upstream.js";

export const COFFER_PATH_PREFIX = "/coffer/";

interface DispatchBody {
  layer?: unknown;
  expert?: unknown;
  token_id?: unknown;
  activation?: unknown;
}

interface BatchBody extends DispatchBody {
  entries?: unknown;
  fast?: unknown;
  deadline_ms?: unknown;
  request_id?: unknown;
}

class BadRequest extends Error {}

function asInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max)
    throw new BadRequest(`${name} must be an integer between 0 and ${max}`);
  return value;
}

function asActivation(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new BadRequest("activation must be a non-empty array of numbers");
  return value.map((element) => {
    if (typeof element !== "number" || !Number.isFinite(element))
      throw new BadRequest("activation must contain finite numbers only");
    return element;
  });
}

function asEntries(value: unknown): BatchEntry[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new BadRequest("entries must be a non-empty array");
  return value.map((raw) => {
    if (typeof raw !== "object" || raw === null)
      throw new BadRequest("each entry must be an object");
    const entry = raw as { expert?: unknown; gate?: unknown; replica?: unknown };
    if (typeof entry.gate !== "number" || !Number.isFinite(entry.gate))
      throw new BadRequest("each entry needs a finite gate");
    return {
      expert: asInteger(entry.expert, "expert", 0xffff),
      gate: entry.gate,
      replica: entry.replica === undefined ? 0 : asInteger(entry.replica, "replica", 0xff),
    };
  });
}

function asRequestId(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number")
    return BigInt(asInteger(value, "request_id", Number.MAX_SAFE_INTEGER));
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed > 0xffffffffffffffffn) throw new BadRequest("request_id out of range");
    return parsed;
  }
  throw new BadRequest("request_id must be an integer or a decimal string");
}

function json(responder: Responder, status: number, body: unknown): void {
  responder.sendHead(status, { "content-type": "application/json" });
  responder.sendChunk(new TextEncoder().encode(JSON.stringify(body)));
  responder.sendEnd(null);
}

function parseBody(msg: UpstreamRequest): Record<string, unknown> {
  if (!msg.body) return {};
  let text: string;
  try {
    text = Buffer.from(msg.body, "base64").toString("utf8");
  } catch {
    throw new BadRequest("body is not valid base64");
  }
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequest("body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new BadRequest("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

export function createP3xcUpstream(config: SidecarConfig): Upstream {
  const client = new P3xcClient({
    host: config.p3xcHost,
    port: config.p3xcPort,
    timeoutMs: config.p3xcTimeoutMs,
  });

  const handle = async (msg: UpstreamRequest, responder: Responder): Promise<void> => {
    const path = msg.path.split("?")[0] as string;
    if (msg.method === "GET" && (path === "/api/version" || path === "/coffer/v1/version")) {
      json(responder, 200, { version: "ram-coffers-uplink", backend: "p3xc" });
      return;
    }
    if (msg.method === "GET" && path === "/api/ps") {
      json(responder, 200, { models: [] });
      return;
    }
    if (msg.method === "GET" && path === "/api/tags") {
      json(responder, 200, { models: config.models.map((name) => ({ name, model: name })) });
      return;
    }
    if (msg.method === "GET" && path === "/coffer/v1/health") {
      const rttMs = await client.ping();
      json(responder, 200, {
        status: "ok",
        coordinator: `${config.p3xcHost}:${config.p3xcPort}`,
        rtt_ms: rttMs,
      });
      return;
    }
    if (msg.method === "POST" && path === "/coffer/v1/dispatch") {
      const body = parseBody(msg) as DispatchBody;
      const output = await client.dispatchExpert({
        layer: asInteger(body.layer, "layer", 0xffff),
        expert: asInteger(body.expert, "expert", 0xffff),
        tokenId: body.token_id === undefined ? 0 : asInteger(body.token_id, "token_id", 0xffffffff),
        activation: asActivation(body.activation),
      });
      json(responder, 200, { output: Array.from(output) });
      return;
    }
    if (msg.method === "POST" && path === "/coffer/v1/batch") {
      const body = parseBody(msg) as BatchBody;
      if (body.fast !== undefined && typeof body.fast !== "boolean")
        throw new BadRequest("fast must be a boolean");
      const response = await client.dispatchBatch({
        layer: asInteger(body.layer, "layer", 0xffff),
        tokenId: body.token_id === undefined ? 0 : asInteger(body.token_id, "token_id", 0xffffffff),
        activation: asActivation(body.activation),
        entries: asEntries(body.entries),
        ...(body.deadline_ms === undefined
          ? {}
          : { deadlineMs: asInteger(body.deadline_ms, "deadline_ms", 3_600_000) }),
        ...(body.fast === undefined ? {} : { fast: body.fast }),
        ...(asRequestId(body.request_id) === undefined
          ? {}
          : { requestId: asRequestId(body.request_id) as bigint }),
      });
      json(responder, 200, {
        layer: response.layer,
        token_id: response.tokenId,
        n_reduced: response.nReduced,
        per_expert: response.perExpert,
        experts: response.experts,
        contributions: response.contributions.map((row) => Array.from(row)),
        request_id: response.requestId === null ? null : response.requestId.toString(),
      });
      return;
    }
    json(responder, 404, { error: "not supported by a P3XC upstream" });
  };

  return {
    models: () => Promise.resolve(config.models),
    forward: async (msg, responder) => {
      let cancelled = false;
      responder.onCancel(() => {
        cancelled = true;
      });
      try {
        await handle(msg, responder);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof BadRequest) {
          json(responder, 400, { error: error.message });
          return;
        }
        if (error instanceof BatchDispatchError) {
          json(responder, 502, {
            error: error.message,
            code: error.detail.code,
            failures: error.detail.failures,
          });
          return;
        }
        responder.sendError("upstream request failed");
      }
    },
    close: () => client.close(),
  };
}
