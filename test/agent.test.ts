import { beforeEach, describe, expect, it, vi } from 'vitest';

// A scripted stand-in for Claude, so the tool loop is tested without an API key.
const calls: any[] = [];
let script: Array<(lastToolResults: any[]) => any> = [];

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (params: any) => {
        calls.push(structuredClone(params));
        const last = params.messages.at(-1);
        const results = Array.isArray(last.content) ? last.content.filter((b: any) => b.type === 'tool_result') : [];
        return script.shift()!(results);
      },
    };
  },
}));

const toolUse = (id: string, name: string, input: object = {}) => ({ type: 'tool_use', id, name, input });

describe('Claude agent loop', () => {
  beforeEach(async () => {
    calls.length = 0;
    (await import('../src/state/store')).resetState();
  });

  it('feeds tool results back, lets the engine reject bad ideas, and returns the summary', async () => {
    let poolId = '';
    script = [
      () => ({ stop_reason: 'tool_use', content: [toolUse('t1', 'get_treasury_snapshot'), toolUse('t2', 'get_policy')] }),
      () => ({ stop_reason: 'tool_use', content: [toolUse('t3', 'scan_yields', { kind: 'stablecoin_yield' })] }),
      (results) => {
        poolId = JSON.parse(results[0].content).pools.find((p: any) => p.project === 'maple').poolId;
        return {
          stop_reason: 'tool_use',
          content: [toolUse('t4', 'submit_proposal', { kind: 'stablecoin_yield', source_account_id: 'treasury-wallet-usdc', amount_usd: 5_000_000, pool_id: poolId, rationale: 'Too big on purpose', risks: [] })],
        };
      },
      (results) => {
        expect(JSON.parse(results[0].content).submitted).toBe(false);
        return {
          stop_reason: 'tool_use',
          content: [toolUse('t5', 'submit_proposal', { kind: 'stablecoin_yield', source_account_id: 'treasury-wallet-usdc', amount_usd: 400_000, pool_id: poolId, rationale: 'Best allowed USDC yield with deep liquidity', risks: ['Credit risk'] })],
        };
      },
      () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Proposed $400,000 into Maple USDC.' }] }),
    ];

    process.env.ANTHROPIC_API_KEY = 'test';
    const { runCycle } = await import('../src/cycle');
    const result = await runCycle({ offline: true, useAgent: true });

    expect(result.mode).toBe('agent');
    expect(result.summary).toBe('Proposed $400,000 into Maple USDC.');
    expect(result.rejected).toHaveLength(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].derived.label).toMatch(/maple/);
    expect(calls).toHaveLength(5);
    expect(calls[0].tools.map((t: any) => t.name)).toContain('submit_proposal');
  });
});
