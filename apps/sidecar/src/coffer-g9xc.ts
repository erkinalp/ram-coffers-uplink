/**
 * The G9XC upstream: translates the relay's JSON coffer routes into G9XC v2
 * frames for a gen9 node worker (`gen9_cluster.node.NodeServer`).
 *
 * Only cluster-level operations live here — liveness, the node's self-report,
 * expert dispatch and batched dispatch. There is no gen9 generation endpoint
 * to forward chat to yet; that lands on the HTTP upstream when one exists.
 */

import { G9xcClient, G9xcError, MAX_BATCH_ID } from "@ram-coffers-uplink/g9xc";
import type { Responder } from "@ram-coffers-uplink/protocol";
import type { UpstreamRequest } from "./coffer-http.js";
import type { SidecarConfig } from "./config.js";
import type { Upstream } from "./upstream.js";

interface DispatchBody {
  layer?: unknown;
  expert?: unknown;
  token_id?: unknown;
  activation?: unknown;
}

interface BatchBody extends DispatchBody {
  entries?: unknown;
  fast?: unknown;
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

interface BatchEntry {
  expert: number;
  gate: number;
}

function asEntries(value: unknown): BatchEntry[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new BadRequest("entries must be a non-empty array");
  return value.map((raw) => {
    if (typeof raw !== "object" || raw === null)
      throw new BadRequest("each entry must be an object");
    const entry = raw as { expert?: unknown; gate?: unknown; replica?: unknown };
    // A gen9 node is addressed directly; replica placement belongs to the
    // shelf coordinator the node answers to, not to this hop.
    if (entry.replica !== undefined && entry.replica !== 0)
      throw new BadRequest("replica is a coordinator decision; a G9XC node takes none");
    if (typeof entry.gate !== "number" || !Number.isFinite(entry.gate))
      throw new BadRequest("each entry needs a finite gate");
    return { expert: asInteger(entry.expert, "expert", 0xffff), gate: entry.gate };
  });
}

/** `request_id` maps onto the batch's dedup id: a retry of the same logical
 * batch replays the node's first answer rather than re-running the experts. */
function asBatchId(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number")
    return BigInt(asInteger(value, "request_id", Number.MAX_SAFE_INTEGER));
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed > MAX_BATCH_ID) throw new BadRequest("request_id out of range");
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
    throw new BadRequest("body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new BadRequest("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

export function createG9xcUpstream(config: SidecarConfig): Upstream {
  const client = new G9xcClient({
    host: config.g9xcHost,
    port: config.g9xcPort,
    timeoutMs: config.g9xcTimeoutMs,
  });

  const handle = async (msg: UpstreamRequest, responder: Responder): Promise<void> => {
    const path = msg.path.split("?")[0] as string;
    if (msg.method === "GET" && (path === "/api/version" || path === "/coffer/v1/version")) {
      json(responder, 200, { version: "ram-coffers-uplink", backend: "g9xc" });
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
      const hello = await client.hello();
      json(responder, 200, {
        status: "ok",
        node: `${config.g9xcHost}:${config.g9xcPort}`,
        rtt_ms: rttMs,
        unit: hello.unitId,
        sku: hello.sku,
        backend: hello.backend,
        resident_bytes: Number(hello.weightBytes),
      });
      return;
    }
    if (msg.method === "GET" && path === "/coffer/v1/status") {
      json(responder, 200, { status: await client.status() });
      return;
    }
    if (msg.method === "POST" && path === "/coffer/v1/dispatch") {
      const body = parseBody(msg) as DispatchBody;
      const output = await client.dispatchExpert({
        layer: asInteger(body.layer, "layer", 0xffff),
        expert: asInteger(body.expert, "expert", 0xffff),
        token: body.token_id === undefined ? 0 : asInteger(body.token_id, "token_id", 0xffffffff),
        activation: asActivation(body.activation),
      });
      json(responder, 200, { output: Array.from(output) });
      return;
    }
    if (msg.method === "POST" && path === "/coffer/v1/batch") {
      const body = parseBody(msg) as BatchBody;
      if (body.fast !== undefined && typeof body.fast !== "boolean")
        throw new BadRequest("fast must be a boolean");
      const entries = asEntries(body.entries);
      const batchId = asBatchId(body.request_id);
      const result = await client.dispatchBatch({
        layer: asInteger(body.layer, "layer", 0xffff),
        token: body.token_id === undefined ? 0 : asInteger(body.token_id, "token_id", 0xffffffff),
        activation: asActivation(body.activation),
        expertIds: entries.map((entry) => entry.expert),
        gates: entries.map((entry) => entry.gate),
        ...(batchId === undefined ? {} : { batchId }),
        ...(body.fast === undefined ? {} : { fast: body.fast }),
      });
      json(responder, 200, {
        layer: body.layer,
        token_id: body.token_id ?? 0,
        n_experts: result.perExpert ? result.experts.length : 1,
        per_expert: result.perExpert,
        experts: result.experts,
        contributions: result.rows.map((row) => Array.from(row)),
        batch_id: batchId === undefined ? null : batchId.toString(),
        replayed: result.replayed,
        from_storage: result.fromStorage,
      });
      return;
    }
    json(responder, 404, { error: "not supported by a G9XC upstream" });
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
        if (error instanceof G9xcError) {
          json(responder, 502, { error: error.message });
          return;
        }
        responder.sendError("upstream request failed");
      }
    },
    close: () => client.close(),
  };
}
