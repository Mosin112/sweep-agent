import type { Quote } from '../types';

/**
 * Live best bid/ask from public exchange APIs. No API keys needed.
 * Each venue is fetched independently so one outage doesn't stop the scan.
 */

const TIMEOUT_MS = 8000;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'sweep-agent' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const KRAKEN_PAIRS: Record<string, { query: string; keys: string[] }> = {
  'BTC-USD': { query: 'XBTUSD', keys: ['XXBTZUSD', 'XBTUSD'] },
  'ETH-USD': { query: 'ETHUSD', keys: ['XETHZUSD', 'ETHUSD'] },
  'USDT-USD': { query: 'USDTUSD', keys: ['USDTZUSD', 'USDTUSD'] },
  'USDC-USD': { query: 'USDCUSD', keys: ['USDCUSD'] },
};

async function kraken(pairs: string[]): Promise<Quote[]> {
  const known = pairs.filter((p) => KRAKEN_PAIRS[p]);
  if (!known.length) return [];
  const data = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${known.map((p) => KRAKEN_PAIRS[p].query).join(',')}`);
  if (data.error?.length) throw new Error(data.error.join(', '));
  return known.flatMap((pair) => {
    const key = KRAKEN_PAIRS[pair].keys.find((k) => data.result[k]);
    if (!key) return [];
    const t = data.result[key];
    return [{ venue: 'kraken', pair, bid: Number(t.b[0]), ask: Number(t.a[0]) }];
  });
}

async function coinbase(pairs: string[]): Promise<Quote[]> {
  // Coinbase treats USDC as USD, so it has no USDC-USD book.
  const settled = await Promise.allSettled(
    pairs.filter((p) => p !== 'USDC-USD').map(async (pair) => {
      const t = await getJson(`https://api.exchange.coinbase.com/products/${pair}/ticker`);
      return { venue: 'coinbase', pair, bid: Number(t.bid), ask: Number(t.ask) } as Quote;
    }),
  );
  return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

async function bitstamp(pairs: string[]): Promise<Quote[]> {
  const settled = await Promise.allSettled(
    pairs.map(async (pair) => {
      const t = await getJson(`https://www.bitstamp.net/api/v2/ticker/${pair.replace('-', '').toLowerCase()}/`);
      return { venue: 'bitstamp', pair, bid: Number(t.bid), ask: Number(t.ask) } as Quote;
    }),
  );
  return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

const VENUES: Record<string, (pairs: string[]) => Promise<Quote[]>> = { kraken, coinbase, bitstamp };

export async function fetchQuotes(pairs: string[], venues: string[]): Promise<{ quotes: Quote[]; errors: string[] }> {
  const errors: string[] = [];
  const results = await Promise.all(
    venues.map(async (venue) => {
      const fetcher = VENUES[venue];
      if (!fetcher) {
        errors.push(`No market adapter for venue "${venue}"`);
        return [];
      }
      try {
        return await fetcher(pairs);
      } catch (e) {
        errors.push(`${venue}: ${(e as Error).message}`);
        return [];
      }
    }),
  );
  const quotes = results.flat().filter((q) => q.bid > 0 && q.ask > 0 && q.ask >= q.bid);
  return { quotes, errors };
}
