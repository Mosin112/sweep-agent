import type { YieldPool } from '../types';

/**
 * Live yields from DeFiLlama's public yields API (no key needed).
 * Only pools from projects the policy could ever allow are kept, so the
 * snapshot stays small and auditable.
 */
export async function fetchPools(projects: string[]): Promise<YieldPool[]> {
  const res = await fetch('https://yields.llama.fi/pools', { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`DeFiLlama yields: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data: any[] };
  const wanted = new Set(projects);
  return body.data
    .filter((p) => wanted.has(p.project) && typeof p.apy === 'number')
    .map((p) => ({
      poolId: p.pool,
      project: p.project,
      chain: p.chain,
      symbol: p.symbol,
      tvlUsd: p.tvlUsd,
      apy: Number(p.apy.toFixed(4)),
      stablecoin: Boolean(p.stablecoin),
    }));
}
