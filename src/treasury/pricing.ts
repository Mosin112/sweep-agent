import type { Policy } from '../policy/schema';
import type { MarketSnapshot, Quote } from '../types';

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const mid = (q: Quote) => (q.bid + q.ask) / 2;

/** Median mid-price for a pair across venues, or undefined when no venue quotes it. */
export function marketPrice(pair: string, market?: MarketSnapshot): number | undefined {
  const quotes = market?.quotes.filter((q) => q.pair === pair) ?? [];
  return quotes.length ? median(quotes.map(mid)) : undefined;
}

/** USD value of one unit of a currency: live price for crypto, policy rate for fiat. */
export function usdPerUnit(currency: string, policy: Policy, market?: MarketSnapshot): number {
  if (currency === 'USD') return 1;
  const live = marketPrice(`${currency}-USD`, market);
  if (live !== undefined) return live;
  const fixed = policy.fx_to_usd[currency];
  if (fixed === undefined) throw new Error(`No USD rate for ${currency}. Add it to fx_to_usd in the policy.`);
  return fixed;
}
