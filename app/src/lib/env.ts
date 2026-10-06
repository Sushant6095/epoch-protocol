// Public configuration. Every NEXT_PUBLIC_ variable is read by its full name so Next inlines it at build time.
// Names only live in app/.env.example; values come from the deployment (never committed).

const trim = (url: string) => url.replace(/\/+$/, "");

export const env = {
  /** The Epoch API (packages/api_app). Every page reads it; WS /v1/stream is on the same host. */
  apiUrl: trim(process.env.NEXT_PUBLIC_EPOCH_API_URL ?? "http://localhost:4000"),
  /** Solana mainnet RPC for the wallet connection (Panta trades are broadcast by the API, not by this RPC). */
  mainnetRpcUrl: trim(process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"),
  /** The Epoch program's cluster (devnet for now): redeem is sent here. */
  epochRpcUrl: trim(process.env.NEXT_PUBLIC_EPOCH_RPC_URL ?? "https://api.devnet.solana.com"),
  /** The launch cluster's RPC: Launch buys and sells are sent here (defaults to the program's cluster). */
  launchRpcUrl: trim(
    process.env.NEXT_PUBLIC_LAUNCH_RPC_URL ?? process.env.NEXT_PUBLIC_EPOCH_RPC_URL ?? "https://api.devnet.solana.com",
  ),
  /** The Epoch program id; needed to build `redeem` with @epoch/epoch-sdk. Unset: redeem is shown but disabled. */
  epochProgramId: process.env.NEXT_PUBLIC_EPOCH_PROGRAM_ID ?? null,
  /** `sample` forces sample mode (fixtures, labelled Sample) even when the API answers. */
  forceSample: process.env.NEXT_PUBLIC_EPOCH_DATA === "sample",
  /** Links to the code behind each integration. */
  githubBlob: "https://github.com/Sushant6095/epoch-protocol/blob/main",
  githubTree: "https://github.com/Sushant6095/epoch-protocol/tree/main",
} as const;

/** ws(s):// of the API's stream. */
export const streamUrl = () => `${env.apiUrl.replace(/^http/, "ws")}/v1/stream`;

/** The API host as people read it (`localhost:4000`). */
export const apiHost = () => {
  try {
    return new URL(env.apiUrl).host;
  } catch {
    return env.apiUrl;
  }
};

export const githubFile = (path: string) => `${env.githubBlob}/${path.replace(/^\/+/, "")}`;
