import { useCallback, useEffect, useState } from "react";
import * as api from "../api.js";
import { TriStateToggle } from "../components/TriStateToggle.js";

export function Models() {
  const [models, setModels] = useState<string[]>([]);
  const [keys, setKeys] = useState<api.KeyInfo[]>([]);
  const [policies, setPolicies] = useState<Record<number, Record<string, "allow" | "disallow">>>(
    {},
  );
  const [global, setGlobal] = useState<Record<string, "allowed" | "blocked">>({});

  const refresh = useCallback(async () => {
    const [m, k, g] = await Promise.all([api.getModels(), api.getKeys(), api.getGlobalPolicy()]);
    setModels(m.models);
    setKeys(k.filter((key) => !key.revoked));
    setGlobal(Object.fromEntries(g.map((row) => [row.model, row.mode])));
    const entries = await Promise.all(
      k
        .filter((key) => !key.revoked)
        .map(async (key) => [key.id, await api.getKeyPolicy(key.id)] as const),
    );
    setPolicies(
      Object.fromEntries(
        entries.map(([id, rows]) => [id, Object.fromEntries(rows.map((r) => [r.model, r.mode]))]),
      ),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <h2>model matrix</h2>
      <p className="muted">
        Cells cycle allow → disallow → inherit. Key allow wins; key disallow blocks; inherit falls
        back to the global policy.
      </p>
      <table>
        <thead>
          <tr>
            <th>model</th>
            <th>global</th>
            {keys.map((k) => (
              <th key={k.id}>{k.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model}>
              <td>{model}</td>
              <td>
                <button
                  type="button"
                  className={global[model] === "blocked" ? "global-blocked" : "global-allowed"}
                  onClick={() =>
                    void api
                      .setGlobalPolicy(model, global[model] === "blocked" ? "default" : "blocked")
                      .then(refresh)
                  }
                >
                  {global[model] === "blocked" ? "blocked" : "allowed"}
                </button>
              </td>
              {keys.map((k) => (
                <td key={k.id}>
                  <TriStateToggle
                    value={policies[k.id]?.[model] ?? "inherit"}
                    label={`${model} for ${k.name}`}
                    onChange={(mode) => void api.setKeyPolicy(k.id, model, mode).then(refresh)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
