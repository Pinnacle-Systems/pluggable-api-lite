#!/usr/bin/env bash
# Runs as the CloudPanel site user after GitHub Actions overwrites htdocs.
set -euo pipefail

: "${APP_DIR:?APP_DIR is required}"
APP_PORT="${APP_PORT:-9765}"
cd "$APP_DIR"

if [[ ! -s .env ]]; then
  echo "Missing $APP_DIR/.env. Create it on the VPS before deploying." >&2
  exit 1
fi

# CloudPanel often uses nvm for Node versions; use it for installation.
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null
fi

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo "Node.js 24 must be available to the CloudPanel site user." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null; then
  echo "pnpm must be installed for the CloudPanel site user." >&2
  exit 1
fi

pnpm install --prod --frozen-lockfile

# systemd keeps the application running and restores it after server reboot.
# Site user needs sudoers permission for this single restart command only.
sudo -n /usr/bin/systemctl restart pluggable-api-lite.service

healthy=false
for attempt in {1..15}; do
  if curl -fsS --max-time 3 "http://127.0.0.1:$APP_PORT/health" 2>/dev/null | grep -q '"status":"ok"'; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" != true ]]; then
  echo "Deployment health check failed. Check journalctl -u pluggable-api-lite.service." >&2
  exit 1
fi

echo "Application updated in-place and /health verified"
