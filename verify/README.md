# dsh-offline-packer — independent verification workspace

Owner: `qa-verifier` (fresh context; every claim in `report.md` is personally
reproduced here). Guest project: `../` (owned by Lead / A / B / C — this
directory only writes under `verify/`).

Everything here is reproducible and idempotent. Ports, homes and files are
scoped so the real user environment (`http://127.0.0.1:3080`,
`DSH_HOME=/home/fc/.dsh`) is **read-only scan source only**: never written, and
port 3080 is never touched.

## Layout

| Path | Purpose |
|---|---|
| `env.sh` | shared constants/helpers (paths, ports, auth cookie jar, guards) |
| `check-env.sh` | read-only environment self-check (node/pnpm/hosts/browser/registry/ports/user profile) |
| `setup-host.sh` | install the dev plugin into an isolated home and boot `dsh web` (ports 3084-3086) |
| `teardown-host.sh` | stop hosts, report ports free |
| `probe-api.sh` | HTTP API wrapper + assertions (`state`/`plugins`/`matrix`/`job`/`poll`/`download`/`fence`/`raw`/`package-*`) |
| `validate-zip.sh` | offline zip validator (`unzip -t`, layout, manifest, `sha256sum -c`, `bash -n`, member safety, dry-run) |
| `ui-smoke.mjs` | Playwright smoke: page → onboarding → Settings → 「离线打包」 → screenshots + console/page errors + `data-testid` assertions |
| `logs/` | per-host server logs + command transcripts |
| `run/` | `host-<port>.{pid,env}`, `cookies-<port>.jar` for booted hosts |
| `artifacts/` | screenshots + captured JSON evidence for the report |
| `tmp/` | throwaway staging (project copy for install, zip extractions) |
| `home/`, `home-*` | isolated test DSH homes |

## Quick start

```bash
bash verify/check-env.sh                 # environment self-check

# terminal A: keep this running (managed background job)
bash verify/setup-host.sh                # dev plugin host on 3084, verify/home
# flags: --no-plugin --stub-client --port 3085 --home verify/home-x
#        --dsh-bin /home/fc/dsh-plugin-build/host-pinned/.../lib/bin.js
#        --no-start --fresh --stop

# terminal B
bash verify/probe-api.sh base
bash verify/probe-api.sh state --home /home/fc/.dsh --min-plugins 10
bash verify/probe-api.sh package-local dsh-unlag
bash verify/probe-api.sh poll <jobId>

node verify/ui-smoke.mjs --port 3084 --require-section --min-plugins 1

bash verify/validate-zip.sh verify/tmp/downloads/<zip> \
  --expect-plugin dsh-unlag --expect-version <v> --expect-target 0.2.1-rc.2 --dryrun

bash verify/teardown-host.sh
```

## Boot conventions (why they look like this)

* Each bash tool call runs in its own bwrap sandbox: `/tmp` is not persistent and
  processes are not shared (`ps`/`kill` are PID-namespace-local; background jobs
  share the network). A server therefore must be started through a **managed
  background job** (`run_in_background`), which stays alive across calls.
  Restarting on the same port means `job_kill` on the old job first — a new call
  cannot kill the old process, and `setup-host.sh` detects a busy port and aborts
  with a message saying exactly that. `teardown-host.sh` clears state files and
  reports port status.
* `dsh web` (0.2.1-rc.2) prints a random `?token=` URL on boot and gates every
  route behind an auth cookie (plain `GET /` → 401). `setup-host.sh` scrapes the
  token from the log, bootstraps `run/cookies-<port>.jar`, and records
  `BASE=http://127.0.0.1:<port>/?token=...` in `run/host-<port>.env`.
* The shipped installer `test/install-dev-plugin.sh` does
  `cp -a <project> <profile>/node_modules/<plugin>`. Because the test home lives
  inside `verify/` (inside the project), installing directly fails with
  `cp: cannot copy a directory into itself`. `setup-host.sh` stages a copy of the
  project (excluding `verify/`) into `tmp/plugin-src/` and runs the *shipped
  installer* from there — same script and code, destination outside the copy
  source.
* The client bundle (`client.js`) is owned by another task; before it lands,
  `setup-host.sh --stub-client` writes a VERIFY-ONLY placeholder into the
  installed copy only (never into the working tree) so the host can boot. Hosts
  booted without a client bundle fail with
  `client-modules: ... client bundle not found`.

## Formal verification checklist (task-7)

1. plugin loads: boot log clean, `/api/state` structure + `host.dshVersion`
2. UI: screenshots, list non-empty (≥10 scanning `/home/fc/.dsh`), refresh, no console/page errors
3. one-click local package: `dsh-unlag` → job done → zip validated → install into
   a fresh home via `install-offline.sh` → boot (3085) manifest contains plugin →
   uninstall → boot again
4. large plugin: `dsh-better-sidebar@0.28.1`, size/structure/time bound
5. historical: matrix ≥30 versions, `0.13.1` peers `^0.1.0-rc.7`, build → install
   into fresh home → boot with pinned rc.7 host (3086) → `/sidebar/api/terminal.deps`
6. error paths: unknown matrix package, illegal download name, missing local
   plugin → structured `{ok:false,error:{code,message}}`, service stays up
7. security/boundary: fence 403 on forged Origin, `../` traversal rejected,
   relative `home` handled sanely
8. no regression: user 3080 GUI still answers, `/home/fc/.dsh` unmodified
   (hash/snapshot before vs after)
