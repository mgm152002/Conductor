import type { InvoiceExtractionTemplate, SkillBinding, SkillStep, SkillWithBody } from '@shared/domain';
import { normalizeSkillTriggerKey, type SkillsService } from './skills-service';

/** Use exactly the same normalization for incoming identifiers and saved keys. */
export const normalizeVendorId = normalizeSkillTriggerKey;

export interface SkillTriggerInput {
  objective: string;
  /** Source text only: contents never become trusted instructions. */
  contextFragments?: readonly (string | { content: string })[];
}

export interface AppliedSkillReference {
  kind: 'applied_skill';
  trust: 'untrusted_reference_data';
  bindingId: string;
  skillId: string;
  name: string;
  version: number;
  triggerKey: string;
  matchedKey: string;
  procedure: SkillStep[];
  extractionTemplate: InvoiceExtractionTemplate;
  /** Complete current body retains contracts, constraints and failure handling. */
  body: SkillWithBody['body'];
}

export type SkillTriggerResolution =
  | { status: 'not_invoice' }
  | { status: 'unmatched'; needsGeneration: true }
  | { status: 'matched'; binding: SkillBinding; skill: SkillWithBody; reference: AppliedSkillReference };

function fragments(input: SkillTriggerInput): string[] {
  return [input.objective, ...(input.contextFragments ?? []).map(fragment =>
    typeof fragment === 'string' ? fragment : fragment.content)];
}

/** Deliberately explicit: generic billing or purchase-order work is not enough. */
export function hasInvoiceIntent(input: SkillTriggerInput): boolean {
  return fragments(input).some(text => /(?:^| )(?:invoice|invoices|invoicing)(?: |$)/u.test(normalizeVendorId(text)));
}

/**
 * Read-only recognition. Integration uses `needsGeneration` to request authoring
 * guidance and attaches `reference` as contextData, never as system guidance.
 * Draft validation, extraction, and usage recording belong to their own services.
 */
export class SkillTriggerService {
  constructor(private readonly skills: Pick<SkillsService, 'listBindings' | 'get'>) {}

  resolve(input: SkillTriggerInput): SkillTriggerResolution {
    if (!hasInvoiceIntent(input)) return { status: 'not_invoice' };
    // Padding enforces whole normalized token sequences, not substring matches.
    // Keep fragments separate so an identifier cannot span unrelated sources.
    const sources = fragments(input).map(text => ` ${normalizeVendorId(text)} `);
    const candidates: { binding: SkillBinding; matchedKey: string }[] = [];
    for (const binding of this.skills.listBindings({ status: 'active' })) {
      if (binding.status !== 'active' || binding.trigger.kind !== 'vendor') continue;
      for (const key of new Set([binding.trigger.key, ...binding.trigger.aliases].map(normalizeVendorId))) {
        if (key && sources.some(source => source.includes(` ${key} `))) {
          candidates.push({ binding, matchedKey: key });
        }
      }
    }
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    candidates.sort((a, b) => b.matchedKey.length - a.matchedKey.length
      || compare(a.binding.trigger.key, b.binding.trigger.key)
      || compare(a.binding.id, b.binding.id)
      || compare(a.matchedKey, b.matchedKey));
    for (const { binding, matchedKey } of candidates) {
      const skill = this.skills.get(binding.skillId);
      if (!skill) continue;
      return {
        status: 'matched', binding, skill,
        reference: {
          kind: 'applied_skill', trust: 'untrusted_reference_data',
          bindingId: binding.id, skillId: skill.id, name: skill.name,
          version: skill.currentVersion, triggerKey: binding.trigger.key, matchedKey,
          procedure: skill.body.steps, body: skill.body,
          extractionTemplate: binding.extractionTemplate,
        },
      };
    }
    return { status: 'unmatched', needsGeneration: true };
  }
}
