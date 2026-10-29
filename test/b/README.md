# test/b — registry / tar / historical self-tests (task-5)

Owner: teammate `registry` (task-5). Files under test/out-b/ are generated.

| script | network? | what it proves |
|---|---|---|
| `test-satisfies.mjs` | no | `satisfiesDsh` semver subset: exact, `^`, `~`, `>= <= > < =`, `||`, x-ranges, and npm prerelease semantics (`^0.1.0-rc.7` accepts `0.1.0-rc.8`, rejects `0.2.0-rc.1`; `^0.2.1-rc.1` accepts `0.2.1-rc.2`; plain ranges reject prereleases; `*` accepts everything). 48 checks. |
| `test-matrix.mjs` | yes | `listPluginVersions('dsh-better-sidebar')` returns 36 versions / 39 DSH versions; `0.13.1` has `dshPeers: ["^0.1.0-rc.7"]` and `compatibleDsh` includes `0.1.0-rc.7`; `0.28.2` targets `^0.2.1-rc.1`. Also `dsh-unlag` (170 versions, no DSH peers), scoped-name encoding `@scope%2fname`, registry env override, and error paths (`REGISTRY_HTTP` 404, `VERSION_NOT_FOUND`). Writes `out-b/matrix-dsh-better-sidebar.json`. |
| `test-tar.mjs` | yes | downloads the real `dsh-better-sidebar@0.13.1` tarball (sha512 verified), extracts it and checks `package.json` + `lib/index.js` + 181 files, then proves hostile archives are rejected (`..`, absolute path, escaping symlink, empty, non-gzip) and checks root stripping, pax long names, executable modes and relative symlinks. |
| `test-historical.mjs` | yes + npm | full historical pipeline: download → extract → peer check → `npm install --omit=dev --omit=peer --ignore-scripts` → `assembleOfflinePackage` (server-core `lib/pack.mjs`) → zip in `out-b/`. Checks the zip layout (single top-level bundle dir), `unzip -t`, rewritten manifest (`dependencies:{}`, all peers optional, `dsh.bundle.patch` kept), vendored `schemastery`/`ws`, absence of `node-pty`/`react`/`@deepseek-ai/*`, and `CHECKSUMS.txt`. |

Run everything: `bash test/b/run-all.sh`.

## Design notes / deviations from the literal task text

1. **`--omit=peer` added to the npm install.** npm 7+ auto-installs declared
   peerDependencies. Those peers are exactly the packages the target DSH host
   provides (`@deepseek-ai/dsh-*`, `react`, `react-dom`, `cordis`), so installing
   them would only slow the build down (they are filtered out by `pack.mjs`
   anyway) and can trip `ERESOLVE` on historical combinations. Omitting them
   matches the intent of "install the runtime dependencies".
2. **Unbuilt native direct dependencies are pruned from the vendor tree.**
   `--ignore-scripts` means packages such as `node-pty` have no native binding.
   Shipping a broken copy inside `<plugin>/node_modules` would *shadow* a working
   copy provided by the DSH host (`$DSH_HOME/profiles/node_modules` fallback) and
   degrade the terminal feature. `historical.mjs` removes direct dependencies
   whose `install`/`preinstall`/`postinstall` scripts were skipped, adds a
   warning, and lets the host provide them. Set
   `DSH_OFFLINE_PACKER_KEEP_NATIVE_DEPS=1` to keep them instead.
3. The vendored tree is the plugin's **full declared dependency tree**
   (157 packages, ~47 MB zip for `dsh-better-sidebar@0.13.1`), not the pruned
   "only what is statically imported" set the hand-made reference package used.
   This is the contract (`npm install --omit=dev`) and is a safe superset; the
   trade-off is package size.

## Environment knobs

- `DSH_OFFLINE_PACKER_REGISTRY` — registry base URL (default `https://registry.npmjs.org`).
- `DSH_OFFLINE_PACKER_TMPDIR` — scratch-directory parent for the historical pipeline (default `os.tmpdir()`); the scratch dir is kept on failure.
- `DSH_OFFLINE_PACKER_KEEP_NATIVE_DEPS=1` — do not prune unbuilt native direct dependencies.
- `DSH_OFFLINE_PACKER_NPM` — npm executable override.

## Known limitations

- The matrix needs live network access; behind a proxy/offline the API answers
  `REGISTRY_HTTP` / `REGISTRY_UNREACHABLE` / `REGISTRY_TIMEOUT`.
- `listPluginVersions` caps `compatibleDsh` at 30 entries per version.
- npm's cache/network is used as-is; the first cold install of
  `dsh-better-sidebar@0.13.1` took ~4 minutes, a warm run ~1 minute.
- `pack.mjs` treats every `@deepseek-ai/*` package as host-provided. For plugin
  versions that declare `@deepseek-ai/schemastery` as a *dependency* (e.g.
  `dsh-better-sidebar@0.28.x`) the target DSH host must actually provide it.
