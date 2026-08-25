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
  # The container runs as pwuser (UID 1001 in the Playwright image); the host
  # directory must be owned by that UID so the container can create sub-directories.
  if [[ ! -d "$root" ]]; then
    echo "[synthetic-ui] report root '$root' does not exist; create it with: sudo install -d -m 0755 '$root' && sudo chown 1001:1001 '$root'" >&2
    return 1
  fi
  if [[ ! -w "$root" ]]; then
    echo "[synthetic-ui] report root '$root' is not writable; check permissions" >&2
    return 1
  fi
  # UID ownership check is meaningful only on Linux, where Docker enforces
  # container UIDs on bind mounts. Skip on macOS/Windows dev environments.
  if [[ "$(uname -s 2>/dev/null)" == "Linux" ]]; then
    local uid
    uid="$(stat -c '%u' "$root" 2>/dev/null || true)"
    if [[ -n "$uid" && "$uid" != 1001 ]]; then
      echo "[synthetic-ui] report root '$root' is owned by UID $uid, not container UID 1001 (pwuser); run: sudo chown 1001:1001 '$root'" >&2
      return 1
    fi
  fi
}

prune_report_runs() {
  local report_root="$1"
  local keep_runs="$2"
  local runs_root="$report_root/runs"
  mkdir -p "$runs_root"

  shopt -s nullglob
  local entry
  local -a snapshots=()
  for entry in "$runs_root"/*; do
    [[ -e "$entry" ]] || continue
    if [[ -L "$entry" || ! -d "$entry" ]]; then
      echo "[synthetic-ui] unexpected non-directory entry under $runs_root: ${entry##*/}" >&2
      shopt -u nullglob
      return 1
    fi
    snapshots+=("$(stat -c '%Y' "$entry")"$'\t'"$entry")
  done
  shopt -u nullglob

  if (( ${#snapshots[@]} <= keep_runs )); then
    return 0
  fi

  mapfile -t sorted_snapshots < <(printf '%s\n' "${snapshots[@]}" | sort -rn -k1,1)
  local index=0
  local line snapshot_path
  for line in "${sorted_snapshots[@]}"; do
    ((index += 1))
    if (( index > keep_runs )); then
      snapshot_path="${line#*$'\t'}"
      rm -rf -- "$snapshot_path"
    fi
  done
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

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
export PLAYWRIGHT_REPORT_RUN_ID="$run_id"

mkdir -p "$report_root/runs"
echo "[synthetic-ui] report output folder: ./playwright-report/runs/$run_id"

set +e
docker compose -f "$compose_file" run --rm monitor
run_status=$?
set -e

retention_status=0
if ! prune_report_runs "$report_root" "$keep_runs_raw"; then
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
