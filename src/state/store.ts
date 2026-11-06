import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerState, MarketSnapshot } from '../types';

const DIR = process.env.SWEEP_STATE_DIR || 'state';
const LEDGER = () => join(DIR, 'ledger.json');
const AUDIT = () => join(DIR, 'audit.jsonl');
const SNAPSHOT = () => join(DIR, 'last-snapshot.json');

const empty = (): LedgerState => ({ proposals: [], positions: [], accountDeltas: {}, cycles: [] });

export function loadState(): LedgerState {
  if (!existsSync(LEDGER())) return empty();
  return { ...empty(), ...JSON.parse(readFileSync(LEDGER(), 'utf8')) };
}

export function saveState(state: LedgerState) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(LEDGER(), JSON.stringify(state, null, 2));
}

/** Append-only record of everything the agent and the humans did. */
export function audit(event: string, data: Record<string, unknown> = {}) {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(AUDIT(), JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n');
}

export function readAudit(limit = 50): Array<Record<string, unknown>> {
  if (!existsSync(AUDIT())) return [];
  const lines = readFileSync(AUDIT(), 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l));
}

export function saveSnapshot(snapshot: MarketSnapshot) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(SNAPSHOT(), JSON.stringify(snapshot));
}

export function loadLastSnapshot(): MarketSnapshot | undefined {
  return existsSync(SNAPSHOT()) ? JSON.parse(readFileSync(SNAPSHOT(), 'utf8')) : undefined;
}

export function resetState() {
  rmSync(DIR, { recursive: true, force: true });
}
