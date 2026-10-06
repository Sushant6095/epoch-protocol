# Skills in this kit

Every skill below is in `.claude/skills/` (→ `app/.claude/skills/` once the kit is copied). Claude Code loads
them automatically; other coding agents read them through `AGENTS.md`. Sources and content hashes are pinned
in `skills-lock.json`; `bash scripts/update-skills.sh` refreshes them. Vendored on 30 Sep 2026.

## Epoch's own

| Skill | What it does | Origin |
| --- | --- | --- |
| epoch-ui-craft | The router: picks the one skill or tool for a task, points every component at a library, enforces CLAUDE.md | Epoch |
| refero-replica | Rebuilds a page as a structural replica of its Refero screens with Epoch's identity; the compare loop | Epoch |
| sushant-special-fe | Premium landing finish: taste engine, 3D-scroll engine, premium component sourcing | Sushant's own skill (from the keel project), scoped for Epoch |

## Published, vendored with their licence

| Skill | Source | Licence | Use it for |
| --- | --- | --- | --- |
| refero-design | referodesign/refero_skill | MIT (Refero) | Refero research method: styles → screens → flows |
| ui-ux-pro-max | nextlevelbuilder/ui-ux-pro-max-skill | MIT | pulling, integrating and re-skinning components |
| shadcn | shadcn-ui/ui | MIT | the shadcn CLI, registries and theming |
| design-taste-frontend | Leonxlnx/taste-skill | MIT | a pass that stops the landing looking templated |
| frontend-design | anthropics/skills | Apache-2.0 (LICENSE.txt in the folder) | distinctive visual direction for the landing |
| emil-design-eng, animation-vocabulary, review-animations, improve-animations, find-animation-opportunities, apple-design | emilkowalski/skills | MIT | animation and interaction craft |
| gsap-core, gsap-react, gsap-scrolltrigger, gsap-timeline, gsap-plugins, gsap-performance, gsap-utils | greensock/gsap-skills (official) | MIT | everything GSAP |
| vercel-react-best-practices, vercel-composition-patterns, vercel-react-view-transitions | vercel-labs/agent-skills | MIT (declared in each SKILL.md) | React and Next performance, component APIs, page transitions |

## Installed globally by `scripts/install-skills.sh` (not vendored)

| Skill | Source | Why not vendored |
| --- | --- | --- |
| threejs-fundamentals, -shaders, -materials, -lighting, -animation, -postprocessing | CloudAI-X/threejs-skills | the repo has no licence file |
| web-design-guidelines | vercel-labs/agent-skills | no licence declared for this skill |
| impeccable | npx impeccable (Apache-2.0) | installs a platform-specific binary |

Keep the LICENSE file in each vendored folder when you update. Skills run with full agent permissions:
read a skill's diff before committing an update.
