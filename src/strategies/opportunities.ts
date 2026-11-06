import type { Policy } from '../policy/schema';
import type { MarketSnapshot, Quote, YieldPool } from '../types';

export type YieldKind = 'stablecoin_yield' | 'tokenized_treasury';

export function yieldConfig(kind: YieldKind, policy: Policy) {
  return kind === 'stablecoin_yield' ? policy.instruments.stablecoin_yield : policy.instruments.tokenized_treasuries;
}

/** The asset you hold once you're in the pool, used to price the conversion. */
export function poolAsset(kind: YieldKind, pool: YieldPool, policy: Policy): string {
  return kind === 'stablecoin_yield' ? pool.symbol : policy.instruments.tokenized_treasuries.subscription_asset;
}

/** Why a pool is outside the policy, or undefined when it's allowed. */
export function poolExclusion(kind: YieldKind, pool: YieldPool, policy: Policy): string | undefined {
  const c = yieldConfig(kind, policy);
  if (!c.allowed_projects.includes(pool.project)) return 'project not allowed';
  if (!c.allowed_chains.includes(pool.chain)) return 'chain not allowed';
  if (kind === 'stablecoin_yield' && !policy.instruments.stablecoin_yield.allowed_assets.includes(pool.symbol)) return 'asset not allowed';
  if (kind === 'tokenized_treasury' && !pool.stablecoin) return 'not a dollar-denominated fund';
  if (pool.tvlUsd < c.min_tvl_usd) return 'TVL below minimum';
  if (pool.apy < c.min_apy_pct) return 'APY below minimum';
  if (pool.apy > c.max_apy_pct) return 'APY above maximum (likely hidden risk)';
  return undefined;
}

export function scanYields(kind: YieldKind, policy: Policy, market: MarketSnapshot, limit = 10) {
  const projects = new Set(yieldConfig(kind, policy).allowed_projects);
  const candidates = market.pools.filter((p) => projects.has(p.project));
  const excluded: Record<string, number> = {};
  const eligible: YieldPool[] = [];
  for (const pool of candidates) {
    const why = poolExclusion(kind, pool, policy);
    if (why) excluded[why] = (excluded[why] ?? 0) + 1;
    else eligible.push(pool);
  }
  eligible.sort((a, b) => b.apy - a.apy);
  return { eligible: eligible.slice(0, limit), eligibleCount: eligible.length, excluded };
}

export interface ArbOpportunity {
  pair: string;
  buyVenue: string;
  sellVenue: string;
  buyAsk: number;
  sellBid: number;
  grossSpreadBps: number;
  feesBps: number;
  netSpreadBps: number;
}

const bps = (x: number) => Number((x * 10000).toFixed(2));

/** Net spread for buying on one venue and selling on another, after taker fees on both legs. */
export function arbSpread(buy: Quote, sell: Quote, feeBps: Record<string, number>): ArbOpportunity {
  const gross = bps((sell.bid - buy.ask) / buy.ask);
  const fees = (feeBps[buy.venue] ?? Infinity) + (feeBps[sell.venue] ?? Infinity);
  return {
    pair: buy.pair,
    buyVenue: buy.venue,
    sellVenue: sell.venue,
    buyAsk: buy.ask,
    sellBid: sell.bid,
    grossSpreadBps: gross,
    feesBps: fees,
    netSpreadBps: Number((gross - fees).toFixed(2)),
  };
}

export function scanArbitrage(policy: Policy, market: MarketSnapshot): ArbOpportunity[] {
  const { pairs, venues, taker_fee_bps } = policy.instruments.arbitrage;
  const out: ArbOpportunity[] = [];
  for (const pair of pairs) {
    const quotes = market.quotes.filter((q) => q.pair === pair && venues.includes(q.venue));
    for (const buy of quotes) for (const sell of quotes) if (buy.venue !== sell.venue) out.push(arbSpread(buy, sell, taker_fee_bps));
  }
  return out.sort((a, b) => b.netSpreadBps - a.netSpreadBps);
}

export function findQuote(market: MarketSnapshot, pair: string, venue: string) {
  return market.quotes.find((q) => q.pair === pair && q.venue === venue);
}
