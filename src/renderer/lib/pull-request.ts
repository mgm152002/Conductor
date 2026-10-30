// Helpers for opening a pull request in the in-app PR reader tab.

/** Route of the PR reader for one pull request. */
export function prPath(workspaceId: string, number: number): string {
  return `/pr/${encodeURIComponent(workspaceId)}/${number}`;
}

/** Extract the PR number from a github.com pull URL, when present. */
export function prNumberFromUrl(url: string | undefined): number | null {
  if (url === undefined) return null;
  const match = /\/pull\/(\d+)/.exec(url);
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
}
