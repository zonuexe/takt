/**
 * VCS provider type constants.
 *
 * Single source of truth for supported VCS provider identifiers.
 * Used by config schemas, type definitions, and detection logic.
 */

export const VCS_PROVIDER_TYPES = ['github', 'gitlab'] as const;
export type VcsProviderType = (typeof VCS_PROVIDER_TYPES)[number];

/**
 * How a TAKT-published PR body references the issue a task is bound to.
 * `closes` writes `Closes #N` (auto-closing keyword), `refs` writes `Refs #N`,
 * `none` omits the issue line.
 */
export const PR_ISSUE_KEYWORDS = ['closes', 'refs', 'none'] as const;
export type PrIssueKeyword = (typeof PR_ISSUE_KEYWORDS)[number];
