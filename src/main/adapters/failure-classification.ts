import type { AdapterResult } from '@shared/adapter';
import { compareAgentPreference } from '@shared/agent-preference';
import type { Registry } from '../registry/registry';

// Classifying an agent CLI's failure so Conductor can decide whether to fall
// back to a different agent. A usage/quota/rate-limit exhaustion is retryable
// on another agent (a different provider has its own quota). An invalid model
// (or model/effort combination) is also worth retrying elsewhere: the other
// CLI has its own model list. A plain error (bad input, a crash, an auth
// problem) is not — retrying elsewhere would just fail again and waste a
// second provider's budget.
//
// CLI errors arrive as stderr/stdout text and a non-zero exit code, not as a
// structured field, so classification is text-based over the collected output
// plus any `AdapterResult.error`.

const QUOTA = new RegExp([
  'usage limit',
  'quota',
  'rate limit',
  'rate.?limited',
  'too many requests',
  'insufficient (?:credit|quota|funds|balance)',
  'out of (?:credit|usage|capacity)',
  'credits? (?:exhausted|used up|ran out)',
  'billing',
  'payment required',
  'plan limit',
  'limit (?:reached|exceeded)',
  'exceeded your',
  'overloaded',
  'capacity',
  '\\b429\\b',
  '\\b529\\b',
].join('|'), 'i');

const MODEL = new RegExp([
  'invalid model',
  'model selection',
  'unknown model',
  'unsupported model',
  'model .{0,80}not (?:found|available|supported)',
  'model .{0,80}(?:requires|restricted|blocked)',
  'invalid effort',
  'conflicts with --effort',
  // Provider-side restrictions on a model (OpenCode Go): the CLI is fine, the
  // model is not usable for this account/region/privacy choice. Another agent
  // (or another model) can still do the work.
  'trains? on (?:request )?data',
  'privacy settings',
  'allow (?:paid )?endpoints',
  'workspace.{0,30}(?:privacy|settings)',
  'select .{0,30} in your workspace',
  'not (?:available|enabled) (?:in|for) your (?:workspace|account|region|plan)',
].join('|'), 'i');

export type FailureKind = 'quota_exhausted' | 'model_unavailable' | 'other';

/**
 * Classify a failed adapter run. `output` is the recent stderr/stdout text
 * collected while the agent ran; `result.error` (when present) is also
 * considered. Returns 'quota_exhausted' or 'model_unavailable' only for
 * signals that a different provider could plausibly satisfy.
 */
export function classifyFailure(result: Pick<AdapterResult, 'error'>, output: string): FailureKind {
  const text = `${result.error ?? ''}\n${output}`;
  if (QUOTA.test(text)) return 'quota_exhausted';
  if (MODEL.test(text)) return 'model_unavailable';
  return 'other';
}

/** Whether retrying on another available agent may succeed. */
export function retryableOnAnotherAgent(kind: FailureKind): boolean {
  return kind === 'quota_exhausted' || kind === 'model_unavailable';
}

/**
 * Keep only the most recent, non-empty lines of streamed output, bounded so a
 * verbose agent can't grow this without limit. Used to feed the classifier.
 */
export function tailLines(lines: readonly string[], max = 40): string {
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0 && kept.length < max; i -= 1) {
    const line = lines[i]!.trim();
    if (line !== '') kept.push(line);
  }
  return kept.reverse().join('\n');
}

/**
 * Available agents that can fulfil a casual-chat objective, in preference order,
 * excluding the ids already tried. Chat uses the bare `objective.fulfill`
 * capability on local CLI agents.
 */
export function chatFallbackCandidates(registry: Registry, tried: ReadonlySet<string>): string[] {
  return registry.listAdapters()
    .filter((a) => a.available && a.class === 'local_cli_agent'
      && a.capabilities.some((c) => c.id === 'objective.fulfill')
      && !tried.has(a.id))
    .map((a) => a.id)
    .sort(compareAgentPreference);
}
