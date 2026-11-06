import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('idle cash', () => {
  const { idle } = setup();
  const acct = (id: string) => idle.accounts.find((a) => a.accountId === id)!;

  it('reserves only obligations due inside the horizon', () => {
    // 6.0M + 2.5M AED are due in 2 and 5 days; the 4.0M due in 12 days is outside the 7-day horizon.
    expect(acct('ops-bank-aed').reserved).toBe(8_500_000);
  });

  it('keeps the larger of the account minimum and the default buffer', () => {
    expect(acct('ops-bank-aed').buffer).toBe(3_000_000); // minimum beats 15% of 18.5M (2.775M)
    expect(acct('kraken-usd').buffer).toBe(97_500); // 15% of 650k
  });

  it('converts AED at the policy peg', () => {
    const a = acct('ops-bank-aed');
    expect(a.idle).toBe(7_000_000);
    expect(a.idleUsd).toBeCloseTo(7_000_000 * 0.2723, 0);
  });

  it('never reports negative idle cash', () => {
    for (const a of idle.accounts) expect(a.idle).toBeGreaterThanOrEqual(0);
  });
});
