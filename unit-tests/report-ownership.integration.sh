#!/usr/bin/env bash
set -euo pipefail

if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
  echo '[ownership] sudo is unavailable or passwordless sudo is not configured; skipping ownership integration guard' >&2
  exit 0
fi

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$(mktemp -d -t synthetic-ui-ownership-XXXXXX)"
fixture="$workspace/fixture"
report_root="$workspace/report"
runs_root="$report_root/runs"
results_root="$workspace/results"
host_home="$workspace/host-home"
compose_file="$fixture/deploy/docker-compose.yml"
project_name="synthetic-ui-ownership-$$"

cleanup() {
  TEST_REPORT_ROOT="$report_root" \
    TEST_RESULTS_ROOT="$results_root" \
    REPORT_MANAGER_SOURCE="$fixture/scripts/deployment-guardrails.mjs" \
    COMPOSE_PROJECT_NAME="$project_name" \
    docker compose -f "$compose_file" down --remove-orphans >/dev/null 2>&1 || true
  sudo rm -rf -- "$workspace"
}
trap cleanup EXIT

install -d -m 0755 "$fixture/scripts" "$fixture/deploy" "$host_home"
sed \
  -e "s|^readonly report_root=\"/opt/synthetic-ui/report\"$|readonly report_root=\"$report_root\"|" \
  -e "s|^readonly results_root=\"/opt/synthetic-ui/results\"$|readonly results_root=\"$results_root\"|" \
  "$repo_root/scripts/run-synthetic-ui.sh" >"$fixture/scripts/run-synthetic-ui.sh"
cp "$repo_root/scripts/deployment-guardrails.mjs" "$fixture/scripts/"
chmod 0755 "$fixture/scripts/run-synthetic-ui.sh"

cat >"$compose_file" <<'YAML'
services:
  monitor:
    image: node:20-alpine
    pull_policy: missing
    user: "1001:1001"
    environment:
      PLAYWRIGHT_REPORT_RUN_ID: "${PLAYWRIGHT_REPORT_RUN_ID:-missing}"
      TEST_MONITOR_EXIT: "${TEST_MONITOR_EXIT:-0}"
    volumes:
      - "${TEST_REPORT_ROOT:?}:/app/playwright-report"
      - "${TEST_RESULTS_ROOT:?}:/app/test-results"
      - "${REPORT_MANAGER_SOURCE:?}:/app/scripts/deployment-guardrails.mjs:ro"
    entrypoint: ["node"]
    command:
      - "-e"
      - |
        const fs = require('node:fs');
        fs.rmSync('/app/test-results/latest', { recursive: true, force: true });
        fs.mkdirSync('/app/test-results/latest');
        fs.writeFileSync('/app/test-results/latest/result.txt', 'ok\n');
        const run = '/app/playwright-report/runs/' + process.env.PLAYWRIGHT_REPORT_RUN_ID;
        fs.mkdirSync(run);
        process.exit(Number(process.env.TEST_MONITOR_EXIT));
YAML

chmod 0755 "$workspace" "$fixture" "$host_home"
sudo chown 1000:1000 "$host_home"
docker pull node:20-alpine >/dev/null
docker_gid="$(stat -c '%g' /var/run/docker.sock)"
image="ghcr.io/jmal1/selfservice-synthetic-ui:$(printf 'a%.0s' {1..40})"

run_as_host() {
  sudo env \
    PATH="$PATH" \
    HOME="$host_home" \
    COMPOSE_PROJECT_NAME="$project_name" \
    REPORT_MANAGER_SOURCE="$fixture/scripts/deployment-guardrails.mjs" \
    TEST_REPORT_ROOT="$report_root" \
    TEST_RESULTS_ROOT="$results_root" \
    SYNTHETIC_REPORT_KEEP_RUNS=3 \
    SYNTHETIC_UI_IMAGE="$image" \
    TEST_MONITOR_EXIT="${TEST_MONITOR_EXIT:-0}" \
    setpriv --reuid=1000 --regid="$docker_gid" --clear-groups "$@"
}

# Model the legacy state: roots repaired non-recursively, but runs remains UID 1000.
sudo install -d -m 0755 -o 1001 -g 1001 "$report_root" "$results_root"
sudo install -d -m 0755 -o 1000 -g 1000 "$runs_root"
sudo install -d -m 0755 -o 1000 -g 1000 "$results_root/latest"
sudo touch "$results_root/latest/legacy.txt"
sudo chown 1000:1000 "$results_root/latest/legacy.txt"
sudo chown 1001:1001 "$report_root" "$results_root"
if run_as_host bash "$fixture/scripts/run-synthetic-ui.sh" >"$workspace/nonrecursive.log" 2>&1; then
  echo "non-recursive ownership repair unexpectedly passed container preflight" >&2
  exit 1
fi
grep -q 'report storage preflight failed' "$workspace/nonrecursive.log"

# Repairing only report children still leaves Playwright unable to replace legacy results.
sudo chown -R --no-dereference 1001:1001 "$report_root"
if run_as_host bash "$fixture/scripts/run-synthetic-ui.sh" >"$workspace/results-nonrecursive.log" 2>&1; then
  echo "non-recursive results ownership repair unexpectedly allowed the monitor run" >&2
  exit 1
fi
grep -q 'EACCES' "$workspace/results-nonrecursive.log"

# Production repair owns every legacy child, while UID 1000 remains unable to write directly.
sudo chown -R --no-dereference 1001:1001 "$report_root" "$results_root"
if run_as_host test -w "$report_root" || run_as_host test -w "$runs_root"; then
  echo "host UID 1000 unexpectedly has direct write access to the UID 1001 report tree" >&2
  exit 1
fi

for index in 1 2 3 4; do
  snapshot="$runs_root/old-$index"
  sudo install -d -m 0755 -o 1001 -g 1001 "$snapshot"
  sudo touch -d "$((5 - index)) hours ago" "$snapshot"
done
if run_as_host rm -rf -- "$runs_root/old-1" 2>/dev/null; then
  echo "host UID 1000 unexpectedly pruned a UID 1001 snapshot" >&2
  exit 1
fi
test -d "$runs_root/old-1"

run_as_host bash "$fixture/scripts/run-synthetic-ui.sh"
test "$(find "$runs_root" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 3
test ! -e "$runs_root/old-1"
test ! -e "$runs_root/old-2"
test -d "$runs_root/old-3"
test -d "$runs_root/old-4"
test -f "$results_root/latest/result.txt"

# Retention still runs after a failed monitor, but the monitor status wins.
set +e
TEST_MONITOR_EXIT=23 run_as_host bash "$fixture/scripts/run-synthetic-ui.sh"
status=$?
set -e
test "$status" -eq 23
test "$(find "$runs_root" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 3

# A direct-child symlink aborts pruning and cannot affect its external target.
sudo install -d -m 0755 "$workspace/outside"
sudo touch "$workspace/outside/sentinel"
sudo ln -s "$workspace/outside" "$runs_root/unexpected-link"
set +e
run_as_host bash "$fixture/scripts/run-synthetic-ui.sh"
status=$?
set -e
test "$status" -eq 1
test -L "$runs_root/unexpected-link"
test -f "$workspace/outside/sentinel"

echo "UID 1000/1001 report ownership integration passed"
