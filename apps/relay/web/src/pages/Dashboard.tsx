import { useCallback, useEffect, useState } from "react";
import * as api from "../api.js";

export function Dashboard() {
  const [sidecars, setSidecars] = useState<api.SidecarInfo[]>([]);
  const [status, setStatus] = useState<{ enabled: boolean; source: string } | null>(null);
  const [rows, setRows] = useState<api.StatsRow[]>([]);
  const [newName, setNewName] = useState("");
  const [oneTimePsk, setOneTimePsk] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api
      .getSidecars()
      .then(setSidecars)
      .catch((e: Error) => setError(e.message));
    api
      .getStatsStatus()
      .then(setStatus)
      .catch(() => undefined);
    api
      .getStats()
      .then((r) => setRows(r.rows))
      .catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  return (
    <>
      <h2>sidecars</h2>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>name</th>
            <th>status</th>
            <th>connected since</th>
            <th>active requests</th>
            <th>models</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sidecars.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td className={s.online && !s.revoked ? "ok" : "error"}>
                {s.revoked ? "revoked" : s.online ? "online" : "offline"}
              </td>
              <td>{s.connected_at ?? "—"}</td>
              <td>{s.active_requests}</td>
              <td>{s.models.join(", ") || "—"}</td>
              <td>
                {!s.revoked && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void api.revokeSidecar(s.id).then(refresh)}
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
          void api.createSidecar(newName).then((r) => {
            setOneTimePsk(r.psk);
            setNewName("");
            refresh();
          });
        }}
      >
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="new sidecar name"
          required
        />
        <button type="submit">create sidecar</button>
      </form>
      {oneTimePsk && (
        <div className="card">
          <strong>PSK (shown once — copy it now):</strong>
          <span className="onetime-key">{oneTimePsk}</span>
        </div>
      )}

      <h2>statistics</h2>
      {status && (
        <div className="card">
          <p>
            Statistics are{" "}
            <strong className={status.enabled ? "ok" : "error"}>
              {status.enabled ? "enabled" : "disabled"}
            </strong>
            . When enabled, the relay records only aggregate counters per API key, model and hour:
            request counts, prompt/completion token counts and error counts. Prompts and responses
            are never recorded.
          </p>
          {status.enabled ? (
            <button
              type="button"
              className="danger"
              onClick={() => void api.setStats(false, true).then(refresh)}
            >
              disable statistics and purge all recorded data
            </button>
          ) : (
            <button type="button" onClick={() => void api.setStats(true, false).then(refresh)}>
              enable statistics
            </button>
          )}
        </div>
      )}
      {status?.enabled && rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>hour</th>
              <th>key</th>
              <th>model</th>
              <th>requests</th>
              <th>prompt tokens</th>
              <th>completion tokens</th>
              <th>errors</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.hour}-${r.key_id}-${r.model}`}>
                <td>{r.hour}</td>
                <td>{r.key_name}</td>
                <td>{r.model}</td>
                <td>{r.requests}</td>
                <td>{r.prompt_tokens}</td>
                <td>{r.completion_tokens}</td>
                <td>{r.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
