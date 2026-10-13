# HANDOFF — remote gateway connectors (seam + iroh plugin)

Updated: 2026-10-13 · Agent: Pixel · Status: **seam built & green, plugin live, pxl dogfood pending**

This branch carries the generic *remote gateway connectors* seam; the iroh
implementation lives in its own repo and is the proof it earns its keep.

## Where everything lives

| Piece | Location | Head |
|---|---|---|
| Seam (this branch) | `agentbox-tech/hermes-agent` @ `feat/remote-connector-seam-0.21.7` | `9bac4e8b66` |
| Seam commits | desktop `3083123bdb` · server `9bac4e8b66` (re-cut clean onto tag `v0.21.7` = `71d34bad`) | — |
| iroh connector | `agentbox-tech/hermes-iroh-connector` (public) | `813b9c5` |
| Design doc | Rain's vault: `tasks/20261013-remote-connector-plugin/DESIGN.md` | — |
| Reference transport (retire after extraction confirmed) | `agentbox-tech/hermes-agent` @ `iroh-core` / branch tip `ed82415`, `tools/iroh/*` | — |
| Task board | Grist pxl :8484 — seam PR task #47, dogfood task (see Notes) | — |

## Base strategy (Rain, 2026-10-13)

**We track release tags, never upstream/main.** This branch sits on
`v0.21.7`; the seam can still be *proposed* upstream, but all builds and
dogfood run off the tagged base. Do not "fix" this by rebasing onto main.

## What's proven (green, this session)

- Registry 20 + loader 11 vitest green **on the 0.21.7 base**; tsc clean.
- Python: 25 seam tests via `scripts/run_tests.sh` green; 87 plugin tests
  green as regression.
- **Server-side e2e on pxl**: connector `serve()` in the glibc container
  (`hermes-iroh-seam-serve`, podman, host-net, own key+ticket under
  `~/.hermes/iroh/pxl-seam/`) — untouched reference client dials the live
  ticket → dashboard HTML 200 (10KB) in ~26ms. Wire-format compat with the
  reference bridges proven old-client ↔ new-server.
- Field bug fixed in plugin (`813b9c5`): `Endpoint.watch_addr` is broken in
  the Python bindings (bare callable → TypeError; subclass → "no reactor
  running" FFI error — which is why the reference bridge silently ran
  STATIC tickets). Connector now polls `endpoint.addr()` every 60s.

## The shape for pxl dogfood (decided, not open)

PyPI `iroh` ships **no musllinux wheel** (verified against the 1.1.0
release: macos/glibc-Linux/windows only). pxl is musl. Therefore the serve
process runs in a glibc container running the *real* hermes CLI, loading
the *real* plugin through real discovery — container is an OS shim, the
seam stays completely faithful. (Node has musl prebuilds; Python doesn't.
A native-musl Node sidecar stays a possible later optimization, not now.)

## Gaps, in build order (→ Grist dogfood task)

1. `__init__.py` exposing `register(ctx)` in the plugin repo (discovery
   requirement; `provides_remote_connectors` manifest key warns-but-loads —
   verified in `plugins_manifest.py`, becomes a known field in the seam PR).
2. Implement `IrohConnector.connect()` (currently honest
   `NotImplementedError`) — without it there is no full pxl loop and no
   headless dialer, ever.
3. Runtime Dockerfile: `python:3.12-slim` + seam checkout +
   `pip install iroh==1.1.0` + plugin; CMD
   `hermes remote serve --scheme iroh --gateway-url http://127.0.0.1:9119`.
   Build via podman on pxl (bridge:0.1 is the base precedent).
4. Home isolation: container gets `HERMES_HOME=~/.hermes/iroh-seam` mount
   (plugin, key, ticket). Never mount live `~/.hermes`.
5. Enablement: confirm/default the enabled-plugins store in the dogfood home.
6. Relay proof: force relay-only dial so traffic demonstrably traverses
   relay.agentbox.tech — tonight's 26ms was almost certainly direct LAN.
7. Durability trio: quadlet unit (survive reboot), pulse (endpoint alive +
   ticket fresh), Grist task until boring. Today's serve container has
   none — it dies at the next reboot.
8. NOT dogfoodable on pxl (headless): the desktop loader half. That leg
   runs on the Mac/box0: stage the tarball
   (`connectors/iroh/<ver>/iroh-connector-<ver>-<platform>.tar.gz`,
   napi per-platform prebuilds packed from npm — no compiling; published to
   dl.agentbox.tech, install = folder-drop + ⌘K "Reload desktop plugins").

## Constraints & gotchas (do not rediscover)

- `scripts/run_tests.sh` is the ONLY sanctioned test runner (home-io-guard
  rejects raw pytest on this machine); musl uv swap documented in
  hermes-operations skill `references/pxl-repo-tests.md`.
- Push to the fork needs SSH (`git@github.com:…`) — the rain-sk fine-grained
  PATs can't touch workflow files, and fine-grained PATs cannot create org
  repos (repo creation is Rain's click).
- `plugins/AGENTS.md` policy: no new third-party-product plugins in core —
  core ships the seam, connector ships from our repos. Never a name check.
- Don't disturb the live reference stack (`hermes-iroh-bridge`,
  `hermes-iroh-client`, gateway :9119): dogfood uses its own identity,
  ticket dir, and ports (9121+).
- Relay ops: QUIC is opt-in in iroh-relay; deploy repo
  `agentbox-tech/relay.agentbox.tech`; heartbeat cron `6216f29770c2`.

## Next upstream move

Open the seam PR from this branch once pxl dogfood (gaps 1–7) is green —
the working connector repo is the existence proof. The iroh-core branch
retires after extraction is confirmed equivalent.
