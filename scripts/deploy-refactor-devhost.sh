#!/usr/bin/env bash
# Redeploy the pwa-port-refactor VS Code Web dev-host at
# https://vs-ext-test.sophtwhere.com (PM2 pptx-dev-server-refactor, :3002).
#
# Pushes the committed tip of pwa-port-refactor from THIS machine into the VPS's
# isolated bare repo over SSH (the engine never touches GitHub), then on the box:
# pull -> npm run bundle -> pm2 restart -> wait for :3002 -> verify HTTPS.
#
# The LIVE main instance (vscode.sophtwhere.com, :3001) is never touched.
#
# Usage:  scripts/deploy-refactor-devhost.sh
set -euo pipefail

BRANCH="pwa-port-refactor"
SERVER="jonathan@vscode.sophtwhere.com"
BARE="pptx-viewer-ext-refactor.git"          # ~/ on the server
WORKTREE="/home/jonathan/pptx-viewer-ext-refactor"
PM2_APP="pptx-dev-server-refactor"
URL="https://vs-ext-test.sophtwhere.com/"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

cur="$(git rev-parse --abbrev-ref HEAD)"
if [ "$cur" != "$BRANCH" ]; then
  echo "!! on branch '$cur', expected '$BRANCH' — checkout $BRANCH first." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "!! working tree has uncommitted changes — only COMMITTED work is deployed." >&2
  echo "   commit (or stash) first, then re-run. Continuing with HEAD = $(git rev-parse --short HEAD)..."
fi

echo "==> push $BRANCH -> VPS bare repo (over SSH, not GitHub)"
git push "$SERVER:$BARE" "$BRANCH"

echo "==> server: pull, bundle, restart, verify"
ssh -o BatchMode=yes "$SERVER" "
  set -e
  cd $WORKTREE
  git pull --ff-only origin $BRANCH
  npm run bundle
  pm2 restart $PM2_APP --update-env
  # wait for the dev-host to rebind :3002 (VS Code already cached, so quick)
  for i in \$(seq 1 30); do
    ss -ltn 2>/dev/null | grep -q ':3002' && { echo 'listening'; break; }
    sleep 2
  done
  curl -s -o /dev/null -w 'local :3002 -> %{http_code}\n' http://127.0.0.1:3002/ || true
"

echo "==> verify from here"
curl -sS -o /dev/null -w "vs-ext-test.sophtwhere.com -> %{http_code} (TLS %{ssl_verify_result})\n" "$URL"
echo "Done."
