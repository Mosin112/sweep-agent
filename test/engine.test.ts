import { describe, expect, it } from 'vitest';
import { validateProposal } from '../src/policy/engine';
import { arbSpread } from '../src/strategies/opportunities';
import type { Proposal } from '../src/types';
import { base, pool, setup } from './helpers';

describe('policy engine', () => {
  it('accepts an allowed yield proposal and derives the APY from market data', () => {
    const ctx = setup();
    const maple = pool(ctx, 'maple', 'USDC');
    const r = validateProposal(base({ poolId: maple.poolId }), ctx);
    expect(r.violations).toEqual([]);
    expect(r.derived.expectedApyPct).toBe(maple.apy);
    expect(r.requiredApprovers).toBe(1);
  });

  it('ignores numbers the model tries to supply', () => {
    const ctx = setup();
    const maple = pool(ctx, 'maple', 'USDC');
    const r = validateProposal({ ...base({ poolId: maple.poolId }), expectedApyPct: 99 } as any, ctx);
    expect(r.derived.expectedApyPct).toBe(maple.apy);
  });

  it('rejects a pool on a chain the policy does not allow', () => {
    const ctx = setup();
    const offChain = ctx.market.pools.find((p) => p.project === 'aave-v3' && p.symbol === 'USDC' && !ctx.policy.instruments.stablecoin_yield.allowed_chains.includes(p.chain))!;
    const r = validateProposal(base({ poolId: offChain.poolId }), ctx);
    expect(r.ok).toBe(false);
    expect(r.violations.join()).toMatch(/chain not allowed/);
  });

  it('rejects spending more than an account has idle', () => {
    const ctx = setup();
    const r = validateProposal(base({ poolId: pool(ctx, 'maple', 'USDC').poolId, amountUsd: 1_500_000 }), ctx);
    expect(r.violations.join()).toMatch(/only has .* idle/);
  });

  it('enforces the per-project limit across pending proposals', () => {
    const ctx = setup();
    const maple = pool(ctx, 'maple', 'USDC');
    ctx.pending = [{ id: 'x', kind: 'stablecoin_yield', sourceAccountId: 'settlement-bank-usd', amountUsd: 900_000, derived: { label: '', conversionCostUsd: 0, project: 'maple' } } as Proposal];
    const r = validateProposal(base({ poolId: maple.poolId, amountUsd: 200_000 }), ctx);
    expect(r.violations.join()).toMatch(/above its \$1,000,000 limit/);
  });

  it('enforces the per-cycle cap', () => {
    const ctx = setup();
    const cap = (ctx.idle.actionableIdleUsd * ctx.policy.deployment.max_share_of_idle_pct) / 100;
    ctx.pending = [{ id: 'x', kind: 'tokenized_treasury', sourceAccountId: 'settlement-bank-usd', amountUsd: cap - 50_000, derived: { label: '', conversionCostUsd: 0, project: 'blackrock-buidl' } } as Proposal];
    const r = validateProposal(base({ poolId: pool(ctx, 'maple', 'USDC').poolId, amountUsd: 100_000 }), ctx);
    expect(r.violations.join()).toMatch(/cycle's cap/);
  });

  it('scales required approvers with ticket size and blocks anything above the top tier', () => {
    const ctx = setup();
    const id = pool(ctx, 'maple', 'USDC').poolId;
    expect(validateProposal(base({ poolId: id, amountUsd: 600_000 }), ctx).requiredApprovers).toBe(2);
    const huge = validateProposal(base({ poolId: id, amountUsd: 4_000_000 }), ctx);
    expect(huge.violations.join()).toMatch(/largest approval tier/);
  });

  it('charges conversion costs and rejects routes the policy does not list', () => {
    const ctx = setup();
    const id = pool(ctx, 'maple', 'USDC').poolId;
    const fromAed = validateProposal(base({ poolId: id, sourceAccountId: 'ops-bank-aed', amountUsd: 500_000 }), ctx);
    expect(fromAed.derived.conversionCostUsd).toBeCloseTo(500_000 * 0.002, 2);
    delete ctx.policy.deployment.conversion_costs_bps['AED->USDC'];
    const noRoute = validateProposal(base({ poolId: id, sourceAccountId: 'ops-bank-aed', amountUsd: 500_000 }), ctx);
    expect(noRoute.violations.join()).toMatch(/No allowed conversion route AED->USDC/);
  });

  it('always needs two approvers for spot buys and caps the position', () => {
    const ctx = setup();
    const ok = validateProposal(base({ kind: 'spot', asset: 'BTC', sourceAccountId: 'kraken-usd', amountUsd: 100_000 }), ctx);
    expect(ok.violations).toEqual([]);
    expect(ok.requiredApprovers).toBe(2);
    const big = validateProposal(base({ kind: 'spot', asset: 'BTC', sourceAccountId: 'kraken-usd', amountUsd: 300_000 }), ctx);
    expect(big.violations.join()).toMatch(/position limit|above the \$250,000 limit/);
    const fromBank = validateProposal(base({ kind: 'spot', asset: 'BTC', sourceAccountId: 'settlement-bank-usd', amountUsd: 100_000 }), ctx);
    expect(fromBank.violations.join()).toMatch(/exchange account/);
  });

  it('rejects arbitrage that does not clear fees, or that is funded from the wrong venue', () => {
    const ctx = setup();
    const r = validateProposal(base({ kind: 'arbitrage', pair: 'BTC-USD', buyVenue: 'kraken', sellVenue: 'bitstamp', sourceAccountId: 'coinbase-usd', amountUsd: 100_000 }), ctx);
    expect(r.violations.join()).toMatch(/buy venue/);
    expect(r.violations.join()).toMatch(/below the 5 bps minimum/);
  });
});

describe('arbitrage math', () => {
  it('nets taker fees on both legs', () => {
    const o = arbSpread({ venue: 'a', pair: 'X-USD', bid: 99, ask: 100 }, { venue: 'b', pair: 'X-USD', bid: 101, ask: 102 }, { a: 20, b: 30 });
    expect(o.grossSpreadBps).toBe(100);
    expect(o.netSpreadBps).toBe(50);
  });

  it('treats a venue with no fee schedule as unusable', () => {
    const o = arbSpread({ venue: 'a', pair: 'X-USD', bid: 99, ask: 100 }, { venue: 'z', pair: 'X-USD', bid: 120, ask: 121 }, { a: 20 });
    expect(o.netSpreadBps).toBe(-Infinity);
  });
});
