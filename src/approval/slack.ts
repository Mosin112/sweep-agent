import 'dotenv/config';
import { App, type BlockAction, type ButtonAction } from '@slack/bolt';
import { runCycle, type CycleResult } from '../cycle';
import { approveProposal, rejectProposal } from '../execution/simulator';
import { expected, usd } from '../format';
import { loadState, saveState } from '../state/store';
import type { Proposal } from '../types';

/**
 * Slack is where humans stay in the loop:
 *   /sweep            run a cycle and post the proposals to the channel
 *   Approve / Reject  buttons on each proposal; bigger tickets need more approvers
 * Runs in Socket Mode, so no public URL is needed. Create the app from slack/manifest.yaml.
 */

const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_CHANNEL_ID, SWEEP_INTERVAL_MINUTES } = process.env;
if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error('Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env (see README: Slack setup).');
  process.exit(1);
}

const app = new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true });
type WebClient = App['client'];

function statusLine(p: Proposal) {
  switch (p.status) {
    case 'pending':
      return `:hourglass_flowing_sand: Waiting for approval · ${p.approvals.length}/${p.requiredApprovers}${p.approvals.length ? ` (${p.approvals.map((a) => `<@${a.by}>`).join(', ')})` : ''} · expires <!date^${Math.floor(new Date(p.expiresAt).getTime() / 1000)}^{time}|${p.expiresAt}>`;
    case 'executed':
      return `:white_check_mark: Executed (simulated) · approved by ${p.approvals.map((a) => `<@${a.by}>`).join(', ')} · ${p.executionNote}`;
    case 'blocked':
      return `:no_entry: ${p.executionNote}`;
    case 'rejected':
      return `:x: Rejected by <@${p.rejectedBy?.by}>`;
    default:
      return `Status: ${p.status}`;
  }
}

function proposalBlocks(p: Proposal) {
  const blocks: any[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${p.derived.label}*\n${usd(p.amountUsd)} from \`${p.sourceAccountId}\` · ${expected(p)}` },
    },
    { type: 'section', text: { type: 'mrkdwn', text: `_${p.rationale}_` } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*Risks:* ${p.risks.join(' · ') || 'none listed'}  |  *Policy checks passed:* ${p.checks.length}` }],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: statusLine(p) }] },
  ];
  if (p.status === 'pending') {
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: 'sweep_approve', value: p.id },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: 'sweep_reject', value: p.id },
      ],
    });
  }
  return blocks;
}

async function postCycle(client: WebClient, channel: string, result: CycleResult) {
  const { ctx } = result;
  await client.chat.postMessage({
    channel,
    text: `Sweep ${ctx.cycleId}: ${result.proposals.length} proposals`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `Treasury sweep · ${usd(ctx.idle.actionableIdleUsd)} idle` } },
      { type: 'section', text: { type: 'mrkdwn', text: result.summary.slice(0, 2900) } },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${ctx.cycleId} · ${result.mode === 'agent' ? 'Claude agent' : 'deterministic baseline'} · market data: ${ctx.market.source} · ${result.rejected.length} idea(s) rejected by the policy engine` }],
      },
    ],
  });

  const state = loadState();
  for (const p of result.proposals) {
    const res = await client.chat.postMessage({ channel, text: `${p.derived.label}: ${usd(p.amountUsd)}`, blocks: proposalBlocks(p) });
    const stored = state.proposals.find((x) => x.id === p.id);
    if (stored && res.ts) stored.slack = { channel, ts: res.ts };
  }
  saveState(state);
}

async function refresh(client: WebClient, id: string) {
  const p = loadState().proposals.find((x) => x.id === id);
  if (p?.slack) await client.chat.update({ channel: p.slack.channel, ts: p.slack.ts, text: `${p.derived.label}: ${p.status}`, blocks: proposalBlocks(p) });
  return p;
}

app.command('/sweep', async ({ ack, respond, command, client }) => {
  await ack();
  await respond({ response_type: 'ephemeral', text: 'Running a sweep. Proposals will appear here in a moment.' });
  try {
    const result = await runCycle({ offline: command.text.includes('offline') });
    await postCycle(client, command.channel_id, result);
  } catch (e) {
    await respond({ response_type: 'ephemeral', text: `Sweep failed: ${(e as Error).message}` });
  }
});

for (const verb of ['approve', 'reject'] as const) {
  app.action<BlockAction<ButtonAction>>(`sweep_${verb}`, async ({ ack, body, action, client }) => {
    await ack();
    const id = action.value!;
    const user = body.user.id;
    const result = verb === 'approve' ? await approveProposal(id, user) : rejectProposal(id, user);
    const p = await refresh(client, id);
    if (!result.ok && p?.status !== 'blocked' && body.channel?.id) {
      await client.chat.postEphemeral({ channel: body.channel.id, user, text: result.message });
    }
    if (p?.slack && (p.status === 'executed' || p.status === 'blocked')) {
      await client.chat.postMessage({ channel: p.slack.channel, thread_ts: p.slack.ts, text: result.message });
    }
  });
}

await app.start();
console.log('sweep-agent is connected to Slack. Type /sweep in a channel the bot is in.');

const minutes = Number(SWEEP_INTERVAL_MINUTES);
if (minutes > 0 && SLACK_CHANNEL_ID) {
  setInterval(async () => {
    try {
      await postCycle(app.client, SLACK_CHANNEL_ID, await runCycle());
    } catch (e) {
      console.error('Scheduled sweep failed:', (e as Error).message);
    }
  }, minutes * 60000);
  console.log(`Scheduled sweeps every ${minutes} minutes to ${SLACK_CHANNEL_ID}.`);
}
