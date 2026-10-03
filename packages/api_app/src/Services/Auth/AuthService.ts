import { randomBytes } from 'crypto';

import { type CookieOptions } from '@epoch/common_http_server';
import { type AuthConfig } from '@epoch/config-sdk';
import { base58Encode } from '@epoch/epoch-sdk';
import { EpochException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import { authNonces, type EpochDb } from '@epoch/pg_models';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { decodePublicKey, decodeSignature } from '../../Lib/Keys';
import { RateLimiter } from '../../Lib/RateLimiter';
import { type SessionInfo } from '../../Lib/Session';
import { parseSiwsMessage, SiwsParseError, type SiwsFields, verifyEd25519 } from '../../Lib/Siws';
import { isoIst, shortKey } from '../../Lib/Stats';
import { type SessionView, type SiwsNonce } from '../../types/Account.types';
import { type RoleResolver } from './RoleResolver';
import { type SessionStore } from './SessionStore';

const logger = Logger.create('AuthService');

/** How far in the future a wallet's clock may put `Issued At`. */
const ISSUED_AT_SKEW_MS = 5 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;

/** 400: the request is malformed. 401: it is well-formed but does not prove the wallet signed in just now. */
const rejected = (status: 400 | 401, code: string, message: string, details: Record<string, unknown> = {}) =>
  new EpochException(message, code, status, details);

export interface VerifyInput {
  /** The exact text the wallet signed. */
  message: string;
  /** 64-byte ed25519 signature, base58 or base64. */
  signature: string;
  /** When sent, must equal the address in the message. */
  address?: string;
}

export interface AuthServiceDeps {
  db: () => EpochDb;
  config: AuthConfig;
  sessions: SessionStore;
  roles: RoleResolver;
  now?: () => number;
  /** Nonce and verify requests per IP per minute. */
  perIpPerMinute?: number;
}

/** Sign-In With Solana (request #7): one-time nonces, message checks, signature check, session cookie. */
export class AuthService {
  private readonly now: () => number;
  private readonly allowedDomains: Set<string>;
  private readonly nonceLimiter: RateLimiter;
  private readonly verifyLimiter: RateLimiter;
  private lastPruneAt = 0;

  constructor(private readonly deps: AuthServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.allowedDomains = new Set(deps.config.SIWS_ALLOWED_DOMAINS.map((domain) => domain.toLowerCase()));
    this.nonceLimiter = new RateLimiter(deps.perIpPerMinute ?? 30, 60_000, this.now);
    this.verifyLimiter = new RateLimiter(deps.perIpPerMinute ?? 30, 60_000, this.now);
    if (deps.config.SESSION_COOKIE_SAMESITE === 'none' && !deps.config.SESSION_COOKIE_SECURE) {
      logger.warn('SESSION_COOKIE_SAMESITE=none needs SESSION_COOKIE_SECURE=true, or browsers drop the cookie');
    }
  }

  get cookieName(): string {
    return this.deps.config.SESSION_COOKIE_NAME;
  }

  /** Attributes of the session cookie (HttpOnly, Path=/, Max-Age = SESSION_TTL_HOURS; Secure, SameSite, Domain). */
  cookieOptions(): CookieOptions {
    const { config } = this.deps;
    return {
      maxAgeSeconds: config.SESSION_TTL_HOURS * 3_600,
      httpOnly: true,
      secure: config.SESSION_COOKIE_SECURE,
      sameSite: config.SESSION_COOKIE_SAMESITE,
      domain: config.SESSION_COOKIE_DOMAIN,
      path: '/',
    };
  }

  /** POST /v1/auth/siws/nonce: a fresh single-use nonce, stored with its expiry and the caller's IP. */
  async issueNonce(ip: string | undefined): Promise<SiwsNonce> {
    this.nonceLimiter.consume(`nonce:${ip ?? 'unknown'}`, 'Too many sign-in requests from your network; wait a minute');
    const { config } = this.deps;
    // 16 random bytes in base58: 16–22 alphanumeric characters (SIWS asks for at least 8).
    const nonce = base58Encode(randomBytes(16));
    const issuedAt = new Date(this.now());
    const expiresAt = new Date(issuedAt.getTime() + config.SIWS_NONCE_TTL_MINUTES * 60_000);
    await this.deps
      .db()
      .insert(authNonces)
      .values({ nonce, expiresAt, ip: ip ?? null });
    this.pruneSoon();
    return {
      nonce,
      statement: config.SIWS_STATEMENT,
      issuedAt: isoIst(issuedAt),
      expirationTime: isoIst(expiresAt),
      domains: config.SIWS_ALLOWED_DOMAINS,
    };
  }

  /**
   * POST /v1/auth/siws/verify. Checks, in order: the message parses; its domain is allowed; the address is a 32-byte
   * key (and equals `address` when sent); the nonce exists, is unused and unexpired (consumed atomically, so it never
   * works twice); Issued At is at most 5 minutes ahead; Expiration Time (if any) is in the future; Not Before (if any)
   * is in the past; the ed25519 signature covers the UTF-8 bytes of the message. Then opens a session.
   */
  async verify(
    input: VerifyInput,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ token: string; session: SessionInfo }> {
    this.verifyLimiter.consume(`verify:${meta.ip ?? 'unknown'}`, 'Too many sign-in attempts from your network');
    const signature = decodeSignature(input.signature);
    if (!signature) {
      throw rejected(400, 'SIWS_SIGNATURE_MALFORMED', 'The signature must be 64 bytes in base58 or base64');
    }
    const fields = this.parse(input.message);

    if (!this.allowedDomains.has(fields.domain.toLowerCase())) {
      throw rejected(401, 'SIWS_DOMAIN_NOT_ALLOWED', `Sign-in for ${fields.domain} is not accepted by this API`, {
        domain: fields.domain,
        allowed: [...this.allowedDomains],
      });
    }
    const publicKey = decodePublicKey(fields.address);
    if (!publicKey) {
      throw rejected(400, 'SIWS_ADDRESS_INVALID', 'The address in the message is not a Solana public key');
    }
    if (input.address !== undefined && input.address !== fields.address) {
      throw rejected(401, 'SIWS_ADDRESS_MISMATCH', 'The address does not match the one in the signed message');
    }
    if (!fields.nonce) {
      throw rejected(400, 'SIWS_NONCE_MISSING', 'The message has no Nonce: fetch one from /v1/auth/siws/nonce');
    }
    await this.consumeNonce(fields.nonce);

    const now = this.now();
    if (fields.issuedAt && Date.parse(fields.issuedAt) > now + ISSUED_AT_SKEW_MS) {
      throw rejected(401, 'SIWS_ISSUED_IN_FUTURE', 'Issued At is in the future: check the device clock and sign again');
    }
    if (fields.expirationTime && Date.parse(fields.expirationTime) <= now) {
      throw rejected(401, 'SIWS_MESSAGE_EXPIRED', 'The sign-in message expired: sign again');
    }
    if (fields.notBefore && Date.parse(fields.notBefore) > now) {
      throw rejected(401, 'SIWS_NOT_YET_VALID', 'The sign-in message is not valid yet (Not Before)');
    }
    if (!verifyEd25519(Buffer.from(input.message, 'utf8'), signature, publicKey)) {
      throw rejected(401, 'SIWS_SIGNATURE_INVALID', 'The signature does not match the message and address');
    }

    const created = await this.deps.sessions.create(fields.address, this.deps.config.SESSION_TTL_HOURS, meta.userAgent);
    logger.info('signed in', { wallet: shortKey(fields.address), session: created.session.id.slice(0, 8) });
    return created;
  }

  /** What GET /v1/auth/session and verify answer: the address, its roles from chain and the expiry. */
  async view(session: SessionInfo): Promise<SessionView> {
    return {
      address: session.address,
      roles: await this.deps.roles.rolesOf(session.address),
      expiresAt: session.expiresAt,
    };
  }

  private parse(message: string): SiwsFields {
    try {
      return parseSiwsMessage(message);
    } catch (error) {
      if (error instanceof SiwsParseError) {
        throw rejected(400, 'SIWS_MESSAGE_INVALID', `Not a Sign-In With Solana message: ${error.message}`, {
          reason: error.message,
        });
      }
      throw error;
    }
  }

  /** Marks the nonce used only if it exists, is unused and unexpired, in one statement; otherwise says why not. */
  private async consumeNonce(nonce: string): Promise<void> {
    const db = this.deps.db();
    const used = await db
      .update(authNonces)
      .set({ usedAt: sql`now()` })
      .where(and(eq(authNonces.nonce, nonce), isNull(authNonces.usedAt), gt(authNonces.expiresAt, sql`now()`)))
      .returning({ nonce: authNonces.nonce });
    if (used.length > 0) return;
    const [row] = await db.select({ usedAt: authNonces.usedAt }).from(authNonces).where(eq(authNonces.nonce, nonce));
    if (!row) throw rejected(401, 'SIWS_NONCE_UNKNOWN', 'Unknown nonce: fetch a new one and sign again');
    if (row.usedAt)
      throw rejected(401, 'SIWS_NONCE_USED', 'This nonce was already used: fetch a new one and sign again');
    throw rejected(401, 'SIWS_NONCE_EXPIRED', 'This nonce expired: fetch a new one and sign again');
  }

  /** At most hourly, in the background: drop nonces and sessions that expired long ago. */
  private pruneSoon(): void {
    const now = this.now();
    if (now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    Promise.resolve()
      .then(async () => {
        await this.deps
          .db()
          .delete(authNonces)
          .where(sql`${authNonces.expiresAt} < now() - interval '1 day'`);
        await this.deps.sessions.pruneExpired();
      })
      .catch((error: unknown) => logger.warn('pruning old nonces and sessions failed', { error: String(error) }));
  }
}
