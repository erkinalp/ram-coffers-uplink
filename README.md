# ram-coffers-uplink

Expose a RAM Coffers node or a PS3/P3XC expert cluster through a VPS relay, for
yourself and the people you grant access to, via **Ollama-compatible and
OpenAI-compatible HTTP APIs** plus the lower-level **RAM Coffers cluster API**
(`/coffer/v1/*`).

- **sidecar** — runs next to the coffer hardware (POWER8 host, PS3 shelf, layer
  coordinator). Dials out to the relay over WSS, so no inbound firewall rules or
  public addresses are needed anywhere near the cluster. Configured purely via
  environment.
- **relay** — runs on the VPS. Accepts 0..n sidecars, serves the client APIs and
  hosts a web GUI (admin dashboard + per-user privacy page).

It is a port of [ollama-uplink](https://github.com/symphonic-navigator/ollama-uplink)
to RAM Coffers: the relay, encrypted uplink, API keys, model policies and
rate limiting are the same design, while the upstream side speaks either a
RAM Coffers HTTP inference service or P3XC directly.

## Architecture

```
  ┌─────────────┐  HTTPS (Ollama / OpenAI / coffer APIs) ┌───────────────────────────┐
  │ API clients │ ─────────────────────────────────────▶ │           relay           │
  └─────────────┘                                        │ Fastify: /api/*, /v1/*,   │
  ┌─────────────┐  HTTPS (admin / privacy SPA)            │ /coffer/v1/*, admin REST │
  │  browsers   │ ─────────────────────────────────────▶ │ SQLite (/data volume)     │
  └─────────────┘                                        └────────────▲──────────────┘
                                                                      │ WSS /uplink
                                               E2EE frames (XChaCha20-Poly1305,
                                               keys from per-sidecar PSK via HKDF)
                                                                      │
                                                 ┌────────────────────┴──────────┐
                                                 │ sidecar (dials out, no inbound)│
                                                 └───────┬───────────────┬───────┘
                                        HTTP (generation)│               │P3XC (cluster)
                                    ┌───────────────────┴──┐   ┌────────┴─────────────────┐
                                    │ coffer inference :8080│   │ expert node / subcluster │
                                    │ (NUMA weight banks)   │   │ or layer coordinator     │
                                    └───────────────────────┘   └──────────────────────────┘
```

`UPSTREAM` selects which of the two upstream legs a sidecar uses: `http`, `p3xc`
or `both` (generation over HTTP, `/coffer/v1/*` over P3XC).

## Quickstart (compose)

1. Create `.env` next to `compose.yml`:

   ```
   ADMIN_TOKEN=<long-random-string>
   SESSION_SECRET=<even-longer-random-string>
   SIDECAR_PSK=<filled in after step 3>
   ```

2. `docker compose up -d relay`
3. Open `http://localhost:8082/admin`, log in with `ADMIN_TOKEN`, create a
   sidecar named `homelab` and copy the PSK shown once into `.env` as
   `SIDECAR_PSK`.
4. `docker compose up -d sidecar` — the sidecar uses host networking and expects
   the coffer inference service at `http://localhost:8080` (`COFFER_URL`), or a
   P3XC coordinator at `P3XC_HOST:P3XC_PORT`, and the relay at its published host
   port (`RELAY_URL`, default `ws://localhost:8082/uplink`).
5. Create API keys in the admin UI and hand them out.

For a PS3 cluster, start the coordinator on the cluster head first, e.g.

```bash
python -m ps3_cluster.tools.run_layer --listen 0.0.0.0:5920 --config shelf.toml
```

then run the sidecar with `UPSTREAM=p3xc`, `P3XC_PORT=5920` and `MODELS` naming
whatever the cluster serves (P3XC has no model-listing operation, so the model
list must be configured).

## Configuration

### relay (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `ADMIN_TOKEN` | — (required, ≥16 chars) | admin dashboard login token |
| `SESSION_SECRET` | — (required, ≥32 chars) | admin session cookie signing secret |
| `DATABASE_PATH` | `./data/relay.db` (`/data/relay.db` in the image) | SQLite file |
| `STATS_ENABLED` | `false` | initial default only; the admin GUI toggle persists and wins |
| `ALLOWED_ORIGINS` | empty (same-origin) | comma-separated CORS origins |
| `WEB_ROOT` | `apps/relay/web/dist` | built SPA location |

### sidecar (environment)

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_URL` | — (required) | `wss://` (production) or `ws://` (local/trusted networks) |
| `SIDECAR_NAME` | — (required) | name created in the relay admin UI |
| `PSK` | — (required) | shown once at sidecar creation |
| `UPSTREAM` | `http` | `http`, `p3xc` or `both` |
| `COFFER_URL` | `http://localhost:8080` | RAM Coffers HTTP inference service (`http`/`both`) |
| `P3XC_HOST` | `127.0.0.1` | expert node, subcluster or layer coordinator (`p3xc`/`both`) |
| `P3XC_PORT` | `5920` | P3XC port |
| `P3XC_TIMEOUT_MS` | `30000` | per-request P3XC deadline |
| `MODELS` | empty | models to advertise; required for `p3xc`, additive for `both`, overrides discovery for `http` |

## APIs

Ollama-compatible (`/api/chat`, `/api/generate`, `/api/embed`, `/api/show`,
`/api/tags`, `/api/version`, `/api/ps`) and OpenAI-compatible
(`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`) requests are routed to a
sidecar that advertises the requested model, streamed back verbatim and cancelled
upstream when the client disconnects.

```bash
curl https://relay.example.com/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"model":"deepseek-v3-mxfp4","messages":[{"role":"user","content":"Hello"}]}'
```

RAM Coffers cluster routes reach the P3XC layer directly, which is what makes a
remote console shelf usable for experiments rather than just for chat:

```bash
# Liveness and round-trip time to the coordinator.
curl https://relay.example.com/coffer/v1/health -H "Authorization: Bearer $API_KEY"

# One expert's forward pass (P3XC REQ/RSP).
curl https://relay.example.com/coffer/v1/dispatch \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"layer":5,"expert":9,"token_id":1234,"activation":[1.5,-2.25,0.125,4.0]}'

# A batched subcluster dispatch (P3XC BREQ/BRSP), gates included.
curl https://relay.example.com/coffer/v1/batch \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"layer":3,"token_id":77,"activation":[0.5,0.25],
       "entries":[{"expert":11,"gate":0.75},{"expert":12,"gate":0.25,"replica":1}],
       "fast":false,"deadline_ms":1500}'
```

`fast` selects the cluster's fast (order-independent) reduction rather than the
exact one; `deadline_ms` bounds the coordinator's wait; `request_id` makes a
retry deduplicable by the coordinator. `/coffer/v1/health` and
`/coffer/v1/version`, like `/api/ps` and `/api/version`, carry no model and are
answered by any online sidecar; `/coffer/v1/dispatch` and `/coffer/v1/batch`
accept an optional `model` to pin a specific cluster, and model policies apply
whenever one is given.

## Security model

- **Prompts, activations and responses are never logged or stored** by either
  service, in any mode. Logs contain connection and operational status only.
- **Sidecar ↔ relay frames are end-to-end encrypted** (application layer):
  XChaCha20-Poly1305 with per-session, per-direction keys derived via HKDF-SHA256
  from the sidecar's PSK hash over both handshake nonces, with sequence-numbered
  AAD. A TLS-terminating reverse proxy in front of the relay never sees plaintext
  payloads. The relay process itself necessarily sees plaintext to enforce
  policies and serve the wire formats. Over plain `ws://` only the initial
  `hello` handshake — sidecar name, nonces and model list — is plaintext.
- **The API key is the only identity.** Keys and PSKs are stored as SHA-256
  hashes and shown exactly once at creation.
- **Statistics are opt-in** (default off) and aggregate only: request counts,
  token counts and error counts per key/model/hour.

## Deployment note

Put the relay behind a TLS-terminating reverse proxy (Caddy, nginx, Traefik, …)
in production and access everything over HTTPS. The admin session cookie
deliberately carries no `secure` flag so that local development over plain HTTP
works; exposing the relay over HTTP on the public internet would leak admin
session cookies and API keys.

P3XC itself is unauthenticated and unencrypted, exactly as `ps3_cluster`'s
transport is: keep the coordinator and its consoles on a private segment and let
the sidecar be the only thing that talks to them.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

The P3XC codec is verified against the Python reference implementation in
[erkinalp/ram-coffers](https://github.com/erkinalp/ram-coffers)'s `ps3-cluster`
(`packages/p3xc/test/interop.test.ts` encodes in TypeScript, decodes with
`ps3_cluster.protocol`/`ps3_cluster.batch` and back, and runs a Python coordinator
over a real socket). Point `PS3_CLUSTER_DIR` at that directory, or keep a
ram-coffers checkout beside this one; the tests skip when neither is available.

See `AGENTS.md` for repository conventions. Licence: AGPLv3.
