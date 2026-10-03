import { clearCookie, parseCookies, type Request, type Response, setCookie } from '@epoch/common_http_server';
import { Logger } from '@epoch/logger';

import { dbAvailable } from '../Lib/Db';
import { currentSession } from '../Lib/Session';
import { type SiwsVerifyBody } from '../dto/Account.dto';
import { getAccountServices } from '../Services/Account';
import { hashSessionToken } from '../Services/Auth/SessionStore';
import { type SessionView, type SiwsNonce } from '../types/Account.types';

const logger = Logger.create('AuthController');

/** Sign-In With Solana and the session cookie (request #7). */
export class AuthController {
  /** POST /v1/auth/siws/nonce */
  static async nonce(req: Request, res: Response): Promise<SiwsNonce> {
    res.setHeader('cache-control', 'no-store');
    return getAccountServices().auth.issueNonce(req.ip);
  }

  /** POST /v1/auth/siws/verify { message, signature, address? } → sets the session cookie. */
  static async verify(req: Request, res: Response): Promise<SessionView> {
    res.setHeader('cache-control', 'no-store');
    const { auth } = getAccountServices();
    const body = res.locals.body as SiwsVerifyBody;
    const { token, session } = await auth.verify(body, { ip: req.ip, userAgent: req.get('user-agent') });
    setCookie(res, auth.cookieName, token, auth.cookieOptions());
    return auth.view(session);
  }

  /** POST /v1/auth/logout: revokes the session behind the cookie and clears it; fine when already signed out. */
  static async logout(req: Request, res: Response): Promise<{ signedOut: true }> {
    res.setHeader('cache-control', 'no-store');
    const { auth, sessions } = getAccountServices();
    const token = parseCookies(req)[auth.cookieName];
    const id = currentSession(res)?.id ?? (token ? hashSessionToken(token) : undefined);
    if (id && dbAvailable()) {
      // The browser is signed out either way; a failed revoke only leaves a cookie nobody holds any more.
      await sessions
        .revoke(id)
        .catch((error: unknown) => logger.warn('revoking a session failed', { error: String(error) }));
    }
    const { maxAgeSeconds: _maxAge, ...attributes } = auth.cookieOptions();
    clearCookie(res, auth.cookieName, attributes);
    return { signedOut: true };
  }

  /** GET /v1/auth/session → the session with roles, or null when signed out (200 either way). */
  static async session(_req: Request, res: Response): Promise<SessionView | null> {
    res.setHeader('cache-control', 'no-store');
    const session = currentSession(res);
    return session ? getAccountServices().auth.view(session) : null;
  }
}
