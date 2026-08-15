import "dotenv/config";
import { SidecarClient } from "./client.js";
import { loadSidecarConfig } from "./config.js";

const config = loadSidecarConfig(process.env);
const client = new SidecarClient(config);
process.on("SIGINT", () => client.stop());
process.on("SIGTERM", () => client.stop());
await client.run();
