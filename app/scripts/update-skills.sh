#!/usr/bin/env bash
# Epoch — refresh the vendored skills in app/.claude/skills from their sources (run inside app/).
# Sources and hashes are pinned in app/skills-lock.json. Review the diff before committing, and keep
# each skill's LICENSE file. The Epoch skills (epoch-ui-craft, refero-replica, sushant-special-fe) are
# ours and are not touched.
set -euo pipefail
cd "$(dirname "$0")/.."

add() { npx -y skills@latest add "$@" -a claude-code -y; }

add referodesign/refero_skill --skill refero-design
add nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max
add shadcn/ui --skill shadcn
add Leonxlnx/taste-skill --skill design-taste-frontend
add anthropics/skills --skill frontend-design
add emilkowalski/skills --skill emil-design-eng --skill animation-vocabulary --skill review-animations \
    --skill improve-animations --skill find-animation-opportunities --skill apple-design
add greensock/gsap-skills --skill gsap-core --skill gsap-react --skill gsap-scrolltrigger \
    --skill gsap-timeline --skill gsap-plugins --skill gsap-performance --skill gsap-utils
add vercel-labs/agent-skills --skill vercel-react-best-practices --skill vercel-composition-patterns \
    --skill vercel-react-view-transitions

echo "✓ Vendored skills refreshed. Check git diff, keep the LICENSE files, commit on your branch."
