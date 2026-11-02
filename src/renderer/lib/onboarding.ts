// First-run onboarding bookkeeping. The flag lives in the renderer's local
// storage (per install). Storage can throw or be unavailable, so every access
// is guarded and a failure simply means "show the walkthrough".

const KEY = 'conductor.onboarding.completed.v1';

export function isOnboardingCompleted(): boolean {
  try { return window.localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function markOnboardingCompleted(): void {
  try { window.localStorage.setItem(KEY, '1'); } catch { /* best effort */ }
}

export function resetOnboarding(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* best effort */ }
}
