# @epoch/panta

Typed client for the [Panta public API](https://docs.panta.market): USDC prediction markets on Solana mainnet. Used
by `panta_bot_app` (creates Epoch's Fee Index markets) and `api_app` (real-money Predict at `/v1/predict/panta`).
Panta never holds keys: it returns unsigned transactions (or instructions) that the wallet signs; we broadcast on our
RPC and tell Panta the signature.

```ts
import { PantaClient, RequestBudget, PantaApiError } from '@epoch/panta';

const panta = new PantaClient({ apiKey: process.env.PANTA_API_KEY, budget: new RequestBudget({ share: 0.8 }) });
const market = await panta.getMarket(marketId); // zod-validated, prices as strings
try {
  await panta.quoteBuy({ wallet, marketId, side: 'yes', amountUsdc: '20.00' });
} catch (error) {
  if (PantaApiError.is(error, 'MARKET_NOT_IN_PRIMARY')) {
    /* closed */
  }
}
```

## What it does

| | |
| --- | --- |
| Endpoints | account, metrics, creates, attributed trades · markets list / get / trades, categories, wallet trades · create quote / build / register · primary-buy quote / build / submit / verify · positions · win-claim and creator-fee builds · trade report and status. Paths keep Panta's required trailing slash. |
| Validation | every answer is parsed with the zod schemas in `src/schemas.ts`, written from the docs pages cited there. Unknown fields are dropped; numbers the docs show both as strings and numbers (prices, amounts, shares) come out as strings. A 2xx that does not match throws `PantaResponseError` (not retried). Requests are checked too: a market quote that breaks Panta's limits (question ≤ 512, rule ≤ 2,048, 1–20 sources, `startTime < endTime ≤ resolutionTime`, http(s) image) or an id that is not base58 throws `PantaInputError` before anything is sent. |
| Errors | Panta's `{ code, message, field?, fields? }` becomes a typed `PantaApiError` subclass by status (`PantaRequestError` 400, `PantaAuthError` 401, `PantaForbiddenError` 403, `PantaNotFoundError` 404, `PantaRateLimitedError` 429, `PantaServerError` 5xx) with `code` as Panta sent it (`PANTA_ERROR_CODES` lists the documented ones). `PantaNetworkError` (timeout or no answer), `PantaBudgetError` (our own budget, nothing sent), `PantaConfigError` (no key). `isRetryablePantaError` and `pantaRetryAfterSeconds` for callers. |
| Retries | on 408, 429, 5xx and network errors: up to `maxRetries` (2) with exponential backoff (0.5 s, 1 s, 2 s … 8 s) and 50–100% jitter; a 429 waits at least its `Retry-After`, and a wait longer than `maxRetryWaitMs` is not made (the error is thrown at once). Every call is safe to repeat: quotes and builds open fresh sessions, register / submit / trade report are idempotent per signature. |
| Rate budget | `RequestBudget` keeps a sliding window per family under Panta's documented per-ACCOUNT limits (read 120, positions 60, quote 30, build 20, register 40, upload 10 per minute) times `share`, so a process can never burst past its share. A 429's `Retry-After` and `X-RateLimit-Remaining: 0` with `X-RateLimit-Reset` block the family until then. `maxBudgetWaitMs` decides whether a call waits for a slot (the bot: 30 s) or fails at once with `PantaBudgetError` (the API: a user is waiting). |
| Secrets | the key sits in a private field and goes out only in the `X-Api-Key` header: never in a URL, a log line, an error or `JSON.stringify(client)` (tests check all four). Base URL must be https. |
| Transactions | `compileUnsignedTransaction` turns Panta's instruction list + blockhash into one unsigned v0 transaction paid by the wallet (refusing instructions that need any other signer); `decodeTransaction`, `describeTransaction` (payer, signers, programs, message hash), `messageHash` (sha256 of the message bytes: what the wallet signs) and `transactionSignature`. |
| Units | `usdcToBase("20.00") === 20_000_000n`, `baseToUsdc(2_500_000n) === "2.50"`: no floating point for money. |

## Not used, on purpose

Register, login, refresh and the API-key routes (`/auth/*`, `/account/keys/`): keys are made by a person in Panta's
dashboard and live only in server env (`PANTA_API_KEY`). Image upload: markets use `PANTA_MARKET_IMAGE_URL`.

## Tests

`pnpm --filter @epoch/panta test`: a fake `fetch` answering with the documented examples (`src/__fixtures__`), the
retry and backoff schedule, Retry-After and rate headers, error mapping, timeouts, schema mismatches, request
validation, key redaction, the budget's sliding window, units and transaction compilation. Nothing calls the real API.
