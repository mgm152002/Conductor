import { describe, expect, it } from 'vitest';
import { classifyFailure, retryableOnAnotherAgent, tailLines } from '@main/adapters/failure-classification';

describe('failure classification', () => {
  it('recognizes quota and model failures as retryable on another agent', () => {
    expect(classifyFailure({ error: 'You have hit your usage limit' }, '')).toBe('quota_exhausted');
    expect(classifyFailure({}, 'insufficient credits for this request')).toBe('quota_exhausted');
    expect(classifyFailure({ error: 'invalid model selection (--model "gemini-3.8-flash-high" --effort "medium"): --model conflicts with --effort=medium' }, ''))
      .toBe('model_unavailable');
    expect(classifyFailure({}, 'unknown model: gemini-9')).toBe('model_unavailable');
    // OpenCode Go model restrictions are per workspace/region/privacy setting:
    // the model is unusable for this account, so another agent should take over.
    expect(classifyFailure({}, "This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it."))
      .toBe('model_unavailable');
    expect(classifyFailure({ error: 'This Go model trains on request data. Allow paid endpoints that train on request data in your workspace\'s Privacy settings to use it.' }, ''))
      .toBe('model_unavailable');
    expect(retryableOnAnotherAgent('quota_exhausted')).toBe(true);
    expect(retryableOnAnotherAgent('model_unavailable')).toBe(true);
  });

  it('does not retry plain failures on another provider', () => {
    expect(classifyFailure({ error: 'authentication failed' }, '')).toBe('other');
    expect(retryableOnAnotherAgent('other')).toBe(false);
  });

  it('keeps only the most recent non-empty output lines', () => {
    expect(tailLines(['old', '', ' first ', 'second', 'third'], 2)).toBe('second\nthird');
  });
});
