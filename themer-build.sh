#!/usr/bin/env bash
# Builds Dark Reader Themer for Firefox (build/release/darkreader-firefox.xpi) and Chromium
# (build/release/chrome-mv3/, load it unpacked).
# Install them with the Themer browser plugin: <themer>/plugins/browser/install.sh --firefox-xpi <the .xpi>
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# nvm is often loaded lazily by the shell profile, so a script does not see npm until nvm.sh is sourced.
if ! command -v npm >/dev/null && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi
[[ -d node_modules ]] || npm ci
node --max-old-space-size=3072 tasks/cli.js build --release --firefox --chrome-mv3
echo "Firefox:  $PWD/build/release/darkreader-firefox.xpi"
echo "Chromium: $PWD/build/release/chrome-mv3"
