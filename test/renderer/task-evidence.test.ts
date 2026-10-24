import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/shared/domain';
import type { TaskDetails } from '../../src/shared/task-view';
import { VerificationRegion } from '../../src/renderer/components/workspace/VerificationRegion';
import { ArtifactsRegion } from '../../src/renderer/components/workspace/ArtifactsRegion';
import { PlanTimelineRegion } from '../../src/renderer/components/workspace/PlanTimelineRegion';

const task: Task = { id: 'task', workspaceId: 'workspace', objective: 'Produce a report', state: 'COMPLETED', acceptanceCriteria: ['Report has the required figures', 'Report has sources'], contextRefs: ['input-reference'], lastVerifiedCheckpointId: 'legacy-checkpoint', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' };
const details: TaskDetails = { task, steps: [], events: [], artifacts: [], attachments: [], approvals: [], verification: null };

describe('task evidence presented in workspace regions', () => {
  it('never infers per-criterion passes from COMPLETED state or a checkpoint id', () => {
    const html = renderToStaticMarkup(createElement(VerificationRegion, { task, details }));
    expect(html).toContain('No verification recorded');
    expect(html).toContain('Pending');
    expect(html).not.toContain('Passed');
  });
  it('renders actual pass, failure, and pending results independently after interrupted verification', () => {
    const html = renderToStaticMarkup(createElement(VerificationRegion, { task, details: { ...details, verification: { checkpointId: 'evidence', verified: false, finished: false, criteria: [{ index: 0, criterion: task.acceptanceCriteria[0]!, satisfied: false, detail: 'Required figure missing' }] } } }));
    expect(html).toContain('Verification unfinished');
    expect(html).toContain('Failed');
    expect(html).toContain('Pending');
    expect(html).toContain('Required figure missing');
    expect(html).not.toContain('Passed');
  });
  it('lists recorded artifacts and never mislabels input context as produced output', () => {
    const empty = renderToStaticMarkup(createElement(ArtifactsRegion, { task, details }));
    expect(empty).not.toContain('input-reference');
    const recorded = renderToStaticMarkup(createElement(ArtifactsRegion, { task, details: { ...details, artifacts: [{ id: 'output-blob', name: 'Report.txt', mimeType: 'text/plain', sizeBytes: 42, createdAt: task.createdAt }] } }));
    expect(recorded).toContain('Report.txt');
    expect(recorded).toContain('42 bytes');
    expect(recorded).not.toContain('input-reference');
  });
  it('renders persisted plan steps, dependency descriptions, and assigned agents', () => {
    const html = renderToStaticMarkup(createElement(PlanTimelineRegion, { task, details: { ...details, steps: [{ id: 'read', taskId: task.id, ordinal: 0, description: 'Read sources', dependsOn: [], status: 'succeeded' }, { id: 'write', taskId: task.id, ordinal: 1, description: 'Write report', dependsOn: ['read'], assignedAdapterId: 'real-agent', status: 'running' }] } }));
    expect(html).toContain('Read sources');
    expect(html).toContain('Depends on: 1. Read sources');
    expect(html).toContain('real-agent');
    expect(html).toContain('running');
  });
});
