import type {
  UsageLimitWindow, UsageLimitWindowKind, UsageRange, UsageSummary,
} from '@shared/usage';
import { clientLabel, compactNumber, formatCost } from '../../lib/usage-format';
import { relativeTime } from '../../lib/time';
import { TerminalIcon } from '../ui/icons';
import { BrandMark, agentBrand } from '../ui/BrandMarks';
import { Alert, EmptyState } from '../ui/primitives';
import { UsageBarGroup } from './UsageBars';
import { UsageLimitCard } from './UsageLimitCard';

// The Limits view (Requirements 2.3, 2.4, 4.4). Only windows a CLI actually
// reported are rendered: CLIs with no reported limits get no card at all, and
// a kind the CLI did not report gets no placeholder bar. A kind reported for
// several labelled model groups (Antigravity's Gemini and Claude/GPT weekly
// quotas) renders one card per group.
//
// Quota windows are rare: Codex, Claude Code, Antigravity, OpenCode Go, and OpenCode's free
// tier report them; most other CLIs only report tokens. The view therefore
// leads with the usage that *is* available (a bar per CLI) and explains, once,
// why some CLIs have no quota windows below.

function CliIcon({ id }: { id: string }): React.JSX.Element {
  const brand = agentBrand(id);
  if (brand !== null) return <BrandMark brand={brand} size={14} className="shrink-0 text-foreground/85" />;
  return <TerminalIcon size={13} className="text-muted-foreground" aria-hidden="true" />;
}

function findLimits(limits: UsageLimitWindow[], kind: UsageLimitWindowKind): UsageLimitWindow[] {
  return limits.filter((limit) => limit.kind === kind);
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

  const reportingClients = summary.clients.filter((client) => client.limits.length > 0);
  const reporting = reportingClients.length;
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
          Claude Code reports its 5-hour and weekly windows (checked in the background with a tiny Haiku request); Antigravity reports its Gemini model groups; OpenCode reports its free-model daily window,
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
          {reportingClients.map((client) => {
            const label = clientLabel(client);
            const daily = findLimits(client.limits, 'daily');
            const session = findLimits(client.limits, 'session');
            const weekly = findLimits(client.limits, 'weekly');
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
                </header>

                <div className="flex flex-col gap-2">
                  {daily.map((limit) => (
                    <UsageLimitCard
                      key={`daily-${limit.label ?? ''}`}
                      title="Daily"
                      clientLabel={label}
                      limit={limit}
                      now={now}
                    />
                  ))}
                  {session.map((limit) => (
                    <UsageLimitCard
                      key={`session-${limit.label ?? ''}`}
                      title="Session"
                      clientLabel={label}
                      limit={limit}
                      now={now}
                    />
                  ))}
                  {weekly.map((limit) => (
                    <UsageLimitCard
                      key={`weekly-${limit.label ?? ''}`}
                      title="Weekly"
                      clientLabel={label}
                      limit={limit}
                      now={now}
                    />
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
