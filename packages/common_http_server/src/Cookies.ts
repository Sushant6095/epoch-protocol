import type { Request, Response } from 'express';

/** Parses the `Cookie` header into a name → value map (values URI-decoded). No dependency needed. */
export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(raw.replace(/^"(.*)"$/, '$1'));
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  domain?: string;
  path?: string;
}

/** Appends a Set-Cookie header (keeps any already set on the response). */
export function setCookie(res: Response, name: string, value: string, options: CookieOptions = {}): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
    parts.push(`Expires=${new Date(Date.now() + Math.max(0, options.maxAgeSeconds) * 1_000).toUTCString()}`);
  }
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite[0].toUpperCase()}${options.sameSite.slice(1)}`);
  const existing = res.getHeader('set-cookie');
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('set-cookie', [...list, parts.join('; ')]);
}

/** Expires a cookie in the browser. Pass the same path/domain it was set with. */
export function clearCookie(res: Response, name: string, options: Omit<CookieOptions, 'maxAgeSeconds'> = {}): void {
  setCookie(res, name, '', { ...options, maxAgeSeconds: 0 });
}
