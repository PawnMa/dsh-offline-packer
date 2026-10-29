#!/usr/bin/env bash
# Run the task-B (registry / tar / historical) self-tests in order.
#
#   bash test/b/run-all.sh
#
# test-historical.mjs needs network + npm and takes ~1-2 minutes with a warm
# npm cache (longer on a cold cache).
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

echo '== node --check =='
node --check lib/registry.mjs
node --check lib/tar.mjs
node --check lib/historical.mjs

echo '== satisfiesDsh unit tests =='
node test/b/test-satisfies.mjs

echo '== live registry matrix =='
node test/b/test-matrix.mjs

echo '== tar extraction (live tarball + hostile archives) =='
node test/b/test-tar.mjs

echo '== historical packaging (dsh-better-sidebar@0.13.1 -> DSH 0.1.0-rc.7) =='
node test/b/test-historical.mjs

echo 'ALL TASK-B TESTS PASSED'
