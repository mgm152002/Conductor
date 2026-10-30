// A CLI's "logo" in the app's visual idiom: a small monogram tile in a
// colour derived from the agent id, like the project tiles in the sidebar.
// Used wherever an agent/model switch needs to be attributed at a glance.

const HUES = [222, 262, 190, 150, 24, 340, 96, 12];

function hueFor(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  return HUES[hash % HUES.length]!;
}

function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'A';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

export function AgentMark({ agentId, name, size = 18 }: { agentId: string; name: string; size?: number }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      title={name}
      className="flex shrink-0 items-center justify-center rounded-md font-bold text-white"
      style={{
        width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)),
        backgroundColor: `hsl(${hueFor(agentId)} 45% 42%)`,
      }}
    >
      {initials(name)}
    </span>
  );
}

/** The centered divider shown in the answer space when the CLI/model changes. */
export function HandoffDivider({ fromAgent, fromModel, toAgentId, toAgent, toModel, reason }: {
  fromAgent?: string | undefined;
  fromModel?: string | undefined;
  toAgentId: string;
  toAgent: string;
  toModel?: string | undefined;
  reason?: string | undefined;
}): React.JSX.Element {
  const modelName = toModel !== undefined ? toModel.split('/').pop() ?? toModel : undefined;
  const from = fromAgent !== undefined && fromAgent !== toAgent
    ? `${fromAgent}${fromModel !== undefined ? ` (${fromModel.split('/').pop()})` : ''} → `
    : fromModel !== undefined && toModel !== undefined && fromModel !== toModel
      ? `${fromModel.split('/').pop()} → `
      : '';
  return (
    <div role="note" aria-label={`Handoff: ${from}${toAgent}${modelName !== undefined ? `, model ${modelName}` : ''}`} className="flex items-center gap-3 py-1" title={reason}>
      <span className="h-px min-w-6 flex-1 bg-border" aria-hidden="true" />
      <span className="flex max-w-full min-w-0 items-center gap-2 rounded-full border border-border bg-card py-1 pr-3 pl-1.5 text-xs text-muted-foreground shadow-xs">
        <AgentMark agentId={toAgentId} name={toAgent} size={20} />
        <span className="min-w-0 truncate">
          {from !== '' ? <span className="text-muted-foreground/80">{from}</span> : null}
          <span className="font-medium text-foreground">{toAgent}</span>
          {modelName !== undefined ? <span title={toModel}> · {modelName}</span> : null}
          <span className="text-muted-foreground/80"> took over</span>
        </span>
      </span>
      <span className="h-px min-w-6 flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
