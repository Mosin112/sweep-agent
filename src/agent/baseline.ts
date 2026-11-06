import type { ProposalSession } from '../cycle';
import { scanArbitrage, scanYields, poolAsset, yieldConfig, type YieldKind } from '../strategies/opportunities';
import { loadState } from '../state/store';
import type { ProposalInput } from '../types';

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const floorTo = (n: number, step: number) => Math.floor(n / step) * step;

/**
 * A deterministic proposer used when no Anthropic key is set, and as a
 * benchmark for the agent. Greedy: highest net yield first, inside every cap.
 * It never proposes spot buys, because those need judgement.
 */
export async function runBaseline(session: ProposalSession): Promise<string> {
  const { policy, idle, market } = session.ctx;
  const { positions } = loadState();
  const cycleCap = (idle.actionableIdleUsd * policy.deployment.max_share_of_idle_pct) / 100;
  const used = () => session.committed().reduce((s, p) => s + p.amountUsd, 0);
  const usedFrom = (id: string) => session.committed().filter((p) => p.sourceAccountId === id).reduce((s, p) => s + p.amountUsd, 0);
  const inProject = (project: string) =>
    positions.filter((p) => p.project === project).reduce((s, p) => s + p.amountUsd, 0) +
    session.committed().filter((p) => p.derived.project === project).reduce((s, p) => s + p.amountUsd, 0);

  // 1. Arbitrage that clears the bar after fees
  const arb = policy.instruments.arbitrage;
  if (arb.enabled) {
    for (const opp of scanArbitrage(policy, market).filter((o) => o.netSpreadBps >= arb.min_net_spread_bps)) {
      const account = idle.accounts.find((a) => a.venue === opp.buyVenue && a.actionable);
      if (!account) continue;
      const amount = floorTo(Math.min(arb.max_notional_usd, account.idleUsd - usedFrom(account.accountId), cycleCap - used()), 1000);
      if (amount < policy.deployment.min_ticket_usd) continue;
      session.submit({
        kind: 'arbitrage',
        sourceAccountId: account.accountId,
        amountUsd: amount,
        pair: opp.pair,
        buyVenue: opp.buyVenue,
        sellVenue: opp.sellVenue,
        rationale: `Net spread of ${opp.netSpreadBps} bps after fees on ${opp.pair}.`,
        risks: ['Spread can close before both legs fill', 'Needs inventory on the sell venue'],
      });
    }
  }

  // 2. Yield, best net APY first, account by account
  const kinds: YieldKind[] = ['stablecoin_yield', 'tokenized_treasury'];
  const candidates = kinds.flatMap((kind) => (yieldConfig(kind, policy).enabled ? scanYields(kind, policy, market, 50).eligible.map((pool) => ({ kind, pool })) : []));

  for (const account of idle.accounts.filter((a) => a.actionable).sort((a, b) => b.idleUsd - a.idleUsd)) {
    const ranked = candidates
      .map((c) => {
        const asset = poolAsset(c.kind, c.pool, policy);
        const route = `${account.currency}->${asset}`;
        const costBps = account.currency === asset ? 0 : policy.deployment.conversion_costs_bps[route];
        return { ...c, netApy: costBps === undefined ? -Infinity : c.pool.apy - costBps / 100 };
      })
      .filter((c) => c.netApy > 0)
      .sort((a, b) => b.netApy - a.netApy);

    for (const c of ranked) {
      const remaining = account.idleUsd - usedFrom(account.accountId);
      const projectLeft = yieldConfig(c.kind, policy).max_per_project_usd - inProject(c.pool.project);
      const amount = floorTo(Math.min(remaining, projectLeft, cycleCap - used()), 1000);
      if (amount < policy.deployment.min_ticket_usd) continue;
      const input: ProposalInput = {
        kind: c.kind,
        sourceAccountId: account.accountId,
        amountUsd: amount,
        poolId: c.pool.poolId,
        rationale: `Highest net yield available to ${account.name}: ${c.pool.apy.toFixed(2)}% APY, about ${c.netApy.toFixed(2)}% after conversion.`,
        risks: ['Smart-contract and counterparty risk', 'Yield is variable'],
      };
      session.submit(input);
    }
  }

  const total = session.accepted.reduce((s, p) => s + p.amountUsd, 0);
  const waiting = session.outstanding.reduce((s, p) => s + p.amountUsd, 0);
  const waitingNote = session.outstanding.length ? ` ${usd(waiting)} is already in ${session.outstanding.length} earlier proposals waiting for approval.` : '';
  if (!session.accepted.length) return `Idle cash is ${usd(idle.actionableIdleUsd)}, but nothing new cleared the policy this cycle.${waitingNote}`;
  return [
    `Found ${usd(idle.actionableIdleUsd)} of idle cash and proposed ${session.accepted.length} moves totalling ${usd(total)} (cap for this cycle: ${usd(cycleCap)}).${waitingNote}`,
    ...session.accepted.map((p) => `• ${p.derived.label}: ${usd(p.amountUsd)} from ${p.sourceAccountId}`),
  ].join('\n');
}
