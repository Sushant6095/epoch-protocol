// Epoch-boundary jobs in order: claim_mev, update_score, sweep, settle_epoch, accrue. Idempotent; lands via RPC Fast.
async function main() {
  console.log("[cranks] starting");
  // TODO
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
