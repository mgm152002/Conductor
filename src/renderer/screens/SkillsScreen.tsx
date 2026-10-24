import { Alert, Button } from '../components/ui/primitives';
import { CheckIcon, PlusIcon } from '../components/ui/icons';
import { SkillEditorPanel } from '../components/skills/SkillEditorPanel';
import { SkillAutomationPanel } from '../components/skills/SkillAutomationPanel';
import { SkillsListPanel } from '../components/skills/SkillsListPanel';
import { cn } from '../lib/cn';
import { useSkills, type SkillsController } from '../hooks/useSkills';
import { ScreenScaffold } from './ScreenScaffold';

/**
 * The Skills surface: a searchable list beside a tabbed editor. All state and
 * bridge calls live in `useSkills`, so the view can be rendered in tests as a
 * pure function of a controller.
 */
export function SkillsScreen(): React.JSX.Element {
  return <SkillsScreenView controller={useSkills()} />;
}

export function SkillsScreenView({ controller }: { controller: SkillsController }): React.JSX.Element {
  const {
    items, visible, selected, loading, busy, error, notice, query, scopeFilter, screenTab,
    bindings, usages, automationLoading, automationError, automationBusyId, removalCandidate,
    setQuery, setScopeFilter, selectSkill, createNew, refresh, setScreenTab,
    refreshAutomation, setBindingStatus, requestBindingRemoval, cancelBindingRemoval, confirmBindingRemoval,
  } = controller;

  return (
    <ScreenScaffold
      title="Skills"
      description="Reusable procedures Conductor can learn, version, and reuse. Pick a skill to edit its tabs, or review changes before saving."
      actions={screenTab === 'skills' ? (
        <Button variant="primary" size="sm" onClick={createNew} disabled={busy}>
          <PlusIcon size={13} />
          New skill
        </Button>
      ) : undefined}
    >
      <div className="space-y-4 text-foreground">
        <div className="flex border-b border-border" role="tablist" aria-label="Skills sections">
          {(['skills', 'automation'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`skills-tab-${tab}`}
              aria-selected={screenTab === tab}
              aria-controls={`skills-section-${tab}`}
              onClick={() => setScreenTab(tab)}
              className={cn(
                'relative px-3 py-2 text-xs font-medium capitalize text-muted-foreground transition-colors hover:text-foreground',
                screenTab === tab ? 'text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary' : '',
              )}
            >
              {tab === 'skills' ? 'Skills' : 'Automation'}
            </button>
          ))}
        </div>

        {screenTab === 'skills' && error !== null ? (
          <Alert
            tone="destructive"
            action={<Button variant="destructive-outline" size="xs" onClick={() => void refresh()} disabled={busy}>Retry</Button>}
          >
            {error}
          </Alert>
        ) : null}
        {notice !== null ? (
          <p role="status" className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <CheckIcon size={13} className="mt-0.5 shrink-0 text-success" />
            <span className="min-w-0 break-words">{notice}</span>
          </p>
        ) : null}

        {screenTab === 'skills' ? (
          <div id="skills-section-skills" role="tabpanel" aria-labelledby="skills-tab-skills" className="grid items-start gap-5 lg:grid-cols-[minmax(15rem,17rem)_minmax(0,1fr)]">
            <SkillsListPanel
              skills={items}
              visible={visible}
              selectedId={selected?.id}
              loading={loading}
              busy={busy}
              query={query}
              scopeFilter={scopeFilter}
              onQueryChange={setQuery}
              onScopeFilterChange={setScopeFilter}
              onSelect={(id) => void selectSkill(id)}
              onCreate={createNew}
              onRefresh={() => void refresh()}
              onClearFilters={() => { setQuery(''); setScopeFilter('all'); }}
            />
            <SkillEditorPanel controller={controller} />
          </div>
        ) : (
          <div id="skills-section-automation" role="tabpanel" aria-labelledby="skills-tab-automation">
            <SkillAutomationPanel
              bindings={bindings}
              usages={usages}
              skills={items}
              loading={automationLoading}
              error={automationError}
              busyId={automationBusyId}
              removalCandidate={removalCandidate}
              onRetry={() => void refreshAutomation()}
              onShowSkills={() => setScreenTab('skills')}
              onSetStatus={(bindingId, status) => void setBindingStatus(bindingId, status)}
              onRequestRemove={requestBindingRemoval}
              onCancelRemove={cancelBindingRemoval}
              onConfirmRemove={() => void confirmBindingRemoval()}
            />
          </div>
        )}
      </div>
    </ScreenScaffold>
  );
}
