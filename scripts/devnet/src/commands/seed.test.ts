import { openQuoteEpochs, validatorKeyNames } from './seed';

describe('openQuoteEpochs', () => {
  it('lists the quotes posted and not taken back, in epoch order', () => {
    const steps = {
      'quote:12': {},
      'quote:9': {},
      'quote:10': {},
      'quote-back:10': {},
      swap: {},
      'deposit:lender1:junior': {},
    };
    expect(openQuoteEpochs(steps)).toEqual([9n, 12n]);
  });

  it('is empty before the first quote', () => {
    expect(openQuoteEpochs({})).toEqual([]);
  });
});

describe('validatorKeyNames', () => {
  it('names the vote and identity keypairs after the validator', () => {
    expect(validatorKeyNames({ name: 'v3' })).toEqual({ vote: 'v3-vote', identity: 'v3-identity' });
  });
});
