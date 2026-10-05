import * as fx from './__fixtures__/responses';
import {
  PantaAccountSchema,
  PantaAttributedTradesSchema,
  PantaBuyBuildSchema,
  PantaBuyQuoteSchema,
  PantaCategoriesSchema,
  PantaCreateBuildSchema,
  PantaCreateQuoteRequestSchema,
  PantaCreateQuoteSchema,
  PantaCreatesSchema,
  PantaCreatorFeeClaimSchema,
  PantaDashboardSchema,
  PantaMarketListSchema,
  PantaMarketSchema,
  PantaMarketTradesSchema,
  PantaMetricsSchema,
  PantaPositionsSchema,
  PantaRegisterSchema,
  PantaReportTradeSchema,
  PantaSubmitSchema,
  PantaTradeStatusSchema,
  PantaVerifySchema,
  PantaWalletTradesSchema,
  PantaWinClaimSchema,
} from './schemas';

describe('Panta schemas', () => {
  it('accept every documented example', () => {
    const pairs: [{ parse: (value: unknown) => unknown }, unknown][] = [
      [PantaAccountSchema, fx.account],
      [PantaDashboardSchema, fx.dashboard],
      [PantaMetricsSchema, fx.metrics],
      [PantaCreatesSchema, fx.creates],
      [PantaAttributedTradesSchema, fx.attributedTrades],
      [PantaMarketListSchema, fx.marketList],
      [PantaMarketSchema, fx.market],
      [PantaMarketTradesSchema, fx.marketTrades],
      [PantaWalletTradesSchema, fx.walletTrades],
      [PantaCategoriesSchema, fx.categories],
      [PantaCreateQuoteSchema, fx.createQuote],
      [PantaCreateBuildSchema, fx.createBuild],
      [PantaRegisterSchema, fx.register],
      [PantaBuyQuoteSchema, fx.buyQuote],
      [PantaBuyBuildSchema, fx.buyBuild],
      [PantaSubmitSchema, fx.submit],
      [PantaVerifySchema, fx.verify],
      [PantaPositionsSchema, fx.positions],
      [PantaWinClaimSchema, fx.winClaim],
      [PantaCreatorFeeClaimSchema, fx.creatorFees],
      [PantaReportTradeSchema, fx.report],
      [PantaTradeStatusSchema, fx.tradeStatus],
    ];
    for (const [schema, example] of pairs) expect(() => schema.parse(example)).not.toThrow();
  });

  it('normalise numbers and labels the docs show both ways', () => {
    expect(PantaVerifySchema.parse(fx.verify).amountUsdc).toBe('20000000');
    expect(PantaMetricsSchema.parse(fx.metrics).summary.trades.volumeUsdcBase).toBe('40000000');
    expect(PantaWinClaimSchema.parse(fx.winClaim).outcome).toBe('yes');
    expect(PantaBuyQuoteSchema.parse({ ...fx.buyQuote, side: 'YES', shares: 38.42 })).toMatchObject({
      side: 'yes',
      shares: '38.42',
    });
    expect(PantaMarketSchema.parse({ ...fx.market, yesPrice: 0.52, extra: 'ignored' })).not.toHaveProperty('extra');
    expect(PantaMarketSchema.parse({ marketId: fx.MARKET, title: 't', phase: 'primary' })).toMatchObject({
      images: [],
      resolved: false,
      yesPrice: null,
      startTime: null,
      createdByPartner: false,
    });
    expect(() => PantaBuyQuoteSchema.parse({ ...fx.buyQuote, side: 'maybe' })).toThrow();
  });

  it('read the live shapes of the playground (optional heights, base-unit tape, market totals)', () => {
    expect(PantaBuyBuildSchema.parse(fx.liveBuyBuild)).toMatchObject({ lastValidBlockHeight: null, derived: {} });
    expect(
      PantaCreateBuildSchema.parse({ ...fx.createBuild, lastValidBlockHeight: undefined }).lastValidBlockHeight,
    ).toBe(null);
    expect(PantaWinClaimSchema.parse({ ...fx.winClaim, lastValidBlockHeight: undefined }).lastValidBlockHeight).toBe(
      null,
    );
    expect(PantaMarketSchema.parse(fx.liveMarket)).toMatchObject({
      totalVolumeUsdc: '1250.40',
      totalVolumeUsdcBase: '1250400000',
      creationFee: '50',
      creatorAddress: fx.CREATOR,
      oracle: 'https://api.example.com/v1/index/epochs/1051',
    });
    const [row, bare] = PantaMarketTradesSchema.parse(fx.liveMarketTrades).items;
    expect(row).toMatchObject({ yesAmount: '38420000', noAmount: '0', feePaid: '400000', side: 'yes', kind: 'buy' });
    expect(bare).toMatchObject({ id: null, wallet: null, signature: null, isPrimary: null, yesAmount: null });
    const dash = PantaDashboardSchema.parse(fx.dashboard);
    expect(dash.metrics.trades).toEqual({ total: 5, volumeUsdcBase: '125000000', byKind: { buy: 4, claim: 1 } });
    expect(dash.permissions.canCreateMarkets).toBe(true);
    expect(PantaDashboardSchema.parse({ ...fx.dashboard, permissions: undefined }).permissions).toEqual({});
  });

  it('check a market quote request the way Panta documents it', () => {
    const body = {
      wallet: fx.CREATOR,
      question: 'q?',
      resolutionRule: 'r',
      sourcesOfTruth: ['https://example.com'],
      category: 'crypto',
      startTime: 100,
      endTime: 200,
      resolutionTime: 200,
      imageUrl: 'https://example.com/i.png',
    };
    expect(PantaCreateQuoteRequestSchema.safeParse(body).success).toBe(true);
    expect(PantaCreateQuoteRequestSchema.safeParse({ ...body, resolutionTime: 199 }).success).toBe(false);
    expect(PantaCreateQuoteRequestSchema.safeParse({ ...body, category: 'memes' }).success).toBe(false);
    expect(
      PantaCreateQuoteRequestSchema.safeParse({ ...body, sourcesOfTruth: Array.from({ length: 21 }, () => 'x') })
        .success,
    ).toBe(false);
    expect(PantaCreateQuoteRequestSchema.safeParse({ ...body, resolutionRule: 'r'.repeat(2_049) }).success).toBe(false);
  });
});
