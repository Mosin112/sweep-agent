import { readFileSync } from 'node:fs';
import type { TreasuryData } from '../types';
import { loadState } from '../state/store';

/**
 * Where balances and upcoming obligations come from.
 *
 * In production this is your internal treasury dashboard or core-banking API:
 * set DASHBOARD_URL and return the same shape from GET /api/treasury.
 * In the demo it reads data/treasury.json and applies the simulated executions.
 */
export async function loadTreasury(): Promise<TreasuryData> {
  const url = process.env.DASHBOARD_URL;
  if (url) {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/treasury`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Dashboard ${url} returned ${res.status}`);
    return (await res.json()) as TreasuryData;
  }
  return loadLocalTreasury();
}

const DAY = 24 * 60 * 60 * 1000;

export function loadLocalTreasury(path = 'data/treasury.json', now = new Date()): TreasuryData {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const { accountDeltas } = loadState();
  return {
    asOf: now.toISOString(),
    accounts: raw.accounts.map((a: any) => ({ ...a, balance: a.balance + (accountDeltas[a.id] ?? 0) })),
    obligations: raw.obligations.map((o: any) => ({
      id: o.id,
      accountId: o.accountId,
      amount: o.amount,
      description: o.description,
      dueDate: o.dueDate ?? new Date(now.getTime() + o.dueInDays * DAY).toISOString(),
    })),
  };
}
