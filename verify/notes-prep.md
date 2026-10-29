# Prep notes — verifier (preliminary, NOT the formal report)

Date: 2026-10-29 11:40 (Asia/Shanghai). Fresh-context independent verifier.
Formal report will be `verify/report.md` after claiming task-7; everything below is
preparation/rehearsal against the working tree as of ~11:33 UTC+8.

## Environment self-check — PASS (`verify/check-env.sh`, log `verify/logs/check-env.log`)

- node v24.14.0, npm 11.21.1, pnpm 11.21.0, unzip 6.00, curl 7.68, python3 3.12.15
- dev host: `/home/fc/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` → `0.2.1-rc.2`
- pinned rc.7 host: `/home/fc/dsh-plugin-build/host-pinned/.../lib/bin.js` → `0.1.0-rc.7`
- playwright-core 1.64.1 (`/home/fc/dsh-plugin-build/leadcheck/pw`), chromium
  `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` (278 MB, executable)
- registry.npmjs.org reachable (HTTP 200)
- ports 3084–3086 free; live GUI 3080 answers 401 (untouched)
- read-only scan source `/home/fc/.dsh`: 12 dependencies / 15 bundles, readable

## Host/boot facts discovered (encoded in the scripts)

- **token auth (0.2.x)**: boot log prints `...?token=<43 chars>`; `GET /` without it → 401.
  Bootstrap: `curl -c jar "http://127.0.0.1:<p>/?token=..."` (303, sets cookie) then use `-b jar`.
  Playwright: `page.goto(url?token=...)`.
- **rc.7 (0.1.0-rc.7) has no token gate and no `--no-open` flag**; readiness = unauth GET / 200.
  `setup-host.sh` handles both (passes `--no-open` only for 0.2.*).
- **PID namespaces**: each bash call cannot see/kill processes from another call; a restart on
  the same port requires `job_kill` of the managed background job first. `setup-host.sh` aborts
  with that hint if the port is busy. `--no-open` avoids the "opening default browser" attempt.
- `test/install-dev-plugin.sh` was fixed by Lead (staging copy), so direct in-tree install now
  works; `setup-host.sh` falls back to a staged copy only if direct install fails.
- **rc.2 boot manifest** is `globalThis["__DSH_BOOT__"] = {rev, release, entries:[{id,url,rev,inject}]}`;
  client URLs are relative (`plugins/??<id>/client.js&rev=...`) and served 200.
- **plugin load failure is a warning**, not fatal (`dsh: warning: 1 entry did not activate`);
  route presence must be proven by `GET /dsh-offline-packer/api/state` → 200. Scripts do that.

## Scripts (all in verify/, syntax-checked, reproducible)

| script | purpose |
|---|---|
| `env.sh` | shared constants/helpers, auth-aware curl, guards (never write real home / port 3080) |
| `check-env.sh` | read-only environment self-check (above) |
| `setup-host.sh` | install dev plugin into isolated home + boot host (3084–3086); token/cookie/env state files; `--no-plugin --stub-client --dsh-bin --fresh --stop --no-start` |
| `teardown-host.sh` | clear host state + report ports |
| `probe-api.sh` | `base/state/plugins/matrix/package-local/package-registry/job/poll/download/fence/raw`; assertions incl. `--expect-error`; `--home` scan target |
| `validate-zip.sh` | unzip -t, layout, manifest (deps {} peers optional), `sha256sum -c`, `bash -n`, exec bit, member safety, VERSIONS/README, optional installer `--dry-run`; `--legacy` for previous-round artifact |
| `ui-smoke.mjs` | Playwright: page→dismiss onboarding→Settings→「离线打包」→refresh→(optional UI packaging)→screenshots + console/page errors + data-testid/row assertions; `--package-plugin`, `--require-testids`, `--min-plugins`, `--json` |
| `boot-evidence.sh` | log hard-failure scan, GET /, boot manifest contains/absent plugin, client bundle 200, `--dump-config`, arbitrary `--probe "METHOD /path"` |
| `offline-install.sh` | extract artifact + replay `install-offline.sh` (`--dry-run`/`--uninstall`) into a fresh home; asserts dir+bundles |
| `snapshot-user-home.sh` | read-only before/after snapshot of `/home/fc/.dsh` for item 8 |

## Rehearsal evidence (preliminary; will be re-run for the formal report)

- Plugin boot on 3084: clean log (1 line), `state` 200, `host.dshVersion=0.2.1-rc.2`;
  scan `verify/home` → 19 plugins; scan `/home/fc/.dsh` → 17 plugins (≥10 required).
- UI (screenshot `artifacts/03-offline-packer.png`): Settings nav has 「Offline Packager」,
  19 rows, core testids present, refresh works, **no console/page errors**. Title panel shows
  host/profile/DSH_HOME/output folder, plugin cards with size/peer/client/server + build buttons.
- Local packaging `dsh-unlag` (home=/home/fc/.dsh): job done 238 ms; zip 102,944 B / 16 files;
  `validate-zip` PASS (23 checks incl. sha256 15/15, dry-run); install into fresh home PASS;
  boot 3085 manifest contains dsh-unlag + client 200 + dump-config mount; uninstall PASS;
  reboot 3085 → manifest/dump-config absent, GET / 200.
- Large plugin `dsh-better-sidebar@0.28.1` (local): job done 1,987 ms; zip 5,276,912 B /
  482 files; `validate-zip` PASS (22 checks, sha256 481/481); 9 host-provided deps + 3 browser
  modules skipped.
- Historical: `matrix dsh-better-sidebar` → 36 versions / 39 dsh versions, `0.13.1` dshPeers
  contains `^0.1.0-rc.7`; `package-registry 0.13.1 → 0.1.0-rc.7` done; zip 46,940,279 B /
  12,864 entries, sha256-check 12,863/12,863 OK; install into fresh home PASS; rc.7 boot on
  3086: manifest contains dsh-better-sidebar, client 200, `POST /sidebar/api/terminal.deps`
  → 200 `{"ok":true,"value":{"ok":true}}`, `settings.get` ok, dump-config mount, clean log.
- Error paths: matrix unknown package → `REGISTRY_HTTP` structured error; download `../../etc/passwd.zip`
  → 400 `BAD_NAME`; absolute path → 400 `BAD_NAME`; missing zip → 404 `NOT_FOUND`;
  job unknown → 404 `JOB_NOT_FOUND`; package-local missing plugin → job `PLUGIN_NOT_FOUND`.
- Fence: forged `Origin: http://evil.example` → 403; same-origin → 200.
- No regression so far: `/home/fc/.dsh` snapshot diff only has the label timestamp line
  (package.json sha256 unchanged, 328 packages unchanged); 3080 still answers 401.

## Preliminary observations / risks to re-check in the formal run (not yet verdicts)

1. **Historical package size**: 46.9 MB / 12,864 entries vs the previous round's rc.7
   deliverable 7.9 MB / 321 entries. The registry path vendors the whole npm runtime closure
   including browser-only packages (`@codemirror/*`, `mermaid`, `d3-*`, …). It works, but if
   the intent was "browser deps are bundled in client.js already", this is avoidable bloat —
   either way the offline installer works; flag as risk/optimization, not a functional fail.
2. Local `dsh-better-sidebar@0.28.1` package has 0 embedded deps (all host-provided) — correct
   for this host; a fresh-home rc.2 boot was not rehearsed for this local zip (item 4 optional).
3. UI onboarding modal in 0.2.1-rc.2 is `Get started` with Close (not a `Continue` button as
   the task text said); `ui-smoke.mjs` handles both.
4. `setup-host.sh` writes only under `verify/`; artifacts/outputRoot of the plugin under test
   are `verify/home/offline-packages` (never the scanned home `/home/fc/.dsh`).
