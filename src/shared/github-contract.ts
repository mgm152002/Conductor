import { z } from 'zod';

// GitHub integration: each project (workspace) can be connected to the
// GitHub repository its `origin` remote points at, using a personal access
// token stored in the macOS Keychain. When a Work agent finishes a thread,
// Conductor can commit the thread worktree, push its branch, and open a
// pull request, which is then linked back to the thread.

export type PullRequestState = 'open' | 'closed' | 'merged';

export interface GitHubRepoRef {
  owner: string;
  name: string;
  fullName: string;
}

export interface GitHubConnectionStatus {
  workspaceId: string;
  /** The GitHub repo detected from the project's `origin` remote, if any. */
  repo: GitHubRepoRef | null;
  /** Whether a token is stored for this project. */
  connected: boolean;
  /** GitHub login the stored token belongs to (validated on connect). */
  login?: string;
  /** Open a PR automatically when an agent finishes a thread. */
  autoPr: boolean;
  /** Base branch PRs target; empty means the repository default branch. */
  baseBranch?: string;
  /** Most recent automatic-PR failure for this project, if any. */
  lastError?: string;
  lastErrorAt?: string;
}

export interface PullRequestRecord {
  id: string;
  workspaceId: string;
  /** Thread key (root task id) this PR was opened from. */
  threadKey: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  state: PullRequestState;
  /** Display title of the linked thread. */
  threadTitle: string;
  createdAt: string;
  updatedAt: string;
}

export type CreatePrResult =
  | { status: 'created' | 'existing'; pr: PullRequestRecord }
  | { status: 'no-changes'; branch: string };

const WorkspaceId = z.string().trim().min(1).max(200);

export const GITHUB_SCHEMAS = {
  'github.status': z.object({ workspaceId: WorkspaceId }).strict(),
  'github.connect': z.object({
    workspaceId: WorkspaceId,
    // Classic/fine-grained PATs; never echoed back to the renderer.
    token: z.string().trim().min(8).max(512),
  }).strict(),
  'github.disconnect': z.object({ workspaceId: WorkspaceId }).strict(),
  'github.setAutoPr': z.object({ workspaceId: WorkspaceId, enabled: z.boolean() }).strict(),
  'github.setBaseBranch': z.object({ workspaceId: WorkspaceId, branch: z.string().trim().max(200) }).strict(),
  'github.listPrs': z.object({ workspaceId: WorkspaceId }).strict(),
  'github.refreshPrs': z.object({ workspaceId: WorkspaceId }).strict(),
  'github.createPr': z.object({ workspaceId: WorkspaceId, threadId: z.string().trim().min(1).max(200) }).strict(),
  // Only URLs persisted by Conductor itself may be opened (validated in main).
  'github.openPr': z.object({ url: z.string().url().max(2048) }).strict(),
} as const;

export interface GitHubBridge {
  status(workspaceId: string): Promise<GitHubConnectionStatus>;
  connect(input: { workspaceId: string; token: string }): Promise<GitHubConnectionStatus>;
  disconnect(workspaceId: string): Promise<GitHubConnectionStatus>;
  setAutoPr(input: { workspaceId: string; enabled: boolean }): Promise<GitHubConnectionStatus>;
  setBaseBranch(input: { workspaceId: string; branch: string }): Promise<GitHubConnectionStatus>;
  listPrs(workspaceId: string): Promise<PullRequestRecord[]>;
  refreshPrs(workspaceId: string): Promise<PullRequestRecord[]>;
  createPr(input: { workspaceId: string; threadId: string }): Promise<CreatePrResult>;
  openPr(url: string): Promise<void>;
}
