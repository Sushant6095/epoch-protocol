import {
  type AlertMessage,
  DEFAULT_ALERT_RULES,
  evaluateWalletAlerts,
  formatSol,
  readAlertState,
  rewardsAlert,
  trackDelinquency,
  type ValidatorFacts,
  type WalletAlertInput,
} from './AlertRules';
import { plainText } from './AlertSenders';

const APP = 'https://epoch.app/';
const HELIUS = 'he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk';
const DOCOMO = 'FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk';
const HORIZON = 'mrgn2vsZ5EJ8YEfAMNPXmRux7th9cNfBasQ1JJvVwPn';
const STAKE = '6UsGxa3PeMi7yzXZE9yMNqo8Nx3NfiG9dxHL6ECeaFFH';

const validator = (vote: string, name: string, patch: Partial<ValidatorFacts> = {}): ValidatorFacts => ({
  vote,
  name,
  commissionPct: 5,
  mevCommissionPct: 10,
  healthPerEpochSol: 1.2,
  delinquent: false,
  ...patch,
});

const input = (patch: Partial<WalletAlertInput> = {}): WalletAlertInput => ({
  epoch: 1044,
  rules: { offline: true, feeUp: true, losingMoney: true, rewardsLanded: true },
  votes: [HELIUS, DOCOMO, HORIZON],
  validators: new Map(
    [
      validator(HELIUS, 'Helius', { commissionPct: 0, mevCommissionPct: null }),
      validator(DOCOMO, 'NTT DOCOMO GLOBAL'),
      validator(HORIZON, 'Project 0 Horizon', { healthPerEpochSol: -0.46 }),
    ].map((v) => [v.vote, v]),
  ),
  offline: new Set(),
  state: {},
  reminders: [],
  appUrl: APP,
  ...patch,
});

const keys = (alerts: AlertMessage[]) => alerts.map((alert) => alert.dedupeKey);

describe('trackDelinquency', () => {
  it('needs two checks at least 10 minutes apart, and forgets a validator that votes again', () => {
    const t0 = 1_000_000;
    let step = trackDelinquency(new Map(), [HELIUS], t0);
    expect([...step.offline]).toEqual([]);
    step = trackDelinquency(step.firstSeen, [HELIUS, DOCOMO], t0 + 5 * 60_000);
    expect([...step.offline]).toEqual([]);
    step = trackDelinquency(step.firstSeen, [HELIUS, DOCOMO], t0 + 10 * 60_000);
    expect([...step.offline]).toEqual([HELIUS]);
    step = trackDelinquency(step.firstSeen, [DOCOMO], t0 + 15 * 60_000);
    expect([...step.offline]).toEqual([DOCOMO]);
    expect(step.firstSeen.has(HELIUS)).toBe(false);
    step = trackDelinquency(step.firstSeen, [HELIUS], t0 + 16 * 60_000);
    expect([...step.offline]).toEqual([]);
  });
});

describe('evaluateWalletAlerts', () => {
  it('first sight records fees and alerts only on losing money; offline needs the tracker', () => {
    const result = evaluateWalletAlerts(input());
    expect(keys(result.alerts)).toEqual([`breakeven:${HORIZON}:1044`]);
    expect(result.alerts[0]).toMatchObject({
      kind: 'breakeven',
      title: 'Validator starts losing money',
      link: `https://epoch.app/validators/${HORIZON}`,
    });
    expect(result.alerts[0].body).toContain(
      'Project 0 Horizon earns less than its vote fees (-0.46 SOL kept per epoch)',
    );
    expect(result.state.fees).toEqual({
      [HELIUS]: { commissionPct: 0, mevCommissionPct: null },
      [DOCOMO]: { commissionPct: 5, mevCommissionPct: 10 },
      [HORIZON]: { commissionPct: 5, mevCommissionPct: 10 },
    });
  });

  it('alerts when the commission or the MEV fee goes up, not when it goes down or MEV appears', () => {
    const state = {
      fees: {
        [HELIUS]: { commissionPct: 0, mevCommissionPct: null },
        [DOCOMO]: { commissionPct: 4, mevCommissionPct: 10 },
        [HORIZON]: { commissionPct: 7, mevCommissionPct: 8 },
      },
      rewardsEpoch: 1043,
    };
    const validators = new Map(input().validators);
    validators.set(HELIUS, validator(HELIUS, 'Helius', { commissionPct: 0, mevCommissionPct: 5 }));
    const result = evaluateWalletAlerts(
      input({ state, validators, rules: { ...DEFAULT_ALERT_RULES, losingMoney: false } }),
    );
    expect(result.alerts.map((a) => [a.dedupeKey, a.body])).toEqual([
      [
        `fee:${DOCOMO}:1044`,
        'NTT DOCOMO GLOBAL raised its commission from 4% to 5%. You keep less of what your stake earns there.',
      ],
      [
        `fee:${HORIZON}:1044`,
        'Project 0 Horizon raised its MEV fee from 8% to 10%. You keep less of what your stake earns there.',
      ],
    ]);
    expect(result.state.rewardsEpoch).toBe(1043);
    expect(result.state.fees?.[HORIZON]).toEqual({ commissionPct: 5, mevCommissionPct: 10 });
  });

  it('names both raises in one alert', () => {
    const state = { fees: { [DOCOMO]: { commissionPct: 0, mevCommissionPct: 5 } } };
    const result = evaluateWalletAlerts(input({ state, votes: [DOCOMO] }));
    expect(result.alerts[0].body).toBe(
      'NTT DOCOMO GLOBAL raised its commission from 0% to 5% and its MEV fee from 5% to 10%. You keep less of what your stake earns there.',
    );
  });

  it('sends offline for tracked validators, respects switched-off rules and skips unknown votes', () => {
    const on = evaluateWalletAlerts(
      input({ offline: new Set([DOCOMO]), votes: [DOCOMO, 'UnknownVote111111111111111111111111111111111'] }),
    );
    expect(keys(on.alerts)).toEqual([`offline:${DOCOMO}:1044`]);
    expect(on.alerts[0].body).toContain('NTT DOCOMO GLOBAL has been delinquent for more than 10 minutes');
    const off = evaluateWalletAlerts(
      input({
        offline: new Set([DOCOMO]),
        rules: { offline: false, feeUp: false, losingMoney: false, rewardsLanded: false },
        state: { fees: { [DOCOMO]: { commissionPct: 0, mevCommissionPct: 0 } } },
      }),
    );
    expect(off.alerts).toEqual([]);
    // fees are still recorded with the rule off, so turning it on later compares against fresh values
    expect(off.state.fees?.[DOCOMO]).toEqual({ commissionPct: 5, mevCommissionPct: 10 });
  });

  it('sends due move reminders and keeps future ones', () => {
    const due = { kind: 'move-step-2' as const, epoch: 1044, stakeAccount: STAKE };
    const later = { kind: 'move-step-2' as const, epoch: 1045, stakeAccount: STAKE };
    const result = evaluateWalletAlerts(input({ votes: [], reminders: [due, later] }));
    expect(result.dueReminders).toEqual([due]);
    expect(result.alerts).toEqual([
      {
        kind: 'reminder',
        dedupeKey: `reminder:${STAKE}:1044`,
        title: 'Step 2 of your stake move',
        body: 'Step 2 of your stake move: epoch 1044 has started, so stake account 6UsG…aFFH has finished deactivating. Delegate it to its new validator (or withdraw it) on My Stake.',
        link: 'https://epoch.app/me',
      },
    ]);
    // the title is not repeated when the body starts with it
    expect(plainText(result.alerts[0])).toBe(`${result.alerts[0].body}\nhttps://epoch.app/me`);
  });
});

describe('rewards and state', () => {
  it('words the rewards alert and skips an empty epoch', () => {
    expect(rewardsAlert(1043, 18_892_000, APP)).toEqual({
      kind: 'rewards',
      dedupeKey: 'rewards:1043',
      title: 'Rewards landed',
      body: 'Rewards landed: 0.018892 SOL for epoch 1043.',
      link: 'https://epoch.app/me',
    });
    expect(rewardsAlert(1043, 0, APP)).toBeNull();
    expect(formatSol(12.5)).toBe('12.5');
    expect(formatSol(2)).toBe('2');
    expect(formatSol(0.0000004)).toBe('0');
  });

  it('reads stored state defensively', () => {
    expect(readAlertState(null)).toEqual({});
    expect(
      readAlertState({ rewardsEpoch: 'x', fees: { a: { commissionPct: 'no' }, b: { commissionPct: 3 } } }),
    ).toEqual({
      fees: { b: { commissionPct: 3, mevCommissionPct: null } },
    });
  });
});
