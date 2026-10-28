import type { ReactNode } from 'react';
export const inputClass = 'w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50';
export const buttonClass = 'inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';
export const primaryButtonClass = 'inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';
export const panelClass = 'group-card p-4';
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string | undefined }): React.JSX.Element {
  return <label className="flex flex-col gap-1.5 text-sm"><span className="text-xs font-medium text-foreground">{label}</span>{hint && <span className="text-2xs text-muted-foreground">{hint}</span>}{children}</label>;
}
export function JsonField({ label, value, onChange, hint, rows = 5 }: { label: string; value: string; onChange: (value: string) => void; hint?: string | undefined; rows?: number }): React.JSX.Element {
  let issue = '';
  try { JSON.parse(value); } catch { issue = 'Enter valid JSON before saving.'; }
  return <Field label={label} hint={hint}><textarea spellCheck={false} aria-invalid={!!issue} className={`${inputClass} font-mono text-xs`} rows={rows} value={value} onChange={e => onChange(e.target.value)} />{issue && <span className="text-2xs text-destructive-foreground">{issue}</span>}</Field>;
}
export const pretty = (value: unknown): string => JSON.stringify(value, null, 2);
export function readJson<T>(label: string, value: string): T {
  try { return JSON.parse(value) as T; } catch { throw new Error(`${label} must contain valid JSON.`); }
}
export const lines = (value: string): string[] => value.split('\n').map(s => s.trim()).filter(Boolean);
export const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
