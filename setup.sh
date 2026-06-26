#!/usr/bin/env bash
# Ryewired setup

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
echo ""
echo "=== Ryewired Setup ==="
echo ""
echo "→ Installing main app dependencies..."
cd "$ROOT" && npm install
echo "  Done."
echo ""
echo "→ Installing admin tool dependencies..."
cd "$ROOT/admin" && npm install
echo "  Done."
echo ""
echo "=== Setup complete ==="
echo ""
echo "  Main app:   npm start          (from repo root)"
echo "  Admin tool: cd admin && npm start"
echo "  Web dev:    serve . or use VS Code Live Server"
echo ""
