import type { Response } from '@epoch/common_http_server';
import { UnauthorizedException } from '@epoch/exceptions';

/** What a signed-in wallet can do, read from chain (request #7). */
export type Role = 'delegator' | 'lender' | 'operator';

/** The signed-in wallet behind a request, set on `res.locals.session` by the session middleware. */
export interface SessionInfo {
  /** sha256 of the cookie token (hex): the sessions row id. */
  id: string;
  /** Base58 wallet address that signed the SIWS message. */
  address: string;
  /** ISO 8601. */
  expiresAt: string;
}

export const SESSION_LOCALS_KEY = 'session';

/** The session for this request, or undefined when signed out. Never throws. */
export function currentSession(res: Response): SessionInfo | undefined {
  return res.locals[SESSION_LOCALS_KEY] as SessionInfo | undefined;
}

/** The session for this request; 401 UNAUTHORIZED when signed out. */
export function requireSession(res: Response): SessionInfo {
  const session = currentSession(res);
  if (!session) throw new UnauthorizedException('Sign in with your wallet first', { reason: 'SIGNED_OUT' });
  return session;
}
