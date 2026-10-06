# Live API samples (1 Oct 2026, IST)

Real responses from `packages/api_app` as built on 1 Oct for the branch `feat/api-network-validators-delegators`, captured against
Solana mainnet (public RPC) after the first delegator scan had finished: 682 validators, 1,160,603 stake accounts,
581,359 wallets. Each file is the full response, envelope included (`{ ok: true, data }`), and type-checks against
`contracts/epoch-data.ts` (`ApiResponse<T>`).

| File | Request | Type of `data` |
| --- | --- | --- |
| `network.json` | `GET /v1/network` | `NetworkSnapshot` |
| `stake-history-64.json` | `GET /v1/network/stake-history?epochs=64` | `StakeHistory` |
| `validators-first-50.json` | `GET /v1/validators?limit=50` | `ValidatorList` |
| `validators-watch-tab.json` | `GET /v1/validators?tab=watch&limit=10` | `ValidatorList` |
| `top-validators-8.json` | `GET /v1/validators?sort=stake&limit=8` (the Terminal's top validators) | `ValidatorList` |
| `biggest-delegators.json` | `GET /v1/delegators/biggest?limit=10` | `BiggestDelegators` |
| `retail-magnets.json` | `GET /v1/delegators/retail-magnets?limit=10` | `RetailMagnets` |

Use them to test a hook's switch from its fixture to the API, not as fixtures: the pages' numbers and the click map
follow the 29 Sep fixtures. Differences worth knowing:

- Mainnet was in epoch 1046 on 1 Oct; the fixtures' world is epoch 1044.
- `dependOnFoundation` is `null`: the API needs the Foundation's withdraw authorities (`FOUNDATION_AUTHORITIES`,
  request #25) before it can count Foundation-dependent validators.
- Rows carry `health`, `healthReasons`, `clientId` and `countryCode`, which the fixtures don't have.
- Unlabelled big wallets show as short addresses (`4ZJh…kbPY`); stake pools are named from their token symbol
  (`JitoSOL pool`).
