import 'dotenv/config';
import { runCycle, buildCycleContext } from './cycle';
import { approveProposal, expireStale, rejectProposal } from './execution/simulator';
import { formatIdle, formatProposals, usd } from './format';
import { loadPolicy } from './policy/load';
import { fetchLiveSnapshot, saveFixture, FIXTURE_PATH } from './sources/snapshot';
import { loadState, resetState, saveState } from './state/store';
import { scanArbitrage, scanYields } from './strategies/opportunities';

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positional = rest.filter((a) => !a.startsWith('--'));
const flagValue = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const offline = flags.has('--offline');

async function main() {
  switch (command) {
    case 'sweep': {
      const useAgent = flags.has('--baseline') ? false : undefined;
      const result = await runCycle({ offline, useAgent });
      const { ctx } = result;
      console.log(`\nSweep ${ctx.cycleId} · ${result.mode === 'agent' ? `Claude agent (${process.env.ANTHROPIC_MODEL || 'claude-opus-5-5'})` : 'deterministic baseline'} · market data: ${ctx.market.source}`);
      if (ctx.market.errors.length) console.log(`Market data warnings: ${ctx.market.errors.join('; ')}`);
      console.log(`\n${formatIdle(ctx.idle)}\n`);
      console.log(formatProposals(result.proposals));
      if (result.rejected.length) {
        console.log(`\nThe policy engine rejected ${result.rejected.length} idea(s):`);
        for (const r of result.rejected) console.log(`  · ${r.input.kind} ${usd(r.input.amountUsd)} from ${r.input.sourceAccountId}: ${r.violations.join('; ')}`);
      }
      console.log(`\n${result.summary}\n`);
      if (result.proposals.length) console.log('Approve with: npm run approve -- <id> --as <your-name>   (or approve in Slack: npm run slack)\n');
      break;
    }
    case 'snapshot': {
      const ctx = await buildCycleContext({ offline });
      console.log(`\n${formatIdle(ctx.idle)}\n`);
      for (const kind of ['stablecoin_yield', 'tokenized_treasury'] as const) {
        const { eligible, excluded } = scanYields(kind, ctx.policy, ctx.market, 5);
        console.log(`${kind}: ${eligible.map((p) => `${p.project} ${p.symbol}/${p.chain} ${p.apy.toFixed(2)}%`).join(' · ') || 'none eligible'}`);
        console.log(`  excluded: ${JSON.stringify(excluded)}`);
      }
      const arbs = scanArbitrage(ctx.policy, ctx.market).slice(0, 5);
      console.log(`arbitrage (best net spreads): ${arbs.map((a) => `${a.pair} ${a.buyVenue}→${a.sellVenue} ${a.netSpreadBps}bps`).join(' · ')}\n`);
      break;
    }
    case 'proposals': {
      const state = loadState();
      expireStale(state);
      saveState(state);
      const list = flags.has('--all') ? state.proposals : state.proposals.filter((p) => p.status === 'pending');
      console.log(`\n${formatProposals(list)}\n`);
      if (state.positions.length) {
        console.log('Open positions:');
        for (const p of state.positions) console.log(`  · ${p.label}: ${usd(p.amountUsd)}${p.expectedApyPct ? ` at ${p.expectedApyPct.toFixed(2)}%` : ''}`);
        console.log();
      }
      break;
    }
    case 'approve':
    case 'reject': {
      const id = positional[0];
      const by = flagValue('--as') || process.env.USER || 'cli-user';
      if (!id) throw new Error(`Usage: npm run ${command} -- <proposal-id> --as <name>`);
      const r = command === 'approve' ? await approveProposal(id, by, { offline }) : rejectProposal(id, by);
      console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'reset':
      resetState();
      console.log('State cleared: proposals, positions, simulated balances and audit log.');
      break;
    case 'record-fixture': {
      const snap = await fetchLiveSnapshot(loadPolicy());
      saveFixture(snap);
      console.log(`Saved ${snap.quotes.length} quotes and ${snap.pools.length} pools to ${FIXTURE_PATH}${snap.errors.length ? ` (warnings: ${snap.errors.join('; ')})` : ''}`);
      break;
    }
    default:
      console.log('Commands: sweep [--offline] [--baseline] · snapshot · proposals [--all] · approve <id> --as <name> · reject <id> --as <name> · reset · record-fixture');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
