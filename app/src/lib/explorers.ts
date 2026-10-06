// Explorer links. Mainnet data opens Solana Explorer without a cluster; the program's devnet links carry
// `?cluster=devnet` (decision 24). A local stand-in (the Meteora rehearsal) uses the explorer's custom-cluster mode.

export type Cluster = "mainnet" | "devnet" | "testnet" | "localnet" | string | null | undefined;

function clusterQuery(cluster: Cluster): string {
  if (!cluster || cluster === "mainnet" || cluster === "mainnet-beta" || cluster === "solana-mainnet") return "";
  if (cluster === "devnet" || cluster === "testnet") return `?cluster=${cluster}`;
  if (cluster === "localnet" || cluster === "local") {
    return `?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`;
  }
  return `?cluster=${encodeURIComponent(cluster)}`;
}

export const explorerTx = (signature: string, cluster?: Cluster) =>
  `https://explorer.solana.com/tx/${signature}${clusterQuery(cluster)}`;

export const explorerAddress = (address: string, cluster?: Cluster) =>
  `https://explorer.solana.com/address/${address}${clusterQuery(cluster)}`;

/** Human name for a cluster badge. */
export function clusterLabel(cluster: Cluster): string {
  if (!cluster || cluster === "mainnet" || cluster === "mainnet-beta" || cluster === "solana-mainnet") return "Mainnet";
  if (cluster === "devnet") return "Devnet";
  if (cluster === "testnet") return "Testnet";
  if (cluster === "localnet") return "Local chain";
  return cluster;
}
