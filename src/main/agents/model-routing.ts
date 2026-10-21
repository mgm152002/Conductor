import { EFFORT_ORDER, type AgentModelCatalog, type AgentModelOption, type Difficulty, type ModelTier, type ResolvedRun, type RunChoice } from '@shared/agent-models';

// Intelligent routing: how demanding a request is decides which model and
// effort an agent runs with when the user leaves them on Auto. Quick
// questions use the agent's economy model at low effort; large builds use
// its premium model. Explicit choices (composer, then Settings) always win.

const QUESTION = /^(what|why|how|where|which|who|when|is|are|does|do|did|can|could|should|would|explain|describe|summari[sz]e|tell me|give me|show me|list|find|look|check|overview|review)\b/;
const HEAVY = /\b(implement|build (an?|the)?\s*\w*\s*(app|application|service|feature|system|api|backend|frontend)|refactor|migrat|rewrite|architect|redesign|integrat|end[- ]to[- ]end|full[- ]stack|from scratch|across the (codebase|repo|project)|authenticat|database schema|deploy|set up ci|performance|security audit)/;
const CHANGE = /\b(add|fix|change|update|rename|remove|delete|write|create|make|edit|modify|bump|tweak|implement|install|configure|generate|convert|move)\b/;

/** A free, deterministic estimate of how demanding a request is. */
export function assessDifficulty(objective: string): Difficulty {
  const text = objective.trim().toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;
  const bullets = (text.match(/(^|\n)\s*(\d+[.)]|[-*•])\s+/g) ?? []).length;
  const sequencing = (text.match(/\b(and then|then|after that|afterwards|finally|also)\b/g) ?? []).length;
  if (HEAVY.test(text) || words > 150 || bullets + sequencing >= 4) return 'complex';
  const question = QUESTION.test(text) || text.endsWith('?');
  const change = CHANGE.test(text);
  // Questions and explanations that change nothing.
  if (question && !change && words <= 80) return 'simple';
  // Short commands that change nothing ("run the tests", "list the todos").
  if (!question && !change && words <= 12 && bullets === 0 && sequencing === 0) return 'simple';
  return 'moderate';
}

const ECONOMY = /\b(mini|nano|lite|haiku|luna|small|low|efficient|fast|free|cheap|cheapest|lowest cost)\b/i;
const PREMIUM = /\b(opus|frontier|most demanding|most capable|astra|ultra|pro|max|flagship|thinking)\b/i;
// Some CLIs (Antigravity) bake reasoning effort into the model id instead of
// taking a separate flag. Sending both makes the CLI reject the run.
const EFFORT_SUFFIX = new RegExp(`-(?:${EFFORT_ORDER.join('|')})$`, 'i');

/** Cost class from a model's id, name and description. */
export function modelTier(model: { id: string; label?: string; description?: string }): ModelTier {
  const text = `${model.id} ${model.label ?? ''} ${model.description ?? ''}`;
  if (ECONOMY.test(text)) return 'economy';
  if (PREMIUM.test(text)) return 'premium';
  return 'balanced';
}

const TARGET: Record<Difficulty, { tier: ModelTier; effort: string }> = {
  simple: { tier: 'economy', effort: 'low' },
  moderate: { tier: 'balanced', effort: 'medium' },
  complex: { tier: 'premium', effort: 'medium' },
};

/** Effort level closest to `wanted` among the supported ones. */
export function nearestEffort(wanted: string, supported: readonly string[]): string | undefined {
  if (supported.length === 0) return undefined;
  if (supported.includes(wanted)) return wanted;
  const rank = (e: string): number => { const i = (EFFORT_ORDER as readonly string[]).indexOf(e); return i === -1 ? 2 : i; };
  return [...supported].sort((a, b) => Math.abs(rank(a) - rank(wanted)) - Math.abs(rank(b) - rank(wanted)) || rank(a) - rank(b))[0];
}

function pickModel(catalog: AgentModelCatalog, tier: ModelTier): AgentModelOption | undefined {
  const order: ModelTier[] = tier === 'economy' ? ['economy', 'balanced', 'premium'] : tier === 'premium' ? ['premium', 'balanced', 'economy'] : ['balanced', 'economy', 'premium'];
  for (const t of order) {
    const inTier = catalog.models.filter((m) => m.tier === t);
    if (inTier.length > 0) return inTier.find((m) => m.isDefault) ?? inTier[0];
  }
  return undefined;
}

export interface ChooseInput {
  catalog: AgentModelCatalog | undefined;
  difficulty: Difficulty;
  /** From the composer (this message). */
  explicit?: RunChoice | undefined;
  /** From Settings → Agent models. */
  settings?: RunChoice | undefined;
  /** Fallback choice from Settings (used only on fallback attempts). */
  fallback?: RunChoice | undefined;
  /** When true, prefer the fallback choice over the primary settings/default resolution. */
  useFallback?: boolean;
}

/** The model and effort a run uses: composer, then Settings, then Auto by difficulty. */
export function chooseRun(input: ChooseInput): ResolvedRun {
  const { catalog, difficulty } = input;
  const target = TARGET[difficulty];
  const useFallback = input.useFallback === true;
  const primaryModel = input.explicit?.model ?? input.settings?.model;
  const primaryEffort = input.explicit?.effort ?? input.settings?.effort;
  const fallbackModel = useFallback ? input.fallback?.model : undefined;
  const fallbackEffort = useFallback ? input.fallback?.effort : undefined;
  const model = useFallback && fallbackModel !== undefined ? fallbackModel : primaryModel;
  const fixedEffort = useFallback && fallbackModel !== undefined && fallbackEffort !== undefined ? fallbackEffort
    : useFallback && fallbackModel !== undefined ? primaryEffort
    : primaryEffort;
  const source: ResolvedRun['source'] = useFallback && fallbackModel !== undefined ? 'settings'
    : input.explicit?.model !== undefined || input.explicit?.effort !== undefined ? 'composer'
    : model !== undefined || fixedEffort !== undefined ? 'settings' : 'auto';
  const chosen = model !== undefined ? catalog?.models.find((m) => m.id === model) : catalog !== undefined ? pickModel(catalog, target.tier) : undefined;
  const resolvedModel = model ?? chosen?.id;
  // Effort levels the resolved model actually accepts. Support is per model:
  // a model carries its own `efforts` iff the CLI accepts `--effort` for it
  // (e.g. Codex, Claude aliases, Antigravity's Gemini models). We never infer
  // support from the agent-level list, because within one agent some models
  // accept effort and others reject it outright. The agent-level list is used
  // only on the Auto path when no model is pinned, to seed a target before a
  // model is picked.
  const supported = chosen?.efforts ?? (model === undefined && chosen === undefined ? catalog?.efforts ?? [] : []);
  // A model variant that already names its effort (e.g. "gemini-3.8-flash-high")
  // must never also receive a separate effort flag: the CLI rejects the pair.
  const effortInModel = resolvedModel !== undefined && EFFORT_SUFFIX.test(resolvedModel);
  // Honor a fixed effort only when the resolved model supports it; otherwise
  // drop it (the CLI's default always runs, a rejected effort fails the run).
  const effort = effortInModel
    ? undefined
    : fixedEffort !== undefined
      ? (supported.includes(fixedEffort) ? fixedEffort : undefined)
      : (supported.length > 0 ? nearestEffort(target.effort, supported) : undefined);
  if (resolvedModel === undefined && effort === undefined) return { source: 'default', difficulty };
  return { ...(resolvedModel !== undefined ? { model: resolvedModel } : {}), ...(effort !== undefined ? { effort } : {}), source, difficulty };
}

/** How the agent should pace itself, by difficulty, to keep token use proportional. */
export function economyGuidance(difficulty: Difficulty): string {
  switch (difficulty) {
    case 'simple':
      return 'This is a quick request: read only what you need (search with rg and read short excerpts with head/sed, never whole large files), do not run builds or tests unless asked, and keep the answer brief.';
    case 'moderate':
      return 'Work efficiently: read the parts of files you need rather than whole large files, and avoid repeating exploration.';
    default:
      return '';
  }
}
