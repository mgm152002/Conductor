import { describe, expect, it } from 'vitest';
import { requestsArtifact } from '../../src/renderer/lib/artifacts';

describe('requestsArtifact', () => {
  it('is false for ordinary work, which still records a stored output', () => {
    expect(requestsArtifact('Fix the login bug and run the tests')).toBe(false);
    expect(requestsArtifact('Explain how the document parser handles PDFs')).toBe(false);
    expect(requestsArtifact('Review this change and tell me what is wrong')).toBe(false);
    expect(requestsArtifact('Refactor the report module for clarity')).toBe(false);
  });

  it('is true when a deliverable is asked for', () => {
    expect(requestsArtifact('Create a report doc with the required figures')).toBe(true);
    expect(requestsArtifact('Give me the summary as a document')).toBe(true);
    expect(requestsArtifact('Write the plan to PLAN.md')).toBe(true);
    expect(requestsArtifact('Export the results to results.csv')).toBe(true);
    expect(requestsArtifact('Draft a memo about the release')).toBe(true);
    expect(requestsArtifact('Attach the artifact when you are done')).toBe(true);
  });
});
