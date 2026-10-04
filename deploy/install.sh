#!/usr/bin/env bash
# Install the release's production dependencies (run from the release directory by the deploy).
# Reuses the live release's node_modules and compiled TA-Lib when the lockfile and the vendored TA-Lib
# sources are unchanged (deploy/deps.fingerprint; compiling TA-Lib on the small instance takes 15-25
# minutes); otherwise npm ci.
set -uo pipefail
prev="$(readlink ~/bot/current 2>/dev/null || true)"
reuse() {
  [ -n "$prev" ] || return 1
  [ -d "$prev/node_modules" ] || return 1
  [ -d "$prev/vendor/talib/build" ] || return 1
  if [ -f "$prev/deploy/deps.fingerprint" ] && [ -f deploy/deps.fingerprint ]; then
    # Lockfile + TA-Lib sources fingerprint, written by the deploy workflow.
    cmp -s "$prev/deploy/deps.fingerprint" deploy/deps.fingerprint || return 1
  else
    # Older release without a fingerprint: compare the sources, ignoring what the compile generates.
    cmp -s "$prev/package-lock.json" package-lock.json || return 1
    diff -rq --exclude=build --exclude=node_modules --exclude=temp --exclude='*.a' --exclude='*.o' "$prev/vendor/talib" vendor/talib >/dev/null 2>&1 || return 1
  fi
  rm -rf node_modules vendor/talib/build
  cp -a "$prev/node_modules" node_modules || return 1
  cp -a "$prev/vendor/talib/build" vendor/talib/build || return 1
}
if reuse; then
  echo "install: reused node_modules and the TA-Lib build from $prev"
else
  echo "install: npm ci (lockfile or TA-Lib changed, or nothing to reuse)"
  rm -rf node_modules
  nice -n 5 npm ci --omit=dev || exit 1
fi
node -e "require('talib'); console.log('install: TA-Lib native module OK')" || echo 'install: WARNING TA-Lib did not load; the bot uses its built-in indicators'
