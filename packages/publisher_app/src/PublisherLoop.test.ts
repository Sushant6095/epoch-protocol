import { Logger } from '@epoch/logger';

import { PublisherLoop } from './PublisherLoop';

describe('PublisherLoop', () => {
  it('runs every step in order each tick; a failing step does not stop the others', async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ran: string[] = [];
    const loop = new PublisherLoop(
      [
        {
          name: 'IndexPublisher',
          tick: async () => {
            ran.push('index');
            throw new Error('RPC down');
          },
        },
        { name: 'QuoteMaker', tick: async () => void ran.push('quotes') },
      ],
      60_000,
    );
    await loop.tick();
    await loop.tick();
    expect(ran).toEqual(['index', 'quotes', 'index', 'quotes']);
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it('stops after the tick in progress', async () => {
    let ticks = 0;
    const loop = new PublisherLoop(
      [{ name: 's', tick: async () => void ticks++ }],
      1,
      () => new Promise((r) => setTimeout(r, 1)),
    );
    const stop = loop.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stop();
    const after = ticks;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ticks).toBe(after);
    expect(ticks).toBeGreaterThan(0);
  });
});
