import type { Responder } from "@ram-coffers-uplink/protocol";
import type { UpstreamRequest } from "./coffer-http.js";
import { fetchModels, forwardOverHttp } from "./coffer-http.js";
import { COFFER_PATH_PREFIX, createP3xcUpstream } from "./coffer-p3xc.js";
import type { SidecarConfig } from "./config.js";

export interface Upstream {
  /** Models this sidecar advertises to the relay. */
  models(): Promise<string[]>;
  forward(msg: UpstreamRequest, responder: Responder): Promise<void>;
  close(): void;
}

function httpUpstream(config: SidecarConfig, pinned: boolean): Upstream {
  return {
    models: () =>
      pinned && config.models.length > 0
        ? Promise.resolve(config.models)
        : fetchModels(config.cofferUrl as string),
    forward: (msg, responder) => forwardOverHttp(config.cofferUrl as string, msg, responder),
    close: () => {},
  };
}

/**
 * Picks the upstream for a sidecar's configuration. In `both` mode the coffer
 * cluster routes (`/coffer/...`) go over P3XC while chat and embedding traffic
 * goes to the HTTP inference service on the same host. `MODELS` then names the
 * cluster's models only, so the HTTP service is still asked for its own.
 */
export function createUpstream(config: SidecarConfig): Upstream {
  if (config.upstream === "http") return httpUpstream(config, true);
  const p3xc = createP3xcUpstream(config);
  if (config.upstream === "p3xc") return p3xc;
  const http = httpUpstream(config, false);
  return {
    models: async () => {
      const [fromHttp, fromP3xc] = await Promise.all([
        http.models().catch(() => [] as string[]),
        p3xc.models(),
      ]);
      return [...new Set([...fromHttp, ...fromP3xc])];
    },
    forward: (msg, responder) =>
      msg.path.startsWith(COFFER_PATH_PREFIX)
        ? p3xc.forward(msg, responder)
        : http.forward(msg, responder),
    close: () => {
      http.close();
      p3xc.close();
    },
  };
}
