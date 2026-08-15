import type { TunnelSession } from "@ram-coffers-uplink/protocol";

export interface OnlineSidecarInfo {
  id: number;
  name: string;
  connectedAt: string;
  activeRequests: number;
  models: string[];
}

export interface OnlineSidecar extends OnlineSidecarInfo {
  session: TunnelSession;
}

const STICKY_TTL_MS = 60 * 60 * 1000;

// Cursor key for pickAny's round-robin; "*" is not a valid Ollama model
// name, so it can never collide with pickForModel's per-model cursors.
const ANY_SIDECAR_CURSOR = "*";

export class SidecarRegistry {
  private readonly online = new Map<string, OnlineSidecar>();
  private readonly sticky = new Map<number, { sidecarName: string; expiresAt: number }>();
  private readonly cursors = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  register(sidecar: OnlineSidecar): void {
    this.online.set(sidecar.name, sidecar);
  }

  unregister(name: string): void {
    this.online.delete(name);
  }

  get(name: string): OnlineSidecar | undefined {
    return this.online.get(name);
  }

  list(): OnlineSidecarInfo[] {
    return [...this.online.values()].map(({ session: _session, ...info }) => info);
  }

  allModels(): string[] {
    const models = new Set<string>();
    for (const s of this.online.values()) for (const m of s.models) models.add(m);
    return [...models].sort();
  }

  updateModels(name: string, models: string[]): void {
    const sidecar = this.online.get(name);
    if (sidecar) sidecar.models = models;
  }

  incrementActive(name: string): void {
    const sidecar = this.online.get(name);
    if (sidecar) sidecar.activeRequests += 1;
  }

  decrementActive(name: string): void {
    const sidecar = this.online.get(name);
    if (sidecar) sidecar.activeRequests = Math.max(0, sidecar.activeRequests - 1);
  }

  // Round-robin over all online sidecars, for model-less metadata probes
  // (e.g. /api/version, /api/ps) where any online sidecar can answer.
  pickAny(): OnlineSidecar | null {
    const candidates = [...this.online.values()];
    if (candidates.length === 0) return null;
    const index = (this.cursors.get(ANY_SIDECAR_CURSOR) ?? 0) % candidates.length;
    this.cursors.set(ANY_SIDECAR_CURSOR, index + 1);
    return candidates[index] as OnlineSidecar;
  }

  pickForModel(model: string, keyId: number): OnlineSidecar | null {
    const pinned = this.sticky.get(keyId);
    if (pinned && pinned.expiresAt > this.now()) {
      const sidecar = this.online.get(pinned.sidecarName);
      if (sidecar?.models.includes(model)) return sidecar;
    }
    const candidates = [...this.online.values()].filter((s) => s.models.includes(model));
    if (candidates.length === 0) return null;
    // An expired or dangling pin rotates onward from the previously pinned
    // sidecar; a fresh key continues the per-model round-robin.
    const start = pinned
      ? candidates.findIndex((s) => s.name === pinned.sidecarName) + 1
      : (this.cursors.get(model) ?? 0);
    const index = start % candidates.length;
    this.cursors.set(model, index + 1);
    const chosen = candidates[index] as OnlineSidecar;
    this.sticky.set(keyId, { sidecarName: chosen.name, expiresAt: this.now() + STICKY_TTL_MS });
    return chosen;
  }
}
