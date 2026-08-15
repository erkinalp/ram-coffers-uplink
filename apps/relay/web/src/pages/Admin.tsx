import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import * as api from "../api.js";
import { Dashboard } from "./Dashboard.js";
import { Keys } from "./Keys.js";
import { Models } from "./Models.js";

export function Admin() {
  const [state, setState] = useState<"loading" | "anon" | "authed">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getSidecars()
      .then(() => setState("authed"))
      .catch(() => setState("anon"));
  }, []);

  if (state === "loading") return <main className="muted">loading…</main>;

  if (state === "anon") {
    return (
      <main>
        <h1>ram-coffers-uplink admin</h1>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const token = new FormData(e.currentTarget).get("token");
            if (typeof token !== "string") return;
            api
              .login(token)
              .then(() => setState("authed"))
              .catch(() => setError("invalid token"));
          }}
        >
          <input type="password" name="token" placeholder="admin token" required />
          <button type="submit">log in</button>
        </form>
        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  return (
    <main>
      <h1>ram-coffers-uplink admin</h1>
      <nav>
        <NavLink to="/admin" end>
          dashboard
        </NavLink>
        <NavLink to="/admin/keys">api keys</NavLink>
        <NavLink to="/admin/models">models</NavLink>
        <a
          href="/admin"
          onClick={(e) => {
            e.preventDefault();
            void api.logout().then(() => setState("anon"));
          }}
        >
          log out
        </a>
      </nav>
      <Routes>
        <Route index element={<Dashboard />} />
        <Route path="keys" element={<Keys />} />
        <Route path="models" element={<Models />} />
      </Routes>
    </main>
  );
}
