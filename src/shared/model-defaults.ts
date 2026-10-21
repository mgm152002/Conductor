// Shared contract for default/fallback model configuration.

export const MODEL_ID_REGEX = /^[\w./:@-]{1,100}$/;

export type ModelDefaults = {
  defaultModel?: string;
  fallbackModel?: string;
};

export function defaultModelKey(agentId: string): string {
  return `agents.${agentId}.model`;
}

export function fallbackModelKey(agentId: string): string {
  return `agents.${agentId}.fallbackModel`;
}

export function isValidModelId(modelId: string): boolean {
  return MODEL_ID_REGEX.test(modelId);
}
