import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContextItem, ContextScope, MemoryLayer, MemoryRecord, Provenance, Veracity } from '@shared/domain';
import type { KnowledgeBridge, KnowledgeRequest, MemoryInspection } from '@shared/knowledge-contract';
import { ScreenScaffold } from './ScreenScaffold';
import { reportMemoryCleanup } from '../lib/memory-cleanup';
import { Badge, Button, EmptyState, inputClassName, textareaClassName } from '../components/ui/primitives';
import {
  BrainIcon, ChevronDownIcon, ClockIcon, DatabaseIcon, EyeIcon, LayersIcon, PencilIcon,
  PlusIcon, SearchIcon, ShieldCheckIcon, Spinner, TrashIcon, XIcon,
} from '../components/ui/icons';
import { cn } from '../lib/cn';

type View = 'memory' | 'context';
type Entry = MemoryRecord | ContextItem;

const layers: MemoryLayer[] = ['personal', 'project', 'task', 'procedural'];
const scopes: ContextScope['level'][] = ['global', 'project', 'task', 'workflow', 'source'];
const trust: Veracity[] = ['unverified_assumption', 'inferred', 'observed_fact'];
const message = (error: unknown): string => (error instanceof Error ? error.message : 'The request failed. Try again.');
const select = `${inputClassName} cursor-pointer appearance-none pr-8`;
const label = 'text-xs font-medium text-muted-foreground';

function api(): KnowledgeBridge { return window.conductor as typeof window.conductor & KnowledgeBridge; }

/** A select with a chevron affordance, matching the input styling. */
function Select({ title, value, onChange, children }: { title: string; value: string; onChange: (v: string) => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="relative">
      <select aria-label={title} className={select} value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>
      <ChevronDownIcon size={13} className="pointer-events-none absolute inset-y-0 right-2.5 my-auto text-muted-foreground" />
    </div>
  );
}

function Field({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className={label}>{title}</span>
      {children}
      {hint !== undefined ? <span className="text-2xs text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

const TRUST_TONE: Record<Veracity, 'success' | 'info' | 'neutral'> = {
  observed_fact: 'success',
  inferred: 'info',
  unverified_assumption: 'neutral',
};

function TrustBadge({ veracity }: { veracity: Veracity }): React.JSX.Element {
  return (
    <Badge tone={TRUST_TONE[veracity]}>
      {veracity === 'observed_fact' ? <ShieldCheckIcon size={10} /> : null}
      {veracity.replaceAll('_', ' ')}
    </Badge>
  );
}

function Origin({ provenance }: { provenance: Provenance[] }): React.JSX.Element {
  return (
    <ul className="space-y-1.5 text-xs text-muted-foreground">
      {provenance.map((origin, index) => (
        <li key={index} className="break-words">
          <span className="text-foreground">{origin.method.replaceAll('_', ' ')}</span>
          {' · '}source: {origin.sourceId ?? 'unidentified'}
          {origin.derivedFrom?.length ? <span> · derived from {origin.derivedFrom.join(', ')}</span> : null}
        </li>
      ))}
    </ul>
  );
}

// ---- Create dialog --------------------------------------------------------

function CreateDialog({ view, open, busy, onClose, onCreate }: {
  view: View; open: boolean; busy: boolean; onClose: () => void;
  onCreate: (input: KnowledgeRequest<'memory.create'>) => Promise<boolean>;
}): React.JSX.Element | null {
  const [content, setContent] = useState('');
  const [layer, setLayer] = useState<MemoryLayer>('personal');
  const [level, setLevel] = useState<ContextScope['level']>('global');
  const [refId, setRefId] = useState('');
  const [veracity, setVeracity] = useState<Veracity>('unverified_assumption');
  const [confidence, setConfidence] = useState('0');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    void onCreate({ content, layer, scope: { level, ...(level !== 'global' ? { refId: refId.trim() } : {}) }, veracity, confidence: Number(confidence) })
      .then((created) => { if (created) { setContent(''); onClose(); } });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-label={`Create ${view === 'memory' ? 'memory' : 'context item'}`} className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-y-auto rounded-2xl border border-border bg-card p-5 text-foreground shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary"><PlusIcon size={15} /></span>
            <div>
              <h2 className="text-sm font-semibold">New {view === 'memory' ? 'memory' : 'context item'}</h2>
              <p className="text-xs text-muted-foreground">Saved with you as the source.</p>
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close"><XIcon size={14} /></Button>
        </div>

        <div className="space-y-4">
          <Field title="Content">
            <textarea className={textareaClassName} rows={4} required maxLength={100_000} autoFocus value={content} placeholder={view === 'memory' ? 'A fact to remember, e.g. “I prefer TypeScript and pnpm.”' : 'Context to attach…'} onChange={(e) => setContent(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            {view === 'memory' ? <Field title="Layer"><Select title="Layer" value={layer} onChange={(v) => setLayer(v as MemoryLayer)}>{layers.map((v) => <option key={v} value={v}>{v}</option>)}</Select></Field> : null}
            <Field title="Scope"><Select title="Scope" value={level} onChange={(v) => setLevel(v as ContextScope['level'])}>{scopes.map((v) => <option key={v} value={v}>{v}</option>)}</Select></Field>
            {level !== 'global' ? <Field title={level === 'project' ? 'Project / workspace ID' : `${level} ID`} hint="From Projects"><input className={inputClassName} required maxLength={255} value={refId} onChange={(e) => setRefId(e.target.value)} /></Field> : null}
            <Field title="Classification"><Select title="Classification" value={veracity} onChange={(v) => setVeracity(v as Veracity)}>{trust.map((v) => <option key={v} value={v}>{v.replaceAll('_', ' ')}</option>)}</Select></Field>
            <Field title="Confidence" hint="0 to 1"><input className={inputClassName} type="number" min="0" max="1" step="0.05" required value={confidence} onChange={(e) => setConfidence(e.target.value)} /></Field>
          </div>
          <p className="rounded-lg bg-muted/40 px-3 py-2 text-2xs text-muted-foreground">Selecting <strong className="font-medium text-foreground">observed fact</strong> explicitly records your statement; other classifications keep their uncertainty.</p>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !content.trim()}>Save {view === 'memory' ? 'memory' : 'context'}</Button>
        </div>
      </form>
    </div>
  );
}

// ---- Inspector ------------------------------------------------------------

function Inspector({ entry, inspection, busy, onCorrect, onDelete, onClose }: {
  entry: Entry; inspection: MemoryInspection | null; busy: boolean;
  onCorrect: (content: string) => Promise<void>; onDelete: () => Promise<void>; onClose: () => void;
}): React.JSX.Element {
  const [content, setContent] = useState(entry.content);
  const [deleting, setDeleting] = useState(false);
  const facts: { label: string; value: React.ReactNode }[] = [
    { label: 'Scope', value: `${entry.scope.level}${entry.scope.refId ? ` · ${entry.scope.refId}` : ''}` },
    { label: 'Confidence', value: `${Math.round(entry.confidence * 100)}%` },
    { label: 'Created', value: new Date(entry.createdAt).toLocaleString() },
    ...('layer' in entry ? [{ label: 'Layer', value: entry.layer }] : []),
    ...('expiresAt' in entry && entry.expiresAt ? [{ label: 'Expires', value: new Date(entry.expiresAt).toLocaleString() }] : []),
    ...('supersededBy' in entry && entry.supersededBy ? [{ label: 'Replaced by', value: <span className="break-all">{entry.supersededBy}</span> }] : []),
  ];
  return (
    <section className="flex max-h-[calc(100vh-13rem)] flex-col overflow-hidden rounded-xl border border-border bg-card xl:sticky xl:top-0" aria-label="Knowledge details">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold"><EyeIcon size={15} className="text-muted-foreground" />Inspect &amp; correct</div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} disabled={busy} aria-label="Close details"><XIcon size={14} /></Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="flex flex-wrap items-center gap-1.5"><TrustBadge veracity={entry.veracity} />{'layer' in entry ? <Badge tone="primary"><LayersIcon size={10} />{entry.layer}</Badge> : null}</div>
        <dl className="grid gap-x-4 gap-y-2.5 text-xs sm:grid-cols-2">
          {facts.map((f) => <div key={f.label}><dt className="text-muted-foreground">{f.label}</dt><dd className="mt-0.5 text-foreground">{f.value}</dd></div>)}
          <div className="sm:col-span-2"><dt className="text-muted-foreground">ID</dt><dd className="mt-0.5 break-all font-mono text-2xs text-foreground/80">{entry.id}</dd></div>
        </dl>
        <div>
          <h3 className="mb-1.5 text-xs font-semibold">Provenance</h3>
          <Origin provenance={Array.isArray(entry.provenance) ? entry.provenance : [entry.provenance]} />
        </div>
        {inspection && inspection.events.length > 0 ? (
          <div>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold"><ClockIcon size={12} className="text-muted-foreground" />History</h3>
            <ul className="space-y-1.5 border-l border-border pl-3 text-xs text-muted-foreground">
              {inspection.events.map((event) => (
                <li key={event.id} className="break-words">
                  <span className="text-foreground">{event.kind.replaceAll('_', ' ')}</span> · {new Date(event.createdAt).toLocaleString()}
                  {event.sourceId ? ` · ${event.sourceId}` : ''}
                  {event.relatedMemoryId ? ` · linked ${event.relatedMemoryId.slice(0, 8)}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <form className="space-y-2 border-t border-border pt-4" onSubmit={(e) => { e.preventDefault(); void onCorrect(content); }}>
          <label className="flex flex-col gap-1.5"><span className={label}>Corrected content</span><textarea className={textareaClassName} rows={4} required value={content} maxLength={100_000} onChange={(e) => setContent(e.target.value)} /></label>
          <p className="text-2xs text-muted-foreground">Saving a correction confirms this as an observed fact and records you as the source.</p>
          <Button variant="primary" size="md" type="submit" disabled={busy || !content.trim()} className="w-full"><PencilIcon size={13} />Save correction</Button>
        </form>
      </div>
      <footer className="border-t border-border px-4 py-3">
        {deleting ? (
          <div className="space-y-2">
            <p className="text-xs text-foreground">Permanently delete this item and its history?</p>
            <div className="flex gap-2"><Button variant="destructive" size="md" disabled={busy} onClick={() => void onDelete()} className="flex-1">Delete permanently</Button><Button variant="ghost" size="md" disabled={busy} onClick={() => setDeleting(false)}>Keep</Button></div>
          </div>
        ) : (
          <Button variant="destructive-outline" size="md" disabled={busy} onClick={() => setDeleting(true)} className="w-full"><TrashIcon size={13} />Delete item</Button>
        )}
      </footer>
    </section>
  );
}

// ---- Result card ----------------------------------------------------------

function ResultCard({ entry, active, disabled, onClick }: { entry: Entry; active: boolean; disabled: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'w-full space-y-2 rounded-xl border p-3.5 text-left transition-colors disabled:opacity-50',
        active ? 'border-ring bg-accent ring-2 ring-ring/20' : 'border-border hover:border-ring/40 hover:bg-accent/50',
      )}
    >
      <p className="line-clamp-3 text-sm whitespace-pre-wrap break-words text-foreground">{entry.content}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {'layer' in entry ? <Badge tone="primary"><LayersIcon size={10} />{entry.layer}</Badge> : null}
        <Badge>{entry.scope.level}{entry.scope.refId ? `: ${entry.scope.refId.slice(0, 16)}` : ''}</Badge>
        <TrustBadge veracity={entry.veracity} />
        <span className="ml-auto text-2xs text-muted-foreground tabular-nums">{Math.round(entry.confidence * 100)}%</span>
      </div>
    </button>
  );
}

// ---- Screen ---------------------------------------------------------------

const emptyFilters = { text: '', layer: '', projectId: '', sourceId: '', createdAfter: '', createdBefore: '', scope: '', scopeId: '' };

export function MemoryScreen(): React.JSX.Element {
  const [view, setView] = useState<View>('memory');
  const [draft, setDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [inspection, setInspection] = useState<MemoryInspection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);
  const inspecting = useRef(0);

  const activeFilterCount = (view === 'memory'
    ? [filters.layer, filters.projectId.trim(), filters.sourceId.trim(), filters.createdAfter, filters.createdBefore]
    : [filters.scope]).filter(Boolean).length;

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError(null);
    try {
      let result: Entry[];
      if (view === 'memory') {
        const query: KnowledgeRequest<'memory.search'> = { limit: 100 };
        if (filters.text.trim()) query.text = filters.text.trim();
        if (filters.layer) query.layer = filters.layer as MemoryLayer;
        if (filters.projectId.trim()) query.projectId = filters.projectId.trim();
        if (filters.sourceId.trim()) query.sourceId = filters.sourceId.trim();
        if (filters.createdAfter) query.createdAfter = new Date(`${filters.createdAfter}T00:00:00`).toISOString();
        if (filters.createdBefore) query.createdBefore = new Date(`${filters.createdBefore}T23:59:59.999`).toISOString();
        result = (await api().memory.search(query)).map((hit) => hit.memory);
      } else {
        const query: KnowledgeRequest<'context.list'> = { limit: 100 };
        if (filters.text.trim()) query.text = filters.text.trim();
        if (filters.scope) query.scope = { level: filters.scope as ContextScope['level'], ...(filters.scope !== 'global' ? { refId: filters.scopeId.trim() } : {}) };
        result = await api().context.list(query);
      }
      if (current === generation.current) setEntries(result);
    } catch (failure) { if (current === generation.current) { setEntries([]); setError(message(failure)); } }
    finally { if (current === generation.current) setLoading(false); }
  }, [view, filters]);

  useEffect(() => {
    void load();
    // Both current async generations are intentionally invalidated on cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { generation.current++; inspecting.current++; };
  }, [load]);

  async function inspect(id: string): Promise<void> {
    const current = ++inspecting.current;
    setBusy(true); setError(null);
    try {
      if (view === 'memory') {
        const detail = await api().memory.inspect(id);
        if (current === inspecting.current) { setInspection(detail); setSelected(detail.memory); }
      } else {
        const item = await api().context.inspect(id);
        if (current === inspecting.current) { setInspection(null); setSelected(item); }
      }
    } catch (failure) { if (current === inspecting.current) setError(message(failure)); }
    finally { if (current === inspecting.current) setBusy(false); }
  }
  async function create(input: KnowledgeRequest<'memory.create'>): Promise<boolean> {
    setBusy(true); setError(null); setStatus(null);
    try {
      if (view === 'memory') await api().memory.create(input);
      else await api().context.create(input);
      setStatus(`${view === 'memory' ? 'Memory' : 'Context item'} created.`);
      await load(); return true;
    } catch (failure) { setError(message(failure)); return false; }
    finally { setBusy(false); }
  }
  async function correct(content: string): Promise<void> {
    if (!selected) return;
    setBusy(true); setError(null); setStatus(null);
    try {
      const corrected = view === 'memory' ? await api().memory.correct({ id: selected.id, content }) : await api().context.correct({ id: selected.id, content });
      await load(); await inspect(corrected.id); setStatus('Correction saved.');
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function remove(): Promise<void> {
    if (!selected) return;
    setBusy(true); setError(null); setStatus(null);
    try {
      const result = view === 'memory' ? await api().memory.delete(selected.id) : await api().context.delete(selected.id);
      reportMemoryCleanup(result);
      setSelected(null); setInspection(null); await load(); setStatus('Item deleted.');
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  function switchView(next: View): void {
    setView(next); setSelected(null); setInspection(null); setDraft(emptyFilters); setFilters(emptyFilters); setStatus(null); setShowFilters(false);
  }
  function resetFilters(): void { setDraft(emptyFilters); setFilters({ ...emptyFilters }); setSelected(null); }

  const headerActions = (
    <Button variant="primary" size="sm" onClick={() => setCreating(true)} disabled={busy}><PlusIcon size={13} />Add {view === 'memory' ? 'memory' : 'context'}</Button>
  );

  return (
    <ScreenScaffold title="Memory" description="Search lasting knowledge and inspect the context Conductor uses. Every item shows its source, confidence, and classification." actions={headerActions}>
      <div className="space-y-4 text-foreground">
        {/* Segmented view toggle */}
        <div className="inline-flex rounded-lg bg-muted/50 p-0.5" role="tablist" aria-label="Knowledge category">
          {(['memory', 'context'] as const).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={view === value}
              disabled={busy}
              onClick={() => switchView(value)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50',
                view === value ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {value === 'memory' ? <BrainIcon size={13} /> : <DatabaseIcon size={13} />}
              {value === 'memory' ? 'Memories' : 'Context'}
            </button>
          ))}
        </div>

        {/* Search bar + filter toggle */}
        <form onSubmit={(e) => { e.preventDefault(); setFilters({ ...draft }); setSelected(null); }} className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <SearchIcon size={15} className="pointer-events-none absolute inset-y-0 left-2.5 my-auto text-muted-foreground" />
              <input
                className={cn(inputClassName, 'h-9 pl-8.5')}
                value={draft.text}
                placeholder={view === 'memory' ? 'Search by meaning, or leave blank to browse' : 'Search context, or leave blank to browse'}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              />
            </div>
            <Button variant="default" size="md" type="submit" disabled={loading || busy}><SearchIcon size={14} />Search</Button>
            <Button variant="ghost" size="md" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters} className={cn(activeFilterCount > 0 && 'text-foreground')}>
              <LayersIcon size={14} />Filters{activeFilterCount > 0 ? <Badge tone="primary">{activeFilterCount}</Badge> : null}
              <ChevronDownIcon size={13} className={cn('transition-transform', showFilters && 'rotate-180')} />
            </Button>
          </div>

          {showFilters ? (
            <div className="grid gap-3 rounded-xl border border-border bg-card/40 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {view === 'memory' ? <>
                <Field title="Layer"><Select title="Layer" value={draft.layer} onChange={(v) => setDraft({ ...draft, layer: v })}><option value="">All layers</option>{layers.map((v) => <option key={v} value={v}>{v}</option>)}</Select></Field>
                <Field title="Project / workspace ID"><input className={inputClassName} value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value })} /></Field>
                <Field title="Source ID"><input className={inputClassName} value={draft.sourceId} placeholder="e.g. user" onChange={(e) => setDraft({ ...draft, sourceId: e.target.value })} /></Field>
                <Field title="Created on or after"><input className={inputClassName} type="date" value={draft.createdAfter} onChange={(e) => setDraft({ ...draft, createdAfter: e.target.value })} /></Field>
                <Field title="Created on or before"><input className={inputClassName} type="date" value={draft.createdBefore} onChange={(e) => setDraft({ ...draft, createdBefore: e.target.value })} /></Field>
              </> : <>
                <Field title="Scope"><Select title="Scope" value={draft.scope} onChange={(v) => setDraft({ ...draft, scope: v })}><option value="">All scopes</option>{scopes.map((v) => <option key={v} value={v}>{v}</option>)}</Select></Field>
                {draft.scope && draft.scope !== 'global' ? <Field title="Scope owner ID"><input className={inputClassName} required value={draft.scopeId} onChange={(e) => setDraft({ ...draft, scopeId: e.target.value })} /></Field> : null}
              </>}
              <div className="flex items-end sm:col-span-2 xl:col-span-3">
                <Button variant="ghost" size="sm" type="button" onClick={resetFilters} disabled={loading || busy}><XIcon size={12} />Clear filters</Button>
              </div>
            </div>
          ) : null}
        </form>

        {error ? (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/6 px-4 py-2.5 text-sm text-destructive-foreground">
            <p className="min-w-0 break-words">{error}</p>
            <Button variant="destructive-outline" size="sm" disabled={busy} onClick={() => void load()}>Retry</Button>
          </div>
        ) : null}
        {status ? <p role="status" className="flex items-center gap-1.5 text-sm text-success"><CheckDot />{status}</p> : null}

        {/* Results + inspector */}
        <div className="grid items-start gap-5 xl:grid-cols-[1fr_minmax(20rem,24rem)]">
          <section className="space-y-3" aria-label="Search results" aria-busy={loading}>
            <p className="text-xs text-muted-foreground">
              {view === 'memory' ? 'Ranked by meaning with Mem0; newest first when browsing. Expired and replaced memories are excluded.' : 'Current context, newest first.'} Up to 100 items.
            </p>
            {loading ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border py-12 text-sm text-muted-foreground"><Spinner size={15} />Loading {view === 'memory' ? 'memories' : 'context'}…</div>
            ) : !error && entries.length === 0 ? (
              <EmptyState
                icon={view === 'memory' ? <BrainIcon size={26} /> : <DatabaseIcon size={26} />}
                title={activeFilterCount > 0 || filters.text.trim() ? 'No matches' : `No ${view === 'memory' ? 'memories' : 'context items'} yet`}
                description={activeFilterCount > 0 || filters.text.trim() ? 'Adjust your search or filters.' : `Create your first ${view === 'memory' ? 'memory' : 'context item'} to get started.`}
              >
                <Button variant="primary" size="sm" onClick={() => setCreating(true)}><PlusIcon size={13} />Add {view === 'memory' ? 'memory' : 'context'}</Button>
              </EmptyState>
            ) : (
              <ul className="space-y-2.5">
                {entries.map((entry) => <li key={entry.id}><ResultCard entry={entry} active={selected?.id === entry.id} disabled={busy || loading} onClick={() => void inspect(entry.id)} /></li>)}
              </ul>
            )}
          </section>
          {selected ? (
            <Inspector key={selected.id + selected.content} entry={selected} inspection={inspection} busy={busy} onCorrect={correct} onDelete={remove} onClose={() => { setSelected(null); setInspection(null); }} />
          ) : (
            <div className="hidden items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground xl:flex">
              <p>Select an item to inspect its sources, history, and trust, or to correct or delete it.</p>
            </div>
          )}
        </div>
      </div>

      <CreateDialog view={view} open={creating} busy={busy} onClose={() => setCreating(false)} onCreate={create} />
    </ScreenScaffold>
  );
}

function CheckDot(): React.JSX.Element {
  return <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full bg-success" />;
}
