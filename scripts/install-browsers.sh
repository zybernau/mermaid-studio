#!/usr/bin/env bash
# Installs the Playwright Chromium build into a stable, sandbox-writable path.
# The default ~/Library/Caches/ms-playwright path is not writable here.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-.playwright-browsers}"
export PLAYWRIGHT_BROWSERS_PATH
cd "$ROOT"
if [ -f "$PLAYWRIGHT_BROWSERS_PATH/INSTALLED" ]; then
  echo "playwright browsers already present in $PLAYWRIGHT_BROWSERS_PATH"
  exit 0
fi
npx playwright install chromium "$@"
touch "$PLAYWRIGHT_BROWSERS_PATH/INSTALLED"
