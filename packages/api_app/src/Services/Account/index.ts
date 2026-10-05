import { GracefulShutdown } from '@epoch/common';
import {
  AlertsConfigSchema,
  AuthConfigSchema,
  loadConfig,
  PredictConfigSchema,
  type AlertsConfig,
  type AuthConfig,
  type PredictConfig,
} from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { type EpochDb } from '@epoch/pg_models';
import { createTransport } from 'nodemailer';

import { requireDb } from '../../Lib/Db';
import { bus } from '../../Lib/EventBus';
import { AlertJob, type AlertJobDeps } from '../Alerts/AlertJob';
import { AlertPrefsService } from '../Alerts/AlertPrefsService';
import { type AlertSenders, EmailAlertSender, type MailTransport, TelegramAlertSender } from '../Alerts/AlertSenders';
import { type FetchLike, TelegramClient } from '../Alerts/TelegramClient';
import { TelegramLinker } from '../Alerts/TelegramLinker';
import { AuthService } from '../Auth/AuthService';
import { type RoleLookups, RoleResolver } from '../Auth/RoleResolver';
import { SessionStore } from '../Auth/SessionStore';
import { getServices } from '../index';
import { WatchlistService } from '../Me/WatchlistService';
import { type FeeIndexOracle, LiveFeeIndexOracle } from '../Predict/FeeIndexOracle';
import { PredictMarketMaker, PredictResolver } from '../Predict/PredictJobs';
import { PredictService } from '../Predict/PredictService';

const logger = Logger.create('AccountServices');

/** Sign-in, watchlist, alerts and Predict (requests #7, #11, #14, #15). Everything here needs Postgres. */
export interface AccountServices {
  config: { auth: AuthConfig; alerts: AlertsConfig; predict: PredictConfig };
  sessions: SessionStore;
  roles: RoleResolver;
  auth: AuthService;
  watchlist: WatchlistService;
  alerts: AlertPrefsService;
  predict: PredictService;
  oracle: FeeIndexOracle;
  jobs: {
    /** Undefined when ALERTS_ENABLED=false. */
    alerts?: AlertJob;
    /** Undefined without TELEGRAM_BOT_TOKEN. */
    telegram?: TelegramLinker;
    marketMaker: PredictMarketMaker;
    resolver: PredictResolver;
  };
}

/** What the account services read from outside Postgres; `liveAccountDeps()` in production, fakes in tests. */
export interface AccountDeps {
  env?: NodeJS.ProcessEnv;
  db?: () => EpochDb;
  roleLookups: RoleLookups;
  oracle: FeeIndexOracle;
  /** Mainnet reads for the alert job. */
  chain: Pick<AlertJobDeps, 'validators' | 'stakeAccounts' | 'inflationRewards'>;
  /** Telegram Bot API transport (tests pass a fake; production uses fetch). */
  telegramFetch?: FetchLike;
  /** Email transport (tests pass a fake; production uses nodemailer with SMTP_URL). */
  mailTransport?: MailTransport;
  now?: () => number;
}

/** nodemailer with SMTP_URL; a malformed URL turns email off (logged) instead of failing every account route. */
function smtpTransport(url: string | undefined): MailTransport | undefined {
  if (!url) return undefined;
  try {
    return createTransport(url);
  } catch (error) {
    logger.error('SMTP_URL is not usable: email alerts are off', undefined, {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return undefined;
  }
}

/** The SMTP password, raw and decoded, so an error that echoes the URL is redacted. */
function smtpSecrets(url: string | undefined): string[] {
  if (!url) return [];
  try {
    const password = new URL(url).password;
    return password ? [password, decodeURIComponent(password)] : [];
  } catch {
    return [];
  }
}

export function buildAccountServices(deps: AccountDeps): AccountServices {
  const env = deps.env ?? process.env;
  const config = {
    auth: loadConfig(AuthConfigSchema, env),
    alerts: loadConfig(AlertsConfigSchema, env),
    predict: loadConfig(PredictConfigSchema, env),
  };
  const db = deps.db ?? requireDb;
  const now = deps.now ?? Date.now;
  if (config.predict.PREDICT_REAL_SOL) {
    logger.warn(
      'PREDICT_REAL_SOL is superseded (3 Oct 2026): real-money Predict is USDC through Panta at /v1/predict/panta, ' +
        'switched by PANTA_TRADING_ENABLED; points mode is unchanged',
    );
  }

  const telegramClient = config.alerts.TELEGRAM_BOT_TOKEN
    ? new TelegramClient(config.alerts.TELEGRAM_BOT_TOKEN, deps.telegramFetch)
    : undefined;
  const transport = deps.mailTransport ?? smtpTransport(config.alerts.SMTP_URL);
  const appUrl = config.alerts.APP_PUBLIC_URL.replace(/\/+$/, '');
  const senders: AlertSenders = {
    email: new EmailAlertSender(
      transport,
      config.alerts.ALERTS_EMAIL_FROM,
      `${appUrl}/me#alerts`,
      smtpSecrets(config.alerts.SMTP_URL),
    ),
    telegram: new TelegramAlertSender(telegramClient),
  };

  const sessions = new SessionStore(db, undefined, now);
  const roles = new RoleResolver(deps.roleLookups, undefined, now);
  return {
    config,
    sessions,
    roles,
    auth: new AuthService({ db, config: config.auth, sessions, roles, now }),
    watchlist: new WatchlistService(db),
    alerts: new AlertPrefsService({
      db,
      senders,
      telegramBotUsername: config.alerts.TELEGRAM_BOT_USERNAME,
      appUrl,
      now,
    }),
    predict: new PredictService({
      db,
      oracle: deps.oracle,
      config: config.predict,
      emit: (event) => bus.emit('predictCall', event),
    }),
    oracle: deps.oracle,
    jobs: {
      alerts: config.alerts.ALERTS_ENABLED
        ? new AlertJob({
            db,
            ...deps.chain,
            senders,
            appUrl,
            intervalMs: config.alerts.ALERTS_CHECK_MINUTES * 60_000,
            now,
          })
        : undefined,
      telegram: telegramClient ? new TelegramLinker(telegramClient, db) : undefined,
      marketMaker: new PredictMarketMaker(db, deps.oracle, config.predict.PREDICT_MARKETS_AHEAD),
      resolver: new PredictResolver(db, deps.oracle),
    },
  };
}

/** Production dependencies: chain reads through getServices() (mainnet RPC, the Epoch program). */
export function liveAccountDeps(env: NodeJS.ProcessEnv = process.env): AccountDeps {
  const services = getServices();
  const predict = loadConfig(PredictConfigSchema, env);
  return {
    env,
    roleLookups: {
      delegator: async (address) => (await services.solana.getStakeAccountsByAuthority(address)).length > 0,
      lender: async (address) =>
        Object.values(await services.program.lenderAccounts(address)).some(
          (lender) => lender !== null && (lender.account.shares > 0n || lender.account.pendingShares > 0n),
        ),
      operator: async (address) => (await services.program.positionsByOperator(address)).length > 0,
    },
    oracle: new LiveFeeIndexOracle(services.program, services.market, requireDb, predict.PREDICT_RESOLVE_FROM_DB),
    chain: {
      validators: async () => {
        const table = await services.validators.get();
        return { epoch: table.epoch, rows: table.rows };
      },
      stakeAccounts: (address) => services.solana.getStakeAccountsByAuthority(address),
      inflationRewards: (addresses, epoch) => services.solana.getInflationReward(addresses, epoch),
    },
  };
}

let account: AccountServices | undefined;

/** One set per process, built on first use. */
export function getAccountServices(): AccountServices {
  if (!account) account = buildAccountServices(liveAccountDeps());
  return account;
}

/** Tests: swap in services built from fakes (or undefined to rebuild from the environment). */
export function setAccountServices(next: AccountServices | undefined): void {
  account = next;
}

/**
 * Starts the alert sender, the Telegram linker and Predict's market maker and resolver (call only when Postgres is
 * configured). Each job logs and retries on its own schedule; a failure to start one never stops the others.
 */
export function startAccountJobs(services?: AccountServices): void {
  let resolved: AccountServices;
  try {
    resolved = services ?? getAccountServices();
  } catch (error) {
    logger.error('account jobs not started: invalid sign-in, alerts or Predict configuration', error);
    return;
  }
  const { jobs } = resolved;
  const starts: [string, (() => void) | undefined][] = [
    ['alerts', jobs.alerts && (() => jobs.alerts?.start())],
    ['telegram-linker', jobs.telegram && (() => jobs.telegram?.start())],
    ['predict-market-maker', () => jobs.marketMaker.start()],
    ['predict-resolver', () => jobs.resolver.start()],
  ];
  for (const [name, start] of starts) {
    if (!start) {
      logger.info('job off', { job: name });
      continue;
    }
    try {
      start();
    } catch (error) {
      logger.error('job failed to start', error, { job: name });
    }
  }
  GracefulShutdown.register('account-jobs', () => stopAccountJobs(resolved));
}

export async function stopAccountJobs(services: AccountServices | undefined = account): Promise<void> {
  if (!services) return;
  const { jobs } = services;
  await Promise.allSettled([jobs.alerts?.stop(), jobs.telegram?.stop(), jobs.marketMaker.stop(), jobs.resolver.stop()]);
}
