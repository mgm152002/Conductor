import { useState } from 'react';
import type { AgentQuestionAnswers } from '@shared/domain';
import { useQuestionStore } from '../../stores/question-store';
import { Button } from '../ui/primitives';
import { cn } from '../../lib/cn';

// Questions an agent asked mid-run, attached above the composer for human
// review. Picking an option (or writing a free-text answer) sends the answer
// back to the waiting agent, which then continues its turn.

export function PendingQuestionPanel({ scopeId }: { scopeId: string }): React.JSX.Element | null {
  const allPending = useQuestionStore((s) => s.pending);
  const pending = allPending.filter((request) => request.taskId === scopeId);
  const [answers, setAnswers] = useState<AgentQuestionAnswers>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (pending.length === 0) return null;
  const request = pending[0]!;
  const complete = request.questions.every((q) => (answers[q.id]?.length ?? 0) > 0);

  function choose(questionId: string, value: string, multi: boolean): void {
    setAnswers((current) => {
      const existing = current[questionId] ?? [];
      const next = multi
        ? (existing.includes(value) ? existing.filter((v) => v !== value) : [...existing, value])
        : [value];
      return { ...current, [questionId]: next };
    });
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await window.conductor.question.answer({ id: request.id, answers });
      useQuestionStore.getState().remove(request.id);
      setAnswers({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the answer');
    } finally { setBusy(false); }
  }

  return (
    <section aria-label="Agent questions" className="mx-auto mb-2 w-full max-w-(--chat-max) rounded-2xl border border-primary/25 bg-primary/5 px-3.5 py-3">
      <div className="flex items-center gap-2 text-2xs text-muted-foreground">
        <span className="font-medium text-primary">{request.agent} has a question</span>
        {pending.length > 1 ? <span className="ml-auto tabular-nums">1/{pending.length}</span> : null}
      </div>
      <div className="mt-2 flex flex-col gap-3">
        {request.questions.map((question) => (
          <fieldset key={question.id}>
            <legend className="text-[13px] font-medium text-foreground">
              {question.header ? <span className="mr-1.5 text-muted-foreground">{question.header}</span> : null}
              {question.question}
            </legend>
            {question.options !== undefined && question.options.length > 0 ? (
              <div className="mt-1.5 flex flex-col gap-1" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
                {question.options.map((option) => {
                  const selected = (answers[question.id] ?? []).includes(option.label);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role={question.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={selected}
                      onClick={() => { choose(question.id, option.label, question.multiSelect === true); }}
                      className={cn('cursor-pointer rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                        selected ? 'border-primary/50 bg-primary/10 text-foreground' : 'border-border text-foreground/80 hover:bg-accent')}
                    >
                      <span className="font-medium">{option.label}</span>
                      {option.description ? <span className="block text-3xs text-muted-foreground">{option.description}</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <textarea
                aria-label={question.question}
                rows={2}
                value={answers[question.id]?.[0] ?? ''}
                onChange={(event) => { setAnswers((current) => ({ ...current, [question.id]: [event.target.value] })); }}
                className="mt-1.5 w-full resize-none rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-xs text-foreground outline-none focus-visible:border-ring"
                placeholder="Type your answer…"
              />
            )}
            {question.options !== undefined && question.options.length > 0 ? (
              <input
                aria-label={`Other answer: ${question.question}`}
                value={(answers[question.id] ?? []).find((v) => !question.options!.some((o) => o.label === v)) ?? ''}
                onChange={(event) => {
                  const picked = (answers[question.id] ?? []).filter((v) => question.options!.some((o) => o.label === v));
                  setAnswers((current) => ({ ...current, [question.id]: event.target.value ? [...picked, event.target.value] : picked }));
                }}
                className="mt-1.5 w-full rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-xs text-foreground outline-none focus-visible:border-ring"
                placeholder="Or type another answer…"
              />
            ) : null}
          </fieldset>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={busy || !complete} onClick={() => { void submit(); }}>{busy ? 'Sending…' : 'Send answer'}</Button>
        <span className="text-3xs text-muted-foreground">The agent is waiting for your answer.</span>
      </div>
      {error !== null ? <p role="alert" className="mt-2 text-xs text-destructive-foreground">{error}</p> : null}
    </section>
  );
}
