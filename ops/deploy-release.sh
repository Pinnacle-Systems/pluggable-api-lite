#!/usr/bin/env bash
# Runs as the CloudPanel site user. Called over SSH by GitHub Actions.
set -euo pipefail

: "${APP_ROOT:?APP_ROOT is required}"
: "${RELEASE:?RELEASE is required}"

release_dir="$APP_ROOT/releases/$RELEASE"
cd "$release_dir"

if [[ ! -s "$APP_ROOT/shared/.env" ]]; then
  echo "Missing $APP_ROOT/shared/.env. Create it on the VPS before deploying." >&2
  exit 1
fi

# CloudPanel uses nvm for Node versions. Non-interactive SSH may not source it.
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null
fi

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  echo "Node.js 24 must be available to the deployment site user." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null; then
  echo "pnpm 11.13.0 must be installed for the deployment site user." >&2
  exit 1
fi

# Keep secrets outside the versioned release.
ln -sfn "$APP_ROOT/shared/.env" "$release_dir/.env"
pnpm install --prod --frozen-lockfile

previous="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
ln -sfn "$release_dir" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"

rollback() {
  echo "Deployment failed; attempting to restore the previous release." >&2
  if [[ -n "$previous" && -d "$previous" ]]; then
    ln -sfn "$previous" "$APP_ROOT/current.rollback"
    mv -Tf "$APP_ROOT/current.rollback" "$APP_ROOT/current"
    sudo -n /usr/bin/systemctl restart pluggable-api-lite.service || true
  fi
}

if ! sudo -n /usr/bin/systemctl restart pluggable-api-lite.service; then
  rollback
  exit 1
fi

healthy=false
for attempt in {1..15}; do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/health 2>/dev/null | grep -q '"status":"ok"'; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" != true ]]; then
  rollback
  exit 1
fi

echo "Deployed $RELEASE and verified /health"
