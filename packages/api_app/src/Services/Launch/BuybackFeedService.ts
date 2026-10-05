import { getServices } from '..';
import { BuybackFeed, RpcBuybackChainReader } from './BuybackFeed';

let feed: BuybackFeed | undefined;

/** One feed per process, on the program source and event store of `getServices()`. */
export function getBuybackFeed(): BuybackFeed {
  if (!feed) {
    const services = getServices();
    feed = new BuybackFeed({ chain: new RpcBuybackChainReader(services.program), events: services.events });
  }
  return feed;
}

/** Replaces the process-wide feed (tests); `undefined` rebuilds it on next use. */
export function setBuybackFeed(next: BuybackFeed | undefined): void {
  feed = next;
}
