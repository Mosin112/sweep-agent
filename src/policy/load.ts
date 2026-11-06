import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { policySchema, type Policy } from './schema';

export function loadPolicy(path = process.env.POLICY_PATH || 'policies/treasury-policy.yaml'): Policy {
  const raw = parse(readFileSync(resolve(path), 'utf8'));
  const result = policySchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Policy file ${path} is invalid:\n${issues}`);
  }
  const policy = result.data;
  policy.approvals.tiers.sort((a, b) => a.max_usd - b.max_usd);
  return policy;
}
