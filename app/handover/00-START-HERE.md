# 00 · Start here

As of 1 Oct 2026 (IST). Epoch's frontend handover: everything needed to build the web app in `app/`,
page by page, from Refero references, with the libraries, MCP servers and skills already chosen.

**Epoch in one line:** validators borrow against their next paychecks, lenders earn the fees, and every
staker can see which validators are healthy.

**Who owns what.** Chahat (`chahat-code`) owns the frontend and the UI: everything under `app/`. Sushant
owns the backend services (`packages/*`), the Solana program (`programs/*`), tests, deployments and CI.
The frontend builds against fixtures today and switches to the API one hook at a time.

**The look is the Refero screens.** Every page is built as a structural replica of its locked Refero screens:
same app shell, grid, region order and size, spacing, type steps, components, states, flows and motion.
`12-REPLICA-BLUEPRINTS.md` maps every region of every screen to Epoch's content and to the library component
that builds it; the `refero-replica` skill is the method and `scripts/ui/ref-compare.mjs` the check. Only
identity is Epoch's: the emerald tokens, Geist fonts, the logo, lucide icons, the words and the data.

**The canvas is the content map.** The design canvas "Epoch — UI designs (5 pages)" and its renders in
`design/boards/` show which numbers, controls and states exist on each page, with the real 29 Sep data; press
Play to try any flow. Where a board's layout differs from its Refero screen, the Refero screen wins. The
boards were drawn on 29–30 Sep, before the 1 Oct decisions: where a board shows something a spec or the click map
now says differently (Predict in SOL, a Senior target of ≈10.9%, Orb links for devnet transactions …), the spec and
`11-CLICK-MAP.md` win. The Fee Market and Launch came after the canvas and have no board: their specs, fixtures and
click-map rows are the content map. The older wireframes in `design/wireframes/` are superseded.

**Every click is written down.** `11-CLICK-MAP.md` has one row per interactive element on every page (322):
what it does, the route and URL params, the hook, endpoint, Epoch instruction or wallet call, and the
loading, empty, error and success states. Build a page with its Refero screens and blueprint open and its
rows beside it; each row is a test case. Controls marked "prototype only" exist so the canvas can reach every
state: don't build them.

## Reading order

| # | File | Read it for |
| --- | --- | --- |
| 1 | `01-PRODUCT-AND-USERS.md` | What Epoch does, the four user groups, sign-in and roles |
| 2 | `02-SITEMAP-AND-ROUTES.md` | Every route, the header, the links between pages, folder layout in `src/` |
| 3 | `06-REFERO-SCREENS.md` | The reference lock: the exact Refero screens per page and the one to follow first |
| 3b | `12-REPLICA-BLUEPRINTS.md` | The look: every region of every Refero screen mapped to Epoch content and a library component |
| 4 | `pages/<page>.md` | One spec per page: hero, sections, data, states, interactions, copy, done-checklist |
| 5 | `11-CLICK-MAP.md` | What every click does on every page, with its call and its states (one row = one test) |
| 6 | `03-DESIGN-SYSTEM.md` | Tokens, the two themes, type, spacing, motion, components to build once |
| 7 | `04-UI-LIBRARIES.md` | Every library (versions checked 29 Sep 2026), where each is allowed, where it came from |
| 8 | `05-MCP-SERVERS-AND-SKILLS.md` | The MCP servers and published skills, how to sign in, prompts that work |
| 9 | `07-DATA-CONTRACTS.md` | Types, fixtures, the endpoints the backend will serve, explorer links |
| 9b | `13-BACKEND-AND-PROGRAM-MAP.md` | Per screen: which API it reads, which program instruction the wallet signs, what exists today, the error words |
| 10 | `08-GIT-WORKFLOW.md` | Which folders are yours, what never to touch, branches, commits, PRs |
| 11 | `09-BUILD-ORDER.md` | What to build first, tied to the hackathon gates |
| 12 | `10-OPEN-DECISIONS.md` | Product decisions, all settled as of 1 Oct 2026 (palette, Predict in points, credit limits, Senior target, networks, scope, the Fee Market, Launch …) |

Working files you will keep updating: `DECISIONS.md` (design decisions), `PROVENANCE.md` (every pulled
component), `BACKEND-REQUESTS.md` (anything you need from Sushant).

## Pages at a glance

| Page | Route | Hero | Content map · click-map rows | Target Refero screen (the look) |
| --- | --- | --- | --- | --- |
| Landing | `/` | One line + live epoch clock + "Check my stake" | `Main` · LA1–24 | Kraken staking landing `26b6852a` (style: Hyper Foundation) |
| Terminal | `/terminal` | Stake on the move chart, plus Quick answers for every audience | `Terminal` · TE1–32 | Mercury Insights (dark) `18cf9c6a` |
| Fee Market | `/terminal?tab=market` (a Terminal tab; devnet) | The ticket beside the quotes by epoch and the Fee Index chart | no board · FM1–30 | Kraken Pro BTC-USD `cd4884df` |
| Validators | `/validators` | The ranked, filterable table | `Validators` · VE1–41 | OpenSea Collection stats (dark) `52465519` |
| Validator profile | `/validators/[vote]` | Health (score + stake) with the stake chart and the action panel | `Validator` · VP1–48 | **Wealthsimple NVDA (dark) `47b50f40` — north star** |
| My Stake | `/me` | Stake accounts with health badges | `MyStake` · MS9–41 | Mercury Home (dark) `859b1114` |
| Predict | `/predict` (was `/me#predict`) | Market card with the YES/NO bar | `MyStake` · MS42–55 | Stocktwits poll card (dark) `50c3c89d` |
| Vault | `/vault` | Tranche cards + deposit panel | `Vault` · VA1–37 | Mercury Treasury `26e9c3a5` |
| Launch | `/launch`, `/launch/[mint]` (devnet) | Launch cards with the raise bar; a token's price, what backs it and the Trade card | no board · LP1–28 | OpenSea Drops `869184ab` (list) + Wealthsimple NVDA `47b50f40` (token) |
| Sign in | `/me` signed out, Connect modal | Wallet list, then the message to sign | `MyStake` signed out · MS1–8, MS56–69 | Reown split sign-in `0457489c` + Acctual flow 8823 |

Every app page sits in the same Mercury shell (sidebar + top bar, SH1–13); the landing has its own marketing
bar and sign-in has no shell. Boards have a fixed height, so the signed-out My Stake board shows empty space
under the sign-in split; the real page ends there.

## Real vs sample

Network, validator and delegator numbers in `fixtures/*.real.json` are real Solana mainnet data from
29 Sep 2026, 00:30 IST (RPC, Stakewiz, validators.app, Jito). Anything from the Epoch program (vault,
advances, Fee Index, activity, Predict, the Fee Market, Launch) is `*.sample.json`, obeys the program's rules
and uses fictional validator names; it renders a Sample badge until the program's accounts exist on the connected network.
`my-stake.demo.json` is a demo wallet: real validators, invented balances. `api-samples/*.json` are real responses
from the API branch built on 1 Oct (envelope included), for testing the switch from fixtures to the API.

## The rules that matter most

1. **Only `app/` is yours.** The hooks block edits outside it. Backend needs go in `BACKEND-REQUESTS.md`.
2. **Refero replica, libraries first.** Every page replicates its locked screens' structure with Epoch's
   identity, and every component comes from a library (`04-UI-LIBRARIES.md`); nothing is hand-built that a
   registry already has.
3. **Never ship without looking.** Production build → screenshots at four sizes → look → design-cop.
4. **Never show fake data as real,** and never ask anyone for a seed phrase.
5. **Every click is specified.** If the app needs something `11-CLICK-MAP.md` doesn't cover, add a row
   before you build it, never guess.
