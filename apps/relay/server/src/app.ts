import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerCofferRoutes } from "./coffer-routes.js";
import type { RelayConfig } from "./config.js";
import type { Db } from "./db.js";
import { registerModelRoutes } from "./models-routes.js";
import { registerPrivacyRoutes } from "./privacy-routes.js";
import { type ProxyOptions, registerProxyRoutes } from "./proxy-routes.js";
import type { RateLimiter } from "./ratelimit.js";
import type { SidecarRegistry } from "./registry.js";
import { registerStatic } from "./static.js";
import { attachUplink, type UplinkOptions } from "./uplink.js";

export interface AppDeps {
  config: RelayConfig;
  db: Db;
  rateLimiter: RateLimiter;
  registry: SidecarRegistry;
}

export interface ServerOptions {
  uplink?: UplinkOptions;
  proxy?: ProxyOptions;
}

export async function buildServer(
  deps: AppDeps,
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: "info" }, disableRequestLogging: true });
  await app.register(cors, {
    origin: deps.config.allowedOrigins.length > 0 ? deps.config.allowedOrigins : false,
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  attachUplink(app, deps, options.uplink);
  registerModelRoutes(app, deps);
  registerProxyRoutes(app, deps, options.proxy);
  registerCofferRoutes(app, deps, options.proxy);
  await registerAdminRoutes(app, deps);
  registerPrivacyRoutes(app, deps);
  await registerStatic(app, deps.config);
  return app;
}
