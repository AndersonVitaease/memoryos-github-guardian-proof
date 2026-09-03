/**
 * GH-00 — Controlled merge execution: approval gates -> fresh revalidation ->
 * ONE merge attempt with native SHA precondition -> independent post-validation.
 *
 * Completes the GH-00 cycle:
 *   PLAN -> approval -> fresh revalidation -> controlled merge -> post-validation.
 *
 * Guarantees:
 *   - the certified approval gates run first (prepareApprovedPullRequestMerge);
 *   - merge proceeds ONLY on APPROVED_SNAPSHOT_VALID;
 *   - expectedHeadSha comes ONLY from the fresh validated evidence;
 *   - the merge adapter is invoked AT MOST ONCE — zero retry, ever;
 *   - backend acceptance is NEVER a proof: VERIFIED requires independent
 *     post-validation evidence (fresh read: state === MERGED, same PR);
 *   - rejected backend -> FAILED (409 = native SHA/state precondition);
 *   - ambiguous outcome or unprovable post-validation ->
 *     UNKNOWN_REQUIRES_HUMAN_REVIEW (no automatic retry, ever).
 */

import type { PullRequestAdapter } from "./githubAdapter";
import type {
  MergeBackendOutcome,
  PullRequestMergeAdapter,
} from "./githubPullRequestMergeAdapter";
import { postValidationProvesMerged } from "./githubPullRequestMergeAdapter";
import { DEFAULT_OPERATOR_CONFIG, type OperatorConfig } from "./planPullRequestMerge";
import {
  type MergeApproval,
  prepareApprovedPullRequestMerge,
} from "./prepareApprovedPullRequestMerge";

export interface ExecuteApprovedMergeInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly execute: boolean;
  readonly approval: MergeApproval;
}

export interface ExecuteApprovedMergeDeps {
  /** Fresh evidence channel: revalidation + independent post-validation. */
  readonly adapter: PullRequestAdapter;
  /** The single controlled write channel (one attempt, no retry). */
  readonly mergeAdapter: PullRequestMergeAdapter;
  readonly config?: OperatorConfig;
}

export type ExecutedMergeStatus =
  | "APPROVAL_REQUIRED"
  | "BLOCKED"
  | "UNKNOWN"
  | "SNAPSHOT_CHANGED"
  | "FAILED"
  | "UNKNOWN_REQUIRES_HUMAN_REVIEW"
  | "VERIFIED";

export interface ExecutedMergeOutcome {
  readonly status: ExecutedMergeStatus;
  readonly mutationPerformed: boolean;
  /** True when the single merge attempt was actually invoked. */
  readonly mergeAttempted: boolean;
  readonly approvedFingerprint?: string;
  readonly currentFingerprint?: string | null;
  readonly evidence: Record<string, unknown> | null;
  readonly reasons: readonly string[];
}

/**
 * Governed merge execution. READ-ONLY until every gate passes; at most one
 * mutation attempt per approved execution; zero retry in every failure path.
 */
export async function executeApprovedPullRequestMerge(
  input: ExecuteApprovedMergeInput,
  deps: ExecuteApprovedMergeDeps,
): Promise<ExecutedMergeOutcome> {
  const config = deps.config ?? DEFAULT_OPERATOR_CONFIG;

  // Gates 1-3: execute intent + approval binding + fingerprint format.
  // Fresh revalidation + snapshot comparison happen inside (certified logic).
  const prepared = await prepareApprovedPullRequestMerge(
    {
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      execute: input.execute,
      approval: input.approval,
    },
    { adapter: deps.adapter, config },
  );

  if (prepared.status !== "APPROVED_SNAPSHOT_VALID") {
    return {
      status: prepared.status,
      mutationPerformed: false,
      mergeAttempted: false,
      approvedFingerprint: prepared.approvedFingerprint,
      currentFingerprint: prepared.currentFingerprint,
      evidence: prepared.evidence as unknown as Record<string, unknown> | null,
      reasons: prepared.reasons,
    };
  }

  // Gate 4: the only allowed SHA source — fresh, revalidated, approved evidence.
  const freshEvidence = prepared.evidence;
  if (freshEvidence === null || freshEvidence.headSha === null) {
    return {
      status: "UNKNOWN",
      mutationPerformed: false,
      mergeAttempted: false,
      approvedFingerprint: prepared.approvedFingerprint,
      currentFingerprint: prepared.currentFingerprint,
      evidence: freshEvidence as unknown as Record<string, unknown>,
      reasons: ["MERGE_HEAD_SHA_UNAVAILABLE"],
    };
  }

  // THE single controlled mutation attempt. Never retried.
  const backend = await deps.mergeAdapter.mergePullRequest({
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    expectedHeadSha: freshEvidence.headSha,
  });
  const mergeAttempted = true; // adapter was invoked exactly once

  // Backend rejected clearly -> fail-closed, no retry, no repetition.
  if (backend.result === "REJECTED") {
    return {
      status: "FAILED",
      mutationPerformed: true,
      mergeAttempted,
      approvedFingerprint: prepared.approvedFingerprint,
      currentFingerprint: prepared.currentFingerprint,
      evidence: freshEvidence as unknown as Record<string, unknown>,
      reasons: [backend.reason],
    };
  }

  // Independent post-validation: a fresh read must PROVE the merge.
  const post = await postValidationProvesMerged(
    deps.adapter,
    input.repository,
    input.pullRequestNumber,
  );

  if (backend.result === "ACCEPTED" && post.proven) {
    return {
      status: "VERIFIED",
      mutationPerformed: true,
      mergeAttempted,
      approvedFingerprint: prepared.approvedFingerprint,
      currentFingerprint: prepared.currentFingerprint,
      evidence: post.evidence as unknown as Record<string, unknown>,
      reasons: [],
    };
  }

  // Accepted-but-unproven, ambiguous network outcome, or unreadable state:
  // NEVER retried, NEVER claimed as success.
  return {
    status: "UNKNOWN_REQUIRES_HUMAN_REVIEW",
    mutationPerformed: true,
    mergeAttempted,
    approvedFingerprint: prepared.approvedFingerprint,
    currentFingerprint: prepared.currentFingerprint,
    evidence: post.evidence as unknown as Record<string, unknown> | null,
    reasons: [
      backend.result === "AMBIGUOUS"
        ? "MERGE_BACKEND_AMBIGUOUS_NETWORK"
        : "POST_VALIDATION_NOT_PROVEN",
      ...post.proven ? [] : ["POST_VALIDATION_INDEPENDENT_READ_INCOMPLETE"],
    ],
  };
}
