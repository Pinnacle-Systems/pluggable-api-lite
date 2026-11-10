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

# PM2 manages the Node app. A separate PM2 systemd startup service
# (configured once via "pm2 startup") restores saved processes after reboot.
if ! command -v pm2 >/dev/null; then
  echo "PM2 is required for the CloudPanel site user." >&2
  exit 1
fi

export NODE_ENV=production
if pm2 describe pluggable-api-lite >/dev/null 2>&1; then
  pm2 restart pluggable-api-lite --update-env
else
  pm2 start src/server.js --name pluggable-api-lite --node-args="--env-file=.env"
fi
pm2 save

healthy=false
for attempt in {1..15}; do
  if curl -fsS --max-time 3 "http://127.0.0.1:$APP_PORT/health" 2>/dev/null | grep -q '"status":"ok"'; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" != true ]]; then
  echo "Deployment health check failed. Check pm2 logs pluggable-api-lite." >&2
  exit 1
fi

echo "Application updated in-place and /health verified"
