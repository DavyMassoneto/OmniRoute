#!/usr/bin/env node

/**
 * Docker healthcheck script for OmniRoute.
 * Checks the /api/monitoring/health endpoint (public, no auth required).
 * Used by Dockerfile and docker-compose files.
 */
const port = process.env.DASHBOARD_PORT || process.env.PORT || "20128";

fetch(`http://127.0.0.1:${port}/api/monitoring/health`)
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(`[healthcheck] FAIL: ${err.message || err}\n`);
    process.exit(1);
  });
