import { newId } from '../cycle';
import { validateProposal } from '../policy/engine';
import { loadPolicy } from '../policy/load';
import { loadTreasury } from '../sources/dashboard';
import { getSnapshot } from '../sources/snapshot';
import { audit, loadState, saveSnapshot, saveState } from '../state/store';
import { computeIdleCash } from '../treasury/idle-cash';
import type { Proposal } from '../types';
import { expireStale } from './expiry';

export { expireStale };

/**
 * Approvals and simulated execution. Nothing here talks to a bank or an exchange:
 * executions update a local ledger so the dashboard and the next cycle see the result.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
  proposal?: Proposal;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export async function approveProposal(id: string, by: string, opts: { offline?: boolean } = {}): Promise<ActionResult> {
  const policy = loadPolicy();
  const state = loadState();
  expireStale(state);
  const p = state.proposals.find((x) => x.id === id);
  if (!p) return { ok: false, message: `No proposal ${id}` };
  if (p.status !== 'pending') {
    saveState(state);
    return { ok: false, message: `Proposal ${id} is ${p.status}`, proposal: p };
  }
  const allowed = policy.approvals.allowed_approvers;
  if (allowed.length && !allowed.includes(by)) return { ok: false, message: `${by} isn't an allowed approver`, proposal: p };
  if (p.approvals.some((a) => a.by === by)) return { ok: false, message: `${by} has already approved ${id}`, proposal: p };

  p.approvals.push({ by, at: new Date().toISOString() });
  audit('proposal_approved', { proposalId: id, by, approvals: p.approvals.length, required: p.requiredApprovers });

  if (p.approvals.length < p.requiredApprovers) {
    saveState(state);
    return { ok: true, message: `Approved by ${by}. ${p.approvals.length} of ${p.requiredApprovers} approvals.`, proposal: p };
  }
  p.status = 'approved';
  saveState(state);
  return executeProposal(id, opts);
}

export function rejectProposal(id: string, by: string): ActionResult {
  const state = loadState();
  const p = state.proposals.find((x) => x.id === id);
  if (!p) return { ok: false, message: `No proposal ${id}` };
  if (p.status !== 'pending') return { ok: false, message: `Proposal ${id} is ${p.status}`, proposal: p };
  p.status = 'rejected';
  p.rejectedBy = { by, at: new Date().toISOString() };
  saveState(state);
  audit('proposal_rejected', { proposalId: id, by });
  return { ok: true, message: `Rejected by ${by}.`, proposal: p };
}

async function executeProposal(id: string, opts: { offline?: boolean }): Promise<ActionResult> {
  const policy = loadPolicy();
  let state = loadState();
  const p = state.proposals.find((x) => x.id === id)!;

  // Re-check everything against fresh data before acting.
  const [treasury, market] = await Promise.all([loadTreasury(), getSnapshot(policy, opts.offline)]);
  saveSnapshot(market);
  const idle = computeIdleCash(treasury, policy, market);
  const recheck = validateProposal(p, { policy, idle, market, positions: state.positions, pending: [], recheck: true });
  const violations = policy.execution.recheck_before_execute ? [...recheck.violations] : [];

  const before = p.derived.referencePrice;
  const after = recheck.derived.referencePrice;
  if (before && after) {
    const driftBps = Math.abs(after - before) / before * 10000;
    if (driftBps > policy.execution.max_price_drift_bps) violations.push(`Price moved ${driftBps.toFixed(1)} bps since the proposal, above the ${policy.execution.max_price_drift_bps} bps limit`);
  }

  state = loadState();
  const target = state.proposals.find((x) => x.id === id)!;
  if (violations.length) {
    target.status = 'blocked';
    target.executionNote = `Blocked at execution: ${violations.join('; ')}`;
    saveState(state);
    audit('execution_blocked', { proposalId: id, violations });
    return { ok: false, message: target.executionNote, proposal: target };
  }

  const source = treasury.accounts.find((a) => a.id === target.sourceAccountId)!;
  const sourceRate = idle.accounts.find((a) => a.accountId === source.id)!.usdPerUnit;
  const d = recheck.derived;

  if (target.kind === 'arbitrage') {
    // Simulated as an instant round trip: only the realised profit stays.
    const profit = d.expectedProfitUsd ?? 0;
    state.accountDeltas[source.id] = (state.accountDeltas[source.id] ?? 0) + profit / sourceRate;
    target.executionNote = `Simulated round trip at ${d.netSpreadBps} bps net. Realised ${usd(profit)}.`;
  } else {
    const invested = target.amountUsd - d.conversionCostUsd;
    state.accountDeltas[source.id] = (state.accountDeltas[source.id] ?? 0) - target.amountUsd / sourceRate;
    state.positions.push({
      id: newId('pos'),
      proposalId: target.id,
      kind: target.kind,
      label: d.label,
      project: d.project,
      asset: d.instrumentAsset,
      amountUsd: invested,
      sourceAccountId: source.id,
      openedAt: new Date().toISOString(),
      expectedApyPct: d.expectedApyPct,
    });
    target.executionNote =
      target.kind === 'spot'
        ? `Simulated buy of ${usd(invested)} of ${d.instrumentAsset} at ${d.referencePrice?.toFixed(2)}.`
        : `Simulated deposit of ${usd(invested)} at ${d.expectedApyPct?.toFixed(2)}% APY (conversion cost ${usd(d.conversionCostUsd)}).`;
  }
  target.status = 'executed';
  target.derived = d;
  saveState(state);
  audit('executed', { proposalId: id, note: target.executionNote, marketSource: market.source });
  return { ok: true, message: target.executionNote, proposal: target };
}
