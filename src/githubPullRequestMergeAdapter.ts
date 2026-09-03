/**
 * GH-00 — SINGLE controlled write operation: governed Pull Request merge.
 *
 * This is the ONLY mutation surface of the GH-00 lab. It performs exactly one
 * PUT to the fixed official endpoint:
 *
 *   PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge
 *
 * The mandatory native SHA precondition is ALWAYS sent:
 *   body: { "sha": expectedHeadSha, "merge_method": "merge" }
 *
 * expectedHeadSha MUST come exclusively from the fresh, revalidated evidence
 * bound to the approved proposalFingerprint. The caller can never choose it.
 *
 * Idempotency: none is claimed. Exactly one attempt per approved execution.
 * No retry, no repetition on error/timeout/ambiguity.
 *
 * Credential authority: operator env GITHUB_GUARDIAN_TOKEN. Never printed,
 * returned or persisted. Caller cannot choose URL, method, payload or target.
 */

import type {
  MergeableState,
  PullRequestAdapter,
  PullRequestCheck,
  PullRequestEvidence,
  PullRequestQuery,
  PullRequestState,
} from "./githubAdapter";

/** Operator-controlled credential env var. Value is never logged or returned. */
export const GITHUB_GUARDIAN_TOKEN_ENV = "GITHUB_GUARDIAN_TOKEN";

export interface PullRequestMergeRequest {
  readonly repository: string;
  readonly pullRequestNumber: number;
  /** MUST be the headSha of the fresh, revalidated, approved evidence. */
  readonly expectedHeadSha: string;
}

export type MergeBackendResult = "ACCEPTED" | "REJECTED" | "AMBIGUOUS";

/** Backend observation of the single merge attempt. Never a proof of merge. */
export interface MergeBackendOutcome {
  readonly result: MergeBackendResult;
  /** Non-sensitive machine reason. Never contains credentials. */
  readonly reason: string;
  /** HTTP status class evidence when a response was received; else null. */
  readonly backendStatus: number | null;
}

export interface PullRequestMergeAdapter {
  /** Executes the single governed merge attempt. No retry logic exists here. */
  mergePullRequest(request: PullRequestMergeRequest): Promise<MergeBackendOutcome>;
}

/** Minimal HTTP surface, injectable for deterministic tests. */
export type GithubFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface GitHubPullRequestMergeAdapterConfig {
  /** Operator secret. Used only in the Authorization header, never exposed. */
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: GithubFetch;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class GitHubPullRequestMergeAdapter implements PullRequestMergeAdapter {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: GithubFetch;

  constructor(config: GitHubPullRequestMergeAdapterConfig) {
    if (typeof config.token !== "string" || config.token.length === 0) {
      throw new Error(`${GITHUB_GUARDIAN_TOKEN_ENV} is not configured for the operator`);
    }
    this.token = config.token;
    this.apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Factory for the operator: reads the secret from the process environment. */
  static fromEnv(fetchImpl?: GithubFetch): GitHubPullRequestMergeAdapter {
    const token = process.env[GITHUB_GUARDIAN_TOKEN_ENV];
    return new GitHubPullRequestMergeAdapter({ token: token ?? "", fetchImpl });
  }

  /**
   * THE single mutation of this experiment. Exactly one PUT, one attempt,
   * no retry. A network throw is AMBIGUOUS (the backend may or may not have
   * processed the merge) and must lead to human review, never to a retry.
   */
  async mergePullRequest(request: PullRequestMergeRequest): Promise<MergeBackendOutcome> {
    const segments = request.repository.split("/");
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
      return { result: "REJECTED", reason: "MERGE_REJECTED_REPOSITORY_MALFORMED", backendStatus: null };
    }
    if (!HEAD_SHA_PATTERN.test(request.expectedHeadSha)) {
      return { result: "REJECTED", reason: "MERGE_REJECTED_PRECONDITION_MALFORMED", backendStatus: null };
    }
    const repo = `${encodeURIComponent(segments[0])}/${encodeURIComponent(segments[1])}`;
    const url = `${this.apiBaseUrl}/repos/${repo}/pulls/${request.pullRequestNumber}/merge`;

    let response: Awaited<ReturnType<GithubFetch>>;
    try {
      response = await this.fetchImpl(url, {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({
          sha: request.expectedHeadSha, // native SHA precondition (mandatory)
          merge_method: "merge", // fixed by the operator config, not by the caller
        }),
      });
    } catch {
      // Network failure/timeout: outcome ambiguous, never retried here.
      return { result: "AMBIGUOUS", reason: "MERGE_BACKEND_AMBIGUOUS_NETWORK", backendStatus: null };
    }

    if (response.ok) {
      // Accepted by the backend — still NOT a proof of merge (post-validation decides).
      return { result: "ACCEPTED", reason: "MERGE_BACKEND_ACCEPTED", backendStatus: response.status };
    }
    if (response.status === 409) {
      // Native SHA precondition violation or not-mergeable state: specific fail-closed.
      return { result: "REJECTED", reason: "MERGE_REJECTED_PRECONDITION_SHA_OR_STATE", backendStatus: 409 };
    }
    if (response.status === 405) {
      return { result: "REJECTED", reason: "MERGE_REJECTED_NOT_MERGEABLE", backendStatus: 405 };
    }
    if (response.status === 404) {
      return { result: "REJECTED", reason: "MERGE_REJECTED_PR_NOT_FOUND", backendStatus: 404 };
    }
    return { result: "REJECTED", reason: "MERGE_REJECTED_BACKEND_REFUSED", backendStatus: response.status };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`, // internal use only; never echoed
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "memoryos-github-guardian-proof",
      "Content-Type": "application/json",
    };
  }
}

/**
 * Independent post-validation read: does fresh evidence PROVE the merge?
 * Backend acceptance is never sufficient by itself.
 */
export async function postValidationProvesMerged(
  adapter: PullRequestAdapter,
  repository: string,
  pullRequestNumber: number,
): Promise<{ proven: boolean; evidence: PullRequestEvidence | null }> {
  let evidence: PullRequestEvidence | null;
  try {
    evidence = await adapter.getPullRequestEvidence({ repository, pullRequestNumber });
  } catch {
    return { proven: false, evidence: null };
  }
  if (evidence === null) return { proven: false, evidence: null };
  const proven =
    evidence.repository === repository &&
    evidence.pullRequestNumber === pullRequestNumber &&
    evidence.state === "MERGED";
  return { proven, evidence };
}

// Re-exports keep the merge surface self-contained for the domain module.
export type { MergeableState, PullRequestCheck, PullRequestQuery, PullRequestState };
