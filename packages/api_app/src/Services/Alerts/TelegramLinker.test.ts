import { randomBytes, randomInt } from 'crypto';

import { base58Encode } from '@epoch/epoch-sdk';
import { alertPrefs, PostgresConnectionManager, runMigrations, telegramLinks } from '@epoch/pg_models';
import { eq, inArray } from 'drizzle-orm';

import { type FetchLike, TelegramClient, TelegramError, type TelegramUpdate } from './TelegramClient';
import { LINK_EXPIRED_TEXT, LINKED_TEXT, START_HELP_TEXT, TelegramLinker } from './TelegramLinker';

const TOKEN = '123456:SECRET-token-for-tests';

/** A Bot API stand-in: getUpdates answers from a queue (or waits until aborted), sendMessage is recorded. */
function fakeBotApi() {
  const queue: TelegramUpdate[][] = [];
  const requests: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: FetchLike = async (url, init) => {
    const method = url.split('/').pop() ?? '';
    requests.push({ url, method, body: JSON.parse(String(init.body)) });
    if (method === 'sendMessage') return reply({ ok: true, result: { message_id: 1 } });
    const next = queue.shift();
    if (next) return reply({ ok: true, result: next });
    // Long poll: hold until the linker stops.
    return new Promise<Response>((_, reject) =>
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
    );
  };
  return { queue, requests, fetchImpl, sent: () => requests.filter((r) => r.method === 'sendMessage') };
}

let updateId = randomInt(1_000, 1_000_000);
const start = (chatId: number, text: string): TelegramUpdate => ({
  update_id: updateId++,
  message: { message_id: 1, chat: { id: chatId, type: 'private' }, text },
});

async function failure(promise: Promise<unknown>): Promise<TelegramError> {
  try {
    await promise;
  } catch (error) {
    return error as TelegramError;
  }
  throw new Error('expected the call to fail');
}

describe('TelegramClient', () => {
  it('never puts the bot token in an error', async () => {
    const client = new TelegramClient(TOKEN, async () => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const network = await failure(client.sendMessage('1', 'hi'));
    expect(network).toBeInstanceOf(TelegramError);
    expect(network.message).not.toContain(TOKEN);
    expect(network.message).toContain('<token>');

    const rejecting = new TelegramClient(
      TOKEN,
      async () =>
        new Response(JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized for ${TOKEN}` }), {
          status: 401,
        }),
    );
    const unauthorized = await failure(rejecting.sendMessage('1', 'hi'));
    expect(unauthorized.message).toBe('Telegram sendMessage failed (401): Unauthorized for <token>');
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;

(TEST_DB ? describe : describe.skip)('TelegramLinker (TEST_DATABASE_URL)', () => {
  const db = () => PostgresConnectionManager.getDb();
  const wallets: string[] = [];

  async function linkCode(expiresInMs = 15 * 60_000) {
    const address = base58Encode(randomBytes(32));
    wallets.push(address);
    const code = randomBytes(18).toString('base64url');
    await db()
      .insert(telegramLinks)
      .values({ code, address, expiresAt: new Date(Date.now() + expiresInMs) });
    return { address, code };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });

  afterAll(async () => {
    if (wallets.length) {
      await db().delete(alertPrefs).where(inArray(alertPrefs.address, wallets));
      await db().delete(telegramLinks).where(inArray(telegramLinks.address, wallets));
    }
    await PostgresConnectionManager.close();
  });

  it('binds the chat on /start <code>, replies, and moves the offset past each update', async () => {
    const bot = fakeBotApi();
    const linker = new TelegramLinker(new TelegramClient(TOKEN, bot.fetchImpl), db);
    const fresh = await linkCode();
    const existing = await linkCode();
    await db()
      .insert(alertPrefs)
      .values({
        address: existing.address,
        rules: { offline: false, feeUp: true, losingMoney: false, rewardsLanded: true },
        email: 'kept@example.com',
        reminders: [],
        state: { keep: true },
      });
    const first = start(4242, `/start ${fresh.code}`);
    bot.queue.push([first, start(-1009, `/start@EpochAlertsBot ${existing.code}`), start(4242, 'hello')]);

    expect(await linker.pollOnce(0)).toBe(3);
    const [created] = await db().select().from(alertPrefs).where(eq(alertPrefs.address, fresh.address));
    expect(created).toMatchObject({
      telegram: '4242',
      email: null,
      rules: { offline: true, feeUp: true, losingMoney: true, rewardsLanded: false },
      reminders: [],
    });
    const [updated] = await db().select().from(alertPrefs).where(eq(alertPrefs.address, existing.address));
    expect(updated).toMatchObject({
      telegram: '-1009',
      email: 'kept@example.com',
      rules: { offline: false, feeUp: true, losingMoney: false, rewardsLanded: true },
      state: { keep: true },
    });
    expect(bot.sent().map((r) => r.body)).toEqual([
      expect.objectContaining({ chat_id: '4242', text: LINKED_TEXT(fresh.address) }),
      expect.objectContaining({ chat_id: '-1009', text: LINKED_TEXT(existing.address) }),
    ]);
    expect(LINKED_TEXT(fresh.address)).toBe(
      `Connected: Epoch alerts for ${fresh.address.slice(0, 4)}…${fresh.address.slice(-4)} will arrive here.`,
    );
    const [used] = await db().select().from(telegramLinks).where(eq(telegramLinks.code, fresh.code));
    expect(used.usedAt).toBeInstanceOf(Date);

    bot.queue.push([]);
    await linker.pollOnce(0);
    const polls = bot.requests.filter((r) => r.method === 'getUpdates');
    expect(polls[0].body).toMatchObject({ timeout: 0, allowed_updates: ['message'] });
    expect(polls[0].body.offset).toBeUndefined();
    expect(polls[1].body.offset).toBe(first.update_id + 3);
    expect(polls[1].url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
  });

  it('explains used, expired and unknown codes, and a bare /start', async () => {
    const bot = fakeBotApi();
    const linker = new TelegramLinker(new TelegramClient(TOKEN, bot.fetchImpl), db);
    const used = await linkCode();
    const expired = await linkCode(-60_000);
    bot.queue.push([start(1, `/start ${used.code}`)]);
    await linker.pollOnce(0);
    bot.queue.push([
      start(2, `/start ${used.code}`),
      start(3, `/start ${expired.code}`),
      start(4, '/start nope'),
      start(5, '/start'),
    ]);
    await linker.pollOnce(0);
    expect(bot.sent().map((r) => [r.body.chat_id, r.body.text])).toEqual([
      ['1', LINKED_TEXT(used.address)],
      ['2', LINK_EXPIRED_TEXT],
      ['3', LINK_EXPIRED_TEXT],
      ['4', LINK_EXPIRED_TEXT],
      ['5', START_HELP_TEXT],
    ]);
    const [prefs] = await db().select().from(alertPrefs).where(eq(alertPrefs.address, used.address));
    expect(prefs.telegram).toBe('1');
    expect(await db().select().from(alertPrefs).where(eq(alertPrefs.address, expired.address))).toEqual([]);
  });

  it('long-polls until stopped', async () => {
    const bot = fakeBotApi();
    const linker = new TelegramLinker(new TelegramClient(TOKEN, bot.fetchImpl), db, {
      pollSeconds: 50,
      retryDelayMs: 10,
    });
    linker.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await linker.stop();
    expect(bot.requests.filter((r) => r.method === 'getUpdates')).toHaveLength(1);
  });
});
