# Crucible synthetic UI monitor — Playwright in a container.
#
# Uses the official Playwright image which has Chromium + all the
# system libs preinstalled. The image is ~1.8 GB; pulled once and
# cached on netbirdv01.
#
# Build:    docker build -t ghcr.io/jmal1/selfservice-synthetic-ui:latest .
# Run:      docker run --rm --env-file /opt/synthetic-ui/secrets/env \
#               ghcr.io/jmal1/selfservice-synthetic-ui:latest
FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=optional

COPY tsconfig.json playwright.config.ts ./
COPY tests/ ./tests/

# Create the .auth state dir and writable test-results / report dirs,
# then hand /app over to pwuser so it can write during runs.
RUN mkdir -p /app/.auth /app/test-results /app/playwright-report \
    && chown -R pwuser:pwuser /app

# Playwright stores its browser cache in /ms-playwright by default in
# this base image; the browsers are already installed there.

# Run as the non-root pwuser baked into the official image.
USER pwuser

# The test report is small; keep it for grafana-side correlation.
VOLUME ["/app/test-results", "/app/playwright-report"]

ENTRYPOINT ["npm", "test", "--silent"]
