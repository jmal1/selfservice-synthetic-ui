# selfservice-synthetic-ui

External Playwright synthetic-monitoring suite for the Crucible
self-service portal. Pairs with the internal Go API monitor at
`selfservice-api/cmd/synthetic-api-monitor` — this one covers the
**UI layer** that the Go suite cannot: the SvelteKit bundle, the
WebMKS console iframe, the Caddy reverse-proxy path, and the
Authentik OIDC redirect dance.

## What it tests

| spec                          | purpose                                                              |
|-------------------------------|----------------------------------------------------------------------|
| `auth.spec.ts`                | Full OIDC login through Authentik → land on dashboard                |
| `pods-list.spec.ts`           | Authenticated home page loads, no 500s, lists pods (if any)          |
| `create-and-destroy-pod.spec.ts` | UI creates a synthetic pod, waits for "ready", destroys it.        |
| `03-provisioning-maintenance.spec.ts` | Reads provisioning status and verifies maintenance UI controls without mutations. |
| `workflow-list.spec.ts`       | `/admin/workflows` 403 for non-admins (synthetic is a student role)  |
| `webmks-console.spec.ts`      | WebMKS console iframe opens + WebSocket connects                     |
| `healthz.spec.ts`             | Anonymous `/healthz` returns 200 with `status: ok`                   |
| `zz-logout.spec.ts`           | Sign out terminates the session and does not silently re-auth (runs last) |

Each spec records pass/fail + duration and pushes to the lab
Pushgateway with `layer=ui` so Grafana can compare `layer=api` vs
`layer=ui` failure rates side-by-side.

## Architecture

```
                ┌──────────────────────────────────────┐
                │     Internet (public DNS / Caddy)    │
                └────────────┬─────────────────────────┘
                             │
                             │ https://crucible.jmal.io
                             ▼
   ┌──────────────────────┐      ┌─────────────────────────┐
   │  netbirdv01          │      │  Authentik (lab.jmal.io)│
   │  (Playwright runner) │◄────►│  OIDC server            │
   │  systemd timer @ 60m │      └─────────────────────────┘
   │  pushes metrics ──►──┼───┐
   └──────────────────────┘   │
                              ▼
                  ┌─────────────────────────────┐
                  │ Pushgateway (observability) │
                  │  ─►  Prometheus  ─►  Grafana│
                  └─────────────────────────────┘
```

The runner lives on `netbirdv01` (the existing public-facing VM
hosting NetBird + Caddy) so it goes through the **full public path**
the same way a student does. Running it inside the K8s cluster would
short-circuit Caddy + Authentik and miss the most common failure
modes.

## Setup

### One-time, on netbirdv01 (Docker-based, recommended)

The runner is published as a Docker image so netbirdv01 doesn't need
Node.js, npm, or Chromium installed on the host.

```bash
# Pull the credentials from Vault → /opt/synthetic-ui/secrets/env
sudo mkdir -p /opt/synthetic-ui/{secrets,app,results,report/runs}
sudo chown -R jmal:jmal /opt/synthetic-ui

# Edit /opt/synthetic-ui/secrets/env to set:
#   SYNTHETIC_USERNAME=synthetic@lab.jmal.io
#   SYNTHETIC_PASSWORD=<from vault: secret/synthetics/crucible/password>
#   SYNTHETIC_BASE_URL=https://crucible.jmal.io
#   SYNTHETIC_LIFECYCLE_ENABLED=false
#   SYNTHETIC_EXPECT_MAINTENANCE=false
#   PUSHGATEWAY_URL=http://pushgateway.lab.jmal.io:9091
#   PUSHGATEWAY_JOB=crucible_synthetic_ui
sudo chmod 600 /opt/synthetic-ui/secrets/env

# Clone the deploy files (compose + systemd units only — image carries the rest)
git clone --depth 1 https://github.com/jmal1/selfservice-synthetic-ui.git /opt/synthetic-ui/app

# Contain any prior installation, then install the units without enabling them.
sudo systemctl disable --now synthetic-ui.timer
sudo cp /opt/synthetic-ui/app/deploy/synthetic-ui.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
```

The production wrapper writes each HTML report to
`/opt/synthetic-ui/report/runs/<run-id>` and keeps only the newest three runs,
so failure evidence stays bounded without touching unrelated host files.

Do **not** enable or start `synthetic-ui.timer` as part of this change. A safe
manual run is appropriate only after the coordinated backend and UI
maintenance changes have deployed in this order:

1. Deploy the coordinated `selfservice-api` PR (number pending) and verify the
   authenticated provisioning-status endpoint returns maintenance disabled.
2. Deploy
   [`selfservice-ui#48`](https://github.com/jmal1/selfservice-ui/pull/48) and
   verify its banner and provisioning-control gates.
3. Deploy this synthetic image with
   `SYNTHETIC_LIFECYCLE_ENABLED=false` and
   `SYNTHETIC_EXPECT_MAINTENANCE=false`, then run the service manually.
4. Re-enabling the production timer or provisioning is a separate,
   explicitly approved operation and is not part of this PR.

### Local development (Node-based)

For debugging tests interactively you do need Node + Playwright:

```bash
npm ci
npx playwright install chromium

cat > .env <<'EOF'
SYNTHETIC_USERNAME=synthetic@lab.jmal.io
SYNTHETIC_PASSWORD=<from-vault>
SYNTHETIC_BASE_URL=https://crucible.jmal.io
SYNTHETIC_LIFECYCLE_ENABLED=true
SYNTHETIC_EXPECT_MAINTENANCE=false
SYNTHETIC_TEMPLATE_NAME=synthetic-noop
PUSHGATEWAY_URL=skip
EOF

npm test                  # run the suite once (no push since URL=skip)
npm run test:ui-mode      # debug interactively
npm run test:headed       # see the browser
```

### Digest-pinned updates

Each publishing workflow run (`master` push or manual dispatch) uploads an
`image-digest-synthetic-ui` artifact containing
`image-digest-synthetic-ui.tsv`. It has no header and exactly one tab-separated
record with the stable schema `component`, `repository`, `digest`, `source_sha`:

```text
synthetic-ui	ghcr.io/jmal1/selfservice-synthetic-ui	sha256:<64 lowercase hex>	<40-character source SHA>
```

`/opt/synthetic-ui/app` is an installed-file directory, not a Git checkout.
Stage the two deployment files from a clean, exact-SHA checkout on the Windows
admin machine. The following PowerShell also reads the downloaded artifact and
prints the values needed for host verification:

```powershell
$SourceSha = '<full-SHA-of-approved-workflow-run>'
$Work = Join-Path $env:TEMP "synthetic-ui-$SourceSha"
git clone --no-checkout https://github.com/jmal1/selfservice-synthetic-ui.git $Work
git -C $Work fetch --no-tags origin $SourceSha
git -C $Work checkout --detach $SourceSha
if ((git -C $Work rev-parse HEAD) -ne $SourceSha) { throw 'source SHA mismatch' }
if (git -C $Work status --porcelain) { throw 'operator checkout is not clean' }

$Lines = @(Get-Content .\image-digest-synthetic-ui.tsv)
if ($Lines.Count -ne 1) { throw 'manifest must contain exactly one record' }
$Fields = $Lines[0] -split "`t"
if ($Fields.Count -ne 4 -or $Fields[0] -ne 'synthetic-ui' -or
    $Fields[1] -ne 'ghcr.io/jmal1/selfservice-synthetic-ui' -or
    $Fields[3] -ne $SourceSha) { throw 'manifest fields do not match the approved run' }
if ($Fields[2] -notmatch '^sha256:[0-9a-f]{64}$') { throw 'invalid image digest' }

# The CI workflow publishes the exact
# `ghcr.io/jmal1/selfservice-synthetic-ui:$SourceSha` tag alongside the digest,
# and the deploy contract uses that full SHA reference.

$Compose = Join-Path $Work 'deploy\docker-compose.yml'
$Service = Join-Path $Work 'deploy\synthetic-ui.service'
$ComposeHash = (Get-FileHash -Algorithm SHA256 $Compose).Hash.ToLower()
$ServiceHash = (Get-FileHash -Algorithm SHA256 $Service).Hash.ToLower()
$Image = "$($Fields[1])@$($Fields[2])"
$ComposeStage = "/tmp/docker-compose.$SourceSha.yml"
$ServiceStage = "/tmp/synthetic-ui.$SourceSha.service"

# Use the approved Vault-issued SSH credential/config for this target.
scp $Compose "jmal@192.168.68.95:$ComposeStage"
scp $Service "jmal@192.168.68.95:$ServiceStage"
"SOURCE_SHA=$SourceSha"
"IMAGE=$Image"
"COMPOSE_SHA256=$ComposeHash"
"SERVICE_SHA256=$ServiceHash"
```

Connect to `jmal@192.168.68.95` with the same Vault-backed SSH access. Paste
the four printed values, then perform the atomic host install. This
idempotently disables the synthetic timer so it cannot race the file
replacement, waits for any active oneshot run to finish, and does not restart
NetBird or Caddy:

```bash
set -euo pipefail

validate_runtime() {
  local actual_sha expected_sha
  actual_sha="$(sudo sha256sum "$1" | awk '{print $1}')"
  expected_sha="$(printf \
    'SYNTHETIC_LIFECYCLE_ENABLED=%s\nSYNTHETIC_EXPECT_MAINTENANCE=false\n' "$2" |
    sha256sum | awk '{print $1}')"
  test "$actual_sha" = "$expected_sha"
}

SOURCE_SHA='<printed full source SHA>'
IMAGE='ghcr.io/jmal1/selfservice-synthetic-ui:<printed full source SHA>'
PREVIOUS_IMAGE='ghcr.io/jmal1/selfservice-synthetic-ui:<operator-supplied current full source SHA>'
COMPOSE_SHA256='<printed lowercase hash>'
SERVICE_SHA256='<printed lowercase hash>'
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$IMAGE" =~ ^ghcr\.io/jmal1/selfservice-synthetic-ui:[0-9a-f]{40}$ ]]
[[ "$PREVIOUS_IMAGE" =~ ^ghcr\.io/jmal1/selfservice-synthetic-ui:[0-9a-f]{40}$ ]]
[[ "$COMPOSE_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$SERVICE_SHA256" =~ ^[0-9a-f]{64}$ ]]
COMPOSE_STAGE="/tmp/docker-compose.$SOURCE_SHA.yml"
SERVICE_STAGE="/tmp/synthetic-ui.$SOURCE_SHA.service"
test -f "$COMPOSE_STAGE"
test -f "$SERVICE_STAGE"

PREVIOUS_IMAGE_ID="$(sudo docker image inspect \
  "$PREVIOUS_IMAGE" --format '{{.Id}}')"
if sudo test -f /opt/synthetic-ui/image.env; then
INSTALL_MODE=pinned
sudo test -f /opt/synthetic-ui/runtime.env
validate_runtime /opt/synthetic-ui/runtime.env false
CURRENT_IMAGE="$(sudo sed -n \
  's/^SYNTHETIC_UI_IMAGE=//p' /opt/synthetic-ui/image.env)"
[[ "$CURRENT_IMAGE" =~ ^ghcr\.io/jmal1/selfservice-synthetic-ui:[0-9a-f]{40}$ ]]
test "$PREVIOUS_IMAGE" = "$CURRENT_IMAGE"
CURRENT_RESOLVED_IMAGE="$(sudo sh -c \
  'set -a; . /opt/synthetic-ui/image.env; exec docker compose \
  -f /opt/synthetic-ui/app/deploy/docker-compose.yml config --images')"
test "$CURRENT_RESOLVED_IMAGE" = "$PREVIOUS_IMAGE"
CURRENT_IMAGE_ID="$(sudo docker image inspect \
  "$CURRENT_RESOLVED_IMAGE" --format '{{.Id}}')"
test "$CURRENT_IMAGE_ID" = "$PREVIOUS_IMAGE_ID"
else
INSTALL_MODE=first-migration
if sudo test -f /opt/synthetic-ui/runtime.env; then
  validate_runtime /opt/synthetic-ui/runtime.env false
fi
fi

sudo systemctl disable --now synthetic-ui.timer
STATE="$(systemctl show synthetic-ui.service -p ActiveState --value)"
while [ "$STATE" != inactive ] && [ "$STATE" != failed ]; do
  sleep 5
  STATE="$(systemctl show synthetic-ui.service -p ActiveState --value)"
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/opt/synthetic-ui/backups/$STAMP"
sudo install -d -m 0755 "$BACKUP"
sudo cp -a /opt/synthetic-ui/app/deploy/docker-compose.yml "$BACKUP/"
sudo cp -a /etc/systemd/system/synthetic-ui.service "$BACKUP/"
printf '%s\n' "$INSTALL_MODE" | sudo tee "$BACKUP/install-mode" >/dev/null
if sudo test -f /opt/synthetic-ui/image.env; then
  sudo cp -a /opt/synthetic-ui/image.env "$BACKUP/image.env"
else
  # Synthesize the proven immutable prior pin for first-migration rollback.
  printf 'SYNTHETIC_UI_IMAGE=%s\n' "$PREVIOUS_IMAGE" |
    sudo tee "$BACKUP/image.env" >/dev/null
  sudo chmod 0644 "$BACKUP/image.env"
fi
if sudo test -f /opt/synthetic-ui/source.sha; then
  sudo cp -a /opt/synthetic-ui/source.sha "$BACKUP/source.sha"
fi
if sudo test -f /opt/synthetic-ui/runtime.env; then
  sudo cp -a /opt/synthetic-ui/runtime.env "$BACKUP/runtime.env"
else
  printf 'SYNTHETIC_LIFECYCLE_ENABLED=false\nSYNTHETIC_EXPECT_MAINTENANCE=false\n' |
    sudo tee "$BACKUP/runtime.env" >/dev/null
  sudo chmod 0644 "$BACKUP/runtime.env"
fi
printf '%s\n' "$PREVIOUS_IMAGE_ID" |
  sudo tee "$BACKUP/previous-image-id" >/dev/null

printf '%s  %s\n' "$COMPOSE_SHA256" "$COMPOSE_STAGE" | sha256sum -c -
printf '%s  %s\n' "$SERVICE_SHA256" "$SERVICE_STAGE" | sha256sum -c -
sudo install -m 0644 "$COMPOSE_STAGE" \
  /opt/synthetic-ui/app/deploy/docker-compose.yml.new
sudo mv /opt/synthetic-ui/app/deploy/docker-compose.yml.new \
  /opt/synthetic-ui/app/deploy/docker-compose.yml
sudo install -m 0644 "$SERVICE_STAGE" \
  /etc/systemd/system/synthetic-ui.service.new
sudo mv /etc/systemd/system/synthetic-ui.service.new \
  /etc/systemd/system/synthetic-ui.service
printf 'SYNTHETIC_UI_IMAGE=%s\n' "$IMAGE" |
  sudo tee /opt/synthetic-ui/image.env.new >/dev/null
sudo chmod 0644 /opt/synthetic-ui/image.env.new
sudo mv /opt/synthetic-ui/image.env.new /opt/synthetic-ui/image.env
printf 'SYNTHETIC_LIFECYCLE_ENABLED=false\nSYNTHETIC_EXPECT_MAINTENANCE=false\n' |
  sudo tee /opt/synthetic-ui/runtime.env.new >/dev/null
sudo chmod 0644 /opt/synthetic-ui/runtime.env.new
sudo mv /opt/synthetic-ui/runtime.env.new /opt/synthetic-ui/runtime.env
printf '%s\n' "$SOURCE_SHA" |
  sudo tee /opt/synthetic-ui/source.sha >/dev/null
sudo systemctl daemon-reload

RESOLVED_IMAGE="$(sudo sh -c 'set -a; . /opt/synthetic-ui/image.env; \
  exec docker compose -f /opt/synthetic-ui/app/deploy/docker-compose.yml \
  config --images')"
test "$RESOLVED_IMAGE" = "$IMAGE"
validate_runtime /opt/synthetic-ui/runtime.env false
sudo systemctl start synthetic-ui.service
SERVICE_RESULT="$(systemctl show synthetic-ui.service -p Result --value)"
SERVICE_STATUS="$(systemctl show synthetic-ui.service -p ExecMainStatus --value)"
test "$SERVICE_RESULT" = success
test "$SERVICE_STATUS" = 0
validate_runtime /opt/synthetic-ui/runtime.env false
sudo journalctl -u synthetic-ui.service -n 100 --no-pager

TIMER_UNIT_STATE="$(systemctl show synthetic-ui.timer -p UnitFileState --value)"
TIMER_ACTIVE_STATE="$(systemctl show synthetic-ui.timer -p ActiveState --value)"
test "$TIMER_UNIT_STATE" = disabled
test "$TIMER_ACTIVE_STATE" = inactive
sudo systemctl list-timers synthetic-ui.timer --no-pager
sudo rm -f "$COMPOSE_STAGE" "$SERVICE_STAGE"
```

Compose still reads `/opt/synthetic-ui/secrets/env`; the image pin contains no
credential. The mandatory `EnvironmentFile` makes scheduled runs fail closed
rather than accept a mutable tag or an empty pin.

Rollback reads the backup's recorded install mode. A first-migration backup is
**image-only** because its old Compose and unit used an unpinned image
reference; a pinned-upgrade backup restores only after verifying its immutable
Compose, unit, pin, and source identity. Both modes prove the exact resolved
image, run one validation, and keep the timer disabled:

```bash
set -euo pipefail

validate_runtime() {
  local actual_sha expected_sha
  actual_sha="$(sudo sha256sum "$1" | awk '{print $1}')"
  expected_sha="$(printf \
    'SYNTHETIC_LIFECYCLE_ENABLED=%s\nSYNTHETIC_EXPECT_MAINTENANCE=false\n' "$2" |
    sha256sum | awk '{print $1}')"
  test "$actual_sha" = "$expected_sha"
}

BACKUP='/opt/synthetic-ui/backups/<approved-timestamp>'
sudo systemctl disable --now synthetic-ui.timer
STATE="$(systemctl show synthetic-ui.service -p ActiveState --value)"
while [ "$STATE" != inactive ] && [ "$STATE" != failed ]; do
  sleep 5
  STATE="$(systemctl show synthetic-ui.service -p ActiveState --value)"
done

sudo test -f "$BACKUP/image.env"
sudo test -f "$BACKUP/runtime.env"
validate_runtime "$BACKUP/runtime.env" false
sudo test -f "$BACKUP/install-mode"
INSTALL_MODE="$(sudo cat "$BACKUP/install-mode")"
ROLLBACK_IMAGE="$(sudo sed -n 's/^SYNTHETIC_UI_IMAGE=//p' "$BACKUP/image.env")"
[[ "$ROLLBACK_IMAGE" =~ ^ghcr\.io/jmal1/selfservice-synthetic-ui:[0-9a-f]{40}$ ]]

if [ "$INSTALL_MODE" = first-migration ]; then
  # Retain the newly installed immutable files; restore only the prior pin.
  sudo grep -F 'SYNTHETIC_UI_IMAGE' \
    /opt/synthetic-ui/app/deploy/docker-compose.yml
  sudo grep -F 'EnvironmentFile=/opt/synthetic-ui/image.env' \
    /etc/systemd/system/synthetic-ui.service
elif [ "$INSTALL_MODE" = pinned ]; then
  sudo test -f "$BACKUP/source.sha"
  ROLLBACK_SOURCE_SHA="$(sudo cat "$BACKUP/source.sha")"
  [[ "$ROLLBACK_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
  sudo grep -F 'SYNTHETIC_UI_IMAGE' "$BACKUP/docker-compose.yml"
  sudo grep -F 'EnvironmentFile=/opt/synthetic-ui/image.env' \
    "$BACKUP/synthetic-ui.service"
  sudo install -m 0644 "$BACKUP/docker-compose.yml" \
    /opt/synthetic-ui/app/deploy/docker-compose.yml.new
  sudo mv /opt/synthetic-ui/app/deploy/docker-compose.yml.new \
    /opt/synthetic-ui/app/deploy/docker-compose.yml
  sudo install -m 0644 "$BACKUP/synthetic-ui.service" \
    /etc/systemd/system/synthetic-ui.service.new
  sudo mv /etc/systemd/system/synthetic-ui.service.new \
    /etc/systemd/system/synthetic-ui.service
  printf '%s\n' "$ROLLBACK_SOURCE_SHA" |
    sudo tee /opt/synthetic-ui/source.sha.new >/dev/null
  sudo mv /opt/synthetic-ui/source.sha.new /opt/synthetic-ui/source.sha
else
  echo "Unsupported backup install mode: $INSTALL_MODE" >&2
  exit 1
fi

sudo install -m 0644 "$BACKUP/image.env" /opt/synthetic-ui/image.env.new
sudo mv /opt/synthetic-ui/image.env.new /opt/synthetic-ui/image.env
sudo install -m 0644 "$BACKUP/runtime.env" /opt/synthetic-ui/runtime.env.new
sudo mv /opt/synthetic-ui/runtime.env.new /opt/synthetic-ui/runtime.env
sudo systemctl daemon-reload
RESOLVED_IMAGE="$(sudo sh -c 'set -a; . /opt/synthetic-ui/image.env; \
  exec docker compose -f /opt/synthetic-ui/app/deploy/docker-compose.yml \
  config --images')"
test "$RESOLVED_IMAGE" = "$ROLLBACK_IMAGE"
validate_runtime /opt/synthetic-ui/runtime.env false
sudo systemctl start synthetic-ui.service
SERVICE_RESULT="$(systemctl show synthetic-ui.service -p Result --value)"
SERVICE_STATUS="$(systemctl show synthetic-ui.service -p ExecMainStatus --value)"
test "$SERVICE_RESULT" = success
test "$SERVICE_STATUS" = 0
validate_runtime /opt/synthetic-ui/runtime.env false
TIMER_UNIT_STATE="$(systemctl show synthetic-ui.timer -p UnitFileState --value)"
TIMER_ACTIVE_STATE="$(systemctl show synthetic-ui.timer -p ActiveState --value)"
test "$TIMER_UNIT_STATE" = disabled
test "$TIMER_ACTIVE_STATE" = inactive
```

### Explicit timer re-enable after containment

Do not bundle timer re-enable with image install or rollback. It is a separate
operator-approved action only after the non-mutating pinned UI one-shot is
green and monitoring confirms the ESXi1 NFS41 stale-handle rate is `0` and APD
count is `0`. The recovery runs one lifecycle-enabled one-shot while the timer
remains disabled, checks storage again, and enables the timer only if all gates
remain green. Any failure atomically restores lifecycle containment to `false`.

```bash
set -euo pipefail

validate_runtime() {
  local actual_sha expected_sha
  actual_sha="$(sudo sha256sum "$1" | awk '{print $1}')"
  expected_sha="$(printf \
    'SYNTHETIC_LIFECYCLE_ENABLED=%s\nSYNTHETIC_EXPECT_MAINTENANCE=false\n' "$2" |
    sha256sum | awk '{print $1}')"
  test "$actual_sha" = "$expected_sha"
}

STORAGE_STALE_HANDLE_RATE='<verified monitoring value>'
APD_COUNT='<verified monitoring value>'
UI_CHECKS='<verified pinned one-shot result>'
OPERATOR_APPROVAL='<approved change/ticket reference>'
test "$STORAGE_STALE_HANDLE_RATE" = 0
test "$APD_COUNT" = 0
test "$UI_CHECKS" = green
test -n "$OPERATOR_APPROVAL"
test "$OPERATOR_APPROVAL" != '<approved change/ticket reference>'

set_lifecycle() {
  if ! printf \
    'SYNTHETIC_LIFECYCLE_ENABLED=%s\nSYNTHETIC_EXPECT_MAINTENANCE=false\n' "$1" |
    sudo tee /opt/synthetic-ui/runtime.env.new >/dev/null; then
    return 1
  fi
  if ! sudo chmod 0644 /opt/synthetic-ui/runtime.env.new; then
    return 1
  fi
  sudo mv /opt/synthetic-ui/runtime.env.new /opt/synthetic-ui/runtime.env
}

restore_containment() {
  local cleanup_failed=0
  if ! sudo systemctl disable --now synthetic-ui.timer; then
    echo 'Failed to disable synthetic-ui.timer during cleanup' >&2
    cleanup_failed=1
  fi
  if ! set_lifecycle false; then
    echo 'Failed to restore lifecycle=false during cleanup' >&2
    cleanup_failed=1
  fi
  if [ "$cleanup_failed" -ne 0 ]; then
    echo 'MANUAL INTERVENTION REQUIRED: verify timer and runtime containment' >&2
    return 1
  fi
}

test "$(systemctl show synthetic-ui.timer -p UnitFileState --value)" = disabled
test "$(systemctl show synthetic-ui.timer -p ActiveState --value)" = inactive
validate_runtime /opt/synthetic-ui/runtime.env false
SERVICE_RESULT="$(systemctl show synthetic-ui.service -p Result --value)"
SERVICE_STATUS="$(systemctl show synthetic-ui.service -p ExecMainStatus --value)"
test "$SERVICE_RESULT" = success
test "$SERVICE_STATUS" = 0
trap restore_containment ERR
set_lifecycle true
validate_runtime /opt/synthetic-ui/runtime.env true
sudo systemctl start synthetic-ui.service
SERVICE_RESULT="$(systemctl show synthetic-ui.service -p Result --value)"
SERVICE_STATUS="$(systemctl show synthetic-ui.service -p ExecMainStatus --value)"
test "$SERVICE_RESULT" = success
test "$SERVICE_STATUS" = 0

POST_LIFECYCLE_STORAGE_STALE_HANDLE_RATE='<fresh verified monitoring value>'
POST_LIFECYCLE_APD_COUNT='<fresh verified monitoring value>'
test "$POST_LIFECYCLE_STORAGE_STALE_HANDLE_RATE" = 0
test "$POST_LIFECYCLE_APD_COUNT" = 0
sudo systemctl enable --now synthetic-ui.timer
test "$(systemctl show synthetic-ui.timer -p UnitFileState --value)" = enabled
test "$(systemctl show synthetic-ui.timer -p ActiveState --value)" = active
trap - ERR
sudo systemctl list-timers synthetic-ui.timer --no-pager
```

## Metrics

Each completed, non-skipped test emits four series to Pushgateway:

| metric                                          | value           |
|-------------------------------------------------|-----------------|
| `crucible_synthetic_ui_check_success{check=X}`  | 0 or 1          |
| `crucible_synthetic_ui_check_duration_seconds{check=X}` | seconds  |
| `crucible_synthetic_ui_check_last_run_timestamp`| unix epoch (s)  |
| `crucible_synthetic_ui_check_info` | title, description, severity, and runbook labels |
| `crucible_synthetic_ui_overall_check_count` | completed, non-skipped checks |
| `crucible_synthetic_ui_overall_expected_check_count` | checks expected for this configuration |
| `crucible_synthetic_ui_overall_coverage_ratio` | completed / expected checks |

Pushgateway updates use `PUT` to replace the complete
`job=crucible_synthetic_ui,layer=ui` group. A lifecycle-disabled run therefore
removes the prior `create_and_destroy_synthetic_pod` series instead of leaving
it stale or reporting it as passed. Unexpected skips reduce coverage and force
`overall_success` to `0`. Intentionally filtered or targeted Playwright runs
never publish, because a partial `PUT` would erase unselected checks from the
production group. An unfiltered production run that discovers fewer checks
than its canonical configuration still replaces the group with reduced
coverage and `overall_success=0`, so stale green metrics cannot survive.

### Provisioning lifecycle gate

`SYNTHETIC_LIFECYCLE_ENABLED` accepts only `true` or `false`; invalid and empty
values fail suite configuration. It defaults to `true` for backward
compatibility in local/generic environments. The production compose and
systemd examples pin it to `false`. When enabled, `SYNTHETIC_TEMPLATE_NAME`
is required at startup; the suite refuses to run rather than silently skip its
destructive coverage.

`SYNTHETIC_EXPECT_MAINTENANCE` also accepts only `true` or `false` and defaults
to `false`. When true, the non-destructive maintenance contract check is
enabled and requires lifecycle checks to be disabled. It asserts the exact
authenticated API response:

```json
{"enabled":false,"message":"Provisioning is temporarily unavailable for maintenance."}
```

With instructor credentials and `SYNTHETIC_TEMPLATE_NAME` configured, the
current expected check counts are:

| lifecycle | expected maintenance | expected checks |
|-----------|----------------------|-----------------|
| `true`    | `false`              | 19              |
| `false`   | `false`              | 18              |
| `false`   | `true`               | 19              |

The `true`/`true` combination is rejected. If the optional instructor identity
is absent, its four statically skipped checks are excluded from the dynamic
expected count while `admin_identity_configured` remains and fails visibly.

The maintenance check never creates a fixture. If an existing,
cleanup-eligible pod is available, it verifies that Add VM is gated while
Delete Pod remains enabled. If none exists, the result is annotated with that
limitation; the status API, banner, dashboard, and shared provisioning route
are still checked without weakening their assertions.

Grafana alert (paired with the Go suite's `layer=api`):

```
expr: max_over_time(crucible_synthetic_ui_check_success[30m]) == 0
for:  30m
labels:
  severity: page
  title: "Crucible UI synthetic check failing"
```

## Why a separate repo (not part of selfservice-ui)

- **Deploys to netbirdv01, not K8s.** Different runtime, different
  release cadence.
- **Different language / different tooling.** Playwright lives best
  in a TS project with its own `package.json` and `node_modules`.
- **Different secrets.** The synthetic test account credentials must
  never end up in the customer-facing UI bundle.
- **Independent rollback.** A broken synthetic spec must not block a
  UI release.

## Operator runbook

### "The UI synthetic alert is firing but the API one isn't"

This means the API is healthy but the customer-facing path is broken.
Most likely:
1. **Caddy** — check `journalctl -u caddy -n 100 --no-pager` on
   netbirdv01. Look for TLS errors, upstream 5xx.
2. **Authentik** — check `https://auth.lab.jmal.io/-/health/live/`.
3. **UI bundle** — check `kubectl get pod -n selfservice -l app=selfservice-ui`.
4. The synthetic suite saves screenshots on failure to
   `/opt/synthetic-ui/app/test-results/`. SSH in and inspect the
   newest report run under `/opt/synthetic-ui/report/runs/`.

### "How do I add a new check"

1. Create `tests/specs/<name>.spec.ts` modeled on an existing spec.
2. Use the `withMetric` fixture from `tests/fixtures.ts` so it
   automatically pushes the duration/success metrics on completion.
3. Merge to `master`, then use the approved full-SHA-tag deployment procedure
   above. netbirdv01 does not contain a Git checkout or auto-update from Git.
4. Add a Grafana panel for the new metric if it warrants its own
   widget (otherwise it rolls up into the default sum dashboard).

## 🔗 Related

- [[Synthetic-Monitoring]] — Architecture, runbook, on-call triage
- [[Crucible-Resume-Plan-2026-06-07]] — Overnight log; S3 lives here
