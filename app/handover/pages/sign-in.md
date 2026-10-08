# Sign in · `/me (signed out) and the Connect modal from the header`

**Look:** replicate this page's Refero screens region by region: [`12-REPLICA-BLUEPRINTS.md`](../12-REPLICA-BLUEPRINTS.md) § Sign in (method: the `refero-replica` skill; check with `scripts/ui/ref-compare.mjs`). Epoch keeps its own colours, fonts, logo, words and data.

**Content map:** [`4b-my-stake-sign-in.jpg`](../design/boards/4b-my-stake-sign-in.jpg) shows which numbers, controls and states exist (from the design canvas). It is not the look.

**Every click:** [`11-CLICK-MAP.md`](../11-CLICK-MAP.md) § My Stake, rows MS1–MS8 (the sign-in split) and MS56–MS69 (the Connect dialog); the header button is SH8. Each row is a test case.

The older wireframes ([`05b-my-stake-sign-in.png`](../design/wireframes/05b-my-stake-sign-in.png)) are superseded.

**Job:** turn a wallet into an account with a message signature — no email, no password, no fee — and
make it obvious nothing moves.

**Users:** delegators, lenders and operators signing in; exchange stakers who first paste an address.

## Refero lock for this page

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Reown — split sign-in (dark)](https://refero.design/pages/0457489c-1d8c-49cd-91e3-7e4450b8b00f) · `0457489c-1d8c-49cd-91e3-7e4450b8b00f` | Split screen: a value card on the left (three check lines), a short form column on the right with one primary and one secondary button. | Email sign-up. Epoch signs in with a wallet only; the right column is the wallet list. |
| flow | [Acctual flow 8823 · step 2 — wallet list](https://refero.design/pages/7228300f-42cc-4e74-bef3-76405358ae66) · `7228300f-42cc-4e74-bef3-76405358ae66` | A searchable list with 'Installed' tags on detected wallets. | EVM wallets; ours are Phantom, Solflare, Backpack, then Wallet Standard. |
| flow | [Acctual flow 8823 · step 4 — connect](https://refero.design/pages/b17e7859-2d52-4de2-8a27-dd3bf7baaa70) · `b17e7859-2d52-4de2-8a27-dd3bf7baaa70` | One centred state: wallet icon + 'Continue in your wallet'. | — |
| flow | [Acctual flow 8823 · step 5 — sign to confirm ownership](https://refero.design/pages/8a42925d-ceac-4a84-988a-d145ec6edcf4) · `8a42925d-ceac-4a84-988a-d145ec6edcf4` | Exactly our Sign In With Solana step: a calm modal that says you are signing to prove ownership. We add the full message text in mono before the wallet opens. | — |
| flow | [Acctual flow 8823 · step 6 — connected](https://refero.design/pages/50d92ee2-7149-4802-80fe-6e191616ddaf) · `50d92ee2-7149-4802-80fe-6e191616ddaf` | The connected state with the address and a disconnect link. | The payment form behind it. |
| secondary | [OpenSea — dark wallet list with chain tags](https://refero.design/pages/8c2b4da5-7d7a-4b6b-8ab5-752fbb032bae) · `8c2b4da5-7d7a-4b6b-8ab5-752fbb032bae` | Wallet rows with a small 'Solana' tag and a 'Popular' pill on the top one. | The Ethereum-first order. |

Run `/refs sign-in` first: it pulls these images through the Refero MCP and writes `design/screens/sign-in.md`.

## Layout — split screen on `/me` (the header's Connect opens the same right column as a dialog)

| Side | What it shows | Reference region |
| --- | --- | --- |
| Left (value) | "See what your SOL is *really doing.*" and three check lines: signing in is a message, not a transaction · you approve every action in your wallet · exchange stakers can paste an address first | **Reown split sign-in** left card |
| Right, step 1 of 2 | Wallet rows, 56 px: Phantom, Solflare, Backpack (each "Detected" or "Install"), then "Other wallets" (Wallet Standard); a divider; "Any wallet address (read-only)" input + View | Reown right column; OpenSea dark wallet list with the "Solana" tag; Acctual flow step 2 |
| Right, connecting | Wallet icon + "Continue in Phantom" + Cancel | Acctual flow step 4 |
| Right, step 2 of 2 | "Sign to confirm this wallet is yours." The full Sign In With Solana message in mono (domain, address, statement, URI, version, chain, nonce, issued at, expiration) BEFORE the wallet opens; Back and **Sign message** | Acctual flow step 5 (sign to confirm ownership) |
| Right, done | "Signed in" with the short address; the page swaps to My Stake | Acctual flow step 6 |
| Below | Three cards: what you'll see, what we watch, what you can do | — |

## Flow (wallet-adapter)

1. `select(walletName)` → `connect()` (handle "not installed" → link to install, and user rejection).
2. `POST /v1/auth/siws/nonce` → build the SIWS input → show it → `signIn(input)` from the adapter.
3. `POST /v1/auth/siws/verify` with the output → session cookie → roles from chain → redirect to `/me`
   (or back to where the user came from).
4. Until the endpoints exist: sign in the browser and keep the session client-side, clearly marked dev-only.

Account menu (header chip): copy address, view on explorers, switch wallet, read-only address, sign out.

## Rules

Never ask for or accept a seed phrase or private key anywhere, including support copy. The domain in the
message is the real app domain (open decision 7). Session expiry → quiet re-sign prompt, not a logout wall.

## Done when

- [ ] A first-time user understands in one read that signing moves nothing.
- [ ] Rejection, timeout, wrong network and "wallet not installed" each have a calm state.
- [ ] Keyboard only: wallet list, input and buttons reachable; focus returns to the trigger on close.
- [ ] design-cop all PASS, axe and impeccable clean.

## Live sites to look at (not on Refero)

- [Phantom](https://phantom.com) — calm, plain wallet copy
- [Solana wallet-adapter SIWS example](https://github.com/anza-xyz/wallet-adapter) — the `signIn()` flow
