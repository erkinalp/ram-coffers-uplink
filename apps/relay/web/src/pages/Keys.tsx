import { useCallback, useEffect, useState } from "react";
import * as api from "../api.js";

export function Keys() {
  const [keys, setKeys] = useState<api.KeyInfo[]>([]);
  const [oneTimeKey, setOneTimeKey] = useState("");

  const refresh = useCallback(() => {
    void api.getKeys().then(setKeys);
  }, []);
  useEffect(refresh, [refresh]);

  const numericField = (raw: string): number | null | undefined => {
    if (raw === "") return undefined; // leave unchanged
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null; // 0 / invalid clears the limit
  };

  return (
    <>
      <h2>api keys</h2>
      <table>
        <thead>
          <tr>
            <th>name</th>
            <th>created</th>
            <th>requests/min</th>
            <th>tokens/day</th>
            <th>status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td>{k.created_at}</td>
              {[
                ["rpm_limit", k.rpm_limit],
                ["tokens_per_day", k.tokens_per_day],
              ].map(([field, value]) => (
                <td key={field as string}>
                  {k.revoked ? (
                    String(value ?? "unlimited")
                  ) : (
                    <input
                      type="number"
                      min={0}
                      defaultValue={value ?? ""}
                      placeholder="unlimited"
                      onBlur={(e) => {
                        const next = numericField(e.target.value);
                        if (next !== undefined)
                          void api.updateKey(k.id, { [field as string]: next }).then(refresh);
                      }}
                    />
                  )}
                </td>
              ))}
              <td className={k.revoked ? "error" : "ok"}>{k.revoked ? "revoked" : "active"}</td>
              <td>
                {!k.revoked && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void api.revokeKey(k.id).then(refresh)}
                  >
                    revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const name = String(data.get("name") ?? "");
          if (!name) return;
          void api.createKey(name, null, null).then((r) => {
            setOneTimeKey(r.key);
            e.currentTarget.reset();
            refresh();
          });
        }}
      >
        <input type="text" name="name" placeholder="new key name" required />
        <button type="submit">create key</button>
      </form>
      {oneTimeKey && (
        <div className="card">
          <strong>API key (shown once — copy it now):</strong>
          <span className="onetime-key">{oneTimeKey}</span>
        </div>
      )}
    </>
  );
}
