/** ISO 8601 in India Standard Time (`2026-10-07T18:30:00+05:30`), like api_app's `asOf`: for logs and the ops line. */
export function isoIst(date: Date | number = new Date()): string {
  const ms = typeof date === 'number' ? date : date.getTime();
  return `${new Date(ms + 330 * 60_000).toISOString().slice(0, 19)}+05:30`;
}
