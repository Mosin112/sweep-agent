import { z } from 'zod';

const positive = z.number().positive();
const pct = z.number().min(0).max(100);

const yieldInstrument = z.object({
  enabled: z.boolean(),
  allowed_projects: z.array(z.string()).min(1),
  allowed_chains: z.array(z.string()).min(1),
  min_tvl_usd: z.number().min(0),
  min_apy_pct: z.number().min(0),
  max_apy_pct: z.number().positive(),
  max_per_project_usd: positive,
  min_approvers: z.number().int().min(1),
});

export const policySchema = z.object({
  name: z.string(),
  fx_to_usd: z.record(z.string(), positive),
  liquidity: z.object({
    horizon_days: z.number().int().min(0),
    default_buffer_pct: pct,
    account_minimums: z.record(z.string(), z.number().min(0)).default({}),
    min_idle_usd_to_act: z.number().min(0),
  }),
  deployment: z.object({
    max_share_of_idle_pct: pct,
    max_total_deployed_usd: positive,
    min_ticket_usd: positive,
    conversion_costs_bps: z.record(z.string(), z.number().min(0)),
  }),
  instruments: z.object({
    stablecoin_yield: yieldInstrument.extend({ allowed_assets: z.array(z.string()).min(1) }),
    tokenized_treasuries: yieldInstrument.extend({ subscription_asset: z.string() }),
    spot: z.object({
      enabled: z.boolean(),
      allowed_assets: z.array(z.string()),
      max_position_usd: positive,
      min_approvers: z.number().int().min(1),
    }),
    arbitrage: z.object({
      enabled: z.boolean(),
      pairs: z.array(z.string()),
      venues: z.array(z.string()),
      taker_fee_bps: z.record(z.string(), z.number().min(0)),
      min_net_spread_bps: z.number(),
      max_notional_usd: positive,
      min_approvers: z.number().int().min(1),
    }),
  }),
  approvals: z.object({
    tiers: z.array(z.object({ max_usd: positive, approvers: z.number().int().min(1) })).min(1),
    allowed_approvers: z.array(z.string()).default([]),
    expire_after_minutes: positive,
  }),
  execution: z.object({
    mode: z.literal('simulated'),
    recheck_before_execute: z.boolean(),
    max_price_drift_bps: positive,
  }),
});

export type Policy = z.infer<typeof policySchema>;
