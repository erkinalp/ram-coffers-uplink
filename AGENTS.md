# AGENTS.md — ram-coffers-uplink

A port of `symphonic-navigator/ollama-uplink` with RAM Coffers upstreams.

## Structure

- `apps/sidecar` — Node 22 CLI; dials out to the relay, forwards to a RAM Coffers
  HTTP inference service and/or a P3XC cluster.
- `apps/relay/server` — Fastify 5 + ws; uplink endpoint, client APIs
  (`/api/*`, `/v1/*`, `/coffer/v1/*`), admin and privacy REST, static SPA.
- `apps/relay/web` — Vite + React SPA (Gruvbox dark, hand-written CSS).
- `packages/protocol` — tunnel frame codec, session crypto (HKDF-SHA256 +
  XChaCha20-Poly1305), `TunnelSession` multiplexer.
- `packages/p3xc` — native TypeScript P3XC: frames, tensors, batch dispatch and a
  persistent client. It must stay wire-compatible with `ps3_cluster`'s
  `{protocol,batch}.py` in erkinalp/ram-coffers;
  `packages/p3xc/test/interop.test.ts` checks that against the Python
  implementation (set `PS3_CLUSTER_DIR`, or keep a ram-coffers checkout beside
  this one; it skips otherwise) and must be extended whenever the codec changes.
- `packages/g9xc` — native TypeScript G9XC v2: 32-byte frames, expert batch and
  per-expert row payloads, a multiplexed client (replies match `request_id`,
  not position). It must stay wire-compatible with `gen9_cluster`'s
  `protocol.py` in erkinalp/ram-coffers; `packages/g9xc/test/interop.test.ts`
  checks that (set `GEN9_CLUSTER_DIR`, or keep a ram-coffers checkout beside
  this one; it skips otherwise) and must be extended whenever the codec changes.
- Never shell out to Python at runtime.

## Commands

- `pnpm install` — install (lockfile is authoritative; `--frozen-lockfile` in CI)
- `pnpm build` / `pnpm test` / `pnpm typecheck` / `pnpm lint` — Turborepo/Biome at the root
- `pnpm --filter @ram-coffers-uplink/<pkg> <script>` — per package
- Run the relay locally: `pnpm build && node apps/relay/server/dist/index.js`

## Conventions

- TypeScript strict, NodeNext ESM, `.js` extensions on relative imports.
- All code, comments and docs in **British English**.
- **Zero logging of prompts, activations or responses, anywhere, in any mode.**
  Only connection/operational status may be logged. This is a hard rule; reject
  any change that violates it.
- Biome for lint + format (`pnpm lint`, `pnpm format`); vitest for tests.
- Dependencies are pinned to exact versions (`.npmrc` sets `save-exact=true`).
- No credentials in the repository: `.env.example` and `compose.yml` carry
  placeholders and required-variable references only.
- Conventional commits.
