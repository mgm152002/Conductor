import { GITHUB_SCHEMAS } from '@shared/github-contract';
import type { GitHubService } from '../domain/github-service';
import type { IpcRouter } from './router';

export function registerGitHubHandlers(router: IpcRouter, github: GitHubService): void {
  router.handle('github.status', GITHUB_SCHEMAS['github.status'], (_event, { workspaceId }) => github.status(workspaceId));
  router.handle('github.connect', GITHUB_SCHEMAS['github.connect'], (_event, { workspaceId, token }) => github.connect(workspaceId, token));
  router.handle('github.disconnect', GITHUB_SCHEMAS['github.disconnect'], (_event, { workspaceId }) => github.disconnect(workspaceId));
  router.handle('github.setAutoPr', GITHUB_SCHEMAS['github.setAutoPr'], (_event, { workspaceId, enabled }) => github.setAutoPr(workspaceId, enabled));
  router.handle('github.setBaseBranch', GITHUB_SCHEMAS['github.setBaseBranch'], (_event, { workspaceId, branch }) => github.setBaseBranch(workspaceId, branch));
  router.handle('github.listPrs', GITHUB_SCHEMAS['github.listPrs'], (_event, { workspaceId }) => github.listPrs(workspaceId));
  router.handle('github.refreshPrs', GITHUB_SCHEMAS['github.refreshPrs'], (_event, { workspaceId }) => github.refreshPrs(workspaceId));
  router.handle('github.createPr', GITHUB_SCHEMAS['github.createPr'], (_event, { workspaceId, threadId }) => github.createPrForThread(workspaceId, threadId));
  router.handle('github.openPr', GITHUB_SCHEMAS['github.openPr'], (_event, { url }) => github.openPr(url));
  router.handle('github.getPr', GITHUB_SCHEMAS['github.getPr'], (_event, { workspaceId, number }) => github.getPr(workspaceId, number));
  router.handle('github.mergePr', GITHUB_SCHEMAS['github.mergePr'], (_event, { workspaceId, number, method, commitTitle }) => github.mergePr(workspaceId, number, method, commitTitle));
  router.handle('github.commentPr', GITHUB_SCHEMAS['github.commentPr'], (_event, { workspaceId, number, body }) => github.commentPr(workspaceId, number, body));
  router.handle('github.reviewPr', GITHUB_SCHEMAS['github.reviewPr'], (_event, { workspaceId, number, event, body }) => github.reviewPr(workspaceId, number, event, body));
  router.handle('github.setPrState', GITHUB_SCHEMAS['github.setPrState'], (_event, { workspaceId, number, state }) => github.setPrState(workspaceId, number, state));
}
