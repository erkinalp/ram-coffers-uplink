import type { Db } from "./db.js";
import type { SidecarRegistry } from "./registry.js";

export interface ModelPermission {
  allowed: boolean;
  source: "key" | "global" | "default";
}

export function resolveModelPermission(db: Db, keyId: number, model: string): ModelPermission {
  const keyPolicy = db
    .prepare("SELECT mode FROM key_model_policy WHERE key_id = ? AND model = ?")
    .get(keyId, model) as { mode: "allow" | "disallow" } | undefined;
  if (keyPolicy) return { allowed: keyPolicy.mode === "allow", source: "key" };
  const globalPolicy = db
    .prepare("SELECT mode FROM global_model_policy WHERE model = ?")
    .get(model) as { mode: "allowed" | "blocked" } | undefined;
  if (globalPolicy) return { allowed: globalPolicy.mode === "allowed", source: "global" };
  return { allowed: true, source: "default" };
}

export function isModelAllowed(db: Db, keyId: number, model: string): boolean {
  return resolveModelPermission(db, keyId, model).allowed;
}

export function filterModels(db: Db, keyId: number, models: string[]): string[] {
  return models.filter((model) => isModelAllowed(db, keyId, model));
}

export function collectKnownModels(db: Db, registry: SidecarRegistry): string[] {
  const models = new Set<string>(registry.allModels());
  for (const row of db.prepare("SELECT DISTINCT model FROM key_model_policy").all() as Array<{
    model: string;
  }>)
    models.add(row.model);
  for (const row of db.prepare("SELECT model FROM global_model_policy").all() as Array<{
    model: string;
  }>)
    models.add(row.model);
  return [...models].sort();
}
