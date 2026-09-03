/**
 * GH-00 — Approval binding + fresh revalidation + snapshot fingerprint comparison.
 *
 * Proves the hypothesis: "an approval is only valid for the exact state it approved."
 *
 * NO merge, NO execution of merge, NO post-validation.
 * mutationPerformed is always false, on every path.
 *
 * Gates (in order, all fail-closed, all zero-mutation):
 *   execute !== true                           -> APPROVAL_REQUIRED (no evidence fetch)
 *   approval.approved !== true                 -> APPROVAL_REQUIRED (no evidence fetch)
 *   proposalFingerprint not 64 lowercase hex   -> BLOCKED           (no evidence fetch)
 *
 * Revalidation reuses the certified PLAN (planPullRequestMerge): FRESH evidence,
 * the SAME prechecks, the SAME deterministic snapshot, the SAME fingerprint
 * computation. No domain rule is duplicated here.
 *
 * APPROVED_SNAPSHOT_VALID means ONLY "the approval still corresponds to the
 * current observed state". It does NOT mean a merge is authorized anywhere.
 */

import type { PullRequestAdapter } from "./githubAdapter";
import {
  DEFAULT_OPERATOR_CONFIG,
  type OperatorConfig,
  type PlanMergeEvidence,
  planPullRequestMerge,
} from "./planPullRequestMerge";

/** Exactly the fingerprint format produced by the certified PLAN stage. */
const PROPOSAL_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** Approval presented by the caller. Contains ONLY the deterministic binding. */
export interface MergeApproval {
  readonly approved: boolean;
  readonly proposalFingerprint?: unknown;
}

export interface PrepareApprovedMergeInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly execute: boolean;
  readonly approval: MergeApproval;
}

export interface PrepareApprovedMergeDeps {
  /** Caller provides behavior, never credentials: the adapter owns tokens/URLs. */
  readonly adapter: PullRequestAdapter;
  readonly config?: OperatorConfig;
}

export type PreparedMergeStatus =
  | "APPROVAL_REQUIRED"
  | "BLOCKED"
  | "UNKNOWN"
  | "SNAPSHOT_CHANGED"
  | "APPROVED_SNAPSHOT_VALID";

export interface PreparedMergeOutcome {
  readonly status: PreparedMergeStatus;
  readonly mutationPerformed: false;
  /** The fingerprint presented in the approval (only when well-formed). */
  readonly approvedFingerprint?: string;
  /** Fresh fingerprint at revalidation; null when no valid fresh snapshot exists. */
  readonly currentFingerprint?: string | null;
  /** Fresh evidence from revalidation; null when no fetch was performed. */
  readonly evidence: PlanMergeEvidence | null;
  readonly reasons: readonly string[];
}

function isValidFingerprint(value: unknown): value is string {
  return typeof value === "string" && PROPOSAL_FINGERPRINT_PATTERN.test(value);
}

function approvalRequired(reasons: readonly string[]): PreparedMergeOutcome {
  return { status: "APPROVAL_REQUIRED", mutationPerformed: false, evidence: null, reasons };
}

/**
 * Validate the approval binding against FRESH state. READ-ONLY.
 * Deterministic given (input, adapter evidence, operator config).
 */
export async function prepareApprovedPullRequestMerge(
  input: PrepareApprovedMergeInput,
  deps: PrepareApprovedMergeDeps,
): Promise<PreparedMergeOutcome> {
  // Gate 1 — explicit execute intent is required.
  if (input.execute !== true) {
    return approvalRequired(["EXECUTE_REQUIRED"]);
  }
  // Gate 2 — explicit approval is required.
  if (input.approval?.approved !== true) {
    return approvalRequired(["APPROVAL_NOT_GRANTED"]);
  }
  // Gate 3 — the approval must carry an exactly well-formed fingerprint.
  if (!isValidFingerprint(input.approval.proposalFingerprint)) {
    return {
      status: "BLOCKED",
      mutationPerformed: false,
      evidence: null,
      reasons: ["PROPOSAL_FINGERPRINT_MALFORMED"],
    };
  }
  const approvedFingerprint = input.approval.proposalFingerprint;

  // Fresh revalidation — SAME certified PLAN: fresh evidence, same prechecks,
  // same deterministic snapshot, same SHA-256 fingerprint computation.
  const fresh = await planPullRequestMerge(
    { repository: input.repository, pullRequestNumber: input.pullRequestNumber },
    { adapter: deps.adapter, config: deps.config ?? DEFAULT_OPERATOR_CONFIG },
  );

  // No valid fresh snapshot -> the approval cannot be bound to anything.
  if (fresh.status !== "PLAN_READY") {
    return {
      status: fresh.status,
      mutationPerformed: false,
      approvedFingerprint,
      currentFingerprint: null,
      evidence: fresh.evidence,
      reasons: fresh.reasons,
    };
  }
  // Defensive fail-closed: PLAN_READY must always carry its fingerprint.
  if (fresh.proposalFingerprint === undefined) {
    return {
      status: "UNKNOWN",
      mutationPerformed: false,
      approvedFingerprint,
      currentFingerprint: null,
      evidence: fresh.evidence,
      reasons: ["SNAPSHOT_FINGERPRINT_UNAVAILABLE"],
    };
  }
  const currentFingerprint = fresh.proposalFingerprint;

  // The core proof: approval binds to one exact snapshot, nothing else.
  if (currentFingerprint !== approvedFingerprint) {
    return {
      status: "SNAPSHOT_CHANGED",
      mutationPerformed: false,
      approvedFingerprint,
      currentFingerprint,
      evidence: fresh.evidence,
      reasons: ["SNAPSHOT_FINGERPRINT_MISMATCH"],
    };
  }

  return {
    status: "APPROVED_SNAPSHOT_VALID",
    mutationPerformed: false,
    approvedFingerprint,
    currentFingerprint,
    evidence: fresh.evidence,
    reasons: [],
  };
}
