import "dotenv/config";
import { buildServer } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { RateLimiter } from "./ratelimit.js";
import { SidecarRegistry } from "./registry.js";

const config = loadConfig(process.env);
const db = openDatabase(config.databasePath);
const rateLimiter = new RateLimiter();
const registry = new SidecarRegistry();
const app = await buildServer({ config, db, rateLimiter, registry });
await app.listen({ port: config.port, host: "0.0.0.0" });
