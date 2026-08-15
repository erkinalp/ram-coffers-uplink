export interface RelayConfig {
  port: number;
  adminToken: string;
  sessionSecret: string;
  databasePath: string;
  statsEnabled: boolean;
  allowedOrigins: string[];
  webRoot: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): RelayConfig {
  const errors: string[] = [];
  const adminToken = env.ADMIN_TOKEN ?? "";
  if (adminToken.length < 16) errors.push("ADMIN_TOKEN is required (min 16 characters)");
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 32) errors.push("SESSION_SECRET is required (min 32 characters)");
  const port = env.PORT ? Number.parseInt(env.PORT, 10) : 8080;
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    errors.push("PORT must be a valid TCP port");
  if (errors.length > 0) throw new Error(`invalid configuration: ${errors.join("; ")}`);
  return {
    port,
    adminToken,
    sessionSecret,
    databasePath: env.DATABASE_PATH ?? "./data/relay.db",
    statsEnabled: (env.STATS_ENABLED ?? "false") === "true",
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    webRoot: env.WEB_ROOT ?? new URL("../../web/dist", import.meta.url).pathname,
  };
}
