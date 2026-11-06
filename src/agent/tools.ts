import type Anthropic from '@anthropic-ai/sdk';
import type { ProposalSession } from '../cycle';
import { loadState } from '../state/store';
import { scanArbitrage, scanYields, type YieldKind } from '../strategies/opportunities';
import { marketPrice } from '../treasury/pricing';
import type { ProposalInput } from '../types';

const round = (n: number) => Math.round(n);

const proposalSchema: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['stablecoin_yield', 'tokenized_treasury', 'spot', 'arbitrage'] },
    source_account_id: { type: 'string', description: 'Account the cash comes from, from get_treasury_snapshot.' },
    amount_usd: { type: 'number', description: 'Ticket size in USD.' },
    pool_id: { type: 'string', description: 'Required for stablecoin_yield and tokenized_treasury. From scan_yields.' },
    asset: { type: 'string', description: 'Required for spot, e.g. BTC.' },
    pair: { type: 'string', description: 'Required for arbitrage, e.g. BTC-USD.' },
    buy_venue: { type: 'string', description: 'Required for arbitrage.' },
    sell_venue: { type: 'string', description: 'Required for arbitrage.' },
    rationale: { type: 'string', description: 'Why this is a good use of the cash, in one or two sentences for the approvers.' },
    risks: { type: 'array', items: { type: 'string' }, description: 'The main risks, short phrases.' },
  },
  required: ['kind', 'source_account_id', 'amount_usd', 'rationale', 'risks'],
};

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_treasury_snapshot',
    description: 'Balances, obligations reserved within the horizon, safety buffers and idle cash for every account, plus open positions and how much can still be deployed this cycle. All amounts in USD unless labelled.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_policy',
    description: 'The full treasury policy: allowed instruments, projects, chains, limits, conversion costs and approval tiers.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'scan_yields',
    description: 'Live yield opportunities that pass the policy filters, best APY first, plus a count of pools excluded and why.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['stablecoin_yield', 'tokenized_treasury'] },
        limit: { type: 'number', description: 'Max pools to return (default 10).' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'scan_arbitrage',
    description: 'Cross-venue spreads for every allowed pair, net of taker fees on both legs, best first. Only opportunities at or above the policy minimum can be proposed.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_spot_prices',
    description: 'Live bid/ask on each venue for the assets the policy allows for spot purchases.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'check_proposal',
    description: 'Dry run: check a proposal against the policy engine without submitting it. Returns violations, passed checks, derived yield or profit, and required approvers.',
    input_schema: proposalSchema,
  },
  {
    name: 'submit_proposal',
    description: 'Submit a proposal for human approval. The policy engine checks it first and rejects it with reasons if it breaks any rule.',
    input_schema: proposalSchema,
  },
];

function toInput(raw: any): ProposalInput {
  return {
    kind: raw.kind,
    sourceAccountId: raw.source_account_id,
    amountUsd: Number(raw.amount_usd),
    poolId: raw.pool_id,
    asset: raw.asset,
    pair: raw.pair,
    buyVenue: raw.buy_venue,
    sellVenue: raw.sell_venue,
    rationale: raw.rationale ?? '',
    risks: Array.isArray(raw.risks) ? raw.risks : [],
  };
}

export function runTool(name: string, input: any, session: ProposalSession): unknown {
  const { policy, idle, market } = session.ctx;
  switch (name) {
    case 'get_treasury_snapshot': {
      const { positions } = loadState();
      const cycleCap = (idle.actionableIdleUsd * policy.deployment.max_share_of_idle_pct) / 100;
      const proposed = session.committed().reduce((s, p) => s + p.amountUsd, 0);
      const deployed = positions.reduce((s, p) => s + p.amountUsd, 0);
      return {
        asOf: idle.asOf,
        horizonDays: idle.horizonDays,
        accounts: idle.accounts.map((a) => ({
          id: a.accountId,
          name: a.name,
          type: a.type,
          venue: a.venue,
          currency: a.currency,
          balance: round(a.balance),
          reservedForObligations: round(a.reserved),
          safetyBuffer: round(a.buffer),
          idle: round(a.idle),
          idleUsd: round(a.idleUsd),
          actionable: a.actionable,
          reservedFor: a.reservedFor,
        })),
        totals: {
          balanceUsd: round(idle.totalBalanceUsd),
          actionableIdleUsd: round(idle.actionableIdleUsd),
          cycleCapUsd: round(cycleCap),
          awaitingApprovalUsd: round(proposed),
          remainingThisCycleUsd: round(cycleCap - proposed),
          alreadyDeployedUsd: round(deployed),
          remainingUnderTotalLimitUsd: round(policy.deployment.max_total_deployed_usd - deployed - proposed),
        },
        openPositions: positions.map((p) => ({ label: p.label, amountUsd: round(p.amountUsd), project: p.project, asset: p.asset })),
        awaitingApproval: session.committed().map((p) => ({ id: p.id, label: p.derived.label, from: p.sourceAccountId, amountUsd: round(p.amountUsd), status: p.status })),
        marketData: { source: market.source, fetchedAt: market.fetchedAt, errors: market.errors },
      };
    }
    case 'get_policy':
      return policy;
    case 'scan_yields': {
      const kind = input.kind as YieldKind;
      const { eligible, eligibleCount, excluded } = scanYields(kind, policy, market, input.limit ?? 10);
      return {
        kind,
        eligibleCount,
        pools: eligible.map((p) => ({ poolId: p.poolId, project: p.project, chain: p.chain, symbol: p.symbol, apyPct: p.apy, tvlUsdMillions: Math.round(p.tvlUsd / 1e6) })),
        excludedByPolicy: excluded,
      };
    }
    case 'scan_arbitrage': {
      const opps = scanArbitrage(policy, market);
      return {
        minNetSpreadBps: policy.instruments.arbitrage.min_net_spread_bps,
        maxNotionalUsd: policy.instruments.arbitrage.max_notional_usd,
        opportunities: opps.slice(0, 12),
        clearingTheBar: opps.filter((o) => o.netSpreadBps >= policy.instruments.arbitrage.min_net_spread_bps).length,
      };
    }
    case 'get_spot_prices':
      return policy.instruments.spot.allowed_assets.map((asset) => ({
        asset,
        medianMid: marketPrice(`${asset}-USD`, market),
        quotes: market.quotes.filter((q) => q.pair === `${asset}-USD`),
      }));
    case 'check_proposal': {
      const r = session.check(toInput(input));
      return { ok: r.ok, violations: r.violations, checks: r.checks, requiredApprovers: r.requiredApprovers, derived: r.derived };
    }
    case 'submit_proposal': {
      const r = session.submit(toInput(input));
      return r.ok
        ? { submitted: true, proposalId: r.proposalId, requiredApprovers: r.requiredApprovers, derived: r.derived }
        : { submitted: false, violations: r.violations };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
