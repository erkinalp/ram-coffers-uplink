import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { RelayConfig } from "./config.js";

export async function registerStatic(app: FastifyInstance, config: RelayConfig): Promise<void> {
  if (!existsSync(join(config.webRoot, "index.html"))) {
    app.log.info({ webRoot: config.webRoot }, "web SPA not built; static serving disabled");
    return;
  }
  await app.register(fastifyStatic, { root: config.webRoot });
  app.setNotFoundHandler((req, reply) => {
    const isApi =
      req.url.startsWith("/api") ||
      req.url.startsWith("/v1") ||
      req.url.startsWith("/admin/api") ||
      req.url.startsWith("/uplink");
    if (req.method === "GET" && !isApi) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "not found" });
  });
}
