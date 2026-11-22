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

export type IssueState = 'open' | 'closed';

/** A GitHub issue on a project's repository, with the Work threads started from it. */
export interface IssueRecord {
  number: number;
  title: string;
  state: IssueState;
  url: string;
  author: string;
  labels: { name: string; color: string }[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  /** Threads started from this issue (thread keys), newest first. */
  threadKeys: string[];
}

export interface IssueList {
  repo: GitHubRepoRef | null;
  /** Whether a token is stored; without one, public repositories are read anonymously. */
  connected: boolean;
  issues: IssueRecord[];
}

/** An issue written out as Markdown (body and comments), to give a thread as context. */
export interface IssueContext {
  number: number;
  title: string;
  url: string;
  markdown: string;
}

export type CreatePrResult =
  | { status: 'created' | 'existing'; pr: PullRequestRecord }
  | { status: 'no-changes'; branch: string };

/** Everything the in-app PR reader needs for one pull request. */
export interface PullRequestDetail extends PullRequestRecord {
  body: string;
  author: string;
  repoFullName: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  draft: boolean;
  /** Null while GitHub is still computing mergeability. */
  mergeable: boolean | null;
  mergeableState?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  labels: string[];
  reviewers: string[];
  assignees: string[];
  mergedBy?: string;
  mergedAt?: string;
  closedAt?: string;
}

export interface PullRequestFile {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface PullRequestCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface PullRequestComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
  kind: 'comment' | 'review';
  reviewState?: string;
}

export interface PullRequestCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
}

export interface PullRequestBundle {
  detail: PullRequestDetail;
  files: PullRequestFile[];
  commits: PullRequestCommit[];
  comments: PullRequestComment[];
  checks: PullRequestCheck[];
}

export type PrMergeMethod = 'merge' | 'squash' | 'rebase';
export type PrReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

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
  'github.listIssues': z.object({ workspaceId: WorkspaceId, state: z.enum(['open', 'closed', 'all']) }).strict(),
  'github.issueContext': z.object({ workspaceId: WorkspaceId, number: z.number().int().positive().max(10_000_000) }).strict(),
  'github.linkIssue': z.object({ workspaceId: WorkspaceId, number: z.number().int().positive().max(10_000_000), threadKey: z.string().uuid() }).strict(),
  'github.openIssue': z.object({ workspaceId: WorkspaceId, number: z.number().int().positive().max(10_000_000) }).strict(),
  'github.getPr': z.object({ workspaceId: WorkspaceId, number: z.number().int().positive().max(1_000_000) }).strict(),
  'github.mergePr': z.object({
    workspaceId: WorkspaceId, number: z.number().int().positive().max(1_000_000),
    method: z.enum(['merge', 'squash', 'rebase']), commitTitle: z.string().trim().max(500).optional(),
  }).strict(),
  'github.commentPr': z.object({
    workspaceId: WorkspaceId, number: z.number().int().positive().max(1_000_000),
    body: z.string().trim().min(1).max(20_000),
  }).strict(),
  'github.reviewPr': z.object({
    workspaceId: WorkspaceId, number: z.number().int().positive().max(1_000_000),
    event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']), body: z.string().trim().max(20_000).optional(),
  }).strict(),
  'github.setPrState': z.object({
    workspaceId: WorkspaceId, number: z.number().int().positive().max(1_000_000),
    state: z.enum(['open', 'closed']),
  }).strict(),
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
  /** Issues on the project's repository (pull requests left out). */
  listIssues(input: { workspaceId: string; state: 'open' | 'closed' | 'all' }): Promise<IssueList>;
  /** One issue with its comments, as Markdown for a thread to work from. */
  issueContext(input: { workspaceId: string; number: number }): Promise<IssueContext>;
  /** Record that a Work thread was started from an issue. */
  linkIssue(input: { workspaceId: string; number: number; threadKey: string }): Promise<void>;
  /** Open an issue of the project's repository on github.com. */
  openIssue(input: { workspaceId: string; number: number }): Promise<void>;
  getPr(input: { workspaceId: string; number: number }): Promise<PullRequestBundle>;
  mergePr(input: { workspaceId: string; number: number; method: PrMergeMethod; commitTitle?: string }): Promise<PullRequestBundle>;
  commentPr(input: { workspaceId: string; number: number; body: string }): Promise<PullRequestBundle>;
  reviewPr(input: { workspaceId: string; number: number; event: PrReviewEvent; body?: string }): Promise<PullRequestBundle>;
  setPrState(input: { workspaceId: string; number: number; state: 'open' | 'closed' }): Promise<PullRequestBundle>;
}
