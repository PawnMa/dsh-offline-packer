# test/c — browser-half checks (owner: client-ui)

Two Playwright drivers cover the `离线打包` / `Offline Packager` settings section. Both
need a booted isolated host (never the user GUI on :3080):

```bash
# install the working tree into a test home, then boot with --no-open
bash test/install-dev-plugin.sh /home/fc/dsh-offline-packer/test/home-c web
DSH_HOME=/home/fc/dsh-offline-packer/test/home-c \
  node /home/fc/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 3081 --no-open
# the boot log prints: dsh web: http://127.0.0.1:3081/?token=<...>
```

The web host requires that token URL; a bare `/` answers 401. The scripts pass the printed
URL straight to `page.goto`, so the auth cookie follows.

## 1. `ui-check.mjs` — real node half, real data

```bash
node test/c/ui-check.mjs 'http://127.0.0.1:3081/?token=<token>' zh-CN   # also en-US
```

Walks landing → dismiss Preview notice + onboarding sheet (Escape) → account menu →
Settings → `离线打包`/`Offline Packager`, then asserts:

- nav label resolves in both locales, section root and every always-present testid exist;
- plugin rows / package buttons / history buttons match `data-plugin-count`;
- search narrows and empties the list;
- version matrix opens (either npm rows or a readable error envelope);
- refresh keeps the page alive, and an error banner appears only when the API really failed;
- one local packaging job starts, polls, and exposes status + logs (or a readable error);
- switching the scan source to `/home/fc/.dsh` (read-only) loads 17 plugins and labels each
  `来源`/`Source` line; the profile directory is either under the scanned home or flagged;
- no `pageerror`, no console error, boot manifest lists `dsh-offline-packer`.

Screenshots: `screenshot.png` (list), `screenshot-history.png`, `screenshot-job.png`,
`screenshot-scan-source.png`, `screenshot-row-source.png`, `screenshot-final.png`.
Machine-readable result: `ui-check-report.json` (token redacted).

## 2. `ui-mock.mjs` — UI states with mocked envelopes

```bash
node test/c/ui-mock.mjs 'http://127.0.0.1:3081/?token=<token>' zh-CN
```

Intercepts only `**/dsh-offline-packer/api/**` with faithful ARCHITECTURE §1 envelopes
(3 plugins, version matrix, running→done job with result, envelope error, profile-dir
mismatch), so every visual state is exercised even when the node half is being rewritten.
Host endpoints are untouched; any host with the plugin installed works.

Covers: rows/badges/meta/warnings, labelled source line, search, matrix rows + target +
version select + DSH chips, registry POST body, running job log growth, done state with
download href, polling stops after settle, log zoom/clear, envelope error code+message,
recovery, profile-dir mismatch note, zero page errors.

Screenshots: `screenshot-mock-*.png`.

## data-testid contract (stable; qa scripts may rely on these)

Page/list: `offline-packer-page` (`data-plugin-count`), `offline-packer-host-info`,
`offline-packer-host-version`, `offline-packer-home-input`, `offline-packer-profile-input`,
`offline-packer-refresh`, `offline-packer-output-root`, `offline-packer-profile-dir`,
`offline-packer-profile-dir-mismatch`, `offline-packer-search`, `offline-packer-list`,
`offline-packer-list-loading`, `offline-packer-empty`, `offline-packer-no-match`,
`offline-packer-state-error`.

Rows: `offline-packer-row` (`data-plugin-name`), `offline-packer-kind`,
`offline-packer-enabled`, `offline-packer-peer`, `offline-packer-client`,
`offline-packer-server`, `offline-packer-warnings`, `offline-packer-source`,
`offline-packer-package-local`, `offline-packer-history-toggle`.

History matrix: `offline-packer-history` (`data-plugin-name`),
`offline-packer-matrix-loading`, `offline-packer-matrix-empty`,
`offline-packer-matrix-list`, `offline-packer-matrix-row` (`data-version`),
`offline-packer-version-select`, `offline-packer-dsh-version`,
`offline-packer-target-dsh`, `offline-packer-package-registry`.

Job: `offline-packer-job` (`data-job-id`, `data-job-status`), `offline-packer-job-status`,
`offline-packer-job-logs` (`data-log-count`), `offline-packer-job-zoom`,
`offline-packer-job-clear`, `offline-packer-job-dismiss`, `offline-packer-job-error`,
`offline-packer-job-failure`, `offline-packer-result`, `offline-packer-download`,
`offline-packer-result-zipname`, `offline-packer-result-target`.

Errors/notices: `offline-packer-error`, `offline-packer-action-error`, `offline-packer-notice`,
`offline-packer-retry`, `offline-packer-error-dismiss`.

## Notes

- `ui-mock.mjs` can run against a UI-only scaffold host (outside the repo, e.g.
  `DSH_HOME=/home/fc/.cache/dsh-op-mock`) whose `index.js` has no `lib` imports; only
  `client.js` activation matters there because every API call is mocked.
- `ui-check.mjs` needs the real node half (`lib/**`) complete; otherwise the section does
  not register and the nav label never appears.
