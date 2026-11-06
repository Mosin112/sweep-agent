import type { IdleCashReport } from './treasury/idle-cash';
import type { Proposal } from './types';

export const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const num = (n: number) => Math.round(n).toLocaleString('en-US');

function table(rows: string[][], align: Array<'l' | 'r'> = []) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows
    .map((r, ri) => {
      const line = r.map((c, i) => (align[i] === 'r' ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
      return ri === 0 ? `${line}\n${widths.map((w) => '─'.repeat(w)).join('  ')}` : line;
    })
    .join('\n');
}

export function formatIdle(idle: IdleCashReport) {
  const rows = [['Account', 'Ccy', 'Balance', 'Reserved', 'Buffer', 'Idle', 'Idle (USD)', '']];
  for (const a of idle.accounts) rows.push([a.name, a.currency, num(a.balance), num(a.reserved), num(a.buffer), num(a.idle), usd(a.idleUsd), a.actionable ? '●' : '']);
  return `${table(rows, ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'l'])}\n\nTotal balance ${usd(idle.totalBalanceUsd)} · Actionable idle ${usd(idle.actionableIdleUsd)} · Obligations reserved for the next ${idle.horizonDays} days`;
}

export function expected(p: Proposal) {
  if (p.derived.expectedAnnualYieldUsd !== undefined) return `${p.derived.expectedApyPct?.toFixed(2)}% APY ≈ ${usd(p.derived.expectedAnnualYieldUsd)}/yr`;
  if (p.derived.expectedProfitUsd !== undefined) return `${p.derived.netSpreadBps} bps ≈ ${usd(p.derived.expectedProfitUsd)}`;
  if (p.derived.referencePrice) return `at ${p.derived.referencePrice.toLocaleString('en-US')}`;
  return '';
}

export function formatProposals(proposals: Proposal[]) {
  if (!proposals.length) return 'No proposals.';
  const rows = [['ID', 'Status', 'Proposal', 'From', 'Amount', 'Expected', 'Approvals']];
  for (const p of proposals) rows.push([p.id, p.status, p.derived.label, p.sourceAccountId, usd(p.amountUsd), expected(p), `${p.approvals.length}/${p.requiredApprovers}`]);
  return table(rows, ['l', 'l', 'l', 'l', 'r', 'l', 'r']);
}
