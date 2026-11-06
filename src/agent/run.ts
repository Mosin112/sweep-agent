import Anthropic from '@anthropic-ai/sdk';
import type { ProposalSession } from '../cycle';
import { audit } from '../state/store';
import { SYSTEM_PROMPT } from './prompt';
import { runTool, TOOLS } from './tools';

const MAX_TURNS = 30;

/** The Claude tool-use loop. The model investigates and proposes; the session enforces the policy. */
export async function runAgent(session: ProposalSession): Promise<string> {
  const client = new Anthropic();
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Run a sweep cycle (${session.ctx.cycleId}). Market data is ${session.ctx.market.source}, fetched ${session.ctx.market.fetchedAt}. Find idle cash and propose how to use it within the policy.`,
    },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({ model, max_tokens: 4096, system: SYSTEM_PROMPT, tools: TOOLS, messages });
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      audit('agent_finished', { cycleId: session.ctx.cycleId, turns: turn + 1, stopReason: response.stop_reason });
      return text || 'The agent finished without a summary.';
    }

    const results: Anthropic.ToolResultBlockParam[] = toolUses.map((use) => {
      try {
        const output = runTool(use.name, use.input, session);
        audit('agent_tool', { cycleId: session.ctx.cycleId, tool: use.name, input: use.input });
        return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(output) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: use.id, content: (e as Error).message, is_error: true };
      }
    });
    messages.push({ role: 'user', content: results });
  }

  audit('agent_turn_limit', { cycleId: session.ctx.cycleId });
  return `The agent hit the ${MAX_TURNS}-turn limit. ${session.accepted.length} proposals were submitted before it stopped.`;
}
