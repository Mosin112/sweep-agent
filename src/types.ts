export type AccountType = 'bank' | 'exchange' | 'wallet';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  venue: string;
  currency: string;
  balance: number;
}

export interface Obligation {
  id: string;
  accountId: string;
  amount: number;
  dueDate: string;
  description: string;
}

export interface TreasuryData {
  asOf: string;
  accounts: Account[];
  obligations: Obligation[];
}

/** Best bid and ask for one pair on one venue. */
export interface Quote {
  venue: string;
  pair: string;
  bid: number;
  ask: number;
}

export interface YieldPool {
  poolId: string;
  project: string;
  chain: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  stablecoin: boolean;
}

export interface MarketSnapshot {
  fetchedAt: string;
  source: 'live' | 'fixture';
  quotes: Quote[];
  pools: YieldPool[];
  errors: string[];
}

export type ProposalKind = 'stablecoin_yield' | 'tokenized_treasury' | 'spot' | 'arbitrage';

/** What the agent (or the baseline) asks for. It never includes prices or yields: the engine looks those up. */
export interface ProposalInput {
  kind: ProposalKind;
  sourceAccountId: string;
  amountUsd: number;
  poolId?: string;
  asset?: string;
  pair?: string;
  buyVenue?: string;
  sellVenue?: string;
  rationale: string;
  risks: string[];
}

/** Numbers the engine derives from market data, never from the model. */
export interface Derived {
  label: string;
  project?: string;
  instrumentAsset?: string;
  conversionCostUsd: number;
  expectedApyPct?: number;
  expectedAnnualYieldUsd?: number;
  netSpreadBps?: number;
  expectedProfitUsd?: number;
  referencePrice?: number;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'blocked' | 'expired';

export interface Approval {
  by: string;
  at: string;
}

export interface Proposal extends ProposalInput {
  id: string;
  cycleId: string;
  createdAt: string;
  expiresAt: string;
  status: ProposalStatus;
  requiredApprovers: number;
  approvals: Approval[];
  rejectedBy?: Approval;
  derived: Derived;
  checks: string[];
  executionNote?: string;
  slack?: { channel: string; ts: string };
}

export interface Position {
  id: string;
  proposalId: string;
  kind: ProposalKind;
  label: string;
  project?: string;
  asset?: string;
  amountUsd: number;
  sourceAccountId: string;
  openedAt: string;
  expectedApyPct?: number;
}

export interface CycleSummary {
  id: string;
  startedAt: string;
  mode: 'agent' | 'baseline';
  idleUsd: number;
  proposed: number;
  rejectedByEngine: number;
  summary: string;
}

export interface LedgerState {
  proposals: Proposal[];
  positions: Position[];
  /** Change to each account's balance from simulated executions, in the account's currency. */
  accountDeltas: Record<string, number>;
  cycles: CycleSummary[];
}
