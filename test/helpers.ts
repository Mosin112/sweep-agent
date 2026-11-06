import { loadPolicy } from '../src/policy/load';
import type { EngineContext } from '../src/policy/engine';
import { loadLocalTreasury } from '../src/sources/dashboard';
import { loadFixtureSnapshot } from '../src/sources/snapshot';
import { computeIdleCash } from '../src/treasury/idle-cash';
import type { ProposalInput } from '../src/types';

export const NOW = new Date('2026-11-06T09:00:00Z');

export function setup(): EngineContext {
  const policy = loadPolicy('policies/treasury-policy.yaml');
  const market = loadFixtureSnapshot();
  const treasury = loadLocalTreasury('data/treasury.json', NOW);
  const idle = computeIdleCash(treasury, policy, market);
  return { policy, market, idle, positions: [], pending: [] };
}

export function pool(ctx: EngineContext, project: string, symbol: string, chain = 'Ethereum') {
  const p = ctx.market.pools.find((x) => x.project === project && x.symbol === symbol && x.chain === chain);
  if (!p) throw new Error(`fixture has no ${project} ${symbol} on ${chain}`);
  return p;
}

export const base = (over: Partial<ProposalInput>): ProposalInput => ({
  kind: 'stablecoin_yield',
  sourceAccountId: 'treasury-wallet-usdc',
  amountUsd: 200000,
  rationale: 'Test proposal',
  risks: [],
  ...over,
});
