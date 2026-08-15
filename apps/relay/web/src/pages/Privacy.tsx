import { useEffect, useState } from "react";
import { fetchPrivacy, type PrivacyData } from "../api.js";

export function PrivacyView({
  apiKey,
  fetchPrivacy: fetcher,
}: {
  apiKey: string;
  fetchPrivacy: (key: string) => Promise<PrivacyData>;
}) {
  const [data, setData] = useState<PrivacyData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetcher(apiKey)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [apiKey, fetcher]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">loading…</p>;

  return (
    <>
      <h2>
        your key: <span>{data.name}</span>
      </h2>
      <table>
        <tbody>
          <tr>
            <th>requests per minute</th>
            <td>{data.rpm_limit === null ? "unlimited" : `${data.rpm_limit} / minute`}</td>
          </tr>
          <tr>
            <th>tokens per day</th>
            <td>{data.tokens_per_day === null ? "unlimited" : data.tokens_per_day}</td>
          </tr>
          <tr>
            <th>statistics</th>
            <td>{data.stats_enabled ? "enabled (aggregates only)" : "disabled"}</td>
          </tr>
        </tbody>
      </table>

      <h2>model permissions</h2>
      <table>
        <thead>
          <tr>
            <th>model</th>
            <th>access</th>
            <th>decided by</th>
          </tr>
        </thead>
        <tbody>
          {data.models.map((m) => (
            <tr key={m.model}>
              <td>{m.model}</td>
              <td className={m.allowed ? "ok" : "error"}>{m.allowed ? "allowed" : "denied"}</td>
              <td className="muted">
                {m.source === "key"
                  ? "your key"
                  : m.source === "global"
                    ? "global policy"
                    : "default"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.stats_enabled && data.stats && data.stats.length > 0 && (
        <>
          <h2>Your statistics</h2>
          <table>
            <thead>
              <tr>
                <th>hour</th>
                <th>model</th>
                <th>requests</th>
                <th>prompt tokens</th>
                <th>completion tokens</th>
                <th>errors</th>
              </tr>
            </thead>
            <tbody>
              {data.stats.map((r) => (
                <tr key={`${r.hour}-${r.model}`}>
                  <td>{r.hour}</td>
                  <td>{r.model}</td>
                  <td>{r.requests}</td>
                  <td>{r.prompt_tokens}</td>
                  <td>{r.completion_tokens}</td>
                  <td>{r.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="card">
        <p>{data.statement}</p>
      </div>
    </>
  );
}

export function Privacy() {
  const [key, setKey] = useState<string | null>(null);
  return (
    <main>
      <h1>ram-coffers-uplink privacy</h1>
      {key === null ? (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get("key");
            if (typeof value === "string" && value.length > 0) setKey(value);
          }}
        >
          <input type="password" name="key" placeholder="your API key" required />
          <button type="submit">view my data</button>
        </form>
      ) : (
        <PrivacyView apiKey={key} fetchPrivacy={fetchPrivacy} />
      )}
    </main>
  );
}
