import type { Policy } from '../policy/schema';
import type { MarketSnapshot, TreasuryData } from '../types';
import { usdPerUnit } from './pricing';

export interface AccountIdle {
  accountId: string;
  name: string;
  venue: string;
  type: string;
  currency: string;
  balance: number;
  reserved: number;
  buffer: number;
  idle: number;
  usdPerUnit: number;
  balanceUsd: number;
  idleUsd: number;
  actionable: boolean;
  reservedFor: string[];
}

export interface IdleCashReport {
  asOf: string;
  horizonDays: number;
  accounts: AccountIdle[];
  totalBalanceUsd: number;
  totalIdleUsd: number;
  actionableIdleUsd: number;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Idle cash = balance - obligations due inside the horizon - safety buffer.
 * Deterministic on purpose: the model never decides how much cash is free.
 */
export function computeIdleCash(data: TreasuryData, policy: Policy, market?: MarketSnapshot): IdleCashReport {
  const { horizon_days, default_buffer_pct, account_minimums, min_idle_usd_to_act } = policy.liquidity;
  const now = new Date(data.asOf).getTime();
  const cutoff = now + horizon_days * DAY;

  const accounts = data.accounts.map((a): AccountIdle => {
    const due = data.obligations.filter((o) => o.accountId === a.id && new Date(o.dueDate).getTime() <= cutoff);
    const reserved = due.reduce((s, o) => s + o.amount, 0);
    const buffer = Math.max(account_minimums[a.id] ?? 0, (a.balance * default_buffer_pct) / 100);
    const idle = Math.max(0, a.balance - reserved - buffer);
    const rate = usdPerUnit(a.currency, policy, market);
    const idleUsd = idle * rate;
    return {
      accountId: a.id,
      name: a.name,
      venue: a.venue,
      type: a.type,
      currency: a.currency,
      balance: a.balance,
      reserved,
      buffer,
      idle,
      usdPerUnit: rate,
      balanceUsd: a.balance * rate,
      idleUsd,
      actionable: idleUsd >= min_idle_usd_to_act,
      reservedFor: due.map((o) => `${o.description} (${o.amount.toLocaleString('en-US')} ${a.currency}, due ${o.dueDate.slice(0, 10)})`),
    };
  });

  return {
    asOf: data.asOf,
    horizonDays: horizon_days,
    accounts,
    totalBalanceUsd: accounts.reduce((s, a) => s + a.balanceUsd, 0),
    totalIdleUsd: accounts.reduce((s, a) => s + a.idleUsd, 0),
    actionableIdleUsd: accounts.filter((a) => a.actionable).reduce((s, a) => s + a.idleUsd, 0),
  };
}
