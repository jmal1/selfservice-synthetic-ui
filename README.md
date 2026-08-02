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
#   PUSHGATEWAY_URL=http://pushgateway.lab.jmal.io:9091
#   PUSHGATEWAY_JOB=crucible_synthetic_ui
sudo chmod 600 /opt/synthetic-ui/secrets/env

# Clone the deploy files (compose + systemd units only — image carries the rest)
git clone --depth 1 https://github.com/jmal1/selfservice-synthetic-ui.git /opt/synthetic-ui/app

# Install systemd timer
sudo cp /opt/synthetic-ui/app/deploy/synthetic-ui.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now synthetic-ui.timer

# First run (manual) — this also pulls the image (~1.8 GB once)
sudo systemctl start synthetic-ui.service
journalctl -u synthetic-ui -n 100 --no-pager
```

### Local development (Node-based)

For debugging tests interactively you do need Node + Playwright:

```bash
npm ci
npx playwright install chromium

cat > .env.local <<'EOF'
SYNTHETIC_USERNAME=synthetic@lab.jmal.io
SYNTHETIC_PASSWORD=<from-vault>
SYNTHETIC_BASE_URL=https://crucible.jmal.io
PUSHGATEWAY_URL=skip
EOF

npm test                  # run the suite once (no push since URL=skip)
npm run test:ui-mode      # debug interactively
npm run test:headed       # see the browser
```

### Updates

The systemd unit runs `docker compose pull --quiet` on every invocation,
so a new image build automatically picks up on the next hour. To pull
manually:

```bash
sudo docker compose -f /opt/synthetic-ui/app/deploy/docker-compose.yml pull
sudo systemctl start synthetic-ui.service  # run immediately
```

## Metrics

Each test emits 3 series to Pushgateway:

| metric                                          | value           |
|-------------------------------------------------|-----------------|
| `crucible_synthetic_ui_check_success{check=X}`  | 0 or 1          |
| `crucible_synthetic_ui_check_duration_seconds{check=X}` | seconds  |
| `crucible_synthetic_ui_check_last_run_timestamp`| unix epoch (s)  |

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
