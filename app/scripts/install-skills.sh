#!/usr/bin/env bash
# Epoch — install the few design skills that are NOT vendored in app/.claude/skills.
# Most skills now ship inside the kit (app/.claude/skills, each with its licence; see
# THIRD-PARTY-SKILLS.md). These stay global because their source repo has no licence file
# (Three.js, Vercel's web-design-guidelines) or because they install a platform binary (impeccable).
# Checked 30 Sep 2026. Re-run any time; `npx skills update -g -y` updates them later.
set -euo pipefail

add() { npx -y skills@latest add "$@" -g -a claude-code -y; }

echo "→ Three.js (landing hero only)"
add CloudAI-X/threejs-skills --skill threejs-fundamentals --skill threejs-shaders --skill threejs-materials \
    --skill threejs-lighting --skill threejs-animation --skill threejs-postprocessing

echo "→ Web interface guidelines review (Vercel)"
add vercel-labs/agent-skills --skill web-design-guidelines

echo "→ Impeccable design skill + detector commands (no hook manifests)"
npx -y impeccable@latest install -y --providers=claude --scope=global --no-hooks

echo
echo "✓ Global skills installed in ~/.claude/skills. The vendored ones are already in app/.claude/skills."
echo "  Restart Claude Code, then type /skills to see them all. Refero MCP: run /mcp and sign in once."
