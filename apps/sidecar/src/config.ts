export type UpstreamKind = "http" | "p3xc" | "both" | "g9xc";

export interface SidecarConfig {
  relayUrl: string;
  name: string;
  psk: string;
  upstream: UpstreamKind;
  /** Base URL of the RAM Coffers inference service; unset without an HTTP leg. */
  cofferUrl: string | null;
  p3xcHost: string;
  p3xcPort: number;
  p3xcTimeoutMs: number;
  /** G9XC node worker the sidecar speaks to (gen9 fleets). */
  g9xcHost: string;
  g9xcPort: number;
  g9xcTimeoutMs: number;
  /** Models advertised to the relay; required when no HTTP upstream can list them. */
  models: string[];
}

function parsePort(value: string | undefined, fallback: number, name: string, errors: string[]) {
  if (value === undefined) return fallback;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    errors.push(`${name} must be a valid TCP port`);
    return fallback;
  }
  return port;
}

export function loadSidecarConfig(env: NodeJS.ProcessEnv): SidecarConfig {
  const errors: string[] = [];
  if (!env.RELAY_URL) errors.push("RELAY_URL is required");
  if (!env.SIDECAR_NAME) errors.push("SIDECAR_NAME is required");
  if (!env.PSK) errors.push("PSK is required");
  if (env.RELAY_URL && !/^wss?:\/\//.test(env.RELAY_URL))
    errors.push("RELAY_URL must start with ws:// or wss://");
  const upstream = (env.UPSTREAM ?? "http") as UpstreamKind;
  if (upstream !== "http" && upstream !== "p3xc" && upstream !== "both" && upstream !== "g9xc")
    errors.push("UPSTREAM must be http, p3xc, both or g9xc");
  const models = (env.MODELS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if ((upstream === "p3xc" || upstream === "g9xc") && models.length === 0)
    errors.push(`MODELS is required when UPSTREAM=${upstream} (a cluster cannot list models)`);
  const p3xcPort = parsePort(env.P3XC_PORT, 5920, "P3XC_PORT", errors);
  const timeoutMs = env.P3XC_TIMEOUT_MS ? Number.parseInt(env.P3XC_TIMEOUT_MS, 10) : 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    errors.push("P3XC_TIMEOUT_MS must be a positive integer");
  const g9xcPort = parsePort(env.G9XC_PORT, 9713, "G9XC_PORT", errors);
  const g9xcTimeoutMs = env.G9XC_TIMEOUT_MS ? Number.parseInt(env.G9XC_TIMEOUT_MS, 10) : 30_000;
  if (!Number.isInteger(g9xcTimeoutMs) || g9xcTimeoutMs <= 0)
    errors.push("G9XC_TIMEOUT_MS must be a positive integer");
  if (errors.length > 0) throw new Error(`invalid configuration: ${errors.join("; ")}`);
  return {
    relayUrl: env.RELAY_URL as string,
    name: env.SIDECAR_NAME as string,
    psk: env.PSK as string,
    upstream,
    cofferUrl:
      upstream === "p3xc" || upstream === "g9xc"
        ? null
        : (env.COFFER_URL ?? "http://localhost:8080"),
    p3xcHost: env.P3XC_HOST ?? "127.0.0.1",
    p3xcPort,
    p3xcTimeoutMs: timeoutMs,
    g9xcHost: env.G9XC_HOST ?? "127.0.0.1",
    g9xcPort,
    g9xcTimeoutMs,
    models,
  };
}
