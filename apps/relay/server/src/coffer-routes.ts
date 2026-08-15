/**
 * Cluster-level routes: expert and subcluster dispatch on a RAM Coffers node,
 * tunnelled to a sidecar that speaks P3XC upstream.
 *
 * These carry activations rather than prompts, so there is no model to
 * authorise and no token accounting; an API key and its request rate limit
 * still apply, and a `model` in the body pins the request to the sidecars
 * serving that model.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "./app.js";
import { type ApiKeyRow, apiKeyAuth } from "./auth.js";
import { isModelAllowed } from "./policy.js";
import { type ProxyOptions, pipeTunnel, REQUEST_INACTIVITY_MS } from "./proxy-routes.js";

const COFFER_POST_PATHS = ["/coffer/v1/dispatch", "/coffer/v1/batch"] as const;
const COFFER_GET_PATHS = ["/coffer/v1/health", "/coffer/v1/version"] as const;

export function registerCofferRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  options: ProxyOptions = {},
): void {
  const inactivityMs = options.requestInactivityMs ?? REQUEST_INACTIVITY_MS;
  const auth = apiKeyAuth(deps.db);
  for (const path of COFFER_POST_PATHS) {
    app.post(path, { preHandler: auth }, (req, reply) =>
      handleCoffer(req, reply, deps, path, inactivityMs),
    );
  }
  for (const path of COFFER_GET_PATHS) {
    app.get(path, { preHandler: auth }, (req, reply) =>
      handleCoffer(req, reply, deps, path, inactivityMs),
    );
  }
}

function handleCoffer(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  path: string,
  inactivityMs: number,
): void {
  const apiKey = req.apiKey as ApiKeyRow;
  const body = (req.body ?? {}) as { model?: unknown };
  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : null;
  if (model !== null && !isModelAllowed(deps.db, apiKey.id, model)) {
    void reply.code(403).send({ error: "model not permitted" });
    return;
  }
  const rpm = deps.rateLimiter.checkRequests(apiKey.id, apiKey.rpm_limit);
  if (!rpm.allowed) {
    void reply
      .header("Retry-After", String(rpm.retryAfterSeconds))
      .code(429)
      .send({ error: "rate limit exceeded" });
    return;
  }
  const sidecar =
    model === null ? deps.registry.pickAny() : deps.registry.pickForModel(model, apiKey.id);
  if (!sidecar) {
    void reply.code(503).send({ error: "no sidecar available for the requested coffer" });
    return;
  }

  deps.registry.incrementActive(sidecar.name);
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    deps.registry.decrementActive(sidecar.name);
  };

  const isPost = req.method === "POST";
  const pending = sidecar.session.openRequest({
    method: req.method,
    path,
    headers: isPost ? { "content-type": "application/json" } : {},
    body: isPost ? new TextEncoder().encode(JSON.stringify(req.body ?? {})) : null,
  });
  pipeTunnel(reply, pending, inactivityMs, () => finish());
}
