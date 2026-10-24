import type { Skill } from '@shared/domain';
import { Badge, Button, EmptyState, inputClassName } from '../ui/primitives';
import { PlusIcon, RotateIcon, SearchIcon, Spinner, XIcon } from '../ui/icons';
import { cn } from '../../lib/cn';
import type { ScopeFilter } from '../../hooks/useSkills';

export interface SkillsListPanelProps {
  skills: Skill[];
  visible: Skill[];
  selectedId: string | undefined;
  loading: boolean;
  busy: boolean;
  query: string;
  scopeFilter: ScopeFilter;
  onQueryChange: (query: string) => void;
  onScopeFilterChange: (scope: ScopeFilter) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRefresh: () => void;
  onClearFilters: () => void;
}

function scopeLabel(skill: Skill): string {
  return skill.scopeRef ? `${skill.scope} · ${skill.scopeRef.slice(0, 8)}` : skill.scope;
}

export function SkillsListPanel({
  skills, visible, selectedId, loading, busy, query, scopeFilter,
  onQueryChange, onScopeFilterChange, onSelect, onCreate, onRefresh, onClearFilters,
}: SkillsListPanelProps): React.JSX.Element {
  const filtered = query.trim().length > 0 || scopeFilter !== 'all';
  return (
    <aside className="flex max-h-[calc(100vh-12rem)] min-h-72 flex-col overflow-hidden rounded-xl border border-border bg-card" aria-label="Saved skills">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Skills</h2>
          <Badge>{loading ? '…' : `${visible.length}/${skills.length}`}</Badge>
        </div>
        <Button variant="primary" size="xs" onClick={onCreate} disabled={busy}>
          <PlusIcon size={12} />
          New
        </Button>
      </header>

      <div className="space-y-2 border-b border-border px-3 py-3">
        <label className="relative block">
          <span className="sr-only">Search skills</span>
          <SearchIcon size={14} className="pointer-events-none absolute inset-y-0 left-2.5 my-auto text-muted-foreground" />
          <input
            className={cn(inputClassName, 'pl-8')}
            type="search"
            aria-label="Search skills"
            placeholder="Search by name or scope"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
        <div className="flex items-center gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Filter by scope</span>
            <select
              className={inputClassName}
              aria-label="Filter by scope"
              value={scopeFilter}
              onChange={(event) => onScopeFilterChange(event.target.value as ScopeFilter)}
            >
              <option value="all">All scopes</option>
              <option value="global">Global</option>
              <option value="project">Project</option>
              <option value="workflow">Workflow</option>
            </select>
          </label>
          <Button variant="ghost" size="icon" aria-label="Refresh skills" title="Refresh skills" onClick={onRefresh} disabled={loading || busy}>
            <RotateIcon size={14} />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div role="status" className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center text-xs text-muted-foreground">
            <Spinner size={16} />
            <p>Loading skills…</p>
          </div>
        ) : skills.length === 0 ? (
          <EmptyState
            title="No skills yet"
            description="Create your first reusable procedure. Conductor can also learn one from a vendor invoice."
          >
            <Button variant="primary" size="sm" onClick={onCreate}>
              <PlusIcon size={12} />
              Create skill
            </Button>
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState
            title="No matching skills"
            description="No saved skill matches this search and scope. Clear the filters to see every skill."
          >
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              <XIcon size={12} />
              Clear filters
            </Button>
          </EmptyState>
        ) : (
          <ul className="space-y-1" aria-label="Skills">
            {visible.map((skill) => {
              const active = selectedId === skill.id;
              return (
                <li key={skill.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    disabled={busy}
                    onClick={() => onSelect(skill.id)}
                    className={cn(
                      'w-full rounded-lg border px-2.5 py-2 text-left transition-colors disabled:opacity-50',
                      active ? 'border-ring bg-accent ring-1 ring-ring/20' : 'border-transparent hover:bg-accent/60',
                    )}
                  >
                    <span className="block truncate text-sm font-medium text-foreground">{skill.name}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      <Badge tone={skill.scope === 'global' ? 'neutral' : 'primary'}>{scopeLabel(skill)}</Badge>
                      <Badge tone="success">v{skill.currentVersion}</Badge>
                      {filtered ? null : <span className="ml-auto text-2xs text-muted-foreground">{new Date(skill.updatedAt).toLocaleDateString()}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
