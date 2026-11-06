import { audit } from '../state/store';
import type { LedgerState } from '../types';

/** Proposals nobody acted on in time can't be approved later. */
export function expireStale(state: LedgerState, now = new Date()) {
  for (const p of state.proposals) {
    if ((p.status === 'pending' || p.status === 'approved') && new Date(p.expiresAt) < now) {
      p.status = 'expired';
      audit('proposal_expired', { proposalId: p.id });
    }
  }
}
