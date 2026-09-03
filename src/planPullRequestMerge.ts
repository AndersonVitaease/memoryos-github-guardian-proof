/**
 * GH-00 — READ-ONLY Pull Request merge planning.
 *
 * Operation represented: github.pull_request.merge.safe
 * This stage implements ONLY: prechecks -> deterministic snapshot -> fingerprint.
 *
 * NO merge, NO execute, NO approval, NO post-validation.
 * mutationPerformed is always false.
 *
 * Fail-closed rule: absence of evidence is never success — required evidence
 * that is missing or indeterminate yields UNKNOWN, never PLAN_READY.
 */

import { createHash } from "node:crypto";

import type {
  MergeableState,
  PullRequestAdapter,
  PullRequestCheck,
  PullRequestState,
} from "./githubAdapter";

/** The future experimental operation this planning stage belongs to. */
export const GITHUB_GUARDIAN_OPERATION = "github.pull_request.merge.safe" as const;

/**
 * Operator-controlled authority configuration (NOT caller-controlled).
 * Exact, explicit allowlists. No RBAC, no users, no generic policy engine.
 * Environment variable equivalents when wired to a real runtime later:
 *   GITHUB_GUARDIAN_ALLOWED_REPOS
 *   GITHUB_GUARDIAN_ALLOWED_BASE_BRANCHES
 */
export const GITHUB_GUARDIAN_ALLOWED_REPOS: readonly string[] = [
  "AndersonVitaease/memoryos-github-guardian-proof",
];
export const GITHUB_GUARDIAN_ALLOWED_BASE_BRANCHES: readonly string[] = ["main"];

export interface OperatorConfig {
  readonly allowedRepos: readonly string[];
  readonly allowedBaseBranches: readonly string[];
}

export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  allowedRepos: GITHUB_GUARDIAN_ALLOWED_REPOS,
  allowedBaseBranches: GITHUB_GUARDIAN_ALLOWED_BASE_BRANCHES,
};

/** Aggregate state of the known checks (derived, deterministic). */
export type ChecksState = "NO_KNOWN_CHECKS" | "NOT_FAILED" | "FAILED" | "INDETERMINATE";

export type PlanMergeStatus = "PLAN_READY" | "BLOCKED" | "UNKNOWN";

export interface PlanMergeInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
}

export interface PlanMergeDeps {
  /** Caller provides behavior, never credentials: the adapter owns tokens/URLs. */
  readonly adapter: PullRequestAdapter;
  readonly config?: OperatorConfig;
}

export interface PlanMergeEvidence {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly state: PullRequestState;
  readonly baseBranch: string | null;
  readonly headBranch: string | null;
  readonly headSha: string | null;
  readonly mergeableState: MergeableState;
  readonly checksState: ChecksState;
}

export interface PlanMergeOutcome {
  readonly status: PlanMergeStatus;
  readonly mutationPerformed: false;
  /** Present ONLY when status === "PLAN_READY". */
  readonly proposalFingerprint?: string;
  readonly evidence: PlanMergeEvidence;
  readonly reasons: readonly string[];
}

/**
 * Deterministic snapshot of the protected state a future approval binds to.
 * Built ONLY on PLAN_READY. Key order is fixed; serialization is canonical.
 */
export interface MergeProposalSnapshot {
  readonly operation: typeof GITHUB_GUARDIAN_OPERATION;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly state: "OPEN";
  readonly baseBranch: string;
  readonly headBranch: string | null;
  readonly headSha: string;
  readonly mergeableState: "MERGEABLE";
  readonly checksState: ChecksState;
}

const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function deriveChecksState(checks: ReadonlyArray<PullRequestCheck> | null): ChecksState {
  if (checks === null) return "INDETERMINATE";
  if (checks.length === 0) return "NO_KNOWN_CHECKS";
  return checks.some((check) => check.conclusion === "FAILED") ? "FAILED" : "NOT_FAILED";
}

function notFoundEvidence(input: PlanMergeEvidence): PlanMergeOutcome {
  return {
    status: "BLOCKED",
    mutationPerformed: false,
    evidence: {
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      state: null,
      baseBranch: null,
      headBranch: null,
      headSha: null,
      mergeableState: "UNKNOWN",
      checksState: "INDETERMINATE",
    },
    reasons: ["PULL_REQUEST_NOT_FOUND"],
  };
}

/**
 * READ-ONLY planning of a governed PR merge.
 * Deterministic given (input, adapter evidence, operator config).
 */
export async function planPullRequestMerge(
  input: PlanMergeInput,
  deps: PlanMergeDeps,
): Promise<PlanMergeOutcome> {
  const config = deps.config ?? DEFAULT_OPERATOR_CONFIG;

  // Precheck 1 — repository explicitly allowed (operator config, exact match).
  if (!config.allowedRepos.includes(input.repository)) {
    return {
      status: "BLOCKED",
      mutationPerformed: false,
      evidence: {
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        state: null,
        baseBranch: null,
        headBranch: null,
        headSha: null,
        mergeableState: "UNKNOWN",
        checksState: "INDETERMINATE",
      },
      reasons: ["REPOSITORY_NOT_ALLOWED"],
    };
  }

  // READ-ONLY evidence fetch.
  const evidence = await deps.adapter.getPullRequestEvidence({
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
  });

  // Precheck 2 — PR exists (definitive absence from the adapter).
  if (evidence === null) {
    return notFoundEvidence({
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      state: null,
      baseBranch: null,
      headBranch: null,
      headSha: null,
      mergeableState: "UNKNOWN",
      checksState: "INDETERMINATE",
    });
  }

  const checksState = deriveChecksState(evidence.checks);
  const observed: PlanMergeEvidence = {
    repository: evidence.repository,
    pullRequestNumber: evidence.pullRequestNumber,
    state: evidence.state,
    baseBranch: evidence.baseBranch,
    headBranch: evidence.headBranch,
    headSha: evidence.headSha,
    mergeableState: evidence.mergeableState,
    checksState,
  };

  const blocked: string[] = [];
  const unknown: string[] = [];

  // Precheck 3 — PR OPEN.
  if (evidence.state === null) {
    unknown.push("PULL_REQUEST_STATE_INDETERMINATE");
  } else if (evidence.state !== "OPEN") {
    blocked.push("PULL_REQUEST_NOT_OPEN");
  }

  // Precheck 4 — base branch explicitly allowed (operator config, exact match).
  if (evidence.baseBranch === null) {
    unknown.push("BASE_BRANCH_MISSING");
  } else if (!config.allowedBaseBranches.includes(evidence.baseBranch)) {
    blocked.push("BASE_BRANCH_NOT_ALLOWED");
  }

  // Precheck 5 — head SHA present and valid (bindable for future approval).
  if (evidence.headSha === null) {
    unknown.push("HEAD_SHA_MISSING");
  } else if (!HEAD_SHA_PATTERN.test(evidence.headSha)) {
    unknown.push("HEAD_SHA_INVALID");
  }

  // Precheck 6 — not known as non-mergeable.
  if (evidence.mergeableState === "NOT_MERGEABLE") {
    blocked.push("NOT_MERGEABLE");
  } else if (evidence.mergeableState !== "MERGEABLE") {
    unknown.push("MERGEABLE_STATE_INDETERMINATE");
  }

  // Precheck 7 — known checks contain no FAILED conclusion.
  if (checksState === "FAILED") {
    blocked.push("CHECKS_FAILED");
  } else if (checksState === "INDETERMINATE") {
    unknown.push("CHECKS_INDETERMINATE");
  }

  if (blocked.length > 0) {
    return { status: "BLOCKED", mutationPerformed: false, evidence: observed, reasons: blocked };
  }
  if (unknown.length > 0) {
    return { status: "UNKNOWN", mutationPerformed: false, evidence: observed, reasons: unknown };
  }

  // PLAN_READY invariants hold: state OPEN, baseBranch present, headSha valid,
  // mergeable MERGEABLE, checks not failed. Snapshot captures protected state only.
  const snapshot: MergeProposalSnapshot = {
    operation: GITHUB_GUARDIAN_OPERATION,
    repository: observed.repository,
    pullRequestNumber: observed.pullRequestNumber,
    state: "OPEN",
    baseBranch: observed.baseBranch as string,
    headBranch: observed.headBranch,
    headSha: observed.headSha as string,
    mergeableState: "MERGEABLE",
    checksState: observed.checksState,
  };

  return {
    status: "PLAN_READY",
    mutationPerformed: false,
    proposalFingerprint: computeProposalFingerprint(snapshot),
    evidence: observed,
    reasons: [],
  };
}

/**
 * Deterministic serialization: fixed key order, canonical JSON, no whitespace.
 * The same protected state always serializes to exactly the same string.
 */
export function serializeSnapshot(snapshot: MergeProposalSnapshot): string {
  return JSON.stringify({
    operation: snapshot.operation,
    repository: snapshot.repository,
    pullRequestNumber: snapshot.pullRequestNumber,
    state: snapshot.state,
    baseBranch: snapshot.baseBranch,
    headBranch: snapshot.headBranch,
    headSha: snapshot.headSha,
    mergeableState: snapshot.mergeableState,
    checksState: snapshot.checksState,
  });
}

/**
 * proposalFingerprint = SHA-256(deterministic snapshot).
 * 64 lowercase hex characters.
 * NOT authentication: only a deterministic binding between a future approval
 * and the exact observed state.
 */
export function computeProposalFingerprint(snapshot: MergeProposalSnapshot): string {
  return createHash("sha256").update(serializeSnapshot(snapshot)).digest("hex");
}
