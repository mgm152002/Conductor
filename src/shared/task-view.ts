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

/** A file in the project's working tree that differs from the last commit. */
export type ChangedFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface ChangedFile {
  /** Path relative to the workspace root, using forward slashes. */
  path: string;
  /** Previous path when the change is a rename. */
  previousPath?: string;
  status: ChangedFileStatus;
  additions?: number;
  deletions?: number;
}

export interface ChangedFileDiff {
  path: string;
  /** Unified diff text. Empty when the file has no textual changes. */
  patch: string;
  truncated: boolean;
}

/** Uncommitted files in a workspace, plus whether the folder is a Git repo. */
export interface WorkspaceChanges {
  files: ChangedFile[];
  /** False when the workspace folder is not inside a Git work tree. */
  isRepository: boolean;
  /** True when these changes come from the thread's own Git worktree. */
  worktree?: boolean;
  /** The thread worktree's branch, e.g. `conductor/<thread>`. */
  branch?: string;
}
