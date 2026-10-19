import type { AttachmentRef } from './attachments';
import type { ApprovalRequest, Task, TaskEvent, TaskStep } from './domain';
import type { TaskPlanView } from './plan';
import type { TaskUsage } from './usage';

/** Metadata for an output actually recorded by a task, never input context. */
export interface ArtifactSummary {
  id: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  stepId?: string;
  createdAt: string;
}

export interface TaskCriterionResult {
  criterion: string;
  index: number;
  satisfied: boolean;
  detail?: string;
}

/** Persisted verification evidence; task state alone is not proof of success. */
export interface TaskVerification {
  checkpointId: string;
  verified: boolean;
  verifiedAt?: string;
  finished: boolean;
  criteria: TaskCriterionResult[];
}

export interface TaskDetails {
  task: Task;
  steps: TaskStep[];
  events: TaskEvent[];
  artifacts: ArtifactSummary[];
  attachments: AttachmentRef[];
  approvals: ApprovalRequest[];
  verification: TaskVerification | null;
  /** Plan mode: the plan and its waves (null for a single-agent task). */
  plan?: TaskPlanView | null;
  /** Token usage recorded for this task. */
  usage?: TaskUsage;
}

export interface ArtifactPreview {
  text: string;
  truncated: boolean;
}
