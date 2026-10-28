import type { SVGProps } from 'react';
import type {
  UsageLimitWindow, UsageLimitWindowKind, UsageRange, UsageSummary,
} from '@shared/usage';
import { clientLabel, compactNumber, formatCost } from '../../lib/usage-format';
import { relativeTime } from '../../lib/time';
import {
  ActivityIcon,
  BrainIcon,
  LayersIcon,
  SparklesIcon,
  TerminalIcon,
} from '../ui/icons';
import { Alert, Badge, EmptyState } from '../ui/primitives';
import { UsageBarGroup } from './UsageBars';
import { UsageLimitCard } from './UsageLimitCard';

// The Limits view (Requirements 2.3, 2.4, 4.4). Every attached CLI in
// `summary.clients` gets a card with its Session and Weekly windows, even when
// it recorded no sessions or does not report limits at all. A Daily window is
// added only when the CLI reports one (OpenCode's free tier), so the common
// two-window layout stays uncluttered. Windows are looked up by kind so a CLI
// may report any one independently; the missing one renders the explicit
// not-reported state.
//
// Quota windows are rare: Codex, Antigravity, OpenCode Go, and OpenCode's free
// tier report them; most other CLIs only report tokens. The view therefore
// leads with the usage that *is* available (a bar per CLI) and calls out why
// some windows are empty, rather than presenting a wall of identical
// "Not reported" cards.

type CliIconComponent = (props: SVGProps<SVGSVGElement> & { size?: number }) => React.JSX.Element;

const CLI_ICONS: Record<string, CliIconComponent> = {
  codex: SparklesIcon,
  'claude-code': BrainIcon,
  opencode: TerminalIcon,
  antigravity: ActivityIcon,
  kiro: LayersIcon,
};

function CliIcon({ id }: { id: string }): React.JSX.Element {
  const Icon = CLI_ICONS[id] ?? TerminalIcon;
  return <Icon size={13} className="text-muted-foreground" aria-hidden="true" />;
}

function findLimit(limits: UsageLimitWindow[], kind: UsageLimitWindowKind): UsageLimitWindow | undefined {
  return limits.find((limit) => limit.kind === kind);
}

function sessionLabel(sessions: number): string {
  return `${sessions} session${sessions === 1 ? '' : 's'}`;
}

export interface UsageLimitsViewProps {
  summary: UsageSummary;
  /** Accepted for a consistent child-view contract; the shell owns states. */
  loading?: boolean;
  error?: string | null;
  range?: UsageRange;
  view?: string;
  /** Injectable clock so tests get deterministic reset countdowns. */
  now?: Date | number;
}

export function UsageLimitsView({
  summary,
  now = Date.now(),
}: UsageLimitsViewProps): React.JSX.Element {
  if (summary.clients.length === 0) {
    return (
      <EmptyState
        title="No attached CLIs"
        description="Attach an agent CLI to see its session, daily, and weekly limits here."
      />
    );
  }

  const reporting = summary.clients.filter((client) => client.limits.length > 0).length;
  const bars = summary.clients.map((client) => ({
    key: client.key,
    label: clientLabel(client),
    value: client.totalTokens,
    display: `${compactNumber(client.totalTokens)} tokens`,
    ...(client.costUsd !== undefined ? { cost: formatCost(client.costUsd) } : {}),
    detail: `${sessionLabel(client.sessions)} in this range`,
  }));

  return (
    <section className="flex max-w-3xl flex-col gap-5" aria-label="CLI usage limits">
      <UsageBarGroup
        title="Usage by CLI"
        description="Share of tokens recorded in this range"
        rows={bars}
        emptyLabel="No token usage recorded for the selected range."
      />

      {reporting === 0 ? (
        <Alert tone="info">
          No CLI has reported a quota window yet. Codex reports limits after a Codex session starts;
          Antigravity reports its Gemini model groups; OpenCode reports its free-model daily window,
          and adds Go session and weekly windows when an active Go subscription is connected. Other
          CLIs do not expose quota data.
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Quota windows</h2>
          <span className="text-3xs text-muted-foreground">
            {reporting === 0
              ? 'Nothing reported yet'
              : `${reporting} of ${summary.clients.length} CLIs reporting`}
          </span>
        </div>
        <p className="text-3xs text-muted-foreground">
          Fetched from each CLI when this screen opens and every 5 minutes while it stays open.
          OpenCode reports Session/Weekly only with an active Go subscription (otherwise just the
          free-model Daily window, whose percentage OpenCode does not publish); Antigravity
          reports Weekly only.
        </p>

        <div className="flex flex-col gap-3">
          {summary.clients.map((client) => {
            const label = clientLabel(client);
            const hasLimits = client.limits.length > 0;
            const daily = findLimit(client.limits, 'daily');
            const reportedAt = client.limits.reduce<string | undefined>(
              (latest, limit) => (limit.reportedAt !== undefined && (latest === undefined || limit.reportedAt > latest) ? limit.reportedAt : latest),
              undefined,
            );
            return (
              <article
                key={client.key}
                aria-label={`${label} limits`}
                className="flex flex-col gap-2"
              >
                <header className="flex items-center gap-2">
                  <CliIcon id={client.key} />
                  <h3 className="truncate text-sm font-medium text-foreground">{label}</h3>
                  <span className="ml-auto text-3xs text-muted-foreground tabular-nums">
                    {sessionLabel(client.sessions)} · {compactNumber(client.totalTokens)} tokens
                    {reportedAt !== undefined ? <> · limits {relativeTime(reportedAt, typeof now === 'number' ? now : now.getTime())}</> : null}
                  </span>
                  {hasLimits ? null : <Badge>No limits</Badge>}
                </header>

                <div className="flex flex-col gap-2">
                  {daily !== undefined ? (
                    <UsageLimitCard
                      title="Daily"
                      clientLabel={label}
                      limit={daily}
                      now={now}
                    />
                  ) : null}
                  <UsageLimitCard
                    title="Session"
                    clientLabel={label}
                    limit={findLimit(client.limits, 'session')}
                    now={now}
                  />
                  <UsageLimitCard
                    title="Weekly"
                    clientLabel={label}
                    limit={findLimit(client.limits, 'weekly')}
                    now={now}
                  />
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
