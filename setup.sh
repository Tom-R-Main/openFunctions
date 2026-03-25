#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║              OpenFunction — One-Command Setup                    ║
# ║                                                                  ║
# ║  Works in Google Cloud Shell, macOS, Linux, and WSL.            ║
# ║  Run: bash setup.sh                                              ║
# ╚══════════════════════════════════════════════════════════════════╝

set -e

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     OpenFunction — Setting Up...     ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── Check Node.js ───────────────────────────────────────────────────────────

if ! command -v node &> /dev/null; then
  echo "  ❌ Node.js not found."
  echo "     Install it from https://nodejs.org or use nvm:"
  echo "     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
  echo "     nvm install 20"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "  ❌ Node.js v18+ required (found v$(node -v))"
  echo "     Run: nvm install 20"
  exit 1
fi

echo "  ✅ Node.js $(node -v)"

# ── Install dependencies ────────────────────────────────────────────────────

echo "  📦 Installing dependencies..."
npm install --silent 2>&1 | tail -1

echo "  ✅ Dependencies installed"

# ── Verify it works ─────────────────────────────────────────────────────────

echo "  🔍 Verifying setup..."

# Verify tsx can actually run TypeScript
npx tsx -e "console.log('  ✅ TypeScript runner (tsx) ready')" 2>/dev/null
if [ $? -ne 0 ]; then
  echo "  ⚠️  tsx failed — try: npm install"
  exit 1
fi

echo ""
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║                   Ready to go!                       ║"
echo "  ╠══════════════════════════════════════════════════════╣"
echo "  ║                                                      ║"
echo "  ║  Test your tools:     npm run test-tools             ║"
echo "  ║  Dev mode (reload):   npm run dev                    ║"
echo "  ║  Chat with AI:        npm run chat                   ║"
echo "  ║  Run tests:           npm test                       ║"
echo "  ║  Scaffold a tool:     npm run create-tool <name>     ║"
echo "  ║  Start MCP server:    npm start                      ║"
echo "  ║                                                      ║"
echo "  ║  Your code goes in:   src/my-tools/index.ts          ║"
echo "  ║  Examples to read:    src/examples/                  ║"
echo "  ║  API keys:            cp .env.example .env           ║"
echo "  ║                                                      ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo ""
