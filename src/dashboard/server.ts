import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { loadPolicy } from '../policy/load';
import { loadLocalTreasury } from '../sources/dashboard';
import { loadLastSnapshot, loadState, readAudit } from '../state/store';
import { computeIdleCash } from '../treasury/idle-cash';

/**
 * A stand-in for the internal treasury dashboard.
 *   GET /api/treasury   balances and obligations (the agent can read this via DASHBOARD_URL)
 *   GET /api/overview   everything the UI shows
 *   GET /               the UI
 */

const port = Number(process.env.DASHBOARD_PORT || 4100);
const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

function overview() {
  const policy = loadPolicy();
  const state = loadState();
  const market = loadLastSnapshot();
  const idle = computeIdleCash(loadLocalTreasury(), policy, market);
  const deployedUsd = state.positions.reduce((s, p) => s + p.amountUsd, 0);
  const expectedAnnualYieldUsd = state.positions.reduce((s, p) => s + (p.amountUsd * (p.expectedApyPct ?? 0)) / 100, 0);
  return {
    policyName: policy.name,
    asOf: idle.asOf,
    horizonDays: idle.horizonDays,
    market: market ? { source: market.source, fetchedAt: market.fetchedAt, errors: market.errors } : null,
    totals: {
      balanceUsd: idle.totalBalanceUsd,
      idleUsd: idle.actionableIdleUsd,
      deployedUsd,
      expectedAnnualYieldUsd,
      pending: state.proposals.filter((p) => p.status === 'pending').length,
    },
    accounts: idle.accounts,
    proposals: [...state.proposals].reverse().slice(0, 40),
    positions: state.positions,
    cycles: [...state.cycles].reverse().slice(0, 5),
    audit: readAudit(30).reverse(),
  };
}

function send(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (pathname === '/api/treasury') return send(res, 200, JSON.stringify(loadLocalTreasury()), 'application/json');
    if (pathname === '/api/overview') return send(res, 200, JSON.stringify(overview()), 'application/json');
    if (pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8');
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    send(res, 500, JSON.stringify({ error: (e as Error).message }), 'application/json');
  }
}).listen(port, () => console.log(`Dashboard on http://localhost:${port}`));
