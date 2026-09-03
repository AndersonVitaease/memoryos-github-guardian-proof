/**
 * GH-00 — Minimal READ-ONLY adapter for the real GitHub REST API.
 *
 * Satisfies the existing PullRequestAdapter interface. Performs ONLY the two
 * GET operations needed for plan evidence. No merge/execute/approval surface
 * exists on this class.
 *
 * Credential authority: the operator provides GITHUB_GUARDIAN_TOKEN via the
 * environment. The token is never an argument of the domain, never printed,
 * never returned and never persisted. The caller cannot choose URL, endpoint,
 * headers, HTTP method, SHA or base branch.
 *
 * Fail-closed normalization (absence of evidence is never success):
 *   - PR fetch 404            -> null (PR definitively does not exist)
 *   - any other HTTP failure  -> incomplete evidence -> domain UNKNOWN
 *   - network error           -> incomplete evidence -> domain UNKNOWN
 *   - mergeable indeterminate -> "UNKNOWN" (never MERGEABLE)
 *   - pending checks          -> checks null -> domain INDETERMINATE (never PASS)
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

/** Minimal HTTP surface the adapter needs. Injectable for deterministic tests. */
export type GithubFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface GitHubPullRequestAdapterConfig {
  /** Operator secret. Used only in the Authorization header, never exposed. */
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: GithubFetch;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** GitHub conclusions treated as FAILED by this lab (documented minimum). */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
/** Known GitHub mergeable_state values that mean "cannot merge cleanly now". */
const NOT_MERGEABLE_STATES = new Set(["dirty", "blocked", "draft"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeState(rawState: unknown, merged: unknown): PullRequestState {
  if (rawState === "open") return "OPEN";
  if (rawState === "closed") return merged === true ? "MERGED" : "CLOSED";
  return null;
}

function normalizeMergeable(mergeable: unknown, mergeableState: unknown): MergeableState {
  if (mergeable === false) return "NOT_MERGEABLE";
  if (typeof mergeableState === "string" && NOT_MERGEABLE_STATES.has(mergeableState)) {
    return "NOT_MERGEABLE";
  }
  if (mergeable === true && mergeableState === "clean") return "MERGEABLE";
  return "UNKNOWN";
}

/**
 * Normalize check runs to the domain model. Any pending/indeterminate check
 * (null conclusion) degrades the WHOLE checks evidence to null — the domain
 * then yields CHECKS_INDETERMINATE instead of an invented PASS.
 * GitHub lowercase "failure"-family conclusions map to the domain "FAILED".
 */
function normalizeChecks(body: unknown): PullRequestCheck[] | null {
  if (!isRecord(body) || !Array.isArray(body["check_runs"])) return null;
  const checks: PullRequestCheck[] = [];
  for (const raw of body["check_runs"]) {
    if (!isRecord(raw)) return null;
    const name = typeof raw["name"] === "string" ? raw["name"] : "unknown-check";
    const conclusion = raw["conclusion"];
    if (conclusion === null || conclusion === undefined) return null; // pending
    const failed = typeof conclusion === "string" && FAILED_CONCLUSIONS.has(conclusion);
    checks.push({ name, conclusion: failed ? "FAILED" : conclusion === "success" ? "SUCCESS" : String(conclusion).toUpperCase() });
  }
  return checks;
}

export class GitHubPullRequestAdapter implements PullRequestAdapter {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: GithubFetch;

  constructor(config: GitHubPullRequestAdapterConfig) {
    if (typeof config.token !== "string" || config.token.length === 0) {
      throw new Error(`${GITHUB_GUARDIAN_TOKEN_ENV} is not configured for the operator`);
    }
    this.token = config.token;
    this.apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Factory for the operator: reads the secret from the process environment. */
  static fromEnv(fetchImpl?: GithubFetch): GitHubPullRequestAdapter {
    const token = process.env[GITHUB_GUARDIAN_TOKEN_ENV];
    return new GitHubPullRequestAdapter({ token: token ?? "", fetchImpl });
  }

  /** READ-ONLY evidence fetch. Never performs writes; never exposes the token. */
  async getPullRequestEvidence(query: PullRequestQuery): Promise<PullRequestEvidence | null> {
    const segments = query.repository.split("/");
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
      return this.incompleteEvidence(query); // malformed repo ref -> fail closed
    }
    const repo = `${encodeURIComponent(segments[0])}/${encodeURIComponent(segments[1])}`;
    const prUrl = `${this.apiBaseUrl}/repos/${repo}/pulls/${query.pullRequestNumber}`;

    let pr: Record<string, unknown>;
    try {
      const response = await this.fetchImpl(prUrl, {
        method: "GET",
        headers: this.headers(),
      });
      if (response.status === 404) return null; // PR definitively absent
      if (!response.ok) return this.incompleteEvidence(query); // auth/permission/rate/5xx
      const body = await response.json();
      if (!isRecord(body)) return this.incompleteEvidence(query);
      pr = body;
    } catch {
      return this.incompleteEvidence(query); // network failure is never success
    }

    const head = isRecord(pr["head"]) ? pr["head"] : {};
    const base = isRecord(pr["base"]) ? pr["base"] : {};
    const headSha = typeof head["sha"] === "string" ? head["sha"] : null;

    // Second (and last) READ: check runs of the PR HEAD SHA.
    let checks: PullRequestCheck[] | null = null;
    if (headSha !== null) {
      try {
        const checkResponse = await this.fetchImpl(
          `${this.apiBaseUrl}/repos/${repo}/commits/${encodeURIComponent(headSha)}/check-runs`,
          { method: "GET", headers: this.headers() },
        );
        checks = checkResponse.ok ? normalizeChecks(await checkResponse.json()) : null;
      } catch {
        checks = null; // checks unavailable -> indeterminate, never success
      }
    }

    return {
      repository: query.repository,
      pullRequestNumber: query.pullRequestNumber,
      state: normalizeState(pr["state"], pr["merged"]),
      baseBranch: typeof base["ref"] === "string" ? base["ref"] : null,
      headBranch: typeof head["ref"] === "string" ? head["ref"] : null,
      headSha,
      mergeableState: normalizeMergeable(pr["mergeable"], pr["mergeable_state"]),
      checks,
    };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`, // internal use only; never echoed
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "memoryos-github-guardian-proof",
    };
  }

  private incompleteEvidence(query: PullRequestQuery): PullRequestEvidence {
    return {
      repository: query.repository,
      pullRequestNumber: query.pullRequestNumber,
      state: null,
      baseBranch: null,
      headBranch: null,
      headSha: null,
      mergeableState: "UNKNOWN",
      checks: null,
    };
  }
}
