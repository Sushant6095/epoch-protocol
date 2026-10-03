import { createHash, generateKeyPairSync, sign } from 'crypto';
import { type AddressInfo } from 'net';

import { ExpressAppServer } from '@epoch/common_http_server';
import { base58Encode } from '@epoch/epoch-sdk';
import { ServiceUnavailableException } from '@epoch/exceptions';
import {
  alertPrefs,
  authNonces,
  PostgresConnectionManager,
  runMigrations,
  sessions,
  telegramLinks,
} from '@epoch/pg_models';
import { eq } from 'drizzle-orm';

import { buildSiwsMessage, type SiwsFields } from '../Lib/Siws';
import { buildAccountServices, setAccountServices } from '../Services/Account';
import { authRouter, meRouter, predictRouter, sessionMiddleware } from './AccountRouters';

/** A fresh ed25519 wallet: its base58 address and a signer (Node crypto, like a wallet's signMessage). */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { address: base58Encode(raw), sign: (text: string) => sign(null, Buffer.from(text, 'utf8'), privateKey) };
}
type Wallet = ReturnType<typeof wallet>;

const key = (seed: string) => base58Encode(createHash('sha256').update(seed).digest());
const VOTE_A = key('vote-a');
const VOTE_B = key('vote-b');
const STAKE = key('stake-account');
const APP_ORIGIN = 'http://localhost:3000';

interface Envelope<T = unknown> {
  status: number;
  body: { ok: boolean; data: T; error: { code: string; message: string; details?: Record<string, unknown> } };
  cookies: string[];
}

const TEST_DB = process.env.TEST_DATABASE_URL;

(TEST_DB ? describe : describe.skip)('account API over HTTP (TEST_DATABASE_URL)', () => {
  let server: ExpressAppServer;
  let base = '';
  const mails: { to: string; subject: string; text: string }[] = [];
  const telegram: { method: string; body: Record<string, unknown> }[] = [];
  let mailFails = false;
  const delegators = new Set<string>();

  async function call<T = unknown>(
    method: string,
    path: string,
    options: { body?: unknown; cookie?: string; origin?: string } = {},
  ): Promise<Envelope<T>> {
    const headers: Record<string, string> = { 'user-agent': 'jest-account-test' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.cookie) headers.cookie = options.cookie;
    if (options.origin) headers.origin = options.origin;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: res.status, body: (await res.json()) as Envelope<T>['body'], cookies: res.headers.getSetCookie() };
  }

  /** The SIWS message the app builds from a fresh nonce (`patch` changes fields before signing). */
  async function signedMessage(w: Wallet, patch: Partial<SiwsFields> = {}) {
    const { body } = await call<{ nonce: string; statement: string; issuedAt: string; expirationTime: string }>(
      'POST',
      '/v1/auth/siws/nonce',
    );
    const fields: SiwsFields = {
      domain: 'localhost:3000',
      address: w.address,
      statement: body.data.statement,
      uri: APP_ORIGIN,
      version: '1',
      chainId: 'mainnet',
      nonce: body.data.nonce,
      issuedAt: body.data.issuedAt,
      expirationTime: body.data.expirationTime,
      ...patch,
    };
    const message = buildSiwsMessage(fields);
    return { message, signature: base58Encode(w.sign(message)), nonce: body.data.nonce };
  }

  /** Signs in and returns the `name=value` cookie to send back. */
  async function signIn(w: Wallet = wallet()): Promise<{ cookie: string; wallet: Wallet }> {
    const { message, signature } = await signedMessage(w);
    const res = await call('POST', '/v1/auth/siws/verify', {
      body: { message, signature, address: w.address },
      origin: APP_ORIGIN,
    });
    expect(res.status).toBe(200);
    return { cookie: res.cookies[0].split(';')[0], wallet: w };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
    setAccountServices(
      buildAccountServices({
        env: {
          ...process.env,
          SIWS_ALLOWED_DOMAINS: 'localhost:3000,app.epoch.test',
          SESSION_COOKIE_NAME: 'epoch_session',
          SESSION_TTL_HOURS: '168',
          ALERTS_ENABLED: 'false',
          TELEGRAM_BOT_TOKEN: 'test-token-not-real',
          TELEGRAM_BOT_USERNAME: '@EpochAlertsBot',
          APP_PUBLIC_URL: 'https://app.epoch.test',
        },
        roleLookups: {
          delegator: async (address) => delegators.has(address),
          lender: async () => {
            throw new ServiceUnavailableException('no program here', 'PROGRAM_NOT_CONFIGURED');
          },
          operator: async () => false,
        },
        oracle: {
          epochSource: 'test',
          currentEpoch: async () => 9_000_000,
          latestFinal: async () => null,
          finalValue: async () => null,
          proposedValue: async () => null,
        },
        chain: {
          validators: async () => ({ epoch: { epoch: 1, slotIndex: 0 }, rows: [] }),
          stakeAccounts: async () => [],
          inflationRewards: async () => [],
        },
        telegramFetch: async (url, init) => {
          telegram.push({ method: url.split('/').pop() ?? '', body: JSON.parse(String(init.body)) });
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        },
        mailTransport: {
          sendMail: async (mail) => {
            if (mailFails) throw new Error('535 authentication failed');
            mails.push(mail);
          },
        },
      }),
    );
    server = new ExpressAppServer({ appName: 'account-test', port: 0 })
      .use(sessionMiddleware)
      .route('/v1/auth', authRouter)
      .route('/v1/me', meRouter)
      .route('/v1/predict', predictRouter);
    await server.start();
    base = `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await server.stop();
    setAccountServices(undefined);
    await PostgresConnectionManager.close();
  });

  describe('sign-in (request #7)', () => {
    it('issues a nonce, verifies the signed message, sets the cookie, reads it back and signs out', async () => {
      const w = wallet();
      delegators.add(w.address);
      const nonce = await call<{ nonce: string; issuedAt: string; expirationTime: string; domains: string[] }>(
        'POST',
        '/v1/auth/siws/nonce',
      );
      expect(nonce.status).toBe(200);
      expect(nonce.body.data.nonce).toMatch(/^[A-Za-z0-9]{8,}$/);
      expect(nonce.body.data.issuedAt).toMatch(/\+05:30$/);
      expect(Date.parse(nonce.body.data.expirationTime) - Date.parse(nonce.body.data.issuedAt)).toBe(10 * 60_000);
      expect(nonce.body.data.domains).toEqual(['localhost:3000', 'app.epoch.test']);
      const db = PostgresConnectionManager.getDb();
      const [stored] = await db.select().from(authNonces).where(eq(authNonces.nonce, nonce.body.data.nonce));
      expect(stored.usedAt).toBeNull();
      expect(stored.ip).toMatch(/127\.0\.0\.1/);

      const { message, signature } = await signedMessage(w);
      const verify = await call<{ address: string; roles: string[]; expiresAt: string }>(
        'POST',
        '/v1/auth/siws/verify',
        { body: { message, signature, address: w.address }, origin: APP_ORIGIN },
      );
      expect(verify.status).toBe(200);
      expect(verify.body.data).toMatchObject({ address: w.address, roles: ['delegator'] });
      expect(verify.body.data.expiresAt).toMatch(/\+05:30$/);
      expect(verify.cookies).toHaveLength(1);
      expect(verify.cookies[0]).toMatch(
        /^epoch_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=604800; Expires=.+; HttpOnly; SameSite=Lax$/,
      );
      const cookie = verify.cookies[0].split(';')[0];
      const token = cookie.split('=')[1];
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, createHash('sha256').update(token).digest('hex')));
      expect(row).toMatchObject({ address: w.address, revokedAt: null, userAgent: 'jest-account-test' });

      const session = await call('GET', '/v1/auth/session', { cookie });
      expect(session.body).toEqual({ ok: true, data: verify.body.data });
      expect((await call('GET', '/v1/auth/session')).body).toEqual({ ok: true, data: null });

      const out = await call('POST', '/v1/auth/logout', { cookie, origin: APP_ORIGIN });
      expect(out.body.data).toEqual({ signedOut: true });
      expect(out.cookies[0]).toMatch(/^epoch_session=; Path=\/; Max-Age=0; /);
      expect((await call('GET', '/v1/auth/session', { cookie })).body.data).toBeNull();
      expect((await call('GET', '/v1/me/watchlist', { cookie })).status).toBe(401);
      const [revoked] = await db.select().from(sessions).where(eq(sessions.id, row.id));
      expect(revoked.revokedAt).toBeInstanceOf(Date);
      expect((await call('POST', '/v1/auth/logout')).body.data).toEqual({ signedOut: true });
    });

    it('never accepts a nonce twice', async () => {
      const w = wallet();
      const { message, signature } = await signedMessage(w);
      expect((await call('POST', '/v1/auth/siws/verify', { body: { message, signature } })).status).toBe(200);
      const again = await call('POST', '/v1/auth/siws/verify', { body: { message, signature } });
      expect(again.status).toBe(401);
      expect(again.body.error.code).toBe('SIWS_NONCE_USED');
    });

    it('rejects an expired or unknown nonce', async () => {
      const w = wallet();
      const db = PostgresConnectionManager.getDb();
      const nonce = `expired${Date.now()}`;
      await db.insert(authNonces).values({ nonce, expiresAt: new Date(Date.now() - 60_000) });
      const message = buildSiwsMessage({ domain: 'localhost:3000', address: w.address, nonce });
      const expired = await call('POST', '/v1/auth/siws/verify', {
        body: { message, signature: base58Encode(w.sign(message)) },
      });
      expect([expired.status, expired.body.error.code]).toEqual([401, 'SIWS_NONCE_EXPIRED']);
      const unknownMessage = buildSiwsMessage({
        domain: 'localhost:3000',
        address: w.address,
        nonce: 'neverIssued123',
      });
      const unknown = await call('POST', '/v1/auth/siws/verify', {
        body: { message: unknownMessage, signature: base58Encode(w.sign(unknownMessage)) },
      });
      expect([unknown.status, unknown.body.error.code]).toEqual([401, 'SIWS_NONCE_UNKNOWN']);
    });

    it('rejects a domain outside SIWS_ALLOWED_DOMAINS without spending the nonce', async () => {
      const w = wallet();
      const evil = await signedMessage(w, { domain: 'epoch-app.evil.example' });
      const res = await call('POST', '/v1/auth/siws/verify', {
        body: { message: evil.message, signature: evil.signature },
      });
      expect([res.status, res.body.error.code]).toEqual([401, 'SIWS_DOMAIN_NOT_ALLOWED']);
      // The same nonce still works for the real domain.
      const message = buildSiwsMessage({ domain: 'app.epoch.test', address: w.address, nonce: evil.nonce });
      const ok = await call('POST', '/v1/auth/siws/verify', {
        body: { message, signature: Buffer.from(w.sign(message)).toString('base64') },
      });
      expect(ok.status).toBe(200);
    });

    it('answers a clear code for each failed check', async () => {
      const w = wallet();
      const other = wallet();
      const verify = (body: Record<string, unknown>) => call('POST', '/v1/auth/siws/verify', { body });
      const codeOf = async (body: Record<string, unknown>) => {
        const res = await verify(body);
        return [res.status, res.body.error.code];
      };

      const a = await signedMessage(w);
      expect(await codeOf({ message: a.message, signature: 'nope' })).toEqual([400, 'SIWS_SIGNATURE_MALFORMED']);
      expect(await codeOf({ message: `${a.message}\nExtra: line`, signature: a.signature })).toEqual([
        400,
        'SIWS_MESSAGE_INVALID',
      ]);
      expect(await codeOf({ message: a.message, signature: a.signature, address: other.address })).toEqual([
        401,
        'SIWS_ADDRESS_MISMATCH',
      ]);
      const forged = await signedMessage(w);
      expect(await codeOf({ message: forged.message, signature: base58Encode(other.sign(forged.message)) })).toEqual([
        401,
        'SIWS_SIGNATURE_INVALID',
      ]);
      const future = await signedMessage(w, { issuedAt: new Date(Date.now() + 10 * 60_000).toISOString() });
      expect(await codeOf(future)).toEqual([401, 'SIWS_ISSUED_IN_FUTURE']);
      const stale = await signedMessage(w, { expirationTime: new Date(Date.now() - 1_000).toISOString() });
      expect(await codeOf(stale)).toEqual([401, 'SIWS_MESSAGE_EXPIRED']);
      const early = await signedMessage(w, { notBefore: new Date(Date.now() + 60_000).toISOString() });
      expect(await codeOf(early)).toEqual([401, 'SIWS_NOT_YET_VALID']);
      const badKey = buildSiwsMessage({
        domain: 'localhost:3000',
        address: 'tFPVqpVspft3xEmA9cEYZ23zNt4aCKTkK9maKoVDBDFt',
      });
      expect(await codeOf({ message: badKey, signature: a.signature })).toEqual([400, 'SIWS_ADDRESS_INVALID']);
      const noNonce = buildSiwsMessage({ domain: 'localhost:3000', address: w.address });
      expect(await codeOf({ message: noNonce, signature: base58Encode(w.sign(noNonce)) })).toEqual([
        400,
        'SIWS_NONCE_MISSING',
      ]);
      expect(await codeOf({ message: a.message })).toEqual([400, 'BAD_REQUEST']);
    });

    it('treats a garbage or unknown cookie as signed out', async () => {
      for (const cookie of ['epoch_session=garbage', 'epoch_session=', `epoch_session=${'x'.repeat(300)}`]) {
        const res = await call('GET', '/v1/auth/session', { cookie });
        expect([res.status, res.body.data]).toEqual([200, null]);
      }
    });

    it('ignores the cookie on requests from another site: no writes, no reads', async () => {
      const { cookie, wallet: w } = await signIn();
      const body = { votes: [VOTE_A] };
      const evil = 'https://evil.example';
      const write = await call('PUT', '/v1/me/watchlist', { body, cookie, origin: evil });
      expect([write.status, write.body.error.code]).toEqual([403, 'ORIGIN_NOT_ALLOWED']);
      expect((await call('PUT', '/v1/me/watchlist', { body, cookie, origin: 'https://app.epoch.test' })).status).toBe(
        200,
      );
      expect((await call('PUT', '/v1/me/watchlist', { body, cookie })).status).toBe(200);
      // Reads: another site (or a sandboxed "null" origin) sees a signed-out API.
      expect((await call('GET', '/v1/auth/session', { cookie, origin: evil })).body.data).toBeNull();
      expect((await call('GET', '/v1/auth/session', { cookie, origin: 'null' })).body.data).toBeNull();
      expect((await call('GET', '/v1/me/watchlist', { cookie, origin: evil })).status).toBe(401);
      expect((await call('GET', '/v1/auth/session', { cookie, origin: APP_ORIGIN })).body.data).toMatchObject({
        address: w.address,
      });
      const verify = await call('POST', '/v1/auth/siws/verify', {
        body: { message: 'x', signature: 'y' },
        origin: evil,
      });
      expect([verify.status, verify.body.error.code]).toEqual([403, 'ORIGIN_NOT_ALLOWED']);
    });
  });

  describe('watchlist (request #14)', () => {
    it('starts empty, de-duplicates in order, validates keys and caps at 200', async () => {
      const { cookie } = await signIn();
      expect((await call('GET', '/v1/me/watchlist', { cookie })).body.data).toEqual({ votes: [] });
      const saved = await call('PUT', '/v1/me/watchlist', { cookie, body: { votes: [VOTE_B, VOTE_A, VOTE_B] } });
      expect(saved.body.data).toEqual({ votes: [VOTE_B, VOTE_A] });
      expect((await call('GET', '/v1/me/watchlist', { cookie })).body.data).toEqual({ votes: [VOTE_B, VOTE_A] });

      const bad = await call('PUT', '/v1/me/watchlist', { cookie, body: { votes: [VOTE_A, 'not-a-key'] } });
      expect([bad.status, bad.body.error.code]).toEqual([400, 'BAD_REQUEST']);
      const many = Array.from({ length: 201 }, (_, i) => key(`many-${i}`));
      const tooLong = await call('PUT', '/v1/me/watchlist', { cookie, body: { votes: many } });
      expect([tooLong.status, tooLong.body.error.code, tooLong.body.error.details]).toEqual([
        400,
        'WATCHLIST_TOO_LONG',
        { max: 200, count: 201 },
      ]);
      const exactly = await call('PUT', '/v1/me/watchlist', {
        cookie,
        body: { votes: [...many.slice(0, 200), many[0]] },
      });
      expect(exactly.body.data).toEqual({ votes: many.slice(0, 200) });
      expect((await call('GET', '/v1/me/watchlist')).status).toBe(401);
    });
  });

  describe('alerts (request #15)', () => {
    it('serves defaults, saves rules, channels and reminders, and keeps state', async () => {
      const { cookie, wallet: w } = await signIn();
      expect((await call('GET', '/v1/me/alerts', { cookie })).body.data).toEqual({
        rules: { offline: true, feeUp: true, losingMoney: true, rewardsLanded: false },
        channels: { email: null, telegram: null },
        reminders: [],
      });
      const reminder = { kind: 'move-step-2', epoch: 9_999_999, stakeAccount: STAKE };
      const prefs = {
        rules: { offline: true, feeUp: false, losingMoney: true, rewardsLanded: true },
        channels: { email: ' me@example.com ', telegram: '123456789' },
        reminders: [reminder, reminder],
      };
      const saved = await call('PUT', '/v1/me/alerts', { cookie, body: prefs });
      expect(saved.body.data).toEqual({
        rules: prefs.rules,
        channels: { email: 'me@example.com', telegram: '123456789' },
        reminders: [reminder],
      });

      const db = PostgresConnectionManager.getDb();
      await db
        .update(alertPrefs)
        .set({ state: { custom: 1 } })
        .where(eq(alertPrefs.address, w.address));
      // Channels and reminders left out keep their values; "" turns a channel off.
      const partial = await call('PUT', '/v1/me/alerts', {
        cookie,
        body: { rules: { ...prefs.rules, feeUp: true }, channels: { email: '' } },
      });
      expect(partial.body.data).toEqual({
        rules: { ...prefs.rules, feeUp: true },
        channels: { email: null, telegram: '123456789' },
        reminders: [reminder],
      });
      const [row] = await db.select().from(alertPrefs).where(eq(alertPrefs.address, w.address));
      expect(row.state).toMatchObject({ custom: 1 });

      const invalid = async (body: unknown) => (await call('PUT', '/v1/me/alerts', { cookie, body })).status;
      expect(await invalid({ ...prefs, channels: { email: 'not-an-email' } })).toBe(400);
      expect(await invalid({ ...prefs, channels: { telegram: '@someone' } })).toBe(400);
      expect(
        await invalid({ ...prefs, reminders: Array.from({ length: 21 }, (_, i) => ({ ...reminder, epoch: i })) }),
      ).toBe(400);
      expect(await invalid({ ...prefs, reminders: [{ ...reminder, stakeAccount: 'nope' }] })).toBe(400);
      expect(await invalid({ rules: { offline: true } })).toBe(400);
    });

    it('creates a Telegram link and sends a test alert to each channel', async () => {
      const { cookie, wallet: w } = await signIn();
      const link = await call<{ url: string; code: string; expiresAt: string }>('POST', '/v1/me/alerts/telegram-link', {
        cookie,
      });
      expect(link.status).toBe(200);
      expect(link.body.data.url).toBe(`https://t.me/EpochAlertsBot?start=${link.body.data.code}`);
      expect(link.body.data.code).toMatch(/^[A-Za-z0-9_-]{24}$/);
      const db = PostgresConnectionManager.getDb();
      const [stored] = await db.select().from(telegramLinks).where(eq(telegramLinks.code, link.body.data.code));
      expect(stored.address).toBe(w.address);
      expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

      expect((await call('POST', '/v1/me/alerts/test', { cookie })).body.data).toEqual({
        email: 'skipped',
        telegram: 'skipped',
      });
      await call('PUT', '/v1/me/alerts', {
        cookie,
        body: {
          rules: { offline: true, feeUp: true, losingMoney: true, rewardsLanded: false },
          channels: { email: 'alerts@example.com', telegram: '-100200300' },
        },
      });
      const sentBefore = telegram.length;
      expect((await call('POST', '/v1/me/alerts/test', { cookie })).body.data).toEqual({
        email: 'sent',
        telegram: 'sent',
      });
      expect(mails.at(-1)).toMatchObject({ to: 'alerts@example.com', subject: 'Epoch: Test alert from Epoch' });
      expect(telegram.slice(sentBefore)).toEqual([
        {
          method: 'sendMessage',
          body: expect.objectContaining({
            chat_id: '-100200300',
            text: expect.stringContaining('Test alert from Epoch'),
          }),
        },
      ]);
      mailFails = true;
      expect((await call('POST', '/v1/me/alerts/test', { cookie })).body.data).toEqual({
        email: 'failed',
        telegram: 'sent',
      });
      mailFails = false;
    });

    it('answers 503 TELEGRAM_NOT_CONFIGURED without a bot', async () => {
      const bare = buildAccountServices({
        env: { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_USERNAME: '' },
        roleLookups: { delegator: async () => false, lender: async () => false, operator: async () => false },
        oracle: {
          epochSource: 'test',
          currentEpoch: async () => 1,
          latestFinal: async () => null,
          finalValue: async () => null,
          proposedValue: async () => null,
        },
        chain: {
          validators: async () => ({ epoch: { epoch: 1, slotIndex: 0 }, rows: [] }),
          stakeAccounts: async () => [],
          inflationRewards: async () => [],
        },
      });
      await expect(bare.alerts.createTelegramLink(key('nobody'))).rejects.toMatchObject({
        statusCode: 503,
        code: 'TELEGRAM_NOT_CONFIGURED',
      });
    });
  });
});
