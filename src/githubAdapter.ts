/**
 * GH-00 — Minimal READ-ONLY Pull Request evidence interface.
 *
 * Single purpose of this proof lab: governed GitHub Pull Request merge.
 * This file defines ONLY the minimum evidence surface needed for the
 * plan/snapshot/fingerprint stage. It is NOT a general GitHub abstraction.
 *
 * The domain never receives tokens, URLs or endpoints from the caller:
 * any real adapter would own credentials internally. This stage uses a
 * fake adapter in tests only. No real GitHub call is made yet.
 */

/** GitHub PR state. null = state not determinable (fail-closed upstream). */
export type PullRequestState = "OPEN" | "CLOSED" | "MERGED" | null;

/**
 * Normalized mergeability. The adapter must map raw GitHub values:
 * mergeable === true / mergeable_state "clean" -> "MERGEABLE";
 * mergeable === false / known dirty/blocked states -> "NOT_MERGEABLE";
 * anything indeterminable (e.g. mergeable === null) -> "UNKNOWN".
 */
export type MergeableState = "MERGEABLE" | "NOT_MERGEABLE" | "UNKNOWN";

/** One known check run relevant to the PR. conclusion as observed (may be null). */
export interface PullRequestCheck {
  readonly name: string;
  readonly conclusion: string | null;
}

/**
 * Minimal evidence for one Pull Request, as observed by the adapter.
 * Null fields mean "not available" and must lead to fail-closed decisions.
 */
export interface PullRequestEvidence {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly state: PullRequestState;
  readonly baseBranch: string | null;
  readonly headBranch: string | null;
  readonly headSha: string | null;
  readonly mergeableState: MergeableState;
  readonly checks: ReadonlyArray<PullRequestCheck> | null;
}

/** READ-ONLY query the domain is allowed to make. */
export interface PullRequestQuery {
  readonly repository: string;
  readonly pullRequestNumber: number;
}

/**
 * READ-ONLY adapter contract: fetch evidence for one Pull Request.
 * Returns null when the Pull Request does not exist.
 * No mutation methods exist on this interface.
 */
export interface PullRequestAdapter {
  getPullRequestEvidence(query: PullRequestQuery): Promise<PullRequestEvidence | null>;
}
