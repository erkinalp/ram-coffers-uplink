import type { PendingRequest } from "@ram-coffers-uplink/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "./app.js";
import { type ApiKeyRow, apiKeyAuth } from "./auth.js";
import { isModelAllowed } from "./policy.js";
import type { RateLimitVerdict } from "./ratelimit.js";
import { getStatsEnabled, recordStats } from "./store.js";

const TUNNELLED_PATHS = [
  "/api/chat",
  "/api/generate",
  "/api/embed",
  "/api/show",
  "/v1/chat/completions",
  "/v1/embeddings",
] as const;

// Model-less metadata probes (client compatibility, e.g. Open WebUI's Ollama
// connection): tunnelled to any online sidecar, with no model to authorise
// and therefore no model policy or rate limits applied.
const MODELLESS_GET_PATHS = ["/api/version", "/api/ps"] as const;

// Inactivity timeout per tunnelled request, not an overall cap: long
// generations are legitimate as long as frames keep flowing.
export const REQUEST_INACTIVITY_MS = 5 * 60 * 1000;

export interface ProxyOptions {
  requestInactivityMs?: number;
}

export function registerProxyRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  options: ProxyOptions = {},
): void {
  const inactivityMs = options.requestInactivityMs ?? REQUEST_INACTIVITY_MS;
  const auth = apiKeyAuth(deps.db);
  for (const path of TUNNELLED_PATHS) {
    app.post(path, { preHandler: auth }, (req, reply) =>
      handleProxy(req, reply, deps, path, inactivityMs),
    );
  }
  for (const path of MODELLESS_GET_PATHS) {
    app.get(path, { preHandler: auth }, (_req, reply) =>
      handleModellessProxy(reply, deps, path, inactivityMs),
    );
  }
}

function rateLimited(reply: FastifyReply, verdict: RateLimitVerdict): void {
  void reply
    .header("Retry-After", String(verdict.retryAfterSeconds))
    .code(429)
    .send({ error: "rate limit exceeded" });
}

// Streams a tunnelled response back to the client: single-JSON responses pass
// through the same head/chunks/end flow as NDJSON streams. Arms the inactivity
// timeout and releases the sidecar slot via finish exactly once.
export function pipeTunnel(
  reply: FastifyReply,
  pending: PendingRequest,
  inactivityMs: number,
  finish: (isError: boolean) => void,
): void {
  reply.hijack();
  let headSent = false;
  let inactivity: NodeJS.Timeout | null = null;
  const clearInactivity = (): void => {
    if (inactivity) {
      clearTimeout(inactivity);
      inactivity = null;
    }
  };
  const armInactivity = (): void => {
    clearInactivity();
    inactivity = setTimeout(() => {
      inactivity = null;
      if (pending.settled) return;
      pending.cancel();
      finish(true);
      if (!headSent) {
        reply.raw.writeHead(504, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ error: "sidecar inactivity timeout" }));
      } else {
        reply.raw.end();
      }
    }, inactivityMs);
    inactivity.unref();
  };
  armInactivity();
  pending.onHead((status, headers) => {
    armInactivity();
    headSent = true;
    reply.raw.writeHead(status, {
      "content-type": headers["content-type"] ?? "application/json",
      "transfer-encoding": "chunked",
    });
  });
  pending.onChunk((data) => {
    armInactivity();
    reply.raw.write(data);
  });
  pending.onEnd(() => {
    clearInactivity();
    finish(false);
    reply.raw.end();
  });
  pending.onError((message) => {
    clearInactivity();
    finish(true);
    if (!headSent) {
      reply.raw.writeHead(502, { "content-type": "application/json" });
    }
    reply.raw.end(JSON.stringify({ error: message }));
  });
  // Fastify has already consumed req.raw for body parsing, so its "close"
  // event is unreliable; the response socket close is the dependable signal.
  reply.raw.on("close", () => {
    clearInactivity();
    if (!pending.settled) {
      pending.cancel();
      finish(false);
    }
  });
}

function handleProxy(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  path: string,
  inactivityMs: number,
): void {
  const apiKey = req.apiKey as ApiKeyRow;
  const body = (req.body ?? {}) as { model?: unknown };
  if (typeof body.model !== "string" || body.model.length === 0) {
    void reply.code(400).send({ error: "model is required" });
    return;
  }
  const model = body.model;
  if (!isModelAllowed(deps.db, apiKey.id, model)) {
    void reply.code(403).send({ error: "model not permitted" });
    return;
  }
  const rpm = deps.rateLimiter.checkRequests(apiKey.id, apiKey.rpm_limit);
  if (!rpm.allowed) {
    rateLimited(reply, rpm);
    return;
  }
  const tokens = deps.rateLimiter.checkTokens(apiKey.id, apiKey.tokens_per_day);
  if (!tokens.allowed) {
    rateLimited(reply, tokens);
    return;
  }
  const sidecar = deps.registry.pickForModel(model, apiKey.id);
  if (!sidecar) {
    void reply.code(503).send({ error: "no sidecar available for the requested model" });
    return;
  }

  deps.registry.incrementActive(sidecar.name);
  const statsEnabled = getStatsEnabled(deps.db, deps.config.statsEnabled);
  let finished = false;
  const finish = (
    usage: { prompt_tokens: number; completion_tokens: number } | null,
    isError: boolean,
  ): void => {
    if (finished) return;
    finished = true;
    deps.registry.decrementActive(sidecar.name);
    if (usage)
      deps.rateLimiter.recordTokens(apiKey.id, usage.prompt_tokens + usage.completion_tokens);
    if (statsEnabled) recordStats(deps.db, apiKey.id, model, usage, isError);
  };

  const pending = sidecar.session.openRequest({
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(req.body)),
  });

  let usageSeen: { prompt_tokens: number; completion_tokens: number } | null = null;
  pending.onEnd((usage) => {
    usageSeen = usage;
  });
  pipeTunnel(reply, pending, inactivityMs, (isError) => finish(usageSeen, isError));
}

function handleModellessProxy(
  reply: FastifyReply,
  deps: AppDeps,
  path: string,
  inactivityMs: number,
): void {
  const sidecar = deps.registry.pickAny();
  if (!sidecar) {
    void reply.code(503).send({ error: "no sidecar online" });
    return;
  }

  deps.registry.incrementActive(sidecar.name);
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    deps.registry.decrementActive(sidecar.name);
  };

  const pending = sidecar.session.openRequest({
    method: "GET",
    path,
    headers: {},
    body: null,
  });

  pipeTunnel(reply, pending, inactivityMs, () => finish());
}
