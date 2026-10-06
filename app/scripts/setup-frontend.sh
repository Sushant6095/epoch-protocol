#!/usr/bin/env bash
# Epoch — one-time frontend dependency setup for app/.
# Run from anywhere inside the epoch-protocol repo:   bash app/scripts/setup-frontend.sh
# Versions were checked on the npm registry on 29 Sep 2026 (handover/04-UI-LIBRARIES.md).
# It only changes app/package.json and the root pnpm-lock.yaml (both belong in your PR).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ] || [ ! -f "$ROOT/app/package.json" ]; then
  echo "✗ Run this inside the epoch-protocol repo (app/package.json not found)."; exit 1
fi
cd "$ROOT"

node -e 'if (+process.versions.node.split(".")[0] < 22) { console.error("✗ Node 22+ needed (see .nvmrc)"); process.exit(1) }'
if ! command -v pnpm >/dev/null 2>&1; then
  echo "✗ pnpm missing. Run: corepack enable && corepack prepare pnpm@10.28.0 --activate"; exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "✗ You are on $BRANCH. First: git switch -c feat/app-foundation"; exit 1
fi

add()    { pnpm --filter app add "$@"; }
add_dev() { pnpm --filter app add -D "$@"; }

echo "→ 1/6 styling and primitives (Tailwind v4, shadcn's building blocks, icons)"
add tailwindcss@^4.3.3 @tailwindcss/postcss@^4.3.3 tw-animate-css@^1.4.0 shadcn@^4.21.0 cn@^0.4.0 \
    radix-ui@^1.6.7 @base-ui/react@^1.8.0 class-variance-authority@^0.7.1 clsx@^2.1.1 \
    tailwind-merge@^3.7.0 lucide-react@^1.48.0 next-themes@^0.4.6

echo "→ 2/6 data, tables, URL state, small UI helpers"
add @tanstack/react-query@^5.104.0 @tanstack/react-table@^9.2.4 @tanstack/react-virtual@^3.14.13 \
    nuqs@^2.10.1 zustand@^5.0.15 usehooks-ts@^3.1.1 \
    @number-flow/react@^0.6.2 cmdk@^1.1.1 sonner@^2.0.8 vaul@^1.1.2

echo "→ 3/6 charts"
add lightweight-charts@^5.2.1 lightweight-charts-react-components@^2.6.0 recharts@^3.10.1 @visx/visx@^4.0.0

echo "→ 4/6 motion (GSAP primary, Motion for micro-interactions, anime.js via wrapper, Lenis on landing)"
add gsap@^3.15.0 @gsap/react@^2.1.2 motion@^13.4.4 animejs@^4.5.0 lenis@^1.3.26

echo "→ 5/6 landing-only visuals (3D, shader gradient, carousel, flow diagram, annotations)"
add three@^0.186.1 @react-three/fiber@^9.8.1 @react-three/drei@^10.7.9 three-stdlib@^2.36.1 \
    camera-controls@^3.1.2 @shadergradient/react@^2.4.20 \
    embla-carousel-react@^8.6.0 embla-carousel-autoplay@^8.6.0 \
    @xyflow/react@^12.12.0 rough-notation@^0.5.1 canvas-confetti@^1.9.4 svg-dotted-map@^2.1.0

echo "→ 6/6 Solana wallet (web3.js v1 to match packages/epoch-sdk)"
add @solana/wallet-adapter-react@^0.15.40 @solana/wallet-adapter-react-ui@^0.9.40 \
    @solana/wallet-adapter-base@^0.9.28 @solana/web3.js@^1.99.0

echo "→ dev: types, screenshots, accessibility, API mocks, anti-slop detector"
add_dev @types/three@^0.186.0 @types/canvas-confetti@^1.9.0 \
        @playwright/test@^1.63.0 playwright@^1.63.0 @axe-core/playwright@^4.13.0 axe-core@^4.13.0 \
        msw@^3.0.0 impeccable@^4.1.0

if [ -z "${SKIP_BROWSER_INSTALL:-}" ]; then
  echo "→ Chromium for the screenshot loop"
  pnpm --filter app exec playwright install chromium
fi

cat <<'NEXT'

✓ Dependencies installed. Next (Claude Code does these from the kickoff prompt):
  • do NOT run `shadcn init` (it overwrites the first CSS file it finds with its stock palette):
    copy handover/design/components.json → app/, {tokens.css,globals.css} → src/styles/,
    motion.ts → src/design/, lib/{gsap,anime,utils}.ts → src/lib/; then `pnpm dlx shadcn@latest add …` works
  • load Geist, Geist Mono and Instrument Serif with next/font (handover/03-DESIGN-SYSTEM.md)
  • bash scripts/install-skills.sh               (the proven design skills, installed globally)
Commit app/package.json AND the root pnpm-lock.yaml together (CI runs pnpm install --frozen-lockfile).
NEXT
