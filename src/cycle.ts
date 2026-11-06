import { randomBytes } from 'node:crypto';
import { loadPolicy } from './policy/load';
import type { Policy } from './policy/schema';
import { validateProposal, type EngineContext, type ValidationResult } from './policy/engine';
import { loadTreasury } from './sources/dashboard';
import { getSnapshot } from './sources/snapshot';
import { audit, loadState, saveSnapshot, saveState } from './state/store';
import { expireStale } from './execution/expiry';
import { computeIdleCash, type IdleCashReport } from './treasury/idle-cash';
import type { CycleSummary, MarketSnapshot, Proposal, ProposalInput, TreasuryData } from './types';

export const newId = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex')}`;

export interface CycleContext {
  cycleId: string;
  policy: Policy;
  treasury: TreasuryData;
  market: MarketSnapshot;
  idle: IdleCashReport;
}

/**
 * Everything a proposer (the Claude agent or the deterministic baseline) can do
 * in one cycle. Proposers can only check and submit; they can't approve or execute.
 */
export class ProposalSession {
  readonly accepted: Proposal[] = [];
  readonly rejected: Array<{ input: ProposalInput; violations: string[] }> = [];
  /** Proposals from earlier cycles still waiting for approval. Their cash is treated as spoken for. */
  readonly outstanding: Proposal[];

  constructor(readonly ctx: CycleContext) {
    this.outstanding = loadState().proposals.filter((p) => p.status === 'pending' || p.status === 'approved');
  }

  /** Everything that already has a claim on idle cash: earlier open proposals plus this cycle's. */
  committed(): Proposal[] {
    return [...this.outstanding, ...this.accepted];
  }

  private engineContext(): EngineContext {
    const { positions } = loadState();
    return { policy: this.ctx.policy, idle: this.ctx.idle, market: this.ctx.market, positions, pending: this.committed() };
  }

  check(input: ProposalInput): ValidationResult {
    return validateProposal(input, this.engineContext());
  }

  submit(input: ProposalInput): ValidationResult & { proposalId?: string } {
    const result = this.check(input);
    if (!result.ok) {
      this.rejected.push({ input, violations: result.violations });
      audit('engine_rejected', { cycleId: this.ctx.cycleId, input, violations: result.violations });
      return result;
    }
    const now = new Date();
    const proposal: Proposal = {
      ...input,
      id: newId('p'),
      cycleId: this.ctx.cycleId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ctx.policy.approvals.expire_after_minutes * 60000).toISOString(),
      status: 'pending',
      requiredApprovers: result.requiredApprovers,
      approvals: [],
      derived: result.derived,
      checks: result.checks,
    };
    this.accepted.push(proposal);
    audit('proposal_created', { cycleId: this.ctx.cycleId, proposalId: proposal.id, label: proposal.derived.label, amountUsd: proposal.amountUsd });
    return { ...result, proposalId: proposal.id };
  }
}

export async function buildCycleContext(opts: { offline?: boolean } = {}): Promise<CycleContext> {
  const policy = loadPolicy();
  const [treasury, market] = await Promise.all([loadTreasury(), getSnapshot(policy, opts.offline)]);
  saveSnapshot(market);
  const idle = computeIdleCash(treasury, policy, market);
  const cycleId = `c-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  return { cycleId, policy, treasury, market, idle };
}

export type Proposer = (session: ProposalSession) => Promise<string>;

export interface CycleResult {
  ctx: CycleContext;
  proposals: Proposal[];
  rejected: ProposalSession['rejected'];
  summary: string;
  mode: CycleSummary['mode'];
}

export async function runCycle(opts: { offline?: boolean; useAgent?: boolean } = {}): Promise<CycleResult> {
  const ctx = await buildCycleContext(opts);
  const useAgent = opts.useAgent ?? Boolean(process.env.ANTHROPIC_API_KEY);
  const mode: CycleSummary['mode'] = useAgent ? 'agent' : 'baseline';
  audit('cycle_started', { cycleId: ctx.cycleId, mode, marketSource: ctx.market.source, marketErrors: ctx.market.errors, idleUsd: Math.round(ctx.idle.actionableIdleUsd) });

  const before = loadState();
  expireStale(before);
  saveState(before);
  const session = new ProposalSession(ctx);
  if (session.outstanding.length) audit('outstanding_proposals', { cycleId: ctx.cycleId, count: session.outstanding.length, amountUsd: session.outstanding.reduce((s, p) => s + p.amountUsd, 0) });
  const proposer: Proposer = useAgent ? (await import('./agent/run')).runAgent : (await import('./agent/baseline')).runBaseline;
  const summary = await proposer(session);

  const state = loadState();
  state.proposals.push(...session.accepted);
  state.cycles.push({
    id: ctx.cycleId,
    startedAt: new Date().toISOString(),
    mode,
    idleUsd: ctx.idle.actionableIdleUsd,
    proposed: session.accepted.length,
    rejectedByEngine: session.rejected.length,
    summary,
  });
  saveState(state);
  audit('cycle_finished', { cycleId: ctx.cycleId, proposed: session.accepted.length, rejectedByEngine: session.rejected.length });
  return { ctx, proposals: session.accepted, rejected: session.rejected, summary, mode };
}
