#!/usr/bin/env bash
set -euo pipefail

validate_image_reference() {
  local image="$1"
  if [[ ! "$image" =~ ^ghcr\.io/jmal1/selfservice-synthetic-ui:[0-9a-f]{40}$ ]]; then
    echo "[synthetic-ui] SYNTHETIC_UI_IMAGE must be an immutable ghcr.io/jmal1/selfservice-synthetic-ui:<40-character lowercase commit SHA> tag; received ${image@Q}" >&2
    return 1
  fi
}

validate_keep_runs() {
  local keep_runs="$1"
  if [[ ! "$keep_runs" =~ ^[1-9][0-9]*$ ]]; then
    echo "[synthetic-ui] SYNTHETIC_REPORT_KEEP_RUNS must be a positive integer; received ${keep_runs@Q}" >&2
    return 1
  fi
}

validate_report_root() {
  local root="$1"
  # The report root is bind-mounted into the container as /app/playwright-report.
  # Docker would create a missing bind source as root, so reject it first.
  if [[ ! -d "$root" ]]; then
    echo "[synthetic-ui] report root '$root' does not exist; create it with: sudo install -d -m 0755 '$root' && sudo chown 1001:1001 '$root'" >&2
    return 1
  fi
  if [[ -L "$root" ]]; then
    echo "[synthetic-ui] report root '$root' must not be a symlink" >&2
    return 1
  fi
}

run_report_storage_command() {
  docker compose -f "$compose_file" run --rm --no-deps --pull never \
    --entrypoint node monitor \
    /app/scripts/deployment-guardrails.mjs "$@"
}

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
compose_file="$repo_root/deploy/docker-compose.yml"
report_root="${SYNTHETIC_REPORT_ROOT:-/opt/synthetic-ui/report}"
keep_runs_raw="${SYNTHETIC_REPORT_KEEP_RUNS:-3}"
image="${SYNTHETIC_UI_IMAGE:-}"

validate_image_reference "$image"
validate_keep_runs "$keep_runs_raw"
validate_report_root "$report_root"
if ! run_report_storage_command preflight; then
  echo "[synthetic-ui] report storage preflight failed for container UID 1001 (pwuser)" >&2
  exit 1
fi

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
export PLAYWRIGHT_REPORT_RUN_ID="$run_id"

echo "[synthetic-ui] report output folder: ./playwright-report/runs/$run_id"

set +e
docker compose -f "$compose_file" run --rm monitor
run_status=$?
set -e

retention_status=0
if ! run_report_storage_command prune "$keep_runs_raw"; then
  retention_status=1
fi
if (( retention_status != 0 )); then
  echo "[synthetic-ui] report retention failed" >&2
fi

if (( run_status != 0 )); then
  exit "$run_status"
fi
if (( retention_status != 0 )); then
  exit "$retention_status"
fi
exit 0
