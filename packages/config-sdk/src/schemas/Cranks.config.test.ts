import { loadConfig } from '../loadConfig';
import { CranksConfigSchema } from './Cranks.config';
import { OperatorConfigSchema } from './Operator.config';
import { PublisherConfigSchema } from './Publisher.config';

const PROGRAM = '11111111111111111111111111111111';

describe('CranksConfigSchema', () => {
  it('applies defaults and requires the program id and crank keypair', () => {
    const config = loadConfig(CranksConfigSchema, {
      EPOCH_PROGRAM_ID: PROGRAM,
      CRANK_KEYPAIR_PATH: '/keys/crank.json',
    });
    expect(config).toMatchObject({
      EPOCH_CLUSTER: 'devnet',
      EPOCH_RPC_URL: 'https://api.devnet.solana.com',
      CRANK_CU_PRICE_MICROLAMPORTS: 10_000,
      DATA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      JITO_KOBE_API_URL: 'https://kobe.mainnet.jito.network',
      DRY_RUN: false,
      CRANK_POLL_SECONDS: 60,
      CRANK_ALERT_AFTER_MINUTES: 60,
      INDEX_BALLOT_RETENTION_EPOCHS: 4,
    });
    expect(config.SCORER_KEYPAIR_PATH).toBeUndefined();
    expect(() => loadConfig(CranksConfigSchema, { CRANK_KEYPAIR_PATH: 'x' })).toThrow('EPOCH_PROGRAM_ID');
    expect(() => loadConfig(CranksConfigSchema, { EPOCH_PROGRAM_ID: PROGRAM })).toThrow('CRANK_KEYPAIR_PATH');
  });

  it('parses DRY_RUN as a flag', () => {
    const env = { EPOCH_PROGRAM_ID: PROGRAM, CRANK_KEYPAIR_PATH: 'x', DRY_RUN: 'true' };
    expect(loadConfig(CranksConfigSchema, env).DRY_RUN).toBe(true);
    expect(() => loadConfig(CranksConfigSchema, { ...env, DRY_RUN: 'yes' })).toThrow('DRY_RUN');
  });
});

describe('PublisherConfigSchema', () => {
  it('defaults the quote parameters and the epoch offset', () => {
    const config = loadConfig(PublisherConfigSchema, { EPOCH_PROGRAM_ID: PROGRAM });
    expect(config).toMatchObject({
      FEE_INDEX_EPOCH_OFFSET: 0,
      QUOTE_MAX_NOTIONAL_SOL: '50',
      QUOTE_MAX_MOVE_BPS: 2_000,
      QUOTE_EPOCHS_AHEAD: 5,
      QUOTE_SPREAD_BPS: 0,
      PUBLISHER_INTERVAL_SECONDS: 60,
    });
  });

  it('accepts a signed offset or auto, and rejects anything else', () => {
    const parse = (FEE_INDEX_EPOCH_OFFSET: string) =>
      loadConfig(PublisherConfigSchema, { EPOCH_PROGRAM_ID: PROGRAM, FEE_INDEX_EPOCH_OFFSET }).FEE_INDEX_EPOCH_OFFSET;
    expect(parse('126')).toBe(126);
    expect(parse('-3')).toBe(-3);
    expect(parse('auto')).toBe('auto');
    expect(() => parse('1.5')).toThrow('FEE_INDEX_EPOCH_OFFSET');
    expect(() => parse('soon')).toThrow('FEE_INDEX_EPOCH_OFFSET');
  });

  it('splits the operator keypair paths, at most 8 and without duplicates', () => {
    const parse = (INDEX_OPERATOR_KEYPAIR_PATHS?: string) =>
      loadConfig(PublisherConfigSchema, { EPOCH_PROGRAM_ID: PROGRAM, INDEX_OPERATOR_KEYPAIR_PATHS })
        .INDEX_OPERATOR_KEYPAIR_PATHS;
    expect(parse()).toEqual([]);
    expect(parse(' /k/a.json , /k/b.json,,')).toEqual(['/k/a.json', '/k/b.json']);
    expect(() => parse('/k/a.json,/k/a.json')).toThrow('INDEX_OPERATOR_KEYPAIR_PATHS');
    expect(() => parse(Array.from({ length: 9 }, (_, i) => `/k/${i}.json`).join(','))).toThrow(
      'INDEX_OPERATOR_KEYPAIR_PATHS',
    );
  });

  it('validates the notional and spread', () => {
    const base = { EPOCH_PROGRAM_ID: PROGRAM };
    expect(loadConfig(PublisherConfigSchema, { ...base, QUOTE_MAX_NOTIONAL_SOL: '0.5' }).QUOTE_MAX_NOTIONAL_SOL).toBe(
      '0.5',
    );
    expect(() => loadConfig(PublisherConfigSchema, { ...base, QUOTE_MAX_NOTIONAL_SOL: '0' })).toThrow();
    expect(() => loadConfig(PublisherConfigSchema, { ...base, QUOTE_MAX_NOTIONAL_SOL: '1e3' })).toThrow();
    expect(loadConfig(PublisherConfigSchema, { ...base, QUOTE_SPREAD_BPS: '-200' }).QUOTE_SPREAD_BPS).toBe(-200);
  });
});

describe('OperatorConfigSchema', () => {
  it('requires the operator keypair path', () => {
    expect(() => loadConfig(OperatorConfigSchema, { EPOCH_PROGRAM_ID: PROGRAM })).toThrow('OPERATOR_KEYPAIR_PATH');
    expect(
      loadConfig(OperatorConfigSchema, { EPOCH_PROGRAM_ID: PROGRAM, OPERATOR_KEYPAIR_PATH: '~/op.json' })
        .OPERATOR_CU_PRICE_MICROLAMPORTS,
    ).toBe(10_000);
  });
});
