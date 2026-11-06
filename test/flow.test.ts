import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCycle } from '../src/cycle';
import { approveProposal, rejectProposal } from '../src/execution/simulator';
import * as snapshot from '../src/sources/snapshot';
import { loadState, resetState } from '../src/state/store';

describe('sweep → approve → execute', () => {
  beforeEach(() => {
    resetState();
    vi.restoreAllMocks();
  });

  it('the baseline stays inside the cycle cap and every proposal passed the engine', async () => {
    const { proposals, ctx } = await runCycle({ offline: true, useAgent: false });
    const cap = (ctx.idle.actionableIdleUsd * ctx.policy.deployment.max_share_of_idle_pct) / 100;
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.reduce((s, p) => s + p.amountUsd, 0)).toBeLessThanOrEqual(cap);
    for (const p of proposals) expect(p.status).toBe('pending');
  });

  it('needs the right number of distinct approvers, then executes and updates balances', async () => {
    const { proposals } = await runCycle({ offline: true, useAgent: false });
    const big = proposals.find((p) => p.requiredApprovers === 2)!;
    expect((await approveProposal(big.id, 'alice', { offline: true })).message).toMatch(/1 of 2/);
    expect((await approveProposal(big.id, 'alice', { offline: true })).ok).toBe(false);
    const done = await approveProposal(big.id, 'bob', { offline: true });
    expect(done.ok).toBe(true);
    const state = loadState();
    expect(state.proposals.find((p) => p.id === big.id)!.status).toBe('executed');
    expect(state.positions).toHaveLength(1);
    expect(state.accountDeltas[big.sourceAccountId]).toBeLessThan(0);
  });

  it('blocks execution when the market moved outside the policy after approval', async () => {
    const { proposals } = await runCycle({ offline: true, useAgent: false });
    const p = proposals.find((x) => x.requiredApprovers === 1 && x.poolId)!;
    const real = snapshot.loadFixtureSnapshot();
    vi.spyOn(snapshot, 'getSnapshot').mockResolvedValue({
      ...real,
      pools: real.pools.map((pool) => (pool.poolId === p.poolId ? { ...pool, apy: 1.2 } : pool)),
    });
    const r = await approveProposal(p.id, 'alice', { offline: true });
    expect(r.ok).toBe(false);
    expect(loadState().proposals.find((x) => x.id === p.id)!.status).toBe('blocked');
    expect(r.message).toMatch(/APY below minimum/);
  });

  it('a second sweep does not re-propose cash already waiting for approval', async () => {
    const first = await runCycle({ offline: true, useAgent: false });
    const second = await runCycle({ offline: true, useAgent: false });
    const cap = (first.ctx.idle.actionableIdleUsd * first.ctx.policy.deployment.max_share_of_idle_pct) / 100;
    const open = [...first.proposals, ...second.proposals].reduce((s, p) => s + p.amountUsd, 0);
    expect(open).toBeLessThanOrEqual(cap);
    expect(second.summary).toMatch(/waiting for approval/);
  });

  it('rejected proposals cannot be approved later', async () => {
    const { proposals } = await runCycle({ offline: true, useAgent: false });
    rejectProposal(proposals[0].id, 'alice');
    expect((await approveProposal(proposals[0].id, 'bob', { offline: true })).message).toMatch(/is rejected/);
  });
});
