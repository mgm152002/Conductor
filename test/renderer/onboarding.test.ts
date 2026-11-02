import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isOnboardingCompleted, markOnboardingCompleted, resetOnboarding } from '../../src/renderer/lib/onboarding';

function stubWindow(storage: Partial<Storage>): void {
  vi.stubGlobal('window', { localStorage: storage });
}
beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('is not completed on a fresh install, then completed once marked', () => {
  const data = new Map<string, string>();
  stubWindow({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } });
  expect(isOnboardingCompleted()).toBe(false);
  markOnboardingCompleted();
  expect(isOnboardingCompleted()).toBe(true);
  resetOnboarding();
  expect(isOnboardingCompleted()).toBe(false);
});

it('treats unavailable storage as not completed without throwing', () => {
  const boom = (): never => { throw new Error('blocked'); };
  stubWindow({ getItem: boom, setItem: boom, removeItem: boom });
  expect(isOnboardingCompleted()).toBe(false);
  expect(() => { markOnboardingCompleted(); resetOnboarding(); }).not.toThrow();
});
