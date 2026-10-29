#!/usr/bin/env bash
# Stop verification hosts and report whether their ports are free again.
#
#   bash verify/teardown-host.sh             # 3084 3085 3086
#   bash verify/teardown-host.sh 3084
#
# IMPORTANT: every bash tool call runs in its own PID namespace, so a host that
# was started by a *different* call cannot be killed here (kill() is
# namespace-local). Stop those with job_kill on the managed background job id;
# this script then only clears stale state files and reports port status.
#
# Safe: refuses port 3080 (the user's live GUI) and never touches /home/fc/.dsh.
set -uo pipefail
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)/env.sh"

PORTS=("$@")
[ "${#PORTS[@]}" -eq 0 ] && PORTS=("$PORT_MAIN" "$PORT_INSTALL" "$PORT_HIST")
for port in "${PORTS[@]}"; do
  guard_port "$port"
  stop_host "$port"
  rm -f "$(host_cookie_jar "$port")"
done

say ""
say "--- port status ---"
for port in "${PORTS[@]}"; do
  code="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null || true)"
  if [ -z "$code" ] || [ "$code" = "000" ]; then
    say "port $port: free"
  else
    say "port $port: still answering HTTP $code (pid $(cat "$(host_pid_file "$port")" 2>/dev/null || echo '?'))"
  fi
done
