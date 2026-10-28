#!/bin/bash
# BrownHub Haul — double-click launcher for the depot Mac.
# Finds Node, starts the app, waits for it to answer, opens the browser.
# Override the port with:  PORT=9000 ./start.command

set -u
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8420}"
export PORT                     # server.mjs reads it from the environment, not the shell
URL="http://127.0.0.1:${PORT}"

find_node() {
  local c
  c="$(command -v node 2>/dev/null)"
  [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  for c in "$HOME"/tools/node-*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

NODE="$(find_node)"
if [ -z "${NODE:-}" ]; then
  echo "Node.js was not found. Install it from https://nodejs.org (any version 18 or"
  echo "newer), then open this file again. Nothing else is needed — the app has no"
  echo "dependencies to install."
  exit 1
fi

# Something is already answering on that port: use it instead of failing on EADDRINUSE.
if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then
  echo "BrownHub Haul is already running at ${URL} — opening it."
  open "$URL/"
  exit 0
fi

echo "BrownHub Haul · node $("$NODE" -v) · ${URL}"
echo "Manifest: ${DB:-data/shipments.json}   (Ctrl-C or close this window to stop)"
echo "Dispatch is locked. The passphrase was printed once on the very first boot,"
echo "in this window. To set a new one:  HAUL_TOKEN='your phrase' ./start.command"
echo

(
  for _ in $(seq 1 60); do
    if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then open "${URL}/"; exit 0; fi
    sleep 0.25
  done
  echo "The server did not answer on port ${PORT}. Is another app using it?"
) &

exec "$NODE" server.mjs
