#!/usr/bin/env bash
# Ryewired setup

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
echo ""
echo "=== Ryewired Setup ==="
echo ""
echo "→ Installing admin tool dependencies..."
cd "$ROOT/admin" && npm install
echo "  Done."
echo ""
echo "=== Setup complete ==="
echo ""
echo "  Main app:   serve . or use VS Code Live Server, then open index.html"
echo "  Admin tool: cd admin && npm start"
echo ""
