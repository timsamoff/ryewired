#!/usr/bin/env bash
# Ryewired setup — installs npm dependencies for both apps

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "=== Ryewired Setup ==="
echo ""

echo "→ Installing main app dependencies..."
cd "$ROOT/app" && npm install
echo "  Done."

echo ""
echo "→ Installing admin tool dependencies..."
cd "$ROOT/admin" && npm install
echo "  Done."

echo ""
echo "=== Setup complete ==="
echo ""
echo "  Main app:   cd app && npm start"
echo "  Admin tool: cd admin && npm start"
echo ""
