export interface KeyInfo {
  id: number;
  name: string;
  created_at: string;
  rpm_limit: number | null;
  tokens_per_day: number | null;
  revoked: number;
}

export interface SidecarInfo {
  id: number;
  name: string;
  created_at: string;
  revoked: number;
  online: boolean;
  connected_at: string | null;
  active_requests: number;
  models: string[];
}

export interface StatsRow {
  key_id: number;
  key_name: string;
  model: string;
  hour: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  errors: number;
}

export type PolicyMode = "allow" | "disallow" | "inherit";
export type GlobalMode = "allowed" | "blocked" | "default";

export interface ModelPermission {
  model: string;
  allowed: boolean;
  source: "key" | "global" | "default";
}

export interface PrivacyData {
  name: string;
  rpm_limit: number | null;
  tokens_per_day: number | null;
  stats_enabled: boolean;
  models: ModelPermission[];
  stats: StatsRow[] | null;
  statement: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, payload?: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(payload ?? {}) });
const put = <T>(path: string, payload: unknown) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(payload) });
const patch = <T>(path: string, payload: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(payload) });

export const login = (token: string) => post<{ ok: boolean }>("/admin/api/login", { token });
export const logout = () => post<{ ok: boolean }>("/admin/api/logout");
export const getKeys = () => request<KeyInfo[]>("/admin/api/keys");
export const createKey = (name: string, rpm_limit: number | null, tokens_per_day: number | null) =>
  post<{ id: number; key: string }>("/admin/api/keys", { name, rpm_limit, tokens_per_day });
export const updateKey = (
  id: number,
  payload: { name?: string; rpm_limit?: number | null; tokens_per_day?: number | null },
) => patch<{ ok: boolean }>(`/admin/api/keys/${id}`, payload);
export const revokeKey = (id: number) => post<{ ok: boolean }>(`/admin/api/keys/${id}/revoke`);
export const getKeyPolicy = (id: number) =>
  request<Array<{ model: string; mode: "allow" | "disallow" }>>(`/admin/api/keys/${id}/policy`);
export const setKeyPolicy = (id: number, model: string, mode: PolicyMode) =>
  put<{ ok: boolean }>(`/admin/api/keys/${id}/policy`, { model, mode });
export const getGlobalPolicy = () =>
  request<Array<{ model: string; mode: "allowed" | "blocked" }>>("/admin/api/policy/global");
export const setGlobalPolicy = (model: string, mode: GlobalMode) =>
  put<{ ok: boolean }>("/admin/api/policy/global", { model, mode });
export const getSidecars = () => request<SidecarInfo[]>("/admin/api/sidecars");
export const createSidecar = (name: string) =>
  post<{ id: number; psk: string }>("/admin/api/sidecars", { name });
export const revokeSidecar = (id: number) =>
  post<{ ok: boolean }>(`/admin/api/sidecars/${id}/revoke`);
export const getModels = () => request<{ models: string[] }>("/admin/api/models");
export const getStatsStatus = () =>
  request<{ enabled: boolean; source: "setting" | "env" }>("/admin/api/stats/status");
export const setStats = (enabled: boolean, purge: boolean) =>
  put<{ ok: boolean }>("/admin/api/stats", { enabled, purge });
export const getStats = () => request<{ rows: StatsRow[] }>("/admin/api/stats");
export const fetchPrivacy = (key: string) => post<PrivacyData>("/api/privacy/session", { key });
