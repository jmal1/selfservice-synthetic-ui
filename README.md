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
sudo mkdir -p /opt/synthetic-ui/{secrets,app,results,report}
sudo chown -R jmal:jmal /opt/synthetic-ui

# Edit /opt/synthetic-ui/secrets/env to set:
#   SYNTHETIC_USERNAME=synthetic@lab.jmal.io
#   SYNTHETIC_PASSWORD=<from vault: secret/synthetics/crucible/password>
#   SYNTHETIC_BASE_URL=https://crucible.jmal.io
#   SYNTHETIC_LIFECYCLE_ENABLED=false
#   SYNTHETIC_EXPECT_MAINTENANCE=true
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
   `SYNTHETIC_EXPECT_MAINTENANCE=true`, then run the service manually.
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
PUSHGATEWAY_URL=skip
EOF

npm test                  # run the suite once (no push since URL=skip)
npm run test:ui-mode      # debug interactively
npm run test:headed       # see the browser
```

### Updates

The systemd service runs `docker compose pull --quiet` on every invocation.
When the timer is explicitly enabled in the future, a new image build will be
picked up on the next run. To pull manually:

```bash
sudo docker compose -f /opt/synthetic-ui/app/deploy/docker-compose.yml pull
sudo systemctl start synthetic-ui.service  # run immediately
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
`overall_success` to `0`. Filtered or targeted Playwright runs never publish,
because a partial `PUT` would erase unselected checks from the production
group.

### Provisioning lifecycle gate

`SYNTHETIC_LIFECYCLE_ENABLED` accepts only `true` or `false`; invalid and empty
values fail suite configuration. It defaults to `true` for backward
compatibility in local/generic environments. The production compose and
systemd examples pin it to `false`.

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
   most recent run.

### "How do I add a new check"

1. Create `tests/specs/<name>.spec.ts` modeled on an existing spec.
2. Use the `withMetric` fixture from `tests/fixtures.ts` so it
   automatically pushes the duration/success metrics on completion.
3. Push to `main` — netbirdv01's git timer (or a manual `git pull`
   on next run) will pick it up within an hour.
4. Add a Grafana panel for the new metric if it warrants its own
   widget (otherwise it rolls up into the default sum dashboard).

## 🔗 Related

- [[Synthetic-Monitoring]] — Architecture, runbook, on-call triage
- [[Crucible-Resume-Plan-2026-06-07]] — Overnight log; S3 lives here
