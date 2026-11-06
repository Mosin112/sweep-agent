import type { IdleCashReport } from '../treasury/idle-cash';
import { marketPrice } from '../treasury/pricing';
import type { Derived, MarketSnapshot, Position, Proposal, ProposalInput } from '../types';
import { arbSpread, findQuote, poolAsset, poolExclusion, yieldConfig, type YieldKind } from '../strategies/opportunities';
import type { Policy } from './schema';

/**
 * The guardrail. Deterministic code, not the model, decides whether a
 * proposal is allowed. It looks up every price and yield itself, so the
 * model can't talk its way past a limit or invent a number.
 */

export interface EngineContext {
  policy: Policy;
  idle: IdleCashReport;
  market: MarketSnapshot;
  positions: Position[];
  /** Proposals already accepted this cycle. They use up idle cash and limits. */
  pending: Array<Pick<Proposal, 'id' | 'kind' | 'sourceAccountId' | 'amountUsd' | 'derived' | 'asset'>>;
  /** Re-check at execution time. The per-cycle cap was a planning limit and isn't re-applied. */
  recheck?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  violations: string[];
  checks: string[];
  requiredApprovers: number;
  derived: Derived;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function validateProposal(input: ProposalInput, ctx: EngineContext): ValidationResult {
  const { policy, idle, market, positions, pending } = ctx;
  const violations: string[] = [];
  const checks: string[] = [];
  const pass = (ok: boolean, okMsg: string, failMsg: string) => (ok ? checks.push(okMsg) : violations.push(failMsg));
  const derived: Derived = { label: input.kind, conversionCostUsd: 0 };
  let instrumentMinApprovers = 1;

  // 1. Basic shape
  pass(input.amountUsd > 0 && Number.isFinite(input.amountUsd), 'Amount is a positive number', 'Amount must be a positive number');
  pass(input.amountUsd >= policy.deployment.min_ticket_usd, `At or above the ${usd(policy.deployment.min_ticket_usd)} minimum ticket`, `Below the ${usd(policy.deployment.min_ticket_usd)} minimum ticket`);
  pass(Boolean(input.rationale?.trim()), 'Has a written rationale', 'A rationale is required');

  // 2. Cash: the money must be idle, and the cycle and portfolio limits must hold
  const source = idle.accounts.find((a) => a.accountId === input.sourceAccountId);
  if (!source) {
    violations.push(`Unknown source account "${input.sourceAccountId}"`);
  } else {
    const usedFromSource = sum(pending.filter((p) => p.sourceAccountId === source.accountId).map((p) => p.amountUsd));
    const available = source.idleUsd - usedFromSource;
    if (!ctx.recheck) pass(source.actionable, `${source.name} has actionable idle cash`, `${source.name} has no actionable idle cash`);
    pass(input.amountUsd <= available + 0.01, `Within ${source.name}'s idle cash (${usd(available)} available)`, `${source.name} only has ${usd(Math.max(0, available))} idle after reserves and buffers`);
  }

  const cycleCap = (idle.actionableIdleUsd * policy.deployment.max_share_of_idle_pct) / 100;
  const cycleUsed = sum(pending.map((p) => p.amountUsd));
  if (!ctx.recheck) {
    pass(cycleUsed + input.amountUsd <= cycleCap + 0.01, `Within this cycle's cap (${usd(cycleCap - cycleUsed)} left)`, `Exceeds this cycle's cap of ${policy.deployment.max_share_of_idle_pct}% of idle cash (${usd(Math.max(0, cycleCap - cycleUsed))} left)`);
  }

  const deployed = sum(positions.map((p) => p.amountUsd)) + cycleUsed;
  pass(deployed + input.amountUsd <= policy.deployment.max_total_deployed_usd, 'Within the total deployment limit', `Would take total deployed to ${usd(deployed + input.amountUsd)}, above the ${usd(policy.deployment.max_total_deployed_usd)} limit`);

  // 3. Instrument rules
  let instrumentCurrency: string | undefined;
  switch (input.kind) {
    case 'stablecoin_yield':
    case 'tokenized_treasury': {
      const kind: YieldKind = input.kind;
      const config = yieldConfig(kind, policy);
      instrumentMinApprovers = config.min_approvers;
      if (!config.enabled) {
        violations.push(`${kind} is disabled in the policy`);
        break;
      }
      const pool = market.pools.find((p) => p.poolId === input.poolId);
      if (!pool) {
        violations.push(`Pool "${input.poolId}" isn't in the current market data`);
        break;
      }
      const why = poolExclusion(kind, pool, policy);
      pass(!why, `${pool.project} ${pool.symbol} on ${pool.chain} is allowed (TVL ${usd(pool.tvlUsd)}, ${pool.apy.toFixed(2)}% APY)`, `Pool not allowed: ${why}`);
      const inProject = sum(positions.filter((p) => p.project === pool.project).map((p) => p.amountUsd)) + sum(pending.filter((p) => p.derived.project === pool.project).map((p) => p.amountUsd));
      pass(inProject + input.amountUsd <= config.max_per_project_usd, `Within the ${usd(config.max_per_project_usd)} per-project limit for ${pool.project}`, `Would put ${usd(inProject + input.amountUsd)} in ${pool.project}, above its ${usd(config.max_per_project_usd)} limit`);
      instrumentCurrency = poolAsset(kind, pool, policy);
      derived.label = `${pool.project} · ${pool.symbol} on ${pool.chain}`;
      derived.project = pool.project;
      derived.expectedApyPct = pool.apy;
      break;
    }
    case 'spot': {
      const config = policy.instruments.spot;
      instrumentMinApprovers = config.min_approvers;
      if (!config.enabled) {
        violations.push('Spot purchases are disabled in the policy');
        break;
      }
      const asset = input.asset ?? '';
      pass(config.allowed_assets.includes(asset), `${asset} is an allowed asset`, `Asset "${asset}" isn't allowed for spot purchases`);
      const price = marketPrice(`${asset}-USD`, market);
      pass(price !== undefined, `Live ${asset} price available`, `No live price for ${asset}`);
      if (source) pass(source.type === 'exchange', 'Source is an exchange account', 'Spot purchases must be funded from an exchange account');
      const held = sum(positions.filter((p) => p.kind === 'spot' && p.asset === asset).map((p) => p.amountUsd)) + sum(pending.filter((p) => p.kind === 'spot' && p.asset === asset).map((p) => p.amountUsd));
      pass(held + input.amountUsd <= config.max_position_usd, `Within the ${usd(config.max_position_usd)} ${asset} position limit`, `Would take the ${asset} position to ${usd(held + input.amountUsd)}, above the ${usd(config.max_position_usd)} limit`);
      instrumentCurrency = 'USD';
      derived.label = `Buy ${asset}`;
      derived.instrumentAsset = asset;
      derived.referencePrice = price;
      break;
    }
    case 'arbitrage': {
      const config = policy.instruments.arbitrage;
      instrumentMinApprovers = config.min_approvers;
      if (!config.enabled) {
        violations.push('Arbitrage is disabled in the policy');
        break;
      }
      const { pair = '', buyVenue = '', sellVenue = '' } = input;
      pass(config.pairs.includes(pair), `${pair} is an allowed pair`, `Pair "${pair}" isn't allowed`);
      pass(config.venues.includes(buyVenue) && config.venues.includes(sellVenue) && buyVenue !== sellVenue, 'Buy and sell venues are allowed and different', 'Buy and sell venues must be two different allowed venues');
      if (source) pass(source.venue === buyVenue, `Funded from an account on ${buyVenue}`, `Arbitrage must be funded from an account on the buy venue (${buyVenue}); ${source.name} is on ${source.venue}`);
      pass(input.amountUsd <= config.max_notional_usd, `Within the ${usd(config.max_notional_usd)} arbitrage notional limit`, `Above the ${usd(config.max_notional_usd)} arbitrage notional limit`);
      const buy = findQuote(market, pair, buyVenue);
      const sell = findQuote(market, pair, sellVenue);
      if (!buy || !sell) {
        violations.push(`No live quotes for ${pair} on ${!buy ? buyVenue : sellVenue}`);
        break;
      }
      const opp = arbSpread(buy, sell, config.taker_fee_bps);
      pass(opp.netSpreadBps >= config.min_net_spread_bps, `Net spread ${opp.netSpreadBps} bps clears the ${config.min_net_spread_bps} bps minimum`, `Net spread is ${opp.netSpreadBps} bps after ${opp.feesBps} bps of fees, below the ${config.min_net_spread_bps} bps minimum`);
      instrumentCurrency = 'USD';
      derived.label = `${pair}: buy on ${buyVenue}, sell on ${sellVenue}`;
      derived.netSpreadBps = opp.netSpreadBps;
      derived.referencePrice = opp.buyAsk;
      break;
    }
    default:
      violations.push(`Unknown proposal kind "${(input as ProposalInput).kind}"`);
  }

  // 4. Cost of getting the cash into the right currency
  if (source && instrumentCurrency && source.currency !== instrumentCurrency) {
    const route = `${source.currency}->${instrumentCurrency}`;
    const bps = policy.deployment.conversion_costs_bps[route];
    if (bps === undefined) violations.push(`No allowed conversion route ${route}`);
    else {
      derived.conversionCostUsd = (input.amountUsd * bps) / 10000;
      checks.push(`Conversion ${route} allowed (${bps} bps, ${usd(derived.conversionCostUsd)})`);
    }
  }
  if (derived.expectedApyPct !== undefined) derived.expectedAnnualYieldUsd = (input.amountUsd * derived.expectedApyPct) / 100 - derived.conversionCostUsd;
  if (derived.netSpreadBps !== undefined) derived.expectedProfitUsd = (input.amountUsd * derived.netSpreadBps) / 10000 - derived.conversionCostUsd;

  // 5. Who has to sign off
  const tier = policy.approvals.tiers.find((t) => input.amountUsd <= t.max_usd);
  let requiredApprovers = instrumentMinApprovers;
  if (!tier) violations.push(`Amount is above the largest approval tier (${usd(policy.approvals.tiers.at(-1)!.max_usd)})`);
  else {
    requiredApprovers = Math.max(tier.approvers, instrumentMinApprovers);
    checks.push(`Needs ${requiredApprovers} approver${requiredApprovers > 1 ? 's' : ''}`);
  }

  return { ok: violations.length === 0, violations, checks, requiredApprovers, derived };
}
