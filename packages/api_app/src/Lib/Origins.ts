/**
 * True when a browser `Origin` header names one of the app's own hosts (`SIWS_ALLOWED_DOMAINS`, e.g. `localhost:3000`).
 * `null` origins (sandboxed frames, file://) and anything unparsable are foreign.
 */
export function isAppOrigin(origin: string, appHosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return appHosts.some((allowed) => allowed.toLowerCase() === host);
}
