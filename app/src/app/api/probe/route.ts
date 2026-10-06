// GET /api/probe: can the Epoch API be reached? Checked from the server so the browser never logs a failed request
// while the API is down (sample mode). EPOCH_API_URL_INTERNAL lets a deployment probe the API on a private address.

export const dynamic = "force-dynamic";

const apiUrl = () =>
  (process.env.EPOCH_API_URL_INTERNAL ?? process.env.NEXT_PUBLIC_EPOCH_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

export async function GET() {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(`${apiUrl()}/health`, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
    // Any HTTP answer means the API is up; a 5xx on /health is still reachable (the pages show the blocks' own errors).
    return Response.json(
      { reachable: true, status: res.status, ms: Date.now() - started, checkedAt },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ reachable: false, checkedAt }, { headers: { "cache-control": "no-store" } });
  }
}
