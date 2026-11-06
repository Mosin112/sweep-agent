import { readFileSync, writeFileSync } from 'node:fs';
import type { Policy } from '../policy/schema';
import type { MarketSnapshot } from '../types';
import { fetchQuotes } from './markets';
import { fetchPools } from './yields';

export const FIXTURE_PATH = 'fixtures/market-snapshot.json';

/** Every pair and venue the policy touches, plus the stablecoins we price balances with. */
function marketScope(policy: Policy) {
  const { spot, arbitrage, stablecoin_yield, tokenized_treasuries } = policy.instruments;
  const pairs = new Set<string>([...arbitrage.pairs, ...spot.allowed_assets.map((a) => `${a}-USD`), 'USDT-USD', 'USDC-USD']);
  const venues = new Set<string>(arbitrage.venues);
  const projects = [...stablecoin_yield.allowed_projects, ...tokenized_treasuries.allowed_projects];
  return { pairs: [...pairs], venues: [...venues], projects };
}

export async function fetchLiveSnapshot(policy: Policy): Promise<MarketSnapshot> {
  const { pairs, venues, projects } = marketScope(policy);
  const errors: string[] = [];
  const [quotesResult, pools] = await Promise.all([
    fetchQuotes(pairs, venues),
    fetchPools(projects).catch((e: Error) => {
      errors.push(e.message);
      return [];
    }),
  ]);
  return {
    fetchedAt: new Date().toISOString(),
    source: 'live',
    quotes: quotesResult.quotes,
    pools,
    errors: [...quotesResult.errors, ...errors],
  };
}

export function loadFixtureSnapshot(): MarketSnapshot {
  const snap = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as MarketSnapshot;
  return { ...snap, source: 'fixture' };
}

export async function getSnapshot(policy: Policy, offline = false): Promise<MarketSnapshot> {
  return offline ? loadFixtureSnapshot() : fetchLiveSnapshot(policy);
}

export function saveFixture(snapshot: MarketSnapshot) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(snapshot, null, 2) + '\n');
}
